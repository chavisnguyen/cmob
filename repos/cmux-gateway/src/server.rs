use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify, RwLock};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{error, info, warn};

use crate::cmux::DualTransportCmuxBridge;
use crate::notifications::{
    build_dialog_notification_content, build_notification_content, is_generic_placeholder,
    make_push_tag, normalize_text, EngineEvent, NotificationContent, NotificationEngine,
    SurfaceContext,
};
use crate::protocol::{
    AuthError, AuthOk, AuthRequest, JsonRpcError, JsonRpcRequest, JsonRpcResponse,
    PairingOffer, METHOD_CHAT_APPROVE, METHOD_CHAT_INTERRUPT, METHOD_CHAT_READ_SESSION,
    METHOD_CHAT_ANSWER_DIALOG, METHOD_CHAT_SEND, METHOD_CHAT_SESSIONS, METHOD_CHAT_SUBSCRIBE, METHOD_CHAT_UNSUBSCRIBE, METHOD_CLIENT_VIEWING, METHOD_HOST_STATUS, METHOD_PUSH_HISTORY,
    METHOD_AGENT_OPTIONS, METHOD_CHAT_FORK, METHOD_CHAT_SET_OPTION, METHOD_DEVICE_LIST, METHOD_DEVICE_REVOKE, METHOD_GIT_DIFF, METHOD_UPLOAD_IMAGE, METHOD_GIT_STATUS, METHOD_PUSH_PREFERENCES, METHOD_PUSH_REGISTER, METHOD_PUSH_TEST, METHOD_PUSH_VAPID_KEY, METHOD_SURFACE_CLOSE, METHOD_SURFACE_GET,
    METHOD_SURFACE_NEW, METHOD_SURFACE_RENAME, METHOD_TERMINAL_INPUT, METHOD_TERMINAL_PASTE,
    METHOD_TERMINAL_READ, METHOD_TERMINAL_REPLAY, METHOD_TERMINAL_SCROLL, METHOD_TERMINAL_SEND,
    METHOD_TERMINAL_SUBSCRIBE, METHOD_TERMINAL_UNSUBSCRIBE, METHOD_TERMINAL_VIEWPORT,
    METHOD_WORKSPACE_LIST,
    METHOD_WORKSPACE_TREE, WS_CLOSE_AUTH_FAILED,
};
use crate::pairing_store::{ct_eq, DeviceRegistry};
use crate::push::{PushService, PushSubscription};
use crate::protocol::event::{AgentEvent, AgentLifecycleState, AgentTurn};
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::kiro_store::KiroSessionIndex;
use crate::scanner::transcript::TranscriptReader;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;

/// Broadcast message fanned out to active WebSocket clients for live alerts/dismissals.
#[derive(Clone, Debug)]
pub enum NotificationBroadcast {
    Alert { surface_id: String, frame: String },
    Dismiss { surface_id: String, frame: String },
}

/// Shared application state for all Axum routes and WS connections.
#[derive(Clone)]
pub struct AppState {
    pub auth_token: String,
    pub host: String,
    pub port: u16,
    pub cmux_bridge: DualTransportCmuxBridge,
    pub push_service: PushService,
    pub devices: DeviceRegistry,
    /// Caps concurrent WebSocket connections (authenticated or not) so unauthenticated sockets cannot
    /// exhaust memory.
    pub conn_limit: Arc<tokio::sync::Semaphore>,
    /// Authenticated WebSocket sessions that are open right now (for `/api/clients`).
    pub clients: ClientRegistry,
    /// Live notification alert/dismiss broadcast channel for connected desktop & mobile clients.
    pub notif_tx: tokio::sync::broadcast::Sender<NotificationBroadcast>,
}

/// One authenticated, currently open WebSocket session.
#[derive(Clone, serde::Serialize)]
pub struct ClientInfo {
    pub session_id: String,
    /// Device id for a per-device token; None when the shared gateway token was used.
    pub device_id: Option<String>,
    /// Device label, or "gateway token" for the shared token.
    pub label: String,
    pub user_agent: String,
    pub connected_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewing_surface: Option<String>,
    #[serde(default)]
    pub client_visible: bool,
}

/// Live sessions keyed by session id. Entries are removed by `ClientGuard::drop`, so every exit path
/// of `handle_socket` (error, revoke, normal close) unregisters.
#[derive(Clone, Default)]
pub struct ClientRegistry {
    inner: Arc<std::sync::Mutex<HashMap<String, ClientInfo>>>,
}

impl ClientRegistry {
    fn register(&self, info: ClientInfo) -> ClientGuard {
        let id = info.session_id.clone();
        self.inner.lock().unwrap().insert(id.clone(), info);
        ClientGuard { registry: self.clone(), id }
    }

    pub fn set_viewing(&self, session_id: &str, surface_id: Option<String>, visible: bool) {
        if let Some(info) = self.inner.lock().unwrap().get_mut(session_id) {
            info.viewing_surface = surface_id;
            info.client_visible = visible;
        }
    }

    pub fn is_session_viewing(&self, session_id: &str, surface_id: &str) -> bool {
        self.inner.lock().unwrap().get(session_id).is_some_and(|info| {
            info.client_visible && info.viewing_surface.as_deref() == Some(surface_id)
        })
    }

    pub fn devices_viewing_surface(&self, surface_id: &str) -> std::collections::HashSet<String> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|info| info.client_visible && info.viewing_surface.as_deref() == Some(surface_id))
            .filter_map(|info| info.device_id.clone())
            .collect()
    }

    /// Oldest connection first.
    pub fn list(&self) -> Vec<ClientInfo> {
        let mut v: Vec<ClientInfo> = self.inner.lock().unwrap().values().cloned().collect();
        v.sort_by_key(|c| c.connected_at);
        v
    }
}

struct ClientGuard {
    registry: ClientRegistry,
    id: String,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.registry.inner.lock().unwrap().remove(&self.id);
    }
}

/// Maximum concurrent WebSocket connections.
const MAX_WS_CONNECTIONS: usize = 32;
/// Maximum size of one WebSocket message/frame (terminal pastes are the largest legitimate payload).
const MAX_WS_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

impl AppState {
    pub fn new(host: String, port: u16, auth_token: String) -> Self {
        Self {
            auth_token,
            host,
            port,
            cmux_bridge: DualTransportCmuxBridge::new(),
            push_service: PushService::default_dir()
                .map(PushService::with_storage)
                .unwrap_or_else(PushService::new),
            devices: DeviceRegistry::new(DeviceRegistry::default_path()),
            conn_limit: Arc::new(tokio::sync::Semaphore::new(MAX_WS_CONNECTIONS)),
            clients: ClientRegistry::default(),
            notif_tx: tokio::sync::broadcast::channel(128).0,
        }
    }

    /// Accepts the gateway token or any redeemed per-device token.
    pub fn token_valid(&self, candidate: &str) -> bool {
        ct_eq(candidate, &self.auth_token) || self.devices.is_device_token(candidate)
    }

    pub fn pairing_offer(&self) -> PairingOffer {
        // The gateway itself serves plain HTTP/WS (no TLS listener). `wss://` is only valid behind
        // Tailscale Serve on the MagicDNS name, which scripts/tailscale.sh builds separately.
        let endpoint = format!("ws://{}:{}/ws", self.host, self.port);
        PairingOffer::new(endpoint, &self.auth_token)
    }

    /// Offer with a fresh single-use ticket; never exposes the long-lived gateway token.
    pub fn pairing_offer_with_ticket(&self) -> PairingOffer {
        PairingOffer::with_ticket(self.pairing_offer().endpoint, self.devices.issue_ticket())
    }
}

fn desktop_notifications_enabled() -> bool {
    !matches!(std::env::var("CMUX_DESKTOP_NOTIFY").as_deref(), Ok("0" | "false" | "FALSE"))
}

fn surface_context_from_tree(
    tree: &serde_json::Value,
    ws_dirs: &HashMap<String, String>,
    surface_id: &str,
    fallback_dir: Option<&str>,
) -> SurfaceContext {
    for win in tree.get("windows").and_then(|w| w.as_array()).into_iter().flatten() {
        for ws in win.get("workspaces").and_then(|w| w.as_array()).into_iter().flatten() {
            let ws_id = ws.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let ws_title = ws.get("title").and_then(|v| v.as_str()).map(str::to_string);
            let ws_dir = ws_dirs
                .get(ws_id)
                .cloned()
                .or_else(|| fallback_dir.map(str::to_string));
            for pane in ws.get("panes").and_then(|p| p.as_array()).into_iter().flatten() {
                for s in pane.get("surfaces").and_then(|s| s.as_array()).into_iter().flatten() {
                    let id_match = s.get("id").and_then(|v| v.as_str()) == Some(surface_id);
                    let ref_match = s.get("ref").and_then(|v| v.as_str()) == Some(surface_id);
                    if id_match || ref_match {
                        return SurfaceContext {
                            workspace_title: ws_title,
                            workspace_dir: ws_dir,
                            surface_title: s.get("title").and_then(|v| v.as_str()).map(str::to_string),
                        };
                    }
                }
            }
        }
    }
    SurfaceContext {
        workspace_title: None,
        workspace_dir: fallback_dir.map(str::to_string),
        surface_title: None,
    }
}

async fn workspace_dirs_map(bridge: &DualTransportCmuxBridge) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(raw) = bridge.rpc_call("workspace.list", None).await else {
        return map;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return map;
    };
    for ws in val.get("workspaces").and_then(|w| w.as_array()).into_iter().flatten() {
        if let (Some(id), Some(dir)) = (
            ws.get("id").and_then(|v| v.as_str()),
            ws.get("current_directory").and_then(|v| v.as_str()),
        ) {
            map.insert(id.to_string(), dir.to_string());
        }
    }
    map
}

async fn lookup_surface_context(
    bridge: &DualTransportCmuxBridge,
    surface_id: &str,
    fallback_dir: Option<&str>,
) -> SurfaceContext {
    let tree_fut = bridge.run_command("tree", &["--json", "--id-format", "both"]);
    let dirs_fut = workspace_dirs_map(bridge);
    let (tree_res, dirs) = tokio::join!(tree_fut, dirs_fut);
    if let Ok(raw) = tree_res {
        if let Ok(tree) = serde_json::from_str::<serde_json::Value>(&raw) {
            return surface_context_from_tree(&tree, &dirs, surface_id, fallback_dir);
        }
    }
    SurfaceContext {
        workspace_title: None,
        workspace_dir: fallback_dir.map(str::to_string),
        surface_title: None,
    }
}

async fn emit_alert(
    state: &AppState,
    notification_id: &str,
    surface_id: &str,
    workspace_id: &str,
    content: &NotificationContent,
) {
    let data = serde_json::json!({
        "notificationId": notification_id,
        "surfaceId": surface_id,
        "workspaceId": workspace_id,
        "category": content.category,
        "agent": content.agent_kind,
        "agentDisplay": content.agent_display,
        "urgent": content.urgent,
        "tag": content.tag,
    });
    let excluded = state.clients.devices_viewing_surface(surface_id);
    state
        .push_service
        .dispatch_excluding_devices(&content.title, &content.body, Some(&content.tag), data.clone(), &excluded)
        .await;

    let ws_payload = serde_json::json!({
        "notification_id": notification_id,
        "surface_id": surface_id,
        "workspace_id": workspace_id,
        "category": content.category,
        "agent": content.agent_kind,
        "agent_display": content.agent_display,
        "title": content.title,
        "subtitle": content.subtitle,
        "body": content.body,
        "tag": content.tag,
        "urgent": content.urgent,
    });
    let frame = JsonRpcResponse::event_value(EVENT_NOTIFICATION_ALERT, ws_payload);
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = state.notif_tx.send(NotificationBroadcast::Alert {
            surface_id: surface_id.to_string(),
            frame: text,
        });
    }

    if desktop_notifications_enabled() {
        let _ = state
            .cmux_bridge
            .notify_desktop(surface_id, &content.title, content.subtitle.as_deref(), &content.body)
            .await;
    }
}

async fn emit_dismiss(state: &AppState, surface_id: &str, tags: &[String]) {
    let frame = JsonRpcResponse::event_value(
        EVENT_NOTIFICATION_DISMISS,
        serde_json::json!({
            "surface_id": surface_id,
            "tags": tags,
        }),
    );
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = state.notif_tx.send(NotificationBroadcast::Dismiss {
            surface_id: surface_id.to_string(),
            frame: text,
        });
    }
    if desktop_notifications_enabled() {
        let _ = state.cmux_bridge.clear_notifications(surface_id).await;
    }
}

