//! Application-layer workspace & surface orchestration service for `transport/`.
//!
//! Ensures HTTP/WebSocket/RPC handlers never reach directly into `crate::scanner::*`.

use std::path::PathBuf;

use crate::cmux::bridge::CmuxBridgeError;
use crate::domain::workspace_model::{SurfaceNode, WorkspaceNode, WorkspaceSummary};
use crate::protocol::JsonRpcError;
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;
use crate::server::AppState;

pub struct WorkspaceService;

impl WorkspaceService {
    pub async fn build_tree(state: &AppState) -> Result<Vec<WorkspaceNode>, CmuxBridgeError> {
        let hook_index =
            HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        WorkspaceTreeBuilder::build_tree_in(&state.cmux_bridge, &hook_index, &state.runtime).await
    }

    pub async fn list_workspaces(
        state: &AppState,
    ) -> Result<Vec<WorkspaceSummary>, CmuxBridgeError> {
        let hook_index =
            HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        WorkspaceTreeBuilder::list_workspaces(&state.cmux_bridge, &hook_index).await
    }

    pub async fn get_surface(
        state: &AppState,
        surface_id: &str,
    ) -> Result<Option<SurfaceNode>, CmuxBridgeError> {
        let hook_index =
            HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        WorkspaceTreeBuilder::get_surface_in(
            &state.cmux_bridge,
            &hook_index,
            surface_id,
            &state.runtime,
        )
        .await
    }

    pub async fn workspace_dir(
        state: &AppState,
        params: &serde_json::Value,
    ) -> Result<PathBuf, JsonRpcError> {
        let wanted = params
            .get("workspace_id")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| JsonRpcError::invalid_params("Missing workspace_id parameter"))?;
        let tree = Self::build_tree(state)
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

    pub fn invalidate_tree_cache(state: &AppState) {
        state.runtime.invalidate_tree_cache();
    }

    pub fn resolve_cached_surface_ref(state: &AppState, raw_id_or_ref: &str) -> Option<String> {
        state.runtime.resolve_cached_surface_ref(raw_id_or_ref)
    }

    pub async fn mark_surface_notifications_read(state: &AppState, surface_id: &str) {
        WorkspaceTreeBuilder::mark_surface_notifications_read(
            &state.cmux_bridge,
            &state.runtime,
            surface_id,
        )
        .await;
    }

    pub async fn list_hook_sessions() -> Vec<serde_json::Value> {
        let hook_index =
            HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        hook_index
            .sessions_by_id
            .values()
            .filter_map(|rec| serde_json::to_value(rec).ok())
            .collect()
    }

    /// Resolves a session's validated working directory for `mobile.chat.fork`.
    /// Returns `None` if `session_id` does not exist in the hook store, or `Some(valid_abs_cwd)`.
    pub async fn lookup_session_cwd(session_id: &str) -> Option<Option<String>> {
        let hook_index =
            HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        let record = hook_index.sessions_by_id.get(session_id)?;
        let valid_cwd = record
            .cwd
            .as_deref()
            .filter(|c| std::path::Path::new(c).is_absolute() && std::path::Path::new(c).is_dir())
            .map(str::to_string);
        Some(valid_cwd)
    }
}
