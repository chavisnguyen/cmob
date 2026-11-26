//! Axum HTTP router (`/health`, `/api/pairing`, `/api/pair/exchange`, `/api/clients`, `/api/devices`, `/ws`).

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware,
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

use crate::pairing_store::ct_eq;
use crate::server::AppState;
use crate::services::notification_dispatcher::{spawn_dialog_watcher, spawn_push_dispatcher};
use crate::transport::http_guard::{host_and_origin_guard, origin_allowed};
use crate::transport::ws_session::ws_handler;

pub fn create_router(state: AppState) -> Router {
    spawn_push_dispatcher(state.clone());
    spawn_dialog_watcher(state.clone());

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &axum::http::HeaderValue, parts: &axum::http::request::Parts| {
                if let Ok(s) = origin.to_str() {
                    let host = parts.headers.get(header::HOST).and_then(|v| v.to_str().ok());
                    origin_allowed(s, host)
                } else {
                    false
                }
            },
        ))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
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
    #[serde(default)]
    label: String,
}

async fn pair_exchange_handler(
    State(state): State<AppState>,
    Json(body): Json<ExchangeRequest>,
) -> impl IntoResponse {
    let devices = state.devices.clone();
    let ticket = body.ticket;
    let label = body.label;
    let label_for_log = label.clone();
    let redeemed = tokio::task::spawn_blocking(move || devices.redeem_labeled(&ticket, &label))
        .await
        .ok()
        .flatten();

    match redeemed {
        Some(token) => {
            info!(
                "Paired a new device ({})",
                if label_for_log.is_empty() {
                    "unnamed"
                } else {
                    label_for_log.as_str()
                }
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({ "token": token })),
            )
        }
        None => {
            warn!("Pairing ticket rejected: already used, expired or unknown");
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "invalid_or_expired_ticket" })),
            )
        }
    }
}

fn bearer_of(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
}

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

async fn pairing_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    let offer = state.pairing_offer_with_ticket();
    let uri = offer.to_uri().unwrap_or_default();
    Json(serde_json::json!({
        "offer": offer,
        "uri": uri,
    }))
    .into_response()
}

async fn clients_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    Json(serde_json::json!({ "clients": state.clients.list() })).into_response()
}

async fn devices_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    Json(serde_json::json!({ "devices": state.devices.list() })).into_response()
}

async fn device_revoke_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(denied) = require_master(&state, &headers) {
        return denied;
    }
    let st = state.clone();
    let (revoked, push_removed) = tokio::task::spawn_blocking(move || {
        let rev = st.devices.revoke(&id);
        let removed = if rev {
            st.push_service.unregister_device(&id)
        } else {
            0
        };
        (rev, removed)
    })
    .await
    .unwrap_or((false, 0));

    let status = if revoked {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    (
        status,
        Json(serde_json::json!({
            "revoked": revoked,
            "push_subscriptions_removed": push_removed
        })),
    )
        .into_response()
}