/// Spawns the background monitor that scans active top-level agent sessions and dispatches
/// Orca-style alerts to macOS desktop (`cmux notify --desktop true`), connected WebSocket clients,
/// and Web Push mobile subscribers without gating on desktop idle state.
pub fn spawn_push_dispatcher(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        let mut engine = NotificationEngine::default();
        let mut baseline_done = false;
        let mut ticks: u64 = 0;
        loop {
            interval.tick().await;

            // Every ~10 minutes: devices idle past the TTL are gone, and so must their push subscriptions
            // (otherwise agent text keeps flowing to a phone that can no longer authenticate).
            ticks += 1;
            if ticks % 1200 == 1 {
                for id in state.devices.prune_expired() {
                    state.push_service.unregister_device(&id);
                }
            }

            let dir = HookStoreIndex::default_cmuxterm_dir();
            let index = match tokio::task::spawn_blocking(move || HookStoreIndex::scan_dir(&dir)).await {
                Ok(idx) => idx,
                Err(_) => continue,
            };
            let sessions = index.active_top_level_sessions_by_surface();

            if !baseline_done {
                engine.seed(&sessions);
                baseline_done = true;
                continue;
            }

            let events = engine.step(&sessions, Instant::now());
            for ev in events {
                match ev {
                    EngineEvent::Dismiss { surface_id, tags } => {
                        emit_dismiss(&state, &surface_id, &tags).await;
                    }
                    EngineEvent::Alert {
                        notification_id,
                        surface_id,
                        workspace_id,
                        lifecycle,
                        record,
                        ..
                    } => {
                        let ctx = lookup_surface_context(
                            &state.cmux_bridge,
                            &surface_id,
                            record.cwd.as_deref(),
                        )
                        .await;
                        let rec_clone = record.clone();
                        let content = tokio::task::spawn_blocking(move || {
                            build_notification_content(&rec_clone, lifecycle, &ctx)
                        })
                        .await;
                        let Ok(content) = content else { continue };

                        // Orca burst cooldown (NOTIFICATION_COOLDOWN_MS = 5000ms)
                        if state.push_service.should_dispatch(&surface_id, content.category, 5) {
                            emit_alert(&state, &notification_id, &surface_id, &workspace_id, &content).await;
                        }
                    }
                }
            }
        }
    })
}

/// Watches freshly started agents for startup dialogs (trust, update...), which appear before any hook
/// exists: marks the surface as waiting and sends one push per dialog (Orca `TrustDialogStatusObserver`,
/// src/main/runtime/terminal/output/trust-dialog-status-observer.ts, projects the same into the status row).
pub fn spawn_dialog_watcher(state: AppState) -> tokio::task::JoinHandle<()> {
    use crate::cmux::startup_dialog::registry;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        let mut active_dialogs: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut seq: u64 = 0;
        loop {
            interval.tick().await;
            let recent = tokio::task::spawn_blocking(|| WorkspaceTreeBuilder::scan_recent_agent_ttys(300))
                .await
                .unwrap_or_default();
            if recent.is_empty() {
                for sid in active_dialogs.drain() {
                    emit_dismiss(&state, &sid, &[make_push_tag(&sid, "cmux-dialog")]).await;
                }
                continue;
            }
            let Ok(raw) = state.cmux_bridge.run_command("tree", &["--json", "--id-format", "both"]).await else {
                continue;
            };
            let Ok(tree) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            let ws_dirs = workspace_dirs_map(&state.cmux_bridge).await;
            let mut seen_dialogs = std::collections::HashSet::new();
            for (surface_id, tty) in terminal_surfaces(&tree) {
                let Some((_, agent)) = recent.iter().find(|(t, _)| *t == tty) else { continue };
                match state.cmux_bridge.current_dialog(Some(&surface_id)).await {
                    Some(d) => {
                        registry::set(&surface_id, Some(&d.fingerprint));
                        seen_dialogs.insert(surface_id.clone());
                        active_dialogs.insert(surface_id.clone());
                        let cooldown_cat = format!("dialog:{}", d.fingerprint);
                        if state.push_service.should_dispatch(&surface_id, &cooldown_cat, 3600) {
                            let ctx = surface_context_from_tree(&tree, &ws_dirs, &surface_id, None);
                            let content = build_dialog_notification_content(&surface_id, agent, &d.title, &ctx);
                            seq = seq.wrapping_add(1);
                            let notif_id = format!("dlg-{seq}");
                            emit_alert(&state, &notif_id, &surface_id, "", &content).await;
                        }
                    }
                    None => {
                        registry::set(&surface_id, None);
                        if active_dialogs.remove(&surface_id) {
                            emit_dismiss(&state, &surface_id, &[make_push_tag(&surface_id, "cmux-dialog")]).await;
                        }
                    }
                }
            }
            let gone: Vec<String> = active_dialogs
                .iter()
                .filter(|sid| !seen_dialogs.contains(*sid))
                .cloned()
                .collect();
            for sid in gone {
                active_dialogs.remove(&sid);
                emit_dismiss(&state, &sid, &[make_push_tag(&sid, "cmux-dialog")]).await;
            }
        }
    })
}


/// (surface uuid, tty) of every terminal surface in a `cmux tree --json --id-format both` document.
fn terminal_surfaces(tree: &serde_json::Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for win in tree.get("windows").and_then(|w| w.as_array()).into_iter().flatten() {
        for ws in win.get("workspaces").and_then(|w| w.as_array()).into_iter().flatten() {
            for pane in ws.get("panes").and_then(|p| p.as_array()).into_iter().flatten() {
                for s in pane.get("surfaces").and_then(|s| s.as_array()).into_iter().flatten() {
                    if s.get("type").and_then(|t| t.as_str()) != Some("terminal") {
                        continue;
                    }
                    if let (Some(id), Some(tty)) = (
                        s.get("id").and_then(|i| i.as_str()),
                        s.get("tty").and_then(|t| t.as_str()),
                    ) {
                        out.push((id.to_string(), tty.trim_start_matches("/dev/").to_string()));
                    }
                }
            }
        }
    }
    out
}

pub fn create_router(state: AppState) -> Router {
    spawn_push_dispatcher(state.clone());
    spawn_dialog_watcher(state.clone());

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &axum::http::HeaderValue, parts: &axum::http::request::Parts| {
            if let Ok(s) = origin.to_str() {
                let host = parts.headers.get(header::HOST).and_then(|v| v.to_str().ok());
                origin_allowed(s, host)
            } else {
                false
            }
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::UPGRADE,
            header::CONNECTION,
        ])
        .allow_credentials(true)
        .allow_private_network(true);

    Router::new()
        .route("/health", get(health_handler))
        .route("/api/pairing", get(pairing_handler))
        .route("/api/pair/exchange", post(pair_exchange_handler))
        .route("/api/clients", get(clients_handler))
        .route("/api/devices", get(devices_handler))
        .route("/api/devices/{id}", delete(device_revoke_handler))
        .route("/ws", get(ws_handler))
        .layer(middleware::from_fn(host_and_origin_guard))
        .layer(cors)
        .with_state(state)
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let cmux_alive = state.cmux_bridge.ping().await;
    Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "cmux_alive": cmux_alive,
    }))
}

#[derive(serde::Deserialize)]
struct ExchangeRequest {
    ticket: String,
    /// Optional human label shown in the device list (e.g. "iPhone Safari").
    #[serde(default)]
    label: String,
}

/// Redeem a one-time pairing ticket for a per-device token.
async fn pair_exchange_handler(
    State(state): State<AppState>,
    Json(body): Json<ExchangeRequest>,
) -> impl IntoResponse {
    match state.devices.redeem_labeled(&body.ticket, &body.label) {
        Some(token) => {
            info!("Paired a new device ({})", if body.label.is_empty() { "unnamed" } else { body.label.as_str() });
            (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({ "token": token })),
            )
        }
        None => {
            warn!("Pairing ticket rejected: already used, expired or unknown");
            (
                axum::http::StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "invalid_or_expired_ticket" })),
            )
        }
    }
}

/// Only the gateway (master) token may mint pairing offers. Device tokens cannot, and anonymous callers
/// get nothing: without this, anyone who can reach the port could mint a ticket, redeem it and run
/// commands through `mobile.surface.new`.
async fn pairing_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    if bearer.is_empty() || !ct_eq(bearer, &state.auth_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "gateway token required" })),
        )
            .into_response();
    }
    let offer = state.pairing_offer_with_ticket();
    let uri = offer.to_uri().unwrap_or_default();
    Json(serde_json::json!({
        "offer": offer,
        "uri": uri,
    }))
    .into_response()
}

fn bearer_of(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
}

/// `Some(401 response)` unless the caller presented the gateway (master) token.
fn require_master(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    let bearer = bearer_of(headers);
    if bearer.is_empty() || !ct_eq(bearer, &state.auth_token) {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "gateway token required" })),
            )
                .into_response(),
        );
    }
    None
}

/// Currently connected sessions. Gateway (master) token only, like `/api/pairing`.
async fn clients_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    Json(serde_json::json!({ "clients": state.clients.list() })).into_response()
}

/// Paired devices (for `cmob devices`). Gateway token only.
async fn devices_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    Json(serde_json::json!({ "devices": state.devices.list() })).into_response()
}

/// Revokes one paired device and its push subscriptions (for `cmob devices revoke`). Gateway token only.
async fn device_revoke_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    let revoked = state.devices.revoke(&id);
    let push_removed = if revoked { state.push_service.unregister_device(&id) } else { 0 };
    let status = if revoked { StatusCode::OK } else { StatusCode::NOT_FOUND };
    (
        status,
        Json(serde_json::json!({ "revoked": revoked, "push_subscriptions_removed": push_removed })),
    )
        .into_response()
}

/// Host names a legitimate client can use: loopback, IP literals, `*.ts.net` (Tailscale MagicDNS), and
/// anything in `CMUX_ALLOWED_HOSTS`. Anything else is a DNS-rebinding attempt.
pub fn host_allowed(host_header: &str) -> bool {
    let host = host_header.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("").to_string()
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(&host).to_string()
    };
    if name.parse::<std::net::IpAddr>().is_ok() || name == "localhost" || name.ends_with(".localhost") {
        return true;
    }
    if name.ends_with(".ts.net") {
        return true;
    }
    std::env::var("CMUX_ALLOWED_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .any(|h| !h.is_empty() && h == name)
}

/// Origins permitted to connect via WebSocket or REST API:
/// 1. Same-origin (matches Host header authority)
/// 2. Loopback / localhost (http://localhost:*, http://127.0.0.1:*, etc.)
/// 3. Tailscale MagicDNS nodes (*.ts.net)
/// 4. GitHub Pages (github.io, *.github.io)
/// 5. Origins or hosts in CMUX_ALLOWED_ORIGINS or CMUX_ALLOWED_HOSTS
pub fn origin_allowed(origin_str: &str, host_header: Option<&str>) -> bool {
    let origin_str = origin_str.trim();
    if origin_str.is_empty() {
        return false;
    }
    let lower = origin_str.to_ascii_lowercase();

    // Extract authority: strip scheme (e.g. "https://", "http://", "ws://", "wss://")
    let authority = lower
        .split("://")
        .nth(1)
        .unwrap_or(&lower)
        .split('/')
        .next()
        .unwrap_or("");

    if authority.is_empty() {
        return false;
    }

    // 1. Same-origin check against Host header
    if let Some(host) = host_header {
        let host_lower = host.trim().to_ascii_lowercase();
        if authority == host_lower {
            return true;
        }
    }

    // Extract hostname without port or IPv6 brackets
    let host_name = authority
        .strip_prefix('[')
        .and_then(|r| r.split(']').next())
        .unwrap_or_else(|| authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority));

    if host_name.is_empty() {
        return false;
    }

    // 2. Localhost / Loopback
    if host_name == "localhost"
        || host_name.ends_with(".localhost")
        || host_name.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
    {
        return true;
    }

    // 3. Tailscale MagicDNS (*.ts.net)
    if host_name.ends_with(".ts.net") {
        return true;
    }

    // 4. Official GitHub Pages deployment (custom forks use CMUX_ALLOWED_ORIGINS)
    if host_name == "chavisnguyen.github.io" {
        return true;
    }

    // 5. CMUX_ALLOWED_ORIGINS (matches full origin, authority, or hostname)
    if let Ok(allowed) = std::env::var("CMUX_ALLOWED_ORIGINS") {
        for a in allowed.split(',') {
            let a = a.trim().to_ascii_lowercase();
            if a.is_empty() {
                continue;
            }
            if a == lower || a == authority || a == host_name {
                return true;
            }
        }
    }

    // 6. CMUX_ALLOWED_HOSTS
    if let Ok(allowed_hosts) = std::env::var("CMUX_ALLOWED_HOSTS") {
        for h in allowed_hosts.split(',') {
            let h = h.trim().to_ascii_lowercase();
            if !h.is_empty() && h == host_name {
                return true;
            }
        }
    }

    false
}

