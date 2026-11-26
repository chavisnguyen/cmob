//! Core chat session & turn control JSON-RPC handlers (`send`, `approve`, `interrupt`, `sessions`, `readSession`).

use crate::domain::dialog::extract_approval_screen_context;
use crate::protocol::event::AgentLifecycleState;
use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_CHAT_APPROVE, METHOD_CHAT_INTERRUPT,
    METHOD_CHAT_READ_SESSION, METHOD_CHAT_SEND, METHOD_CHAT_SESSIONS,
};
use crate::scanner::hook_store::HookStoreIndex;
use crate::server::AppState;
use crate::services::agent_control::interrupt_surface;
use crate::services::session_state::SessionStateService;

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_CHAT_SEND => handle_send(req, state).await,
        METHOD_CHAT_APPROVE => handle_approve(req, state).await,
        METHOD_CHAT_INTERRUPT => handle_interrupt(req, state).await,
        METHOD_CHAT_SESSIONS => handle_sessions(req).await,
        METHOD_CHAT_READ_SESSION => handle_read_session(req, state).await,
        _ => return None,
    };
    Some(resp)
}

async fn handle_send(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let text = req.params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let surface = req.params.get("surface_id").and_then(|v| v.as_str());
    let agent_kind = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("");
    let enter = req.params.get("enter").and_then(|v| v.as_bool()).unwrap_or(true);

    match state
        .cmux_bridge
        .submit_prompt(surface, text, agent_kind, enter)
        .await
    {
        Ok(_) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": "delivered" }))
                .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_approve(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
    let Some(agent_kind) = req
        .params
        .get("agent_kind")
        .and_then(|v| v.as_str())
        .filter(|k| !k.is_empty())
    else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Missing agent_kind parameter"),
        );
    };

    match state.cmux_bridge.approve(surface, agent_kind).await {
        Ok(_) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": "approved" }))
                .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_interrupt(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
    let explicit_kind = req.params.get("agent_kind").and_then(|v| v.as_str());

    match interrupt_surface(state, surface, explicit_kind).await {
        Ok(_) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": "interrupted" }))
                .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_sessions(req: &JsonRpcRequest) -> JsonRpcResponse {
    let hook_index = HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
    let sessions: Vec<_> = hook_index.sessions_by_id.values().cloned().collect();
    JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "sessions": sessions })).unwrap()
}

async fn handle_read_session(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let raw_surface_id = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
    let surface_id = SessionStateService::canonicalize_surface_id(state, raw_surface_id).await;
    let session_id = req.params.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
    let max_turns = req.params.get("max_turns").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize;
    let before_offset = req.params.get("before_offset").and_then(|v| v.as_u64());
    let fallback_agent = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("agent");

    if before_offset.is_some() {
        match SessionStateService::resolve_session_raw(state, &surface_id, session_id).await {
            Some(res) => match tokio::task::spawn_blocking(move || {
                SessionStateService::session_json_with_turns(&res, max_turns, before_offset, None)
                    .map(|(v, _)| v)
            })
            .await
            {
                Ok(Ok(v)) => JsonRpcResponse::result_value(req.id.clone(), v),
                Ok(Err(e)) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(format!("Failed to read transcript: {e}")),
                ),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            },
            None => JsonRpcResponse::result_value(
                req.id.clone(),
                SessionStateService::empty_session_json(&surface_id, fallback_agent),
            ),
        }
    } else {
        match SessionStateService::resolve_session(state, &surface_id, session_id).await {
            Some(res) => {
                let res_surface_id = res.surface_id.clone();
                let res_lifecycle = res.lifecycle;
                let screen_ctx = if res_lifecycle == AgentLifecycleState::Waiting {
                    state
                        .cmux_bridge
                        .capture_pane(Some(&res_surface_id), 35, false)
                        .await
                        .ok()
                        .as_deref()
                        .and_then(extract_approval_screen_context)
                } else {
                    None
                };
                match tokio::task::spawn_blocking(move || {
                    SessionStateService::session_json_with_turns(
                        &res,
                        max_turns,
                        None,
                        screen_ctx.as_deref(),
                    )
                })
                .await
                {
                    Ok(Ok((mut v, page))) => {
                        let needs_dialog_probe = res_lifecycle != AgentLifecycleState::Working
                            && (page.turns.is_empty()
                                || crate::cmux::startup_dialog::registry::is_waiting(&res_surface_id));
                        v["startup_dialog"] = if needs_dialog_probe {
                            SessionStateService::startup_dialog_value(state, &res_surface_id).await
                        } else {
                            serde_json::Value::Null
                        };
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
            None => {
                let mut v = SessionStateService::empty_session_json(&surface_id, fallback_agent);
                v["startup_dialog"] = SessionStateService::startup_dialog_value(state, &surface_id).await;
                JsonRpcResponse::result_value(req.id.clone(), v)
            }
        }
    }
}
