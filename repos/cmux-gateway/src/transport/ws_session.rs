//! WebSocket first-frame authentication handshake and non-blocking RPC/push multiplexer.

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{error, info, warn};

use crate::domain::workspace_model::{SurfaceNode, WorkspaceNode};
use crate::protocol::{
    AuthBootstrapRequest, AuthError, AuthOk, AuthRequest, JsonRpcError, JsonRpcRequest,
    JsonRpcResponse, EVENT_WORKSPACE_BOOTSTRAP, METHOD_CHAT_SUBSCRIBE, METHOD_CHAT_UNSUBSCRIBE,
    METHOD_CLIENT_VIEWING, METHOD_PUSH_PREFERENCES, METHOD_PUSH_REGISTER, METHOD_TERMINAL_INPUT,
    METHOD_TERMINAL_PASTE, METHOD_TERMINAL_SCROLL, METHOD_TERMINAL_SEND, METHOD_TERMINAL_SUBSCRIBE,
    METHOD_TERMINAL_UNSUBSCRIBE, METHOD_TERMINAL_VIEWPORT, WS_CLOSE_AUTH_FAILED,
};
use crate::server::AppState;
use crate::services::chat_stream::{chat_watcher_stream, handle_subscription, MAX_SUBSCRIPTIONS};
use crate::services::notification_dispatcher::NotificationBroadcast;
use crate::services::session_state::SessionStateService;
use crate::services::terminal_stream::{
    apply_terminal_viewport, handle_terminal_subscription, trigger_terminal_wakeup,
    TerminalSubscriptionHandle,
};
use crate::services::workspace_service::WorkspaceService;
pub use crate::transport::client_registry::{ClientInfo, ClientRegistry};
use crate::transport::rpc::dispatch_rpc;

pub const MAX_WS_CONNECTIONS: usize = 32;
pub const MAX_WS_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

pub async fn ws_handler(
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
    let Ok(permit) = state.conn_limit.clone().try_acquire_owned() else {
        warn!("Rejected WebSocket: connection limit reached");
        return (StatusCode::SERVICE_UNAVAILABLE, "too many connections").into_response();
    };
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            handle_socket(socket, state, user_agent).await;
        })
}

async fn send_auth_close(socket: &mut WebSocket, err: Option<AuthError>, reason: &'static str) {
    if let Some(e) = err {
        let _ = socket
            .send(Message::Text(serde_json::to_string(&e).unwrap().into()))
            .await;
    }
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: WS_CLOSE_AUTH_FAILED,
            reason: reason.into(),
        })))
        .await;
}

async fn send_revoked_close(socket: &mut WebSocket, session_id: &str) {
    warn!("Session {} closed: token revoked or expired", session_id);
    send_auth_close(socket, None, "Token revoked").await;
}