/// Rejects requests whose `Host` is not an expected name (DNS rebinding) or whose `Origin` is not
/// an allowed site (cross-site WebSocket / POST). Requests without these headers
/// (curl, native clients) pass; they still need a token.
/// OPTIONS requests pass through to the CORS layer.
async fn host_and_origin_guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(h) = host.as_deref() {
        if !host_allowed(h) {
            warn!("Rejected request with unexpected Host header: {h}");
            return (StatusCode::FORBIDDEN, "forbidden host").into_response();
        }
    }
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !origin_allowed(origin, host.as_deref()) {
            warn!("Rejected cross-origin request from Origin: {origin}");
            return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
        }
    }
    next.run(req).await
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let user_agent: String = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();
    let permit = match state.conn_limit.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            warn!("Rejected WebSocket: connection limit reached");
            return (StatusCode::SERVICE_UNAVAILABLE, "too many connections").into_response();
        }
    };
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            handle_socket(socket, state, user_agent).await;
        })
}

async fn handle_socket(mut socket: WebSocket, state: AppState, user_agent: String) {
    let session_id = uuid::Uuid::new_v4().to_string();
    info!("New WebSocket connection: session {}", session_id);

    // 1. Mandatory First Frame Authentication Handshake
    // Enforce 5s handshake timeout
    let first_msg = match timeout(Duration::from_secs(5), socket.next()).await {
        Ok(Some(Ok(msg))) => msg,
        _ => {
            warn!("Session {} handshake timed out", session_id);
            let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: WS_CLOSE_AUTH_FAILED,
                reason: "Handshake timeout".into(),
            }))).await;
            return;
        }
    };

    let text = match first_msg {
        Message::Text(t) => t,
        _ => {
            warn!("Session {} rejected: non-text first frame", session_id);
            let err = AuthError::unauthenticated();
            let _ = socket.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
            let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: WS_CLOSE_AUTH_FAILED,
                reason: "Unauthenticated".into(),
            }))).await;
            return;
        }
    };

    let auth_req: Result<AuthRequest, _> = serde_json::from_str(&text);
    let session_token: String;
    match auth_req {
        Ok(req) if req.r#type == "auth" && state.token_valid(&req.token) => {
            session_token = req.token.clone();
            let ok = AuthOk::new(&session_id);
            let ok_json = serde_json::to_string(&ok).unwrap();
            if socket.send(Message::Text(ok_json.into())).await.is_err() {
                return;
            }
            info!("Session {} authenticated successfully", session_id);
        }
        Ok(_) => {
            warn!("Session {} rejected: invalid token", session_id);
            let err = AuthError::invalid_token();
            let _ = socket.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
            let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: WS_CLOSE_AUTH_FAILED,
                reason: "Invalid token".into(),
            }))).await;
            return;
        }
        Err(_) => {
            warn!("Session {} rejected: invalid auth frame format", session_id);
            let err = AuthError::unauthenticated();
            let _ = socket.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
            let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: WS_CLOSE_AUTH_FAILED,
                reason: "Unauthenticated".into(),
            }))).await;
            return;
        }
    }

    let device_id = state.devices.device_id_for_token(&session_token);
    let label = device_id
        .as_ref()
        .and_then(|id| state.devices.list().into_iter().find(|d| &d.id == id))
        .map(|d| d.label)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| if device_id.is_some() { "device".into() } else { "gateway token".into() });
    let _client_guard = state.clients.register(ClientInfo {
        session_id: session_id.clone(),
        device_id,
        label,
        user_agent,
        connected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        viewing_surface: None,
        client_visible: false,
    });

    // 2. Authenticated Message Dispatch Loop.
    // Server-push frames (chat subscriptions) arrive over `out_rx` and are interleaved with
    // client requests, so a single socket carries both request/response and event traffic.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(32);
    let mut notif_rx = state.notif_tx.subscribe();
    let mut subs: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut term_subs: HashMap<String, TerminalSubscriptionHandle> = HashMap::new();

    // Revocation must also reach sockets that only receive (subscriptions push without any client frame).
    let mut token_recheck = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = token_recheck.tick() => {
                if !state.token_valid(&session_token) {
                    warn!("Session {} closed: token revoked or expired", session_id);
                    let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: WS_CLOSE_AUTH_FAILED,
                        reason: "Token revoked".into(),
                    }))).await;
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(Ok(msg)) = incoming else { break };
                // Revocation / expiry must cut live sessions too, not only new handshakes.
                if !state.token_valid(&session_token) {
                    warn!("Session {} closed: token revoked or expired", session_id);
                    let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: WS_CLOSE_AUTH_FAILED,
                        reason: "Token revoked".into(),
                    }))).await;
                    break;
                }
                match msg {
                    Message::Text(text) => {
                        let req: Result<JsonRpcRequest, _> = serde_json::from_str(&text);
                        match req {
                            Ok(rpc_req) => {
                                let response = match rpc_req.method.as_str() {
                                    METHOD_CHAT_SUBSCRIBE | METHOD_CHAT_UNSUBSCRIBE => {
                                        handle_subscription(&rpc_req, &state, &out_tx, &mut subs)
                                    }
                                    METHOD_TERMINAL_SUBSCRIBE | METHOD_TERMINAL_UNSUBSCRIBE => {
                                        handle_terminal_subscription(&rpc_req, &state, &out_tx, &mut term_subs).await
                                    }
                                    METHOD_TERMINAL_VIEWPORT => {
                                        handle_terminal_viewport(&rpc_req, &state, &term_subs).await
                                    }
                                    METHOD_CLIENT_VIEWING => {
                                        let surface_id = rpc_req
                                            .params
                                            .get("surface_id")
                                            .and_then(|v| v.as_str())
                                            .filter(|s| !s.is_empty())
                                            .map(str::to_string);
                                        let visible = rpc_req
                                            .params
                                            .get("visible")
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(true);
                                        state.clients.set_viewing(&session_id, surface_id.clone(), visible);
                                        JsonRpcResponse::result(
                                            rpc_req.id.clone(),
                                            serde_json::json!({
                                                "ok": true,
                                                "surface_id": surface_id,
                                                "visible": visible,
                                            }),
                                        )
                                        .unwrap()
                                    }
                                    _ => {
                                        let mut rpc_req = rpc_req;
                                        if rpc_req.method == METHOD_PUSH_REGISTER {
                                            // Bind the subscription to the authenticated device; never trust
                                            // a client-supplied `device_id`.
                                            if let Some(obj) = rpc_req.params.as_object_mut() {
                                                obj.remove("device_id");
                                                obj.remove("muted_categories");
                                                if let Some(id) = state.devices.device_id_for_token(&session_token) {
                                                    obj.insert("device_id".into(), serde_json::Value::String(id));
                                                }
                                            }
                                        }
                                        if rpc_req.method == METHOD_PUSH_PREFERENCES {
                                            // A device may only change its own subscription's preferences.
                                            if let Some(obj) = rpc_req.params.as_object_mut() {
                                                obj.remove("device_id");
                                                if let Some(id) = state.devices.device_id_for_token(&session_token) {
                                                    obj.insert("device_id".into(), serde_json::Value::String(id));
                                                }
                                            }
                                        }
                                        let resp = dispatch_rpc(&rpc_req, &state).await;
                                        if matches!(
                                            rpc_req.method.as_str(),
                                            METHOD_TERMINAL_INPUT
                                                | METHOD_TERMINAL_PASTE
                                                | METHOD_TERMINAL_SCROLL
                                                | METHOD_TERMINAL_SEND
                                        ) {
                                            if let Some(surf_id) = rpc_req.params.get("surface_id").and_then(|val| val.as_str()) {
                                                notify_terminal_subscriber(&term_subs, surf_id);
                                            }
                                        }
                                        resp
                                    }
                                };
                                let resp_json = serde_json::to_string(&response).unwrap();
                                if socket.send(Message::Text(resp_json.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                let err_resp = JsonRpcResponse::error(None, JsonRpcError::parse_error());
                                let resp_json = serde_json::to_string(&err_resp).unwrap();
                                let _ = socket.send(Message::Text(resp_json.into())).await;
                                error!("Failed to parse JSON-RPC request: {}", e);
                            }
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Message::Close(_) => {
                        info!("Session {} closed by client", session_id);
                        break;
                    }
                    _ => {}
                }
            }
            Some(frame) = out_rx.recv() => {
                if !state.token_valid(&session_token) {
                    warn!("Session {} closed: token revoked or expired", session_id);
                    break;
                }
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            recv_res = notif_rx.recv() => {
                if !state.token_valid(&session_token) {
                    warn!("Session {} closed: token revoked or expired", session_id);
                    break;
                }
                match recv_res {
                    Ok(NotificationBroadcast::Alert { surface_id, frame }) => {
                        if !state.clients.is_session_viewing(&session_id, &surface_id)
                            && socket.send(Message::Text(frame.into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Ok(NotificationBroadcast::Dismiss { frame, .. }) => {
                        if socket.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    for (_, handle) in subs.drain() {
        handle.abort();
    }
    for (surface_id, term_sub) in term_subs.drain() {
        term_sub.task.abort();
        let cfg = term_sub.config.read().await.clone();
        if cfg.mode == "mobile" && !cfg.client_id.is_empty() {
            let bridge = state.cmux_bridge.clone();
            tokio::spawn(async move {
                let _ = bridge.terminal_clear_viewport(&surface_id, &cfg.client_id).await;
            });
        }
    }
}

/// Maximum concurrent chat subscriptions per WebSocket connection.
const MAX_SUBSCRIPTIONS: usize = 8;
/// Event name pushed to subscribed clients; payload matches `mobile.chat.readSession`.
pub const EVENT_CHAT_UPDATE: &str = "mobile.chat.update";
pub const EVENT_TERMINAL_UPDATE: &str = "mobile.terminal.update";
pub const EVENT_NOTIFICATION_ALERT: &str = "mobile.notification.alert";
pub const EVENT_NOTIFICATION_DISMISS: &str = "mobile.notification.dismiss";

#[derive(Debug, Clone)]
struct TerminalStreamConfig {
    mode: String,
    columns: u16,
    rows: u16,
    client_id: String,
    max_scrollback_rows: usize,
    force_push: bool,
}

struct TerminalSubscriptionHandle {
    task: JoinHandle<()>,
    config: Arc<RwLock<TerminalStreamConfig>>,
    notify: Arc<Notify>,
}

fn notify_terminal_subscriber(term_subs: &HashMap<String, TerminalSubscriptionHandle>, surface_id: &str) {
    if let Some(sub) = term_subs.get(surface_id) {
        sub.notify.notify_one();
        let delayed_notify = sub.notify.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(55)).await;
            delayed_notify.notify_one();
        });
    }
}

fn terminal_replay_fingerprint(payload: &serde_json::Value, mode: &str) -> String {
    let rg = &payload["render_grid"];
    let size_state = &payload["size_state"];
    let epoch = rg.get("render_epoch").and_then(|val| val.as_str()).unwrap_or("");
    let rev = rg.get("render_revision").and_then(|val| val.as_u64()).unwrap_or(0);
    let row_rev = rg.get("row_space_revision").and_then(|val| val.as_u64()).unwrap_or(0);
    let state_seq = rg.get("state_seq").and_then(|val| val.as_u64()).unwrap_or(0);
    let cols = rg.get("columns").and_then(|val| val.as_u64()).unwrap_or(0);
    let rows = rg.get("rows").and_then(|val| val.as_u64()).unwrap_or(0);
    let screen = rg.get("active_screen").and_then(|val| val.as_str()).unwrap_or("");
    let sb_rows = rg.get("scrollback_rows").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_row = rg["cursor"].get("row").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_col = rg["cursor"].get("column").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_vis = rg["cursor"].get("visible").and_then(|val| val.as_bool()).unwrap_or(true);
    let ss_cols = size_state.get("cols").and_then(|val| val.as_u64()).unwrap_or(0);
    let ss_rows = size_state.get("rows").and_then(|val| val.as_u64()).unwrap_or(0);
    format!("{mode}|{epoch}|{rev}|{row_rev}|{state_seq}|{cols}x{rows}|{screen}|{sb_rows}|{cursor_row},{cursor_col},{cursor_vis}|{ss_cols}x{ss_rows}")
}

async fn handle_terminal_subscription(
    req: &JsonRpcRequest,
    state: &AppState,
    out_tx: &mpsc::Sender<String>,
    term_subs: &mut HashMap<String, TerminalSubscriptionHandle>,
) -> JsonRpcResponse {
    let surface_id = match req.params.get("surface_id").and_then(|val| val.as_str()) {
        Some(surf) if !surf.is_empty() => surf.to_string(),
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing surface_id parameter"),
            );
        }
    };

    if let Some(old) = term_subs.remove(&surface_id) {
        old.task.abort();
        if req.method == METHOD_TERMINAL_UNSUBSCRIBE {
            let cfg = old.config.read().await.clone();
            if cfg.mode == "mobile" && !cfg.client_id.is_empty() {
                let _ = state
                    .cmux_bridge
                    .terminal_clear_viewport(&surface_id, &cfg.client_id)
                    .await;
            }
        }
    }

    if req.method == METHOD_TERMINAL_UNSUBSCRIBE {
        return JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "unsubscribed": true, "surface_id": surface_id }),
        )
        .unwrap();
    }

    if term_subs.len() >= MAX_SUBSCRIPTIONS {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params(format!(
                "Too many terminal subscriptions (max {MAX_SUBSCRIPTIONS} per connection)"
            )),
        );
    }

    let mode = req
        .params
        .get("mode")
        .and_then(|val| val.as_str())
        .unwrap_or("desktop")
        .to_string();
    let columns = req
        .params
        .get("columns")
        .or_else(|| req.params.get("cols"))
        .and_then(|val| val.as_u64())
        .unwrap_or(0) as u16;
    let rows = req
        .params
        .get("rows")
        .and_then(|val| val.as_u64())
        .unwrap_or(0) as u16;
    let client_id = req
        .params
        .get("client_id")
        .and_then(|val| val.as_str())
        .unwrap_or("pwa")
        .to_string();
    let max_scrollback_rows = req
        .params
        .get("max_scrollback_rows")
        .and_then(|val| val.as_u64())
        .unwrap_or(500)
        .min(2000) as usize;

    if mode == "mobile" && columns > 0 && rows > 0 {
        let _ = state
            .cmux_bridge
            .terminal_set_viewport(&surface_id, &client_id, columns, rows)
            .await;
    } else if mode == "desktop" && !client_id.is_empty() {
        let _ = state
            .cmux_bridge
            .terminal_clear_viewport(&surface_id, &client_id)
            .await;
    }

    let config = Arc::new(RwLock::new(TerminalStreamConfig {
        mode: mode.clone(),
        columns,
        rows,
        client_id,
        max_scrollback_rows,
        force_push: true,
    }));
    let notify = Arc::new(Notify::new());

    let task = tokio::spawn(terminal_watcher(
        state.clone(),
        out_tx.clone(),
        surface_id.clone(),
        config.clone(),
        notify.clone(),
    ));

    term_subs.insert(
        surface_id.clone(),
        TerminalSubscriptionHandle {
            task,
            config,
            notify,
        },
    );

    JsonRpcResponse::result(
        req.id.clone(),
        serde_json::json!({
            "subscribed": true,
            "surface_id": surface_id,
            "mode": mode,
            "event": EVENT_TERMINAL_UPDATE,
        }),
    )
    .unwrap()
}

