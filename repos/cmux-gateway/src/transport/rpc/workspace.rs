//! Workspace & surface management JSON-RPC handlers (`mobile.workspace.*`, `mobile.surface.*`).

use std::path::PathBuf;

use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_SURFACE_CLOSE, METHOD_SURFACE_GET,
    METHOD_SURFACE_NEW, METHOD_SURFACE_RENAME, METHOD_WORKSPACE_LIST, METHOD_WORKSPACE_TREE,
};
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;
use crate::server::AppState;
use crate::services::agent_control::close_surface_and_purge;

pub(crate) async fn workspace_dir(
    state: &AppState,
    params: &serde_json::Value,
) -> Result<PathBuf, JsonRpcError> {
    let wanted = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| JsonRpcError::invalid_params("Missing workspace_id parameter"))?;
    let hook_index = HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
    let tree = WorkspaceTreeBuilder::build_tree(&state.cmux_bridge, &hook_index)
        .await
        .map_err(|e| JsonRpcError::internal_error(e.to_string()))?;
    let ws = tree
        .into_iter()
        .find(|w| w.id == wanted || w.r#ref == wanted)
        .ok_or_else(|| JsonRpcError::invalid_params("Unknown workspace"))?;
    let dir = PathBuf::from(&ws.current_directory);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(JsonRpcError::invalid_params(
            "Workspace has no usable directory",
        ));
    }
    Ok(dir)
}

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_WORKSPACE_TREE => {
            let hook_index =
                HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
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
            let hook_index =
                HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
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
            let surface_id = req
                .params
                .get("surface_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let hook_index =
                HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
            match WorkspaceTreeBuilder::get_surface(&state.cmux_bridge, &hook_index, surface_id)
                .await
            {
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
        METHOD_SURFACE_NEW => handle_surface_new(req, state).await,
        METHOD_SURFACE_RENAME => handle_surface_rename(req, state).await,
        METHOD_SURFACE_CLOSE => handle_surface_close(req, state).await,
        _ => return None,
    };
    Some(resp)
}

async fn handle_surface_new(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let ws = req.params.get("workspace_id").and_then(|v| v.as_str());
    let mut command = req
        .params
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    if let Some(launch) = req.params.get("launch").and_then(|v| v.as_object()) {
        let get = |k: &str| launch.get(k).and_then(|v| v.as_str());
        let Some(kind) = get("agent_kind") else {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("launch.agent_kind is required"),
            );
        };
        let flags =
            match crate::cmux::agent_options::launch_flags(kind, get("model"), get("effort")) {
                Ok(f) => f,
                Err(msg) => {
                    return JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params(msg),
                    )
                }
            };
        if !flags.is_empty() {
            let aliases = crate::cmux::agents::spec_for(kind)
                .map(|s| s.aliases)
                .unwrap_or(&[]);
            let base = command.as_deref().unwrap_or("");
            if !base
                .split_whitespace()
                .next()
                .is_some_and(|w| aliases.contains(&w))
            {
                return JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("launch options need a plain agent command"),
                );
            }
            command = Some(format!("{} {}", base.trim(), flags.join(" ")));
        }
    }

    match state.cmux_bridge.new_surface(ws, command.as_deref()).await {
        Ok(out) => {
            WorkspaceTreeBuilder::invalidate_tree_cache();
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({ "status": "created", "output": out }),
            )
            .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}

async fn handle_surface_rename(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
        Some(surf) if !surf.is_empty() => surf,
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing surface_id parameter"),
            );
        }
    };
    let title = match req
        .params
        .get("title")
        .and_then(|val| val.as_str())
        .map(str::trim)
    {
        Some(next_title) if !next_title.is_empty() => next_title,
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing title parameter"),
            );
        }
    };

    match state.cmux_bridge.rename_tab(surface, title).await {
        Ok(out) => {
            WorkspaceTreeBuilder::invalidate_tree_cache();
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "status": "renamed",
                    "surface_id": surface,
                    "title": title,
                    "output": out
                }),
            )
            .unwrap()
        }
        Err(err) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(err.to_string()),
        ),
    }
}

async fn handle_surface_close(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    let surface = match req.params.get("surface_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s,
        _ => {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("Missing surface_id parameter"),
            );
        }
    };
    let force = req
        .params
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let workspace = req
        .params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty());

    match close_surface_and_purge(state, surface, workspace, force).await {
        Ok((canonical_id, out)) => {
            WorkspaceTreeBuilder::invalidate_tree_cache();
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "status": "closed",
                    "surface_id": canonical_id,
                    "output": out
                }),
            )
            .unwrap()
        }
        Err(e) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(e.to_string()),
        ),
    }
}
