//! Notification session aggregation (Hooks + OpenCode SQLite + Kiro TTY) and cmux surface context lookup.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::cmux::DualTransportCmuxBridge;
use crate::notifications::SurfaceContext;
use crate::protocol::event::AgentLifecycleState;
use crate::scanner::hook_store::{HookSessionRecord, HookStoreIndex};
use crate::scanner::kiro_store::KiroSessionIndex;
use crate::scanner::liveness;
use crate::scanner::opencode_store;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;

pub fn surface_context_from_tree(
    tree: &serde_json::Value,
    ws_dirs: &HashMap<String, String>,
    surface_id: &str,
    fallback_dir: Option<&str>,
) -> SurfaceContext {
    for win in tree.get("windows").and_then(|w| w.as_array()).into_iter().flatten() {
        for ws in win.get("workspaces").and_then(|w| w.as_array()).into_iter().flatten() {
            let ws_id = ws.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let ws_title = ws.get("title").and_then(|v| v.as_str()).map(str::to_string);
            let ws_dir = ws_dirs.get(ws_id).cloned().or_else(|| fallback_dir.map(str::to_string));
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

pub async fn workspace_dirs_map(bridge: &DualTransportCmuxBridge) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(raw) = bridge.rpc_call("workspace.list", None).await else { return map };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else { return map };
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

pub async fn lookup_surface_context(
    bridge: &DualTransportCmuxBridge,
    surface_id: &str,
    fallback_dir: Option<&str>,
) -> SurfaceContext {
    let tree_fut = bridge.tree_json();
    let dirs_fut = workspace_dirs_map(bridge);
    let (tree_res, dirs) = tokio::join!(tree_fut, dirs_fut);
    if let Ok(raw) = tree_res
        && let Ok(tree) = serde_json::from_str::<serde_json::Value>(&raw)
    {
        return surface_context_from_tree(&tree, &dirs, surface_id, fallback_dir);
    }
    SurfaceContext {
        workspace_title: None,
        workspace_dir: fallback_dir.map(str::to_string),
        surface_title: None,
    }
}

/// Collects all active top-level sessions per surface (hook-backed, OpenCode SQLite, and Kiro TTY)
/// for `NotificationEngine`. Blocking: run inside `tokio::task::spawn_blocking`.
pub fn collect_notification_sessions(
    runtime: &liveness::WorkspaceRuntimeStore,
) -> Vec<HookSessionRecord> {
    let dir = HookStoreIndex::default_cmuxterm_dir();
    let hook_index = HookStoreIndex::scan_dir(&dir);
    let (pid_ttys, live_agents_by_tty) = WorkspaceTreeBuilder::scan_processes_snapshot();
    runtime.store_proc_scan(&live_agents_by_tty);
    let kiro_by_tty = KiroSessionIndex::scan_default_by_pid_map(&pid_ttys);

    let mut sessions = Vec::new();
    let mut covered_surfaces = HashSet::new();

    for surface_id in hook_index.sessions_by_surface.keys() {
        let live_kinds = runtime.surface_live_agent_kinds(surface_id);
        let Some(rec) =
            hook_index.get_active_session_for_surface_filtered(surface_id, live_kinds.as_ref())
        else {
            continue;
        };
        if rec.is_subagent_session() {
            continue;
        }
        let mut rec = rec.clone();
        let canonical_kind = crate::domain::agents::spec_for(rec.resolved_agent_kind())
            .map(|s| s.kind)
            .unwrap_or_else(|| rec.resolved_agent_kind());

        if canonical_kind == "opencode"
            && rec.resolved_lifecycle() != AgentLifecycleState::Waiting
            && let Some(path) = rec.transcript_path.as_deref()
            && let Some(st) = opencode_store::status_for_path(Path::new(path))
        {
            apply_synthetic_lifecycle(&mut rec, st.lifecycle, st.turn_completed_at, st.last_subtitle);
        }

        covered_surfaces.insert(rec.surface_id.clone());
        sessions.push(rec);
    }

    for (tty, kiro) in kiro_by_tty {
        if let Some(map) = live_agents_by_tty.as_ref()
            && !map.get(&tty).is_some_and(|k| k.contains("kiro"))
        {
            continue;
        }
        let Some((surface_id, workspace_id, cwd)) = runtime.surface_for_tty(&tty) else {
            continue;
        };
        if covered_surfaces.contains(&surface_id) {
            continue;
        }
        let mut rec = HookSessionRecord {
            session_id: kiro.session_id,
            surface_id: surface_id.clone(),
            workspace_id,
            cwd,
            agent_lifecycle: None,
            runtime_status: None,
            transcript_path: Some(kiro.transcript_path.to_string_lossy().into_owned()),
            last_body: None,
            last_subtitle: kiro.last_subtitle.clone(),
            hook_event_name: None,
            updated_at: kiro.turn_completed_at,
            started_at: None,
            pid: None,
            turn_settled: None,
            launch_command: None,
            agent_kind: Some("kiro".to_string()),
            tool_name: None,
            is_subagent: false,
        };
        apply_synthetic_lifecycle(&mut rec, kiro.lifecycle, kiro.turn_completed_at, kiro.last_subtitle);
        covered_surfaces.insert(surface_id);
        sessions.push(rec);
    }

    sessions
}

fn apply_synthetic_lifecycle(
    rec: &mut HookSessionRecord,
    lifecycle: AgentLifecycleState,
    turn_completed_at: Option<f64>,
    subtitle: Option<String>,
) {
    if subtitle.is_some() {
        rec.last_subtitle = subtitle;
    }
    match lifecycle {
        AgentLifecycleState::Working => {
            rec.agent_lifecycle = Some("running".to_string());
            rec.runtime_status = Some("running".to_string());
            rec.hook_event_name = Some("PreToolUse".to_string());
            rec.turn_settled = Some(false);
        }
        AgentLifecycleState::Waiting => {
            rec.agent_lifecycle = Some("waiting".to_string());
            rec.runtime_status = Some("waiting".to_string());
            rec.hook_event_name = Some("PermissionRequest".to_string());
            rec.turn_settled = Some(false);
        }
        AgentLifecycleState::Error => {
            rec.agent_lifecycle = Some("error".to_string());
            rec.runtime_status = Some("error".to_string());
            rec.hook_event_name = None;
            rec.turn_settled = Some(true);
        }
        AgentLifecycleState::Done => {
            rec.agent_lifecycle = Some("idle".to_string());
            rec.runtime_status = Some("completed".to_string());
            rec.hook_event_name = Some("Stop".to_string());
            rec.turn_settled = Some(true);
            if let Some(ts) = turn_completed_at {
                rec.updated_at = Some(ts);
            }
        }
        AgentLifecycleState::Idle => {
            rec.agent_lifecycle = Some("idle".to_string());
            rec.runtime_status = Some("idle".to_string());
            rec.hook_event_name = None;
            rec.turn_settled = Some(false);
        }
    }
}