async fn handle_socket(mut socket: WebSocket, state: AppState, user_agent: String) {
    let session_id = uuid::Uuid::new_v4().to_string();
    info!("New WebSocket connection: session {}", session_id);

    let auth_text = match timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => return Ok(text),
                // Reverse proxies (e.g. Tailscale Funnel) and mobile Safari may send WebSocket
                // Ping/Pong control frames immediately after Upgrade before the client's `auth`
                // text frame arrives; answer Ping and continue waiting for the first Text frame.
                Some(Ok(Message::Ping(payload))) => {
                    let _ = socket.send(Message::Pong(payload)).await;
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => return Err("closed"),
                Some(Ok(_)) => return Err("non_text"),
                Some(Err(_)) => return Err("io_error"),
            }
        }
    })
    .await
    {
        Ok(Ok(text)) => text,
        Ok(Err("non_text")) => {
            warn!("Session {} rejected: non-text first frame", session_id);
            send_auth_close(&mut socket, Some(AuthError::unauthenticated()), "Unauthenticated").await;
            return;
        }
        _ => {
            warn!("Session {} handshake timed out or closed", session_id);
            send_auth_close(&mut socket, None, "Handshake timeout").await;
            return;
        }
    };

    let (session_token, bootstrap_req) = match serde_json::from_str::<AuthRequest>(&auth_text) {
        Ok(req) if req.r#type == "auth" && state.token_valid(&req.token) => {
            let ok_json = serde_json::to_string(&AuthOk::new(&session_id)).unwrap();
            if socket.send(Message::Text(ok_json.into())).await.is_err() {
                return;
            }
            info!("Session {} authenticated successfully", session_id);
            (req.token, req.bootstrap)
        }
        Ok(_) => {
            warn!("Session {} rejected: invalid token", session_id);
            send_auth_close(&mut socket, Some(AuthError::invalid_token()), "Invalid token").await;
            return;
        }
        Err(_) => {
            warn!("Session {} rejected: invalid auth frame format", session_id);
            send_auth_close(&mut socket, Some(AuthError::unauthenticated()), "Unauthenticated").await;
            return;
        }
    };

    let cached_device_id = state.devices.device_id_for_token(&session_token);
    let label = cached_device_id
        .as_ref()
        .and_then(|id| state.devices.list().into_iter().find(|d| &d.id == id))
        .map(|d| d.label)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| if cached_device_id.is_some() { "device".into() } else { "gateway token".into() });
    let _client_guard = state.clients.register(ClientInfo {
        session_id: session_id.clone(),
        device_id: cached_device_id.clone(),
        label,
        user_agent,
        connected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        viewing_surface: None,
        client_visible: false,
    });

    let (out_tx, mut out_rx) = mpsc::channel::<String>(128);
    let rpc_sem = Arc::new(Semaphore::new(16));
    let mut notif_rx = state.notif_tx.subscribe();
    let mut subs: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut term_subs: HashMap<String, TerminalSubscriptionHandle> = HashMap::new();
    let mut token_recheck = tokio::time::interval(Duration::from_secs(15));

    if let Some(boot) = bootstrap_req.filter(|b| b.workspace_tree)
        && !push_auth_bootstrap(&mut socket, &state, &out_tx, &mut subs, &boot).await
    {
        for (_, handle) in subs.drain() {
            handle.abort();
        }
        return;
    }

    loop {
        tokio::select! {
            _ = token_recheck.tick() => {
                if !state.token_valid(&session_token) {
                    send_revoked_close(&mut socket, &session_id).await;
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(Ok(msg)) = incoming else { break };
                if !state.token_valid(&session_token) {
                    send_revoked_close(&mut socket, &session_id).await;
                    break;
                }
                match msg {
                    Message::Text(text) => match serde_json::from_str::<JsonRpcRequest>(&text) {
                        Ok(rpc_req) => {
                            let inline_response = match rpc_req.method.as_str() {
                                METHOD_CHAT_SUBSCRIBE | METHOD_CHAT_UNSUBSCRIBE => {
                                    Some(handle_subscription(&rpc_req, &state, &out_tx, &mut subs))
                                }
                                METHOD_TERMINAL_SUBSCRIBE | METHOD_TERMINAL_UNSUBSCRIBE => {
                                    Some(handle_terminal_subscription(&session_id, &rpc_req, &state, &out_tx, &mut term_subs).await)
                                }
                                METHOD_TERMINAL_VIEWPORT => {
                                    let sub_ctx = rpc_req
                                        .params
                                        .get("surface_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|sid| term_subs.get(sid))
                                        .map(|s| (s.config.clone(), s.notify.clone()));
                                    let (state_cl, out_tx_cl, sem_cl, sess_cl) =
                                        (state.clone(), out_tx.clone(), rpc_sem.clone(), session_id.clone());
                                    tokio::spawn(async move {
                                        let Ok(_permit) = sem_cl.acquire_owned().await else { return };
                                        let resp = apply_terminal_viewport(&sess_cl, &rpc_req, &state_cl, sub_ctx).await;
                                        if let Ok(json) = serde_json::to_string(&resp) {
                                            let _ = out_tx_cl.send(json).await;
                                        }
                                    });
                                    None
                                }
                                METHOD_CLIENT_VIEWING => handle_client_viewing(
                                    &rpc_req, &state, &session_id, &out_tx, &rpc_sem,
                                ),
                                _ => {
                                    spawn_rpc_task(
                                        rpc_req, &state, &cached_device_id, &term_subs, &out_tx, &rpc_sem,
                                    );
                                    None
                                }
                            };
                            if let Some(resp) = inline_response {
                                let json = serde_json::to_string(&resp).unwrap();
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            let err = JsonRpcResponse::error(None, JsonRpcError::parse_error());
                            let _ = socket.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                            error!("Failed to parse JSON-RPC request: {e}");
                        }
                    },
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
                    send_revoked_close(&mut socket, &session_id).await;
                    break;
                }
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            recv_res = notif_rx.recv() => {
                if !state.token_valid(&session_token) {
                    send_revoked_close(&mut socket, &session_id).await;
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

fn handle_client_viewing(
    rpc_req: &JsonRpcRequest,
    state: &AppState,
    session_id: &str,
    out_tx: &mpsc::Sender<String>,
    rpc_sem: &Arc<Semaphore>,
) -> Option<JsonRpcResponse> {
    let raw_surface = rpc_req
        .params
        .get("surface_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let visible = rpc_req.params.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);

    match raw_surface {
        Some(raw)
            if raw.starts_with("surface:")
                && WorkspaceService::resolve_cached_surface_ref(state, &raw).is_none() =>
        {
            let (state_cl, out_tx_cl, sem_cl, sess_cl, req_id) = (
                state.clone(),
                out_tx.clone(),
                rpc_sem.clone(),
                session_id.to_string(),
                rpc_req.id.clone(),
            );
            tokio::spawn(async move {
                let Ok(_permit) = sem_cl.acquire_owned().await else { return };
                let canonical = SessionStateService::canonicalize_surface_id(&state_cl, &raw).await;
                state_cl.clients.set_viewing(&sess_cl, Some(canonical.clone()), visible);
                if visible {
                    WorkspaceService::mark_surface_notifications_read(&state_cl, &canonical).await;
                }
                let resp = JsonRpcResponse::result(
                    req_id,
                    serde_json::json!({ "ok": true, "surface_id": canonical, "visible": visible }),
                )
                .unwrap();
                if let Ok(json) = serde_json::to_string(&resp) {
                    let _ = out_tx_cl.send(json).await;
                }
            });
            None
        }
        other => {
            let canonical = other.map(|raw| {
                WorkspaceService::resolve_cached_surface_ref(state, &raw).unwrap_or(raw)
            });
            if visible && let Some(ref cid) = canonical {
                let state_cl = state.clone();
                let cid_owned = cid.clone();
                tokio::spawn(async move {
                    WorkspaceService::mark_surface_notifications_read(&state_cl, &cid_owned).await;
                });
            }
            state.clients.set_viewing(session_id, canonical.clone(), visible);
            Some(
                JsonRpcResponse::result(
                    rpc_req.id.clone(),
                    serde_json::json!({ "ok": true, "surface_id": canonical, "visible": visible }),
                )
                .unwrap(),
            )
        }
    }
}

fn spawn_rpc_task(
    mut rpc_req: JsonRpcRequest,
    state: &AppState,
    cached_device_id: &Option<String>,
    term_subs: &HashMap<String, TerminalSubscriptionHandle>,
    out_tx: &mpsc::Sender<String>,
    rpc_sem: &Arc<Semaphore>,
) {
    if rpc_req.method == METHOD_PUSH_REGISTER
        && let Some(obj) = rpc_req.params.as_object_mut()
    {
        obj.remove("device_id");
        obj.remove("muted_categories");
        if let Some(id) = cached_device_id.clone() {
            obj.insert("device_id".into(), serde_json::Value::String(id));
        }
    }
    if rpc_req.method == METHOD_PUSH_PREFERENCES
        && let Some(obj) = rpc_req.params.as_object_mut()
    {
        obj.remove("device_id");
        if let Some(id) = cached_device_id.clone() {
            obj.insert("device_id".into(), serde_json::Value::String(id));
        }
    }
    let wakeup = matches!(
        rpc_req.method.as_str(),
        METHOD_TERMINAL_INPUT | METHOD_TERMINAL_PASTE | METHOD_TERMINAL_SCROLL | METHOD_TERMINAL_SEND
    )
    .then(|| {
        rpc_req
            .params
            .get("surface_id")
            .and_then(|v| v.as_str())
            .and_then(|sid| term_subs.get(sid))
            .map(|s| (s.notify.clone(), s.delayed_wakeup.clone()))
    })
    .flatten();
    let (state_cl, out_tx_cl, sem_cl) = (state.clone(), out_tx.clone(), rpc_sem.clone());
    tokio::spawn(async move {
        let Ok(_permit) = sem_cl.acquire_owned().await else { return };
        let resp = dispatch_rpc(&rpc_req, &state_cl).await;
        if let Some((notify, delayed_pending)) = wakeup {
            trigger_terminal_wakeup(&notify, &delayed_pending);
        }
        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = out_tx_cl.send(json).await;
        }
    });
}

fn pick_bootstrap_surface<'a>(
    workspaces: &'a [WorkspaceNode],
    boot: &AuthBootstrapRequest,
) -> Option<&'a SurfaceNode> {
    if let Some(target) = boot.surface_id.as_deref().filter(|s| !s.is_empty()) {
        for ws in workspaces {
            if let Some(surf) = ws
                .surfaces
                .iter()
                .find(|s| s.id == target || s.r#ref == target)
            {
                return Some(surf);
            }
        }
    }
    if boot.is_desktop == Some(true) {
        let ws = workspaces
            .iter()
            .find(|w| w.selected)
            .or_else(|| workspaces.first())?;
        return ws
            .surfaces
            .iter()
            .find(|s| s.selected)
            .or_else(|| ws.surfaces.first());
    }
    None
}

async fn push_auth_bootstrap(
    socket: &mut WebSocket,
    state: &AppState,
    out_tx: &mpsc::Sender<String>,
    subs: &mut HashMap<String, JoinHandle<()>>,
    boot: &AuthBootstrapRequest,
) -> bool {
    let built = timeout(
        Duration::from_millis(1500),
        WorkspaceService::build_tree(state),
    )
    .await;

    let Ok(Ok(workspaces)) = built else {
        // Notify client immediately so it falls back to `mobile.workspace.tree` without waiting 1.5s.
        let err_frame = JsonRpcResponse::event_value(
            EVENT_WORKSPACE_BOOTSTRAP,
            serde_json::json!({ "workspaces": serde_json::Value::Null }),
        );
        if let Ok(text) = serde_json::to_string(&err_frame) {
            return socket.send(Message::Text(text.into())).await.is_ok();
        }
        return true;
    };

    let mut subscribed_surface_id: Option<String> = None;
    if subs.len() < MAX_SUBSCRIPTIONS
        && let Some(surf) = pick_bootstrap_surface(&workspaces, boot)
        && let Some(agent) = surf.agent.as_ref()
    {
        let canonical_key = if !surf.id.is_empty() {
            surf.id.clone()
        } else {
            surf.r#ref.clone()
        };
        if !canonical_key.is_empty() {
            let max_turns = boot.max_turns.unwrap_or(15).clamp(1, 500);
            let delta_mode = boot.delta.unwrap_or(true);
            let handle = tokio::spawn(chat_watcher_stream(
                state.clone(),
                out_tx.clone(),
                canonical_key.clone(),
                agent.session_id.clone(),
                agent.agent_kind.clone(),
                max_turns,
                delta_mode,
            ));
            subs.insert(canonical_key.clone(), handle);
            subscribed_surface_id = Some(canonical_key);
        }
    }

    let frame = JsonRpcResponse::event_value(
        EVENT_WORKSPACE_BOOTSTRAP,
        serde_json::json!({
            "workspaces": workspaces,
            "subscribed_surface_id": subscribed_surface_id,
        }),
    );
    if let Ok(text) = serde_json::to_string(&frame) {
        return socket.send(Message::Text(text.into())).await.is_ok();
    }
    true
}
