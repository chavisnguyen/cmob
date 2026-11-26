//! Paired device & Web Push subscription JSON-RPC handlers (`mobile.device.*`, `mobile.push.*`).

use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_DEVICE_LIST, METHOD_DEVICE_REVOKE,
    METHOD_PUSH_HISTORY, METHOD_PUSH_PREFERENCES, METHOD_PUSH_REGISTER, METHOD_PUSH_TEST,
    METHOD_PUSH_VAPID_KEY,
};
use crate::push::PushSubscription;
use crate::server::AppState;

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_DEVICE_LIST => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "devices": state.devices.list() }),
        )
        .unwrap(),
        METHOD_DEVICE_REVOKE => {
            let Some(id) = req
                .params
                .get("device_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string)
            else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing device_id parameter"),
                ));
            };
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

            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "revoked": revoked,
                    "push_subscriptions_removed": push_removed
                }),
            )
            .unwrap()
        }
        METHOD_PUSH_PREFERENCES => {
            let Some(endpoint) = req
                .params
                .get("endpoint")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string)
            else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing endpoint parameter"),
                ));
            };
            if let Some(list) = req.params.get("muted_categories").and_then(|v| v.as_array()) {
                let muted: Vec<String> = list
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect();
                let owner = req
                    .params
                    .get("device_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let push = state.push_service.clone();
                let ep_cl = endpoint.clone();
                let ok = tokio::task::spawn_blocking(move || {
                    push.set_muted_for(&ep_cl, &muted, owner.as_deref())
                })
                .await
                .unwrap_or(false);
                if !ok {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Unknown push subscription"),
                    ));
                }
            }
            let Some(sub) = state
                .push_service
                .list()
                .into_iter()
                .find(|s| s.endpoint == endpoint)
            else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Unknown push subscription"),
                ));
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
        METHOD_PUSH_REGISTER => match serde_json::from_value::<PushSubscription>(req.params.clone())
        {
            Ok(sub) => {
                if let Err(msg) = crate::push::validate_push_endpoint(&sub.endpoint) {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params(msg),
                    ));
                }
                if state.push_service.count() >= crate::push::MAX_SUBSCRIPTIONS {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Too many push subscriptions"),
                    ));
                }
                let push = state.push_service.clone();
                let count = tokio::task::spawn_blocking(move || {
                    push.register(sub);
                    push.count()
                })
                .await
                .unwrap_or_else(|_| state.push_service.count());
                JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({
                        "status": "registered",
                        "subscriptions_count": count
                    }),
                )
                .unwrap()
            }
            Err(e) => JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params(format!("Invalid push subscription payload: {e}")),
            ),
        },
        METHOD_PUSH_VAPID_KEY => match state.push_service.vapid_public_key() {
            Some(key) => {
                JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "public_key": key }))
                    .unwrap()
            }
            None => JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::internal_error(
                    "Web Push is not configured (no VAPID key)".to_string(),
                ),
            ),
        },
        METHOD_PUSH_TEST => {
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
        METHOD_PUSH_HISTORY => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({
                "history": state.push_service.history()
            }),
        )
        .unwrap(),
        _ => return None,
    };
    Some(resp)
}
