//! Agent lifecycle & surface control actions (interrupt, close + full state purge).

use crate::cmux::bridge::CmuxBridgeError;
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;
use crate::server::AppState;
use crate::services::notification_dispatcher::emit_dismiss;
use crate::services::notifications::all_surface_tags;
use crate::services::session_state::SessionStateService;

/// Interrupts an agent surface (`escape`, or two `escape` keys 60ms apart for OpenCode).
pub async fn interrupt_surface(
    state: &AppState,
    raw_surface_id: &str,
    explicit_agent_kind: Option<&str>,
) -> Result<(), CmuxBridgeError> {
    let surface_id = SessionStateService::canonicalize_surface_id(state, raw_surface_id).await;
    let resolved_kind = match explicit_agent_kind.filter(|k| !k.is_empty() && *k != "agent") {
        Some(k) => Some(k.to_string()),
        None => SessionStateService::resolve_session_raw(state, &surface_id, "")
            .await
            .map(|r| r.agent_kind),
    };
    state
        .cmux_bridge
        .interrupt_agent(&surface_id, resolved_kind.as_deref())
        .await
}

/// Closes a cmux surface (automatically resolving owning `workspace_id` when omitted) and purges
/// all runtime caches and active notifications for that surface.
pub async fn close_surface_and_purge(
    state: &AppState,
    raw_surface_id: &str,
    explicit_workspace_id: Option<&str>,
    force: bool,
) -> Result<(String, String), CmuxBridgeError> {
    let surface_id = SessionStateService::canonicalize_surface_id(state, raw_surface_id).await;
    let workspace_id = match explicit_workspace_id.filter(|w| !w.is_empty()) {
        Some(w) => Some(w.to_string()),
        None => match state
            .runtime
            .workspace_for_surface(&surface_id)
            .or_else(|| state.runtime.workspace_for_surface(raw_surface_id))
        {
            Some(ws) => Some(ws),
            None => {
                let hook_index =
                    HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
                WorkspaceTreeBuilder::build_tree_in(
                    &state.cmux_bridge,
                    &hook_index,
                    &state.runtime,
                )
                .await
                .ok()
                .and_then(|tree| {
                    tree.into_iter().find_map(|ws| {
                        ws.surfaces
                            .iter()
                            .any(|s| {
                                s.id == surface_id
                                    || s.r#ref == surface_id
                                    || s.id == raw_surface_id
                                    || s.r#ref == raw_surface_id
                            })
                            .then_some(ws.id)
                    })
                })
            }
        },
    };

    let out = state
        .cmux_bridge
        .close_surface(&surface_id, workspace_id.as_deref(), force)
        .await?;

    state.runtime.forget_surface(&surface_id);
    state.runtime.forget_surface(raw_surface_id);
    emit_dismiss(state, &surface_id, &all_surface_tags(&surface_id)).await;

    Ok((surface_id, out))
}