async fn handle_terminal_viewport(
    req: &JsonRpcRequest,
    state: &AppState,
    term_subs: &HashMap<String, TerminalSubscriptionHandle>,
) -> JsonRpcResponse {
    let surface_id = match req.params.get("surface_id").and_then(|val| val.as_str()) {
        Some(surf) if !surf.is_empty() => surf,
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing surface_id parameter"),
            );
        }
    };
    let client_id = req
        .params
        .get("client_id")
        .and_then(|val| val.as_str())
        .unwrap_or("pwa");
    let clear = req.params.get("clear").and_then(|val| val.as_bool()).unwrap_or(false);
    let mode = req
        .params
        .get("mode")
        .and_then(|val| val.as_str())
        .unwrap_or(if clear { "desktop" } else { "mobile" });
    let columns = req
        .params
        .get("columns")
        .or_else(|| req.params.get("cols"))
        .and_then(|val| val.as_u64())
        .unwrap_or(0) as u16;
    let rows = req
        .params
        .get("rows")
        .and_then(|val| val.as_u64())
        .unwrap_or(0) as u16;

    let rpc_res = if clear || mode == "desktop" {
        if let Some(sub) = term_subs.get(surface_id) {
            let mut cfg = sub.config.write().await;
            cfg.mode = "desktop".to_string();
            cfg.force_push = true;
        }
        state
            .cmux_bridge
            .terminal_clear_viewport(surface_id, client_id)
            .await
    } else {
        if columns == 0 || rows == 0 {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("columns and rows must be > 0 for mobile mode"),
            );
        }
        if let Some(sub) = term_subs.get(surface_id) {
            let mut cfg = sub.config.write().await;
            cfg.mode = "mobile".to_string();
            cfg.columns = columns;
            cfg.rows = rows;
            cfg.client_id = client_id.to_string();
            cfg.force_push = true;
        }
        state
            .cmux_bridge
            .terminal_set_viewport(surface_id, client_id, columns, rows)
            .await
    };

    if let Some(sub) = term_subs.get(surface_id) {
        sub.notify.notify_one();
        let delayed = sub.notify.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(160)).await;
            delayed.notify_one();
        });
    }

    match rpc_res {
        Ok(result) => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({
                "surface_id": surface_id,
                "mode": mode,
                "result": result,
            }),
        )
        .unwrap(),
        Err(err) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(err.to_string()),
        ),
    }
}

async fn terminal_watcher(
    state: AppState,
    out_tx: mpsc::Sender<String>,
    surface_id: String,
    config: Arc<RwLock<TerminalStreamConfig>>,
    notify: Arc<Notify>,
) {
    const POLL_MS: u64 = 150;
    let mut last_fp: Option<String> = None;
    let mut viewport_sync_pending = false;

    loop {
        let cfg = config.read().await.clone();
        let viewport = if cfg.mode == "mobile" && cfg.columns > 0 && cfg.rows > 0 {
            Some((cfg.columns, cfg.rows))
        } else {
            None
        };

        match state
            .cmux_bridge
            .terminal_replay(&surface_id, cfg.max_scrollback_rows, viewport)
            .await
        {
            Ok(mut replay) => {
                if let Some((target_cols, target_rows)) = viewport {
                    let actual_cols = replay.get("columns").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
                    let actual_rows = replay.get("rows").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
                    let has_mobile_owner = replay["size_state"]
                        .get("participants")
                        .and_then(|val| val.as_array())
                        .map(|arr| {
                            arr.iter().any(|participant| {
                                participant
                                    .get("id")
                                    .and_then(|id| id.as_str())
                                    .map(|id| id == format!("mobile:{}", cfg.client_id))
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false);

                    if !has_mobile_owner && !viewport_sync_pending {
                        viewport_sync_pending = true;
                        let _ = state
                            .cmux_bridge
                            .terminal_set_viewport(&surface_id, &cfg.client_id, target_cols, target_rows)
                            .await;
                    } else if has_mobile_owner && (actual_cols == target_cols || actual_rows == target_rows) {
                        viewport_sync_pending = false;
                    }
                } else {
                    viewport_sync_pending = false;
                }

                let fp = terminal_replay_fingerprint(&replay, &cfg.mode);
                let should_push = cfg.force_push || last_fp.as_deref() != Some(fp.as_str());
                if should_push {
                    if cfg.force_push {
                        let mut write_cfg = config.write().await;
                        write_cfg.force_push = false;
                    }
                    last_fp = Some(fp);
                    if let Some(obj) = replay.as_object_mut() {
                        obj.insert("mode".to_string(), serde_json::Value::String(cfg.mode.clone()));
                    }
                    let frame = JsonRpcResponse::event_value(EVENT_TERMINAL_UPDATE, replay);
                    if let Ok(text) = serde_json::to_string(&frame) {
                        if out_tx.send(text).await.is_err() {
                            return;
                        }
                    }
                }
            }
            Err(_) => {}
        }

        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(POLL_MS)) => {}
        }
    }
}

fn handle_subscription(
    req: &JsonRpcRequest,
    state: &AppState,
    out_tx: &mpsc::Sender<String>,
    subs: &mut HashMap<String, JoinHandle<()>>,
) -> JsonRpcResponse {
    let surface_id = match req.params.get("surface_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing surface_id parameter"),
            );
        }
    };

    if let Some(old) = subs.remove(&surface_id) {
        old.abort();
    }

    if req.method == METHOD_CHAT_UNSUBSCRIBE {
        return JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "unsubscribed": true, "surface_id": surface_id }),
        )
        .unwrap();
    }

    if subs.len() >= MAX_SUBSCRIPTIONS {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params(format!(
                "Too many subscriptions (max {MAX_SUBSCRIPTIONS} per connection)"
            )),
        );
    }

    let session_id = req.params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let agent_kind = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
    let max_turns = req.params.get("max_turns").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize;

    let handle = tokio::spawn(chat_watcher(
        state.clone(),
        out_tx.clone(),
        surface_id.clone(),
        session_id,
        agent_kind,
        max_turns,
    ));
    subs.insert(surface_id.clone(), handle);

    JsonRpcResponse::result(
        req.id.clone(),
        serde_json::json!({ "subscribed": true, "surface_id": surface_id, "event": EVENT_CHAT_UPDATE }),
    )
    .unwrap()
}

/// A transcript-backed agent session resolved for a surface.
#[derive(Debug, Clone)]
struct ResolvedSession {
    session_id: String,
    surface_id: String,
    agent_kind: String,
    transcript_path: Option<String>,
    lifecycle: AgentLifecycleState,
    last_event: Option<String>,
    last_subtitle: Option<String>,
    last_body: Option<String>,
    tool_name: Option<String>,
    /// Resolved through the (expensive) cmux tree rather than the hook store.
    from_tree: bool,
}

/// Resolve the active session for a surface: hook store first (cheap), then the workspace tree,
/// which also discovers hook-less agents such as Kiro.
async fn resolve_session(state: &AppState, surface_id: &str, session_id: &str) -> Option<ResolvedSession> {
    let mut res = resolve_session_raw(state, surface_id, session_id).await?;
    // No agent process on the surface tty => the agent cannot be working or waiting, whatever the
    // last hook event says (hook-record pids are not reliable, see scanner/liveness.rs).
    if matches!(res.lifecycle, AgentLifecycleState::Working | AgentLifecycleState::Waiting) {
        let sid = res.surface_id.clone();
        let alive = tokio::task::spawn_blocking(move || crate::scanner::liveness::surface_has_agent_process(&sid))
            .await
            .ok()
            .flatten();
        if alive == Some(false) {
            res.lifecycle = AgentLifecycleState::Idle;
        }
    }
    Some(res)
}

async fn resolve_session_raw(state: &AppState, surface_id: &str, session_id: &str) -> Option<ResolvedSession> {
    let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
    let record = if !session_id.is_empty() {
        hook_index.sessions_by_id.get(session_id)
    } else {
        hook_index.get_active_session_for_surface(surface_id)
    };
    if let Some(rec) = record {
        return Some(ResolvedSession {
            session_id: rec.session_id.clone(),
            surface_id: rec.surface_id.clone(),
            agent_kind: rec.resolved_agent_kind().to_string(),
            transcript_path: rec.transcript_path.clone(),
            lifecycle: rec.live_lifecycle(),
            last_event: rec.hook_event_name.clone(),
            last_subtitle: rec.last_subtitle.clone(),
            last_body: rec.last_body.clone(),
            tool_name: rec.tool_name.clone(),
            from_tree: false,
        });
    }

    let surface = WorkspaceTreeBuilder::get_surface(&state.cmux_bridge, &hook_index, surface_id)
        .await
        .ok()
        .flatten()?;
    let agent = surface.agent?;
    let path = agent.transcript_path.clone()?;
    let (lifecycle, subtitle) = match (agent.agent_kind.as_str(), KiroSessionIndex::analyze_file(std::path::Path::new(&path))) {
        ("kiro", Some(s)) => (s.lifecycle, s.last_subtitle),
        _ => (
            match agent.status.as_str() {
                "running" => AgentLifecycleState::Working,
                "waiting" => AgentLifecycleState::Waiting,
                "error" => AgentLifecycleState::Error,
                _ => AgentLifecycleState::Idle,
            },
            None,
        ),
    };
    Some(ResolvedSession {
        session_id: agent.session_id,
        surface_id: surface.id,
        agent_kind: agent.agent_kind,
        transcript_path: Some(path),
        lifecycle,
        last_event: None,
        last_subtitle: subtitle,
        last_body: None,
        tool_name: None,
        from_tree: true,
    })
}

