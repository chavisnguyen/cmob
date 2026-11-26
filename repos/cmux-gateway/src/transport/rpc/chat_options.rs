//! Interactive dialog/question answering, model/effort options, and conversation fork RPC handlers.

use crate::domain::dialog::QuestionAnswerSelection;
use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_AGENT_OPTIONS, METHOD_CHAT_ANSWER_DIALOG,
    METHOD_CHAT_ANSWER_QUESTION, METHOD_CHAT_FORK, METHOD_CHAT_SET_OPTION,
};
use crate::server::AppState;
use crate::services::workspace_service::WorkspaceService;
use crate::transport::rpc::workspace::workspace_dir;

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_CHAT_ANSWER_DIALOG => handle_answer_dialog(req, state).await,
        METHOD_CHAT_ANSWER_QUESTION => handle_answer_question(req, state).await,
        METHOD_AGENT_OPTIONS => handle_agent_options(req).await,
        METHOD_CHAT_SET_OPTION => handle_set_option(req, state).await,
        METHOD_CHAT_FORK => handle_fork(req, state).await,
        _ => return None,
    };
    Some(resp)
}

async fn handle_answer_dialog(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
    let fingerprint = req.params.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("");
    let choice = req.params.get("choice").and_then(|v| v.as_u64());
    match choice {
        Some(choice) if !surface.is_empty() && !fingerprint.is_empty() => {
            match state
                .cmux_bridge
                .answer_dialog(surface, fingerprint, choice as usize)
                .await
            {
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

async fn handle_answer_question(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = req.params.get("surface_id").and_then(|v| v.as_str()).unwrap_or("");
    if surface.is_empty() {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("surface_id is required"),
        );
    }
    let agent_kind = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("agent");

    if let Some(batch_val) = req.params.get("answers") {
        let Ok(selections) = serde_json::from_value::<Vec<QuestionAnswerSelection>>(batch_val.clone())
        else {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("answers must be an array of question selections"),
            );
        };
        if selections.is_empty()
            || selections.iter().any(|s| {
                s.indices.is_empty() && s.other.as_deref().map(str::trim).unwrap_or("").is_empty()
            })
        {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params(
                    "Each entry in answers requires non-empty indices or other",
                ),
            );
        }
        return match state
            .cmux_bridge
            .answer_questions_batch(surface, agent_kind, &selections)
            .await
        {
            Ok(()) => {
                JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": "answered" }))
                    .unwrap()
            }
            Err(e) => JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::internal_error(e.to_string()),
            ),
        };
    }

    let indices: Vec<usize> = req
        .params
        .get("indices")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect())
        .unwrap_or_default();
    let other = req.params.get("other").and_then(|v| v.as_str());
    let option_count = req.params.get("option_count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let multi_select = req.params.get("multi_select").and_then(|v| v.as_bool()).unwrap_or(false);

    if indices.is_empty() && other.map(str::trim).unwrap_or("").is_empty() {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("indices or other is required"),
        );
    }

    match state
        .cmux_bridge
        .answer_question(surface, agent_kind, &indices, other, option_count, multi_select)
        .await
    {
        Ok(()) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": "answered" }))
                .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_agent_options(req: &JsonRpcRequest) -> JsonRpcResponse {
    let Some(kind) = req.params.get("agent_kind").and_then(|v| v.as_str()) else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Missing agent_kind parameter"),
        );
    };
    if crate::cmux::agent_options::is_antigravity(kind) {
        return match crate::cmux::agent_options::antigravity_options().await {
            Ok(v) => JsonRpcResponse::result(req.id.clone(), v).unwrap(),
            Err(msg) => {
                JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::internal_error(msg))
            }
        };
    }
    match crate::cmux::agent_options::options_for(kind) {
        Some(opts) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::to_value(opts).unwrap()).unwrap()
        }
        None => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("This agent has no model/effort options"),
        ),
    }
}

async fn handle_set_option(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
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
        Err(msg) => {
            return JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(msg))
        }
    };
    let bridge = &state.cmux_bridge;
    let outcome = match &action {
        MidSession::Command(text) => bridge
            .submit_prompt(Some(surface), text, kind, true)
            .await
            .map(|_| "applied"),
        MidSession::TypedPicker(text) => match bridge.ensure_no_startup_dialog(Some(surface)).await {
            Ok(()) => match bridge.send_text(Some(surface), text).await {
                Ok(()) => bridge.send_key(Some(surface), "enter").await.map(|_| "picker_opened"),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        },
    };
    match outcome {
        Ok(status) => {
            JsonRpcResponse::result(req.id.clone(), serde_json::json!({ "status": status }))
                .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_fork(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
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
    if let Err(e) = workspace_dir(state, &req.params).await {
        return JsonRpcResponse::error(Some(req.id.clone()), e);
    }
    let Some(cwd) = WorkspaceService::lookup_session_cwd(session).await else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Unknown session"),
        );
    };
    match state
        .cmux_bridge
        .new_surface_with_cwd(Some(ws), Some(&command), cwd.as_deref())
        .await
    {
        Ok(out) => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "status": "forked", "output": out }),
        )
        .unwrap(),
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}