fn empty_session_json(surface_id: &str, agent_kind: &str) -> serde_json::Value {
    serde_json::json!({
        "session_id": "",
        "surface_id": surface_id,
        "agent_kind": agent_kind,
        "is_working": false,
        "lifecycle_state": "ready",
        "last_event": serde_json::Value::Null,
        "last_subtitle": "Ready for prompt",
        "awaiting_prompt": serde_json::Value::Null,
        "turns": []
    })
}

fn is_numbered_choice_line(line: &str, prefix: &str) -> bool {
    let t = line.trim_start_matches(['›', '❯', '>', ' ']);
    t.starts_with(prefix)
}

fn clean_box_line(raw: &str) -> String {
    raw.trim()
        .trim_matches('│')
        .trim_matches('┃')
        .trim()
        .to_string()
}

fn is_box_border_line(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    let first = line.chars().next().unwrap_or(' ');
    if matches!(first, '╭' | '┌' | '╰' | '└') {
        return true;
    }
    line.chars().count() >= 4 && line.chars().all(|c| matches!(c, '─' | '━' | '═' | '-' | ' '))
}

/// Extracts the approval question/command shown above numbered choices (`1. ...`) on the terminal screen.
fn extract_approval_screen_context(screen: &str) -> Option<String> {
    let lines: Vec<String> = screen.lines().map(clean_box_line).collect();
    let first_opt_idx = lines.iter().rposition(|l| is_numbered_choice_line(l, "1."))?;
    let lookahead_end = (first_opt_idx + 9).min(lines.len());
    let has_dialog_tail = lines[first_opt_idx + 1..lookahead_end].iter().any(|l| {
        let lower = l.to_ascii_lowercase();
        is_numbered_choice_line(l, "2.")
            || is_numbered_choice_line(l, "3.")
            || ((lower.contains("confirm") || lower.contains("cancel") || lower.contains("select"))
                && (lower.contains("esc") || lower.contains("enter")))
    });
    if !has_dialog_tail {
        return None;
    }

    let mut collected = Vec::new();
    let mut blank_streak = 0usize;
    for line in lines[..first_opt_idx].iter().rev() {
        if is_box_border_line(line) {
            if !collected.is_empty() {
                break;
            }
            continue;
        }
        if line.is_empty() {
            blank_streak += 1;
            if blank_streak >= 2 && !collected.is_empty() {
                break;
            }
            continue;
        }
        blank_streak = 0;
        if matches!(line.as_str(), "›" | "❯") {
            break;
        }
        collected.push(line.clone());
        if collected.len() >= 8 {
            break;
        }
    }
    if collected.is_empty() {
        return None;
    }
    collected.reverse();
    let joined = collected.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= 360 {
        Some(trimmed.to_string())
    } else {
        let mut out: String = trimmed.chars().take(359).collect();
        out.push('…');
        Some(out)
    }
}

fn summarize_tool_detail(detail: &str) -> String {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(detail) {
        let primary = ["cmd", "command", "file_path", "path", "patch", "url", "pattern", "query", "script"]
            .into_iter()
            .find_map(|k| map.get(k).and_then(|v| v.as_str()).map(|s| normalize_text(Some(s), 200)))
            .filter(|s| !s.is_empty());
        let reason = ["justification", "reason"]
            .into_iter()
            .find_map(|k| map.get(k).and_then(|v| v.as_str()).map(|s| normalize_text(Some(s), 120)))
            .filter(|s| !s.is_empty());
        match (primary, reason) {
            (Some(p), Some(r)) => return format!("{r}\n{p}"),
            (Some(p), None) => return p,
            (None, Some(r)) => return r,
            (None, None) => {}
        }
    }
    normalize_text(Some(detail), 220)
}

fn derive_pending_tool_prompt(turns: &[AgentTurn]) -> Option<String> {
    let mut ended = std::collections::HashSet::new();
    for turn in turns {
        for ev in &turn.events {
            if let AgentEvent::ToolEnd { tool_id, .. } = ev {
                ended.insert(tool_id.as_str());
            }
        }
    }
    for turn in turns.iter().rev() {
        for ev in turn.events.iter().rev() {
            if let AgentEvent::ToolStart { tool_id, name, detail } = ev {
                if ended.contains(tool_id.as_str()) {
                    continue;
                }
                let tool = normalize_text(Some(name), 60);
                let summary = detail.as_deref().map(summarize_tool_detail).unwrap_or_default();
                if !tool.is_empty() && !summary.is_empty() {
                    return Some(format!("{tool}: {summary}"));
                }
                if !tool.is_empty() {
                    return Some(format!("Approve tool: {tool}"));
                }
            }
        }
    }
    None
}

fn derive_awaiting_prompt(
    res: &ResolvedSession,
    turns: &[AgentTurn],
    screen_context: Option<&str>,
) -> Option<String> {
    if res.lifecycle != AgentLifecycleState::Waiting {
        return None;
    }
    let body = normalize_text(res.last_body.as_deref(), 240);
    if !body.is_empty()
        && !is_generic_placeholder(&body)
        && !body.eq_ignore_ascii_case("approval needed")
    {
        return Some(body);
    }
    if let Some(screen_text) = screen_context.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(screen_text.to_string());
    }
    if let Some(pending) = derive_pending_tool_prompt(turns) {
        return Some(pending);
    }
    let tool = normalize_text(res.tool_name.as_deref(), 60);
    if !tool.is_empty() {
        return Some(format!("Approve tool: {tool}"));
    }
    if !body.is_empty() {
        return Some(body);
    }
    let subtitle = normalize_text(res.last_subtitle.as_deref(), 160);
    if !subtitle.is_empty() && !is_generic_placeholder(&subtitle) {
        return Some(subtitle);
    }
    Some("Agent requested approval".to_string())
}

/// Build the `readSession` payload for a resolved session (blocking file IO).
fn session_json(
    res: &ResolvedSession,
    max_turns: usize,
    screen_context: Option<&str>,
) -> Result<serde_json::Value, std::io::Error> {
    let (turns, total_turns) = match &res.transcript_path {
        Some(p) => TranscriptReader::read_recent_turns_page(std::path::Path::new(p), &res.surface_id, max_turns)?,
        None => (Vec::new(), 0),
    };
    let has_more = total_turns > turns.len();
    // Live activity line = what the agent is doing RIGHT NOW. Hook `lastSubtitle` values are completion/
    // notification texts ("Completed in X", "Permission"), never live activity, so only transcript-derived
    // activity (Kiro running tool) is exposed here. Orca: native-chat-turn-activity.ts:76-77.
    let activity = if res.from_tree && res.lifecycle == AgentLifecycleState::Working {
        res.last_subtitle.clone()
    } else {
        None
    };
    let awaiting_prompt = derive_awaiting_prompt(res, &turns, screen_context);
    Ok(serde_json::json!({
        "activity": activity,
        "session_id": res.session_id,
        "surface_id": res.surface_id,
        "agent_kind": res.agent_kind,
        "is_working": res.lifecycle == AgentLifecycleState::Working,
        "lifecycle_state": res.lifecycle,
        "last_event": res.last_event,
        "last_subtitle": res.last_subtitle,
        "awaiting_prompt": awaiting_prompt,
        "has_more": has_more,
        "total_turns": total_turns,
        "turns": turns
    }))
}

/// `startup_dialog` field of a chat snapshot: what the agent is asking on screen (null when nothing).
/// Choices carry labels only; the gateway re-derives the keys when the user answers.
async fn startup_dialog_value(state: &AppState, surface_id: &str) -> serde_json::Value {
    use crate::cmux::startup_dialog::registry;
    match state.cmux_bridge.current_dialog(Some(surface_id)).await {
        Some(d) => {
            registry::set(surface_id, Some(&d.fingerprint));
            serde_json::json!({
                "kind": d.kind.label(),
                "title": d.title,
                "description": d.description,
                "fingerprint": d.fingerprint,
                "aimed": !d.choices.is_empty(),
                "choices": d.choices.iter().map(|c| serde_json::json!({ "label": c.label })).collect::<Vec<_>>(),
            })
        }
        None => {
            registry::set(surface_id, None);
            serde_json::Value::Null
        }
    }
}

/// Cheap change detector: lifecycle/subtitle plus transcript mtime and size.
fn fingerprint(res: &Option<ResolvedSession>) -> String {
    let Some(r) = res else { return "none".to_string() };
    let (mtime, len) = r
        .transcript_path
        .as_deref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            (t, m.len())
        })
        .unwrap_or((0, 0));
    format!(
        "{}|{:?}|{:?}|{:?}|{:?}|{:?}|{mtime}|{len}",
        r.session_id, r.lifecycle, r.last_event, r.last_subtitle, r.last_body, r.tool_name
    )
}

/// Per-subscription watcher: samples the session every 500ms and pushes a full snapshot only
/// when its fingerprint changes. This replaces client-side 1s polling of `readSession`.
async fn chat_watcher(
    state: AppState,
    out_tx: mpsc::Sender<String>,
    surface_id: String,
    session_id: String,
    fallback_agent: String,
    max_turns: usize,
) {
    const TICK: Duration = Duration::from_millis(500);
    const TREE_REFRESH: Duration = Duration::from_secs(3);

    let mut interval = tokio::time::interval(TICK);
    let mut last_fp: Option<String> = None;
    let mut cached_tree: Option<(ResolvedSession, Instant)> = None;
    // Startup dialogs only show while the agent is not mid-turn; the screen is read at most every 2 s.
    const DIALOG_POLL: Duration = Duration::from_secs(2);
    let mut dialog: (serde_json::Value, Option<Instant>) = (serde_json::Value::Null, None);
    let mut approval_screen: (Option<String>, Option<Instant>) = (None, None);

    loop {
        interval.tick().await;

        // Tree-resolved sessions (Kiro) avoid spawning `cmux tree` every tick: reuse the cached
        // resolution and only re-derive lifecycle from the transcript tail.
        let resolved = match cached_tree.as_ref().filter(|(_, at)| at.elapsed() < TREE_REFRESH) {
            Some((r, _)) => {
                let mut r = r.clone();
                if let Some(p) = &r.transcript_path {
                    if r.agent_kind == "kiro" {
                        if let Some(s) = KiroSessionIndex::analyze_file(std::path::Path::new(p)) {
                            r.lifecycle = s.lifecycle;
                            r.last_subtitle = s.last_subtitle;
                        }
                    }
                }
                Some(r)
            }
            None => {
                let r = resolve_session(&state, &surface_id, &session_id).await;
                cached_tree = r.clone().filter(|r| r.from_tree).map(|r| (r, Instant::now()));
                r
            }
        };

        let working = resolved.as_ref().is_some_and(|r| r.lifecycle == AgentLifecycleState::Working);
        if working {
            dialog = (serde_json::Value::Null, None);
            crate::cmux::startup_dialog::registry::set(&surface_id, None);
        } else if dialog.1.map_or(true, |at| at.elapsed() >= DIALOG_POLL) {
            dialog = (startup_dialog_value(&state, &surface_id).await, Some(Instant::now()));
        }
        let waiting = resolved.as_ref().is_some_and(|r| r.lifecycle == AgentLifecycleState::Waiting);
        if !waiting {
            approval_screen = (None, None);
        } else if approval_screen.1.map_or(true, |at| at.elapsed() >= DIALOG_POLL) {
            let extracted = state
                .cmux_bridge
                .capture_pane(Some(&surface_id), 35, false)
                .await
                .ok()
                .as_deref()
                .and_then(extract_approval_screen_context);
            approval_screen = (extracted, Some(Instant::now()));
        }
        let dialog_fp = dialog.0.get("fingerprint").and_then(|f| f.as_str()).unwrap_or("");
        let screen_fp = approval_screen.0.as_deref().unwrap_or("");
        let fp = format!("{}|{dialog_fp}|{screen_fp}", fingerprint(&resolved));
        if last_fp.as_deref() == Some(fp.as_str()) {
            continue;
        }

        let payload = match resolved {
            Some(res) => {
                let screen_ctx = approval_screen.0.clone();
                let built = tokio::task::spawn_blocking(move || {
                    session_json(&res, max_turns, screen_ctx.as_deref())
                })
                .await;
                match built {
                    Ok(Ok(v)) => v,
                    _ => continue,
                }
            }
            None => empty_session_json(&surface_id, &fallback_agent),
        };
        let mut payload = payload;
        payload["startup_dialog"] = dialog.0.clone();
        last_fp = Some(fp);

        let frame = JsonRpcResponse::event_value(EVENT_CHAT_UPDATE, payload);
        let Ok(text) = serde_json::to_string(&frame) else { continue };
        if out_tx.send(text).await.is_err() {
            return; // connection closed
        }
    }
}

/// Directory of the cmux workspace named by `workspace_id` (id or ref). Resolved from cmux itself, never
/// taken from the client, and required to be an existing absolute directory.
async fn workspace_dir(state: &AppState, params: &serde_json::Value) -> Result<std::path::PathBuf, JsonRpcError> {
    let wanted = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| JsonRpcError::invalid_params("Missing workspace_id parameter"))?;
    let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
    let tree = WorkspaceTreeBuilder::build_tree(&state.cmux_bridge, &hook_index)
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
    let ws = tree
        .into_iter()
        .find(|w| w.id == wanted || w.r#ref == wanted)
        .ok_or_else(|| JsonRpcError::invalid_params("Unknown workspace"))?;
    let dir = std::path::PathBuf::from(&ws.current_directory);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(JsonRpcError::invalid_params("Workspace has no usable directory"));
    }
    Ok(dir)
}

async fn dispatch_rpc(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    match req.method.as_str() {
        METHOD_HOST_STATUS => {
            let cmux_alive = state.cmux_bridge.ping().await;
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "cmux_alive": cmux_alive,
                    "host": state.host,
                    "port": state.port,
                    "gateway_version": env!("CARGO_PKG_VERSION")
                }),
            )
            .unwrap()
        }
        METHOD_CHAT_SEND => {
            let text = req.params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let surface = req.params.get("surface_id").and_then(|v| v.as_str());
            let agent_kind = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("");
            // Like Orca's `nativeChat terminalWrite { text, enter }`: submit unless told otherwise.
            let enter = req.params.get("enter").and_then(|v| v.as_bool()).unwrap_or(true);

            match state.cmux_bridge.submit_prompt(surface, text, agent_kind, enter).await {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "delivered" }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_CHAT_APPROVE => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
            // No default: guessing the agent would send the wrong approval key (Claude "1" vs Enter).
            let Some(agent_kind) = req.params.get("agent_kind").and_then(|v| v.as_str()).filter(|k| !k.is_empty()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing agent_kind parameter"),
                );
            };

            // No lifecycle check here on purpose: a permission prompt that stays unanswered for >30 min is
            // reported as Idle by `live_lifecycle` (hook_store.rs, stale rule), so gating on "Waiting" would
            // refuse exactly the approvals made from away from the desk. The client only offers Approve while
            // the agent is waiting, and `approve()` fails closed on startup dialogs.
            match state.cmux_bridge.approve(surface, agent_kind).await {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "approved" }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_CHAT_INTERRUPT => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");

            match state.cmux_bridge.interrupt(surface).await {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "interrupted" }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_WORKSPACE_TREE => {
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            match WorkspaceTreeBuilder::build_tree(&state.cmux_bridge, &hook_index).await {
                Ok(workspaces) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "workspaces": workspaces }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_WORKSPACE_LIST => {
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            match WorkspaceTreeBuilder::list_workspaces(&state.cmux_bridge, &hook_index).await {
                Ok(workspaces) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "workspaces": workspaces }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_SURFACE_GET => {
            let surface_id = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            match WorkspaceTreeBuilder::get_surface(&state.cmux_bridge, &hook_index, surface_id).await {
                Ok(Some(surface)) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "surface": surface }),
                )
                .unwrap(),
                Ok(None) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params(format!("Surface not found: {surface_id}")),
                ),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_CHAT_SESSIONS => {
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            let sessions: Vec<_> = hook_index.sessions_by_id.values().cloned().collect();
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({ "sessions": sessions }),
            )
            .unwrap()
        }
        METHOD_CHAT_READ_SESSION => {
            let surface_id = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
            let session_id = req.params.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let max_turns = req.params.get("max_turns").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize;
            let fallback_agent = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("agent");

            let dialog = startup_dialog_value(state, surface_id).await;
            match resolve_session(state, surface_id, session_id).await {
                Some(res) => {
                    let screen_ctx = if res.lifecycle == AgentLifecycleState::Waiting {
                        state
                            .cmux_bridge
                            .capture_pane(Some(&res.surface_id), 35, false)
                            .await
                            .ok()
                            .as_deref()
                            .and_then(extract_approval_screen_context)
                    } else {
                        None
                    };
                    match tokio::task::spawn_blocking(move || {
                        session_json(&res, max_turns, screen_ctx.as_deref())
                    })
                    .await
                    {
                        Ok(Ok(mut v)) => {
                            v["startup_dialog"] = dialog;
                            JsonRpcResponse::result_value(req.id.clone(), v)
                        }
                        Ok(Err(e)) => JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::internal_error(format!("Failed to read transcript: {e}")),
                        ),
                        Err(e) => JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::internal_error(e.to_string()),
                        ),
                    }
                }
                // Standby surface with no transcript yet: empty turn list with ready status
                None => {
                    let mut v = empty_session_json(surface_id, fallback_agent);
                    v["startup_dialog"] = dialog;
                    JsonRpcResponse::result_value(req.id.clone(), v)
                }
            }
        }
        METHOD_CHAT_ANSWER_DIALOG => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
            let fingerprint = req.params.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("");
            let choice = req.params.get("choice").and_then(|v| v.as_u64());
            match choice {
                Some(choice) if !surface.is_empty() && !fingerprint.is_empty() => {
                    match state.cmux_bridge.answer_dialog(surface, fingerprint, choice as usize).await {
                        Ok(label) => JsonRpcResponse::result(
                            req.id.clone(),
                            serde_json::json!({ "status": "answered", "choice": label }),
                        )
                        .unwrap(),
                        Err(e) => JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::internal_error(e.to_string()),
                        ),
                    }
                }
                _ => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("surface_id, fingerprint and choice are required"),
                ),
            }
        }
        METHOD_AGENT_OPTIONS => {
            let Some(kind) = req.params.get("agent_kind").and_then(|v| v.as_str()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing agent_kind parameter"),
                );
            };
            if crate::cmux::agent_options::is_antigravity(kind) {
                return match crate::cmux::agent_options::antigravity_options().await {
                    Ok(v) => JsonRpcResponse::result(req.id.clone(), v).unwrap(),
                    Err(msg) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::internal_error(msg)),
                };
            }
            match crate::cmux::agent_options::options_for(kind) {
                Some(opts) => JsonRpcResponse::result(req.id.clone(), serde_json::to_value(opts).unwrap()).unwrap(),
                None => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("This agent has no model/effort options"),
                ),
            }
        }
        METHOD_CHAT_SET_OPTION => {
            use crate::cmux::agent_options::{mid_session, MidSession};
            let (Some(surface), Some(kind), Some(option)) = (
                req.params.get("surface_id").and_then(|v| v.as_str()).filter(|v| !v.is_empty()),
                req.params.get("agent_kind").and_then(|v| v.as_str()),
                req.params.get("option").and_then(|v| v.as_str()),
            ) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("surface_id, agent_kind and option are required"),
                );
            };
            let value = req.params.get("value").and_then(|v| v.as_str());
            let action = match mid_session(kind, option, value) {
                Ok(a) => a,
                Err(msg) => return JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(msg)),
            };
            let bridge = &state.cmux_bridge;
            let outcome = match &action {
                MidSession::Command(text) => bridge.submit_prompt(Some(surface), text, kind, true).await.map(|_| "applied"),
                MidSession::TypedPicker(text) => {
                    // Typed, not pasted: Codex treats a multi-character write as paste and would not open its picker.
                    match bridge.ensure_no_startup_dialog(Some(surface)).await {
                        Ok(()) => match bridge.send_text(Some(surface), text).await {
                            Ok(()) => bridge.send_key(Some(surface), "enter").await.map(|_| "picker_opened"),
                            Err(e) => Err(e),
                        },
                        Err(e) => Err(e),
                    }
                }
            };
            match outcome {
                Ok(status) => JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": status })).unwrap(),
                Err(e) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::internal_error(e.to_string())),
            }
        }
        METHOD_CHAT_FORK => {
            let (Some(ws), Some(session), Some(kind)) = (
                req.params.get("workspace_id").and_then(|v| v.as_str()).filter(|v| !v.is_empty()),
                req.params.get("session_id").and_then(|v| v.as_str()),
                req.params.get("agent_kind").and_then(|v| v.as_str()),
            ) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("workspace_id, session_id and agent_kind are required"),
                );
            };
            let Some(command) = crate::cmux::agents::fork_command(kind, session) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("This agent cannot fork conversations from here"),
                );
            };
            // The workspace must be a real one (this also rejects ids that look like CLI flags).
            if let Err(e) = workspace_dir(state, &req.params).await {
                return JsonRpcResponse::error(Some(req.id.clone()), e);
            }
            // `claude --resume` looks the session up under the project directory it ran in, so the fork
            // must start in the session's own cwd (hook record), not wherever the new tab would default to.
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            let Some(record) = hook_index.sessions_by_id.get(session) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Unknown session"),
                );
            };
            let cwd = record
                .cwd
                .as_deref()
                .filter(|c| std::path::Path::new(c).is_absolute() && std::path::Path::new(c).is_dir());
            match state.cmux_bridge.new_surface_with_cwd(Some(ws), Some(&command), cwd).await {
                Ok(out) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "forked", "output": out }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::internal_error(e.to_string())),
            }
        }
        METHOD_UPLOAD_IMAGE => {
            use base64::Engine;
            let Some(b64) = req.params.get("content_base64").and_then(|v| v.as_str()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing content_base64 parameter"),
                );
            };
            // Reject before decoding: base64 of MAX_IMAGE_BYTES is ~4/3 as long.
            if b64.len() > crate::uploads::MAX_IMAGE_BYTES / 3 * 4 + 8 {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Image too large"),
                );
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("content_base64 is not valid base64"),
                );
            };
            let Some(dir) = crate::uploads::default_dir() else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error("No upload directory available"),
                );
            };
            // File I/O off the async worker.
            let saved = tokio::task::spawn_blocking(move || crate::uploads::save_image(&dir, &bytes)).await;
            match saved {
                Ok(Ok(path)) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "path": path.to_string_lossy() }),
                )
                .unwrap(),
                Ok(Err(msg)) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(msg)),
                Err(e) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::internal_error(e.to_string())),
            }
        }
        METHOD_GIT_STATUS => {
            let dir = match workspace_dir(state, &req.params).await {
                Ok(d) => d,
                Err(e) => return JsonRpcResponse::error(Some(req.id.clone()), e),
            };
            match crate::git_view::status(&dir).await {
                Ok(st) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "directory": dir.to_string_lossy(), "status": st }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(e)),
            }
        }
        METHOD_GIT_DIFF => {
            let Some(path) = req.params.get("path").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing path parameter"),
                );
            };
            let staged = req.params.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
            let dir = match workspace_dir(state, &req.params).await {
                Ok(d) => d,
                Err(e) => return JsonRpcResponse::error(Some(req.id.clone()), e),
            };
            let st = match crate::git_view::status(&dir).await {
                Ok(st) => st,
                Err(e) => return JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(e)),
            };
            match crate::git_view::diff(&dir, &st, path, staged).await {
                Ok((diff, truncated)) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "path": path, "staged": staged, "diff": diff, "truncated": truncated }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(e)),
            }
        }
        METHOD_DEVICE_LIST => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "devices": state.devices.list() }),
        )
        .unwrap(),
        METHOD_DEVICE_REVOKE => {
            let Some(id) = req.params.get("device_id").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing device_id parameter"),
                );
            };
            let revoked = state.devices.revoke(id);
            // A revoked phone must stop receiving notification text (agent output) as well.
            let push_removed = if revoked { state.push_service.unregister_device(id) } else { 0 };
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({ "revoked": revoked, "push_subscriptions_removed": push_removed }),
            )
            .unwrap()
        }
        METHOD_PUSH_PREFERENCES => {
            let Some(endpoint) = req.params.get("endpoint").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing endpoint parameter"),
                );
            };
            // With `muted_categories` the preference is written; without it this is a read.
            if let Some(list) = req.params.get("muted_categories").and_then(|v| v.as_array()) {
                let muted: Vec<String> = list.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
                let owner = req.params.get("device_id").and_then(|v| v.as_str());
                if !state.push_service.set_muted_for(endpoint, &muted, owner) {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Unknown push subscription"),
                    );
                }
            }
            let Some(sub) = state.push_service.list().into_iter().find(|s| s.endpoint == endpoint) else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Unknown push subscription"),
                );
            };
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "categories": crate::push::PUSH_CATEGORIES,
                    "muted_categories": sub.muted_categories,
                }),
            )
            .unwrap()
        }
        METHOD_PUSH_REGISTER => {
            match serde_json::from_value::<PushSubscription>(req.params.clone()) {
                Ok(sub) => {
                    if let Err(msg) = crate::push::validate_push_endpoint(&sub.endpoint) {
                        return JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::invalid_params(msg),
                        );
                    }
                    if state.push_service.count() >= crate::push::MAX_SUBSCRIPTIONS {
                        return JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::invalid_params("Too many push subscriptions"),
                        );
                    }
                    state.push_service.register(sub);
                    JsonRpcResponse::result(
                        req.id.clone(),
                        serde_json::json!({
                            "status": "registered",
                            "subscriptions_count": state.push_service.count()
                        }),
                    )
                    .unwrap()
                }
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params(format!("Invalid push subscription payload: {e}")),
                ),
            }
        }
        METHOD_PUSH_VAPID_KEY => match state.push_service.vapid_public_key() {
            Some(key) => JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "public_key": key })).unwrap(),
            None => JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::internal_error("Web Push is not configured (no VAPID key)".to_string()),
            ),
        },
        METHOD_PUSH_TEST => {
            // Sends a real notification to every registered subscription.
            let sent = state
                .push_service
                .dispatch(
                    "cmux test notification",
                    "Push is working.",
                    Some("cmux-test"),
                    serde_json::json!({ "category": "test" }),
                )
                .await;
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "status": "ok",
                    "subscriptions_count": sent
                }),
            )
            .unwrap()
        }
        METHOD_PUSH_HISTORY => {
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "history": state.push_service.history()
                }),
            )
            .unwrap()
        }
        METHOD_SURFACE_NEW => {
            let ws = req.params.get("workspace_id").and_then(|v| v.as_str());
            let mut command = req.params.get("command").and_then(|v| v.as_str()).map(str::to_string);

            // Optional `launch: { agent_kind, model, effort }`: validated flags are appended to a plain
            // `claude` / `codex` command (Orca launch picker, CLI forms in agent_options.rs).
            if let Some(launch) = req.params.get("launch").and_then(|v| v.as_object()) {
                let get = |k: &str| launch.get(k).and_then(|v| v.as_str());
                let Some(kind) = get("agent_kind") else {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("launch.agent_kind is required"),
                    );
                };
                let flags = match crate::cmux::agent_options::launch_flags(kind, get("model"), get("effort")) {
                    Ok(f) => f,
                    Err(msg) => return JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(msg)),
                };
                if !flags.is_empty() {
                    let aliases = crate::cmux::agents::spec_for(kind).map(|s| s.aliases).unwrap_or(&[]);
                    let base = command.as_deref().unwrap_or("");
                    if !base.split_whitespace().next().is_some_and(|w| aliases.contains(&w)) {
                        return JsonRpcResponse::error(
                            Some(req.id.clone()),
                            JsonRpcError::invalid_params("launch options need a plain agent command"),
                        );
                    }
                    command = Some(format!("{} {}", base.trim(), flags.join(" ")));
                }
            }

            match state.cmux_bridge.new_surface(ws, command.as_deref()).await {
                Ok(out) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "created", "output": out }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_SURFACE_RENAME => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let title = match req.params.get("title").and_then(|val| val.as_str()).map(str::trim) {
                Some(next_title) if !next_title.is_empty() => next_title,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing title parameter"),
                    );
                }
            };

            match state.cmux_bridge.rename_tab(surface, title).await {
                Ok(out) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "renamed", "surface_id": surface, "title": title, "output": out }),
                )
                .unwrap(),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_SURFACE_CLOSE => {
            let surface = match req.params.get("surface_id").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let force = req.params.get("force").and_then(|v| v.as_bool()).unwrap_or(true);

            let workspace = req
                .params
                .get("workspace_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty());

            match state.cmux_bridge.close_surface(surface, workspace, force).await {
                Ok(out) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "closed", "surface_id": surface, "output": out }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_REPLAY => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let max_scrollback = req
                .params
                .get("max_scrollback_rows")
                .and_then(|val| val.as_u64())
                .unwrap_or(500)
                .min(2000) as usize;
            let cols = req
                .params
                .get("columns")
                .or_else(|| req.params.get("cols"))
                .and_then(|val| val.as_u64())
                .map(|val| val as u16);
            let rows = req
                .params
                .get("rows")
                .and_then(|val| val.as_u64())
                .map(|val| val as u16);
            let viewport = match (cols, rows) {
                (Some(cols_val), Some(rows_val)) if cols_val > 0 && rows_val > 0 => Some((cols_val, rows_val)),
                _ => None,
            };

            match state
                .cmux_bridge
                .terminal_replay(surface, max_scrollback, viewport)
                .await
            {
                Ok(replay) => JsonRpcResponse::result_value(req.id.clone(), replay),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_INPUT => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let text = req.params.get("text").and_then(|val| val.as_str());
            let key = req.params.get("key").and_then(|val| val.as_str());
            let res = if let Some(raw_text) = text {
                state.cmux_bridge.terminal_input(surface, raw_text).await.map(|_| ())
            } else if let Some(key_name) = key {
                state.cmux_bridge.send_key(Some(surface), key_name).await
            } else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Either 'text' or 'key' must be provided"),
                );
            };
            match res {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "delivered", "surface_id": surface }),
                )
                .unwrap(),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_PASTE => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let text = req.params.get("text").and_then(|val| val.as_str()).unwrap_or("");
            match state.cmux_bridge.terminal_paste(surface, text).await {
                Ok(res) => JsonRpcResponse::result_value(req.id.clone(), res),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_SCROLL => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    );
                }
            };
            let delta_lines = req
                .params
                .get("delta_lines")
                .and_then(|val| val.as_i64())
                .unwrap_or(0) as i32;
            let col = req.params.get("col").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
            let row = req.params.get("row").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
            match state
                .cmux_bridge
                .terminal_scroll(surface, delta_lines, col, row)
                .await
            {
                Ok(res) => JsonRpcResponse::result_value(req.id.clone(), res),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_READ => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str());
            let lines = req.params.get("lines").and_then(|v| v.as_u64()).unwrap_or(80).min(5000) as usize;
            let scrollback = req.params.get("scrollback").and_then(|v| v.as_bool()).unwrap_or(true);

            match state.cmux_bridge.capture_pane(surface, lines, scrollback).await {
                Ok(text) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({
                        "surface_id": surface.unwrap_or_default(),
                        "text": text,
                        "screen": text,
                        "lines": lines,
                        "updated_at": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64
                    }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_SEND => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str());
            let text = req.params.get("text").and_then(|v| v.as_str());
            let key = req.params.get("key").and_then(|v| v.as_str());

            let res = if let Some(k) = key {
                state.cmux_bridge.send_key(surface, k).await
            } else if let Some(t) = text {
                state.cmux_bridge.send_text(surface, t).await
            } else {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Either 'text' or 'key' must be provided"),
                );
            };

            match res {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "delivered", "surface_id": surface.unwrap_or_default() }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        unknown => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::method_not_found(unknown),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    async fn next_event(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
        let raw = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("event within 5s")
            .expect("channel open");
        serde_json::from_str(&raw).expect("json frame")
    }

    /// Subscription pushes an initial snapshot, then a new frame only when the transcript changes.
    #[tokio::test]
    async fn chat_watcher_pushes_on_transcript_change() {
        let dir = std::env::temp_dir().join(format!("cmux-sub-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n").unwrap();
        let hook = serde_json::json!({
            "sessions": { "s1": {
                "sessionId": "s1", "surfaceId": "surf-watch", "workspaceId": "ws",
                "transcriptPath": transcript.to_string_lossy(), "updatedAt": 1.0
            }},
            "activeSessionsBySurface": {}
        });
        std::fs::write(dir.join("claude-hook-sessions.json"), hook.to_string()).unwrap();
        // SAFETY: only this test in the crate reads CMUX_HOOK_SESSIONS_DIR through the watcher.
        unsafe { std::env::set_var("CMUX_HOOK_SESSIONS_DIR", &dir) };

        let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        let (tx, mut rx) = mpsc::channel(8);
        let handle = tokio::spawn(chat_watcher(
            state, tx, "surf-watch".into(), String::new(), "claude".into(), 20,
        ));

        let first = next_event(&mut rx).await;
        assert_eq!(first["event"], EVENT_CHAT_UPDATE);
        assert_eq!(first["data"]["surface_id"], "surf-watch");
        assert_eq!(first["data"]["turns"].as_array().unwrap().len(), 1);

        // Unchanged transcript => no duplicate frame
        assert!(timeout(Duration::from_millis(1300), rx.recv()).await.is_err());

        let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
        writeln!(f, "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"hi\"}}]}}}}").unwrap();
        drop(f);

        let second = next_event(&mut rx).await;
        assert_eq!(second["data"]["turns"].as_array().unwrap().len(), 2);

        handle.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn http(router: &mut Router, method: &str, uri: &str, body: &str) -> (u16, serde_json::Value) {
        http_with(router, method, uri, body, &[]).await
    }

    async fn http_with(
        router: &mut Router,
        method: &str,
        uri: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> (u16, serde_json::Value) {
        use tower::Service;
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let req = builder.body(axum::body::Body::from(body.to_string())).unwrap();
        let resp = router.call(req).await.unwrap();
        let status = resp.status().as_u16();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    /// /api/pairing hands out a ticket (never the gateway token); the ticket is single-use and
    /// yields a device token the WebSocket auth accepts.
    #[tokio::test]
    async fn pairing_ticket_exchange_flow() {
        let devices = std::env::temp_dir().join(format!("devs-{}.json", uuid::Uuid::new_v4()));
        let mut state = AppState::new("127.0.0.1".into(), 8088, "master-secret".into());
        state.devices = DeviceRegistry::new(Some(devices.clone()));
        let mut router = create_router(state.clone());

        // No credentials, wrong credentials and a device token must not mint an offer.
        let (st, _) = http(&mut router, "GET", "/api/pairing", "").await;
        assert_eq!(st, 401, "anonymous callers must not mint tickets");
        let (st, _) = http_with(&mut router, "GET", "/api/pairing", "", &[("authorization", "Bearer wrong")]).await;
        assert_eq!(st, 401);

        let (st, body) =
            http_with(&mut router, "GET", "/api/pairing", "", &[("authorization", "Bearer master-secret")]).await;
        assert_eq!(st, 200);
        let offer = &body["offer"];
        assert_eq!(offer["token"], "", "offer must not leak the gateway token");
        assert!(!body.to_string().contains("master-secret"));
        assert_eq!(offer["endpoint"], "ws://127.0.0.1:8088/ws");
        let ticket = offer["ticket"].as_str().unwrap().to_string();

        let req = serde_json::json!({ "ticket": ticket }).to_string();
        let (st, body) = http(&mut router, "POST", "/api/pair/exchange", &req).await;
        assert_eq!(st, 200);
        let device = body["token"].as_str().unwrap().to_string();
        assert!(state.token_valid(&device));
        assert!(state.token_valid("master-secret"));
        assert!(!state.token_valid("garbage"));

        let (st, _) = http(&mut router, "POST", "/api/pair/exchange", &req).await;
        assert_eq!(st, 401, "replayed ticket must be rejected");

        let _ = std::fs::remove_file(devices);
    }

    #[test]
    fn terminal_replay_fingerprint_tracks_mode_dims_and_cursor() {
        let base = serde_json::json!({
            "size_state": { "cols": 45, "rows": 24 },
            "render_grid": {
                "render_epoch": "ep-1",
                "render_revision": 10,
                "row_space_revision": 4,
                "state_seq": 77,
                "columns": 45,
                "rows": 24,
                "active_screen": "primary",
                "scrollback_rows": 12,
                "cursor": { "row": 3, "column": 5, "visible": true }
            }
        });
        let fp_mobile = terminal_replay_fingerprint(&base, "mobile");
        let fp_desktop = terminal_replay_fingerprint(&base, "desktop");
        assert_ne!(fp_mobile, fp_desktop);

        let mut moved_cursor = base.clone();
        moved_cursor["render_grid"]["cursor"]["column"] = serde_json::json!(6);
        assert_ne!(
            fp_mobile,
            terminal_replay_fingerprint(&moved_cursor, "mobile")
        );
    }

    #[tokio::test]
    async fn surface_rename_and_viewport_validate_params() {
        let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        let missing_title: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "1",
            "method": METHOD_SURFACE_RENAME,
            "params": { "surface_id": "surf-1", "title": "   " }
        })).unwrap();
        let resp = dispatch_rpc(&missing_title, &state).await;
        assert_eq!(resp.error.unwrap().code, -32602);

        let term_subs = HashMap::new();
        let bad_mobile_vp: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "2",
            "method": METHOD_TERMINAL_VIEWPORT,
            "params": { "surface_id": "surf-1", "mode": "mobile", "columns": 0, "rows": 24 }
        })).unwrap();
        let vp_resp = handle_terminal_viewport(&bad_mobile_vp, &state, &term_subs).await;
        assert_eq!(vp_resp.error.unwrap().code, -32602);
    }

    #[test]
    fn host_allowlist_blocks_rebinding_names() {
        assert!(host_allowed("127.0.0.1:8088"));
        assert!(host_allowed("localhost:8088"));
        assert!(host_allowed("[::1]:8088"));
        assert!(host_allowed("100.101.102.103"));
        assert!(host_allowed("mac.tail1234.ts.net"));
        assert!(!host_allowed("evil.test"));
        assert!(!host_allowed("evil.test:8088"));
        assert!(!host_allowed("localhost.evil.test"));
    }

    #[test]
    fn origin_allowlist_permits_github_pages_and_tailscale_cross_origin() {
        assert!(origin_allowed("https://chavisnguyen.github.io", Some("mac.tail1234.ts.net")));
        assert!(origin_allowed("https://chavisnguyen.github.io", Some("127.0.0.1:8088")));
        assert!(!origin_allowed("https://attacker.github.io", None));
        assert!(origin_allowed("http://localhost:5173", Some("mac.tail1234.ts.net:8088")));
        assert!(origin_allowed("http://127.0.0.1:5173", Some("mac.tail1234.ts.net:8088")));
        assert!(origin_allowed("https://node1.tail1234.ts.net", Some("node2.tail1234.ts.net:8088")));
        assert!(origin_allowed("http://my-host.test:8088", Some("my-host.test:8088")));
        assert!(!origin_allowed("https://evil.test", Some("127.0.0.1:8088")));
        assert!(!origin_allowed("https://evil-github.io.phish.com", Some("127.0.0.1:8088")));
        assert!(!origin_allowed("", Some("127.0.0.1:8088")));
    }

    #[tokio::test]
    async fn guard_rejects_bad_host_and_cross_origin() {
        let mut state = AppState::new("127.0.0.1".into(), 8088, "master-secret".into());
        state.devices = DeviceRegistry::new(None);
        let mut router = create_router(state);
        let auth = ("authorization", "Bearer master-secret");
        let (st, _) = http_with(&mut router, "GET", "/api/pairing", "", &[auth, ("host", "evil.test")]).await;
        assert_eq!(st, 403, "rebinding host rejected");
        let (st, _) = http_with(
            &mut router, "GET", "/api/pairing", "",
            &[auth, ("host", "127.0.0.1:8088"), ("origin", "https://evil.test")],
        ).await;
        assert_eq!(st, 403, "cross-origin rejected");
        let (st, _) = http_with(
            &mut router, "GET", "/api/pairing", "",
            &[auth, ("host", "127.0.0.1:8088"), ("origin", "http://127.0.0.1:8088")],
        ).await;
        assert_eq!(st, 200, "same-origin allowed");
        let (st, _) = http_with(
            &mut router, "GET", "/api/pairing", "",
            &[auth, ("host", "127.0.0.1:8088"), ("origin", "https://chavisnguyen.github.io")],
        ).await;
        assert_eq!(st, 200, "github pages origin allowed");
    }

    #[tokio::test]
    async fn push_register_rejects_unlisted_endpoint() {
        let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        let req: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "1",
            "method": METHOD_PUSH_REGISTER,
            "params": { "endpoint": "https://evil.example/x", "keys": { "p256dh": "a", "auth": "b" } }
        })).unwrap();
        let resp = dispatch_rpc(&req, &state).await;
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn device_list_and_revoke_rpc() {
        let mut state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        state.devices = DeviceRegistry::new(None);
        let ticket = state.devices.issue_ticket();
        let token = state.devices.redeem_labeled(&ticket, "Test phone").unwrap();
        assert!(state.token_valid(&token));

        let list: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "1", "method": METHOD_DEVICE_LIST, "params": {}
        })).unwrap();
        let resp = dispatch_rpc(&list, &state).await;
        let body = serde_json::to_string(&resp).unwrap();
        assert!(body.contains("Test phone"));
        assert!(!body.contains(&token), "list must not leak tokens");
        let id = resp.result.as_ref().unwrap()["devices"][0]["id"].as_str().unwrap().to_string();

        let revoke: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "2", "method": METHOD_DEVICE_REVOKE, "params": { "device_id": id }
        })).unwrap();
        let resp = dispatch_rpc(&revoke, &state).await;
        assert_eq!(resp.result.unwrap()["revoked"], true);
        assert!(!state.token_valid(&token), "revoked token no longer authenticates");
        assert!(state.token_valid("tok"), "gateway token unaffected");
    }

    #[tokio::test]
    async fn push_preferences_read_and_write() {
        let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        let ep = "https://fcm.googleapis.com/fcm/send/xyz";
        state.push_service.register(PushSubscription {
            endpoint: ep.into(),
            keys: crate::push::PushSubscriptionKeys { p256dh: "p".into(), auth: "a".into() },
            device_id: None,
            muted_categories: vec![],
        });
        let write: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "1", "method": METHOD_PUSH_PREFERENCES,
            "params": { "endpoint": ep, "muted_categories": ["turn-finished", "nonsense"] }
        })).unwrap();
        let resp = dispatch_rpc(&write, &state).await;
        assert_eq!(resp.result.unwrap()["muted_categories"], serde_json::json!(["turn-finished"]));

        let read: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "2", "method": METHOD_PUSH_PREFERENCES, "params": { "endpoint": ep }
        })).unwrap();
        let resp = dispatch_rpc(&read, &state).await;
        assert_eq!(resp.result.unwrap()["muted_categories"], serde_json::json!(["turn-finished"]));

        let unknown: JsonRpcRequest = serde_json::from_value(serde_json::json!({
            "id": "3", "method": METHOD_PUSH_PREFERENCES, "params": { "endpoint": "https://x/none" }
        })).unwrap();
        assert!(dispatch_rpc(&unknown, &state).await.error.is_some());
    }

    #[tokio::test]
    async fn agent_options_and_set_option_validate_input() {
        let state = AppState::new("127.0.0.1".into(), 0, "tok".into());
        let ask = |m: &str, p: serde_json::Value| {
            serde_json::from_value::<JsonRpcRequest>(serde_json::json!({ "id": "1", "method": m, "params": p })).unwrap()
        };
        let r = dispatch_rpc(&ask(METHOD_AGENT_OPTIONS, serde_json::json!({ "agent_kind": "claude" })), &state).await;
        assert_eq!(r.result.unwrap()["models"][1]["id"], "opus");
        let r = dispatch_rpc(&ask(METHOD_AGENT_OPTIONS, serde_json::json!({ "agent_kind": "kiro" })), &state).await;
        assert!(r.error.is_some());
        // bad values never reach cmux
        for bad in [
            serde_json::json!({ "surface_id": "s", "agent_kind": "claude", "option": "model", "value": "opus\n/exit" }),
            serde_json::json!({ "surface_id": "s", "agent_kind": "claude", "option": "effort", "value": "ultra" }),
            serde_json::json!({ "surface_id": "s", "agent_kind": "kiro", "option": "model", "value": "x" }),
            serde_json::json!({ "agent_kind": "claude", "option": "model", "value": "opus" }),
        ] {
            let r = dispatch_rpc(&ask(METHOD_CHAT_SET_OPTION, bad), &state).await;
            assert_eq!(r.error.unwrap().code, -32602);
        }
        // launch options are validated and need a plain agent command
        for bad in [
            serde_json::json!({ "command": "claude", "launch": { "agent_kind": "claude", "model": "--x" } }),
            serde_json::json!({ "command": "bash -c evil", "launch": { "agent_kind": "claude", "model": "opus" } }),
            serde_json::json!({ "command": "claude", "launch": { "model": "opus" } }),
        ] {
            let r = dispatch_rpc(&ask(METHOD_SURFACE_NEW, bad), &state).await;
            assert_eq!(r.error.unwrap().code, -32602);
        }
    }

    #[test]
    fn client_registry_unregisters_when_guard_drops() {
        let reg = ClientRegistry::default();
        let info = |id: &str, at: u64| ClientInfo {
            session_id: id.into(),
            device_id: Some(format!("dev-{id}")),
            label: "gateway token".into(),
            user_agent: String::new(),
            connected_at: at,
            viewing_surface: None,
            client_visible: false,
        };
        let a = reg.register(info("a", 2));
        let b = reg.register(info("b", 1));
        let ids: Vec<String> = reg.list().into_iter().map(|c| c.session_id).collect();
        assert_eq!(ids, ["b", "a"], "oldest connection first");
        reg.set_viewing("a", Some("surf-1".into()), true);
        assert!(reg.is_session_viewing("a", "surf-1"));
        assert!(!reg.is_session_viewing("a", "surf-2"));
        assert_eq!(reg.devices_viewing_surface("surf-1"), std::collections::HashSet::from(["dev-a".to_string()]));
        reg.set_viewing("a", Some("surf-1".into()), false);
        assert!(!reg.is_session_viewing("a", "surf-1"));
        assert!(reg.devices_viewing_surface("surf-1").is_empty());
        drop(a);
        assert_eq!(reg.list().len(), 1);
        drop(b);
        assert!(reg.list().is_empty());
    }

    #[test]
    fn derive_awaiting_prompt_prefers_rich_body_or_tool_name() {
        let base = ResolvedSession {
            session_id: "s1".into(),
            surface_id: "surf-1".into(),
            agent_kind: "codex".into(),
            transcript_path: None,
            lifecycle: AgentLifecycleState::Waiting,
            last_event: Some("PermissionRequest".into()),
            last_subtitle: Some("Permission".into()),
            last_body: Some("Approval needed".into()),
            tool_name: Some("Bash".into()),
            from_tree: false,
        };
        assert_eq!(derive_awaiting_prompt(&base, &[], None).as_deref(), Some("Approve tool: Bash"));

        let rich = ResolvedSession {
            last_body: Some("Run npm test in workspace".into()),
            ..base.clone()
        };
        assert_eq!(
            derive_awaiting_prompt(&rich, &[], None).as_deref(),
            Some("Run npm test in workspace")
        );

        let pending_turns = vec![AgentTurn {
            id: "t1".into(),
            surface_id: "surf-1".into(),
            role: crate::protocol::event::AgentRole::Assistant,
            timestamp: None,
            events: vec![AgentEvent::ToolStart {
                tool_id: "c1".into(),
                name: "exec_command".into(),
                detail: Some(r#"{"cmd":"npm test","justification":"Run tests"}"#.into()),
            }],
        }];
        assert_eq!(
            derive_awaiting_prompt(&base, &pending_turns, None).as_deref(),
            Some("exec_command: Run tests\nnpm test")
        );
        assert_eq!(
            derive_awaiting_prompt(
                &base,
                &pending_turns,
                Some("Would you like to run the following command?\n$ touch made.txt"),
            )
            .as_deref(),
            Some("Would you like to run the following command?\n$ touch made.txt")
        );

        let generic_no_tool = ResolvedSession {
            tool_name: None,
            ..base.clone()
        };
        assert_eq!(
            derive_awaiting_prompt(&generic_no_tool, &[], None).as_deref(),
            Some("Approval needed")
        );

        let idle = ResolvedSession {
            lifecycle: AgentLifecycleState::Idle,
            ..base
        };
        assert_eq!(derive_awaiting_prompt(&idle, &[], None), None);
    }

    #[test]
    fn extract_approval_screen_context_parses_codex_and_claude_prompts() {
        let codex_screen = "\
• Checking status
────────────────────────────────────
Would you like to run the following command?

  Reason: Check git status
  $ git status -sb

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `git status` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel";
        assert_eq!(
            extract_approval_screen_context(codex_screen).as_deref(),
            Some("Would you like to run the following command?\nReason: Check git status\n$ git status -sb")
        );

        let normal_screen = "• Done\n› Ask Codex to do anything";
        assert_eq!(extract_approval_screen_context(normal_screen), None);
    }
}
