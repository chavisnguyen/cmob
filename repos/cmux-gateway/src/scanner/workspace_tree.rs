use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use crate::cmux::bridge::{CmuxBridgeError, DualTransportCmuxBridge};
use crate::protocol::event::AgentLifecycleState;
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::kiro_store::KiroSessionIndex;
use crate::scanner::liveness::WorkspaceRuntimeStore;

pub use crate::domain::workspace_model::{
    sanitize_hex_color, SurfaceAgentInfo, SurfaceNode, WorkspaceNode, WorkspaceSummary,
};

// Internal raw deserialization structs from cmux CLI output
#[derive(Debug, Deserialize)]
struct RawCmuxTreeOutput {
    #[serde(default)]
    windows: Vec<RawCmuxWindow>,
}

#[derive(Debug, Deserialize)]
struct RawCmuxWindow {
    #[serde(default)]
    workspaces: Vec<RawCmuxWorkspace>,
}

#[derive(Debug, Deserialize)]
struct RawCmuxWorkspace {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    r#ref: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    pinned: Option<bool>,
    #[serde(default)]
    selected: Option<bool>,
    #[serde(default)]
    panes: Vec<RawCmuxPane>,
}

#[derive(Debug, Deserialize)]
struct RawCmuxPane {
    #[serde(default)]
    surfaces: Vec<RawCmuxSurface>,
}

#[derive(Debug, Deserialize)]
struct RawCmuxSurface {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    r#ref: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "type")]
    surface_type: Option<String>,
    #[serde(default)]
    tty: Option<String>,
    #[serde(default)]
    selected: Option<bool>,
    #[serde(default)]
    focused: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RawWorkspaceListOutput {
    #[serde(default)]
    workspaces: Vec<RawWorkspaceEntry>,
}

#[derive(Debug, Deserialize)]
struct RawWorkspaceEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    current_directory: Option<String>,
    #[serde(default)]
    latest_conversation_message: Option<String>,
    #[serde(default)]
    custom_color: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawNotificationListOutput {
    #[serde(default)]
    notifications: Vec<RawCmuxNotification>,
}

#[derive(Debug, Deserialize)]
struct RawCmuxNotification {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    surface_id: Option<String>,
    #[serde(default)]
    is_read: bool,
}

fn parse_unread_notification_counts(raw: &str) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut by_ws = HashMap::new();
    let mut by_surf = HashMap::new();
    let Ok(parsed) = serde_json::from_str::<RawNotificationListOutput>(raw) else {
        return (by_ws, by_surf);
    };
    for n in parsed.notifications {
        if n.is_read {
            continue;
        }
        if let Some(ws_id) = n.workspace_id.filter(|s| !s.is_empty()) {
            *by_ws.entry(ws_id).or_insert(0) += 1;
        }
        if let Some(surf_id) = n.surface_id.filter(|s| !s.is_empty()) {
            *by_surf.entry(surf_id).or_insert(0) += 1;
        }
    }
    (by_ws, by_surf)
}

/// `ps` elapsed time: `[[dd-]hh:]mm:ss` -> seconds.
fn parse_etime_secs(etime: &str) -> Option<u64> {
    let (days, rest) = match etime.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, etime),
    };
    let nums: Vec<u64> = rest.split(':').map(|p| p.parse::<u64>().ok()).collect::<Option<_>>()?;
    let secs = match nums.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86_400 + secs)
}

const SURFACE_LOOKUP_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(4);
const TREE_POLL_COALESCE_TTL: std::time::Duration = std::time::Duration::from_millis(150);

/// Builder responsible for merging cmux UDS output with `HookStoreIndex` and `WorkspaceRuntimeStore`.
pub struct WorkspaceTreeBuilder;

impl WorkspaceTreeBuilder {
    /// Marks notifications for a viewed surface read in `cmux` (no-op if surface had 0 unreads).
    pub async fn mark_surface_notifications_read(
        bridge: &DualTransportCmuxBridge,
        runtime: &WorkspaceRuntimeStore,
        surface_id: &str,
    ) {
        if !runtime.clear_surface_unread(surface_id) {
            return;
        }
        let Some(ws_id) = runtime
            .workspace_for_surface(surface_id)
            .filter(|w| !w.is_empty())
        else {
            return;
        };
        let _ = bridge.mark_notifications_read(&ws_id, surface_id).await;
        runtime.invalidate_tree_cache();
    }

    /// Stateless convenience wrapper around `build_tree_in` (used by standalone mock tests).
    pub async fn build_tree(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
    ) -> Result<Vec<WorkspaceNode>, CmuxBridgeError> {
        let ephemeral = WorkspaceRuntimeStore::new();
        Self::build_tree_in(bridge, hook_index, &ephemeral).await
    }

    /// Build the full 3-level tree from live cmux instance, hook index, and injected `WorkspaceRuntimeStore`.
    pub async fn build_tree_in(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
        runtime: &WorkspaceRuntimeStore,
    ) -> Result<Vec<WorkspaceNode>, CmuxBridgeError> {
        if let Some(cached) = runtime.cached_tree(TREE_POLL_COALESCE_TTL) {
            return Ok(cached);
        }

        // Run `system.tree`, `workspace.list`, `notification.list` (over persistent UDS pool),
        // and native kernel process + Kiro lease scan concurrently.
        let tree_fut = bridge.tree_json();
        let ws_list_fut = bridge.rpc_call("workspace.list", None);
        let notif_list_fut = bridge.rpc_call("notification.list", None);
        let proc_kiro_fut = tokio::task::spawn_blocking(|| {
            let (pid_ttys, live_agents_by_tty) = Self::scan_processes_snapshot();
            let kiro_by_tty = KiroSessionIndex::scan_default_by_pid_map(&pid_ttys);
            (live_agents_by_tty, kiro_by_tty)
        });

        let (tree_res, ws_list_res, notif_list_res, proc_kiro_res) =
            tokio::join!(tree_fut, ws_list_fut, notif_list_fut, proc_kiro_fut);

        let (unread_by_ws, unread_by_surf) = notif_list_res
            .ok()
            .as_deref()
            .map(parse_unread_notification_counts)
            .unwrap_or_default();
        runtime.replace_unread_surfaces(unread_by_surf.keys().cloned().collect());

        let tree_output = tree_res?;
        let tree_data: RawCmuxTreeOutput = serde_json::from_str(&tree_output).map_err(|e| {
            CmuxBridgeError::JsonParseError(format!("cmux tree: {e}"))
        })?;

        let mut dirs_by_id: HashMap<String, String> = HashMap::new();
        let mut latest_msg_by_id: HashMap<String, String> = HashMap::new();
        let mut color_by_id: HashMap<String, String> = HashMap::new();

        if let Ok(ws_list) = ws_list_res.and_then(|out| {
            serde_json::from_str::<RawWorkspaceListOutput>(&out)
                .map_err(|e| CmuxBridgeError::JsonParseError(e.to_string()))
        }) {
            for w in ws_list.workspaces {
                if let Some(id) = w.id {
                    if let Some(dir) = w.current_directory {
                        dirs_by_id.insert(id.clone(), dir);
                    }
                    if let Some(color) = w.custom_color.as_deref().and_then(Self::sanitize_hex_color) {
                        color_by_id.insert(id.clone(), color);
                    }
                    if let Some(msg) = w.latest_conversation_message {
                        latest_msg_by_id.insert(id, msg);
                    }
                }
            }
        }

        let (live_agents_by_tty, kiro_by_tty) = proc_kiro_res.unwrap_or((None, HashMap::new()));
        runtime.store_proc_scan(&live_agents_by_tty);

        let mut result_workspaces = Vec::new();
        let mut all_surface_ids = HashSet::new();

        for win in tree_data.windows {
            for raw_ws in win.workspaces {
                let ws_id = raw_ws.id.unwrap_or_default();
                let ws_id_for_color = ws_id.clone();
                let ws_ref = raw_ws.r#ref.unwrap_or_else(|| format!("workspace:{ws_id}"));
                let title = raw_ws.title.unwrap_or_else(|| "Workspace".to_string());
                let pinned = raw_ws.pinned.unwrap_or(false);
                let selected = raw_ws.selected.unwrap_or(false);

                let current_directory = dirs_by_id
                    .get(&ws_id)
                    .cloned()
                    .unwrap_or_else(|| "~".to_string());

                let mut surfaces = Vec::new();
                for pane in raw_ws.panes {
                    for raw_surf in pane.surfaces {
                        let surf_id = raw_surf.id.unwrap_or_default();
                        let surf_ref = raw_surf.r#ref.unwrap_or_else(|| format!("surface:{surf_id}"));
                        let surf_title = raw_surf.title.unwrap_or_else(|| "Terminal".to_string());
                        let surf_type = raw_surf.surface_type.unwrap_or_else(|| "terminal".to_string());
                        let surf_selected = raw_surf.selected.unwrap_or(false);
                        let surf_focused = raw_surf.focused.unwrap_or(false);

                        all_surface_ids.insert(surf_id.clone());
                        runtime.record_surface_meta(
                            &surf_id,
                            &surf_ref,
                            &ws_id,
                            Some(&current_directory),
                        );
                        if let Some(tty) = raw_surf.tty.as_deref() {
                            runtime.record_surface_tty(&surf_id, tty);
                        }

                        let live_kinds = if surf_type == "terminal" {
                            Self::live_kinds_for(&live_agents_by_tty, raw_surf.tty.as_deref())
                        } else {
                            None
                        };
                        let still_alive = |info: &SurfaceAgentInfo| match &live_kinds {
                            Some(kinds) => {
                                !kinds.is_empty()
                                    && (info.agent_kind == "agent"
                                        || kinds.contains(info.agent_kind.as_str()))
                            }
                            None => true,
                        };

                        let discovered_info = Self::resolve_surface_agent_info(
                            &surf_id,
                            &surf_title,
                            &surf_type,
                            raw_surf.tty.as_deref(),
                            hook_index,
                            &kiro_by_tty,
                            &live_kinds,
                        );

                        let agent_info = if let Some(info) = discovered_info {
                            runtime.remember_surface_agent(&surf_id, info.clone());
                            Some(info)
                        } else if live_kinds.as_ref().is_some_and(|k| k.is_empty()) {
                            runtime.forget_remembered_agent(&surf_id);
                            None
                        } else {
                            runtime
                                .remembered_surface_agent(&surf_id)
                                .filter(still_alive)
                        };

                        let agent_info = agent_info.map(|mut a| {
                            if runtime.is_dialog_waiting(&surf_id) {
                                a.status = "waiting".to_string();
                            }
                            a
                        });

                        let surf_unread = unread_by_surf.get(&surf_id).copied().unwrap_or(0);
                        surfaces.push(SurfaceNode {
                            id: surf_id,
                            r#ref: surf_ref,
                            title: surf_title,
                            surface_type: surf_type,
                            tty: raw_surf.tty,
                            selected: surf_selected,
                            focused: surf_focused,
                            unread_count: surf_unread,
                            agent: agent_info,
                        });
                    }
                }

                let status = crate::domain::lifecycle::derive_workspace_status(&surfaces);
                let surf_unread_sum: usize = surfaces.iter().map(|s| s.unread_count).sum();
                let ws_unread = unread_by_ws.get(&ws_id).copied().unwrap_or(0).max(surf_unread_sum);

                result_workspaces.push(WorkspaceNode {
                    id: ws_id,
                    r#ref: ws_ref,
                    title,
                    pinned,
                    selected,
                    status,
                    current_directory,
                    color: color_by_id.get(&ws_id_for_color).cloned(),
                    snippet: None,
                    unread_count: ws_unread,
                    surfaces,
                });
            }
        }

        let hook_for_snippets = hook_index.clone();
        let result_workspaces = tokio::task::spawn_blocking(move || {
            let mut workspaces = result_workspaces;
            for ws in &mut workspaces {
                ws.snippet = hook_for_snippets
                    .get_workspace_snippet(&ws.id)
                    .or_else(|| {
                        ws.surfaces
                            .iter()
                            .filter(|s| s.selected || s.focused)
                            .chain(ws.surfaces.iter().filter(|s| !s.selected && !s.focused))
                            .find_map(|s| {
                                let path = s.agent.as_ref()?.transcript_path.as_deref()?;
                                crate::notifications::cached_transcript_workspace_snippet(path, &s.id)
                            })
                    })
                    .or_else(|| latest_msg_by_id.get(&ws.id).cloned());
            }
            workspaces
        })
        .await
        .unwrap_or_default();

        runtime.prune_remembered_surfaces(&all_surface_ids);
        runtime.prune_surfaces(&all_surface_ids);
        runtime.store_tree_snapshot(result_workspaces.clone());

        Ok(result_workspaces)
    }

    /// Lightweight workspace summary list for `mobile.workspace.list` (skips `ps` and Kiro scans).
    pub async fn list_workspaces(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
    ) -> Result<Vec<WorkspaceSummary>, CmuxBridgeError> {
        let (tree_res, ws_list_res, notif_res) = tokio::join!(
            bridge.tree_json(),
            bridge.rpc_call("workspace.list", None),
            bridge.rpc_call("notification.list", None),
        );
        let tree_output = tree_res?;
        let tree_data: RawCmuxTreeOutput = serde_json::from_str(&tree_output)
            .map_err(|e| CmuxBridgeError::JsonParseError(format!("cmux tree: {e}")))?;

        let (unread_by_ws, _) = notif_res
            .ok()
            .as_deref()
            .map(parse_unread_notification_counts)
            .unwrap_or_default();

        let mut dirs_by_id: HashMap<String, String> = HashMap::new();
        let mut latest_msg_by_id: HashMap<String, String> = HashMap::new();
        let mut color_by_id: HashMap<String, String> = HashMap::new();
        if let Ok(ws_list) = ws_list_res.and_then(|out| {
            serde_json::from_str::<RawWorkspaceListOutput>(&out)
                .map_err(|e| CmuxBridgeError::JsonParseError(e.to_string()))
        }) {
            for w in ws_list.workspaces {
                if let Some(id) = w.id {
                    if let Some(dir) = w.current_directory {
                        dirs_by_id.insert(id.clone(), dir);
                    }
                    if let Some(color) = w.custom_color.as_deref().and_then(Self::sanitize_hex_color) {
                        color_by_id.insert(id.clone(), color);
                    }
                    if let Some(msg) = w.latest_conversation_message {
                        latest_msg_by_id.insert(id, msg);
                    }
                }
            }
        }

        let hook_for_summaries = hook_index.clone();
        let summaries = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            for win in tree_data.windows {
                for raw_ws in win.workspaces {
                    let ws_id = raw_ws.id.unwrap_or_default();
                    let ws_ref = raw_ws.r#ref.unwrap_or_else(|| format!("workspace:{ws_id}"));
                    let title = raw_ws.title.unwrap_or_else(|| "Workspace".to_string());
                    let pinned = raw_ws.pinned.unwrap_or(false);
                    let selected = raw_ws.selected.unwrap_or(false);
                    let current_directory =
                        dirs_by_id.get(&ws_id).cloned().unwrap_or_else(|| "~".to_string());
                    let snippet = hook_for_summaries
                        .get_workspace_snippet(&ws_id)
                        .or_else(|| latest_msg_by_id.get(&ws_id).cloned());
                    let has_running = hook_for_summaries.is_workspace_running(&ws_id);
                    let status = if has_running { "running" } else { "idle" }.to_string();
                    let surface_count: usize = raw_ws.panes.iter().map(|p| p.surfaces.len()).sum();
                    let unread_count = unread_by_ws.get(&ws_id).copied().unwrap_or(0);
                    out.push(WorkspaceSummary {
                        id: ws_id.clone(),
                        r#ref: ws_ref,
                        title,
                        pinned,
                        selected,
                        status,
                        current_directory,
                        color: color_by_id.get(&ws_id).cloned(),
                        snippet,
                        unread_count,
                        surface_count,
                        has_running_agent: has_running,
                    });
                }
            }
            out
        })
        .await
        .unwrap_or_default();
        Ok(summaries)
    }

    /// Retrieve detail for a single surface using an injected `WorkspaceRuntimeStore`.
    pub async fn get_surface_in(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
        surface_id: &str,
        runtime: &WorkspaceRuntimeStore,
    ) -> Result<Option<SurfaceNode>, CmuxBridgeError> {
        if let Some(cached_tree) = runtime.cached_tree(SURFACE_LOOKUP_CACHE_TTL) {
            for ws in cached_tree {
                for surf in ws.surfaces {
                    if surf.id == surface_id || surf.r#ref == surface_id {
                        return Ok(Some(surf));
                    }
                }
            }
        }
        let tree = Self::build_tree_in(bridge, hook_index, runtime).await?;
        for ws in tree {
            for surf in ws.surfaces {
                if surf.id == surface_id || surf.r#ref == surface_id {
                    return Ok(Some(surf));
                }
            }
        }
        Ok(None)
    }

    /// Stateless convenience wrapper around `get_surface_in`.
    pub async fn get_surface(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
        surface_id: &str,
    ) -> Result<Option<SurfaceNode>, CmuxBridgeError> {
        let ephemeral = WorkspaceRuntimeStore::new();
        Self::get_surface_in(bridge, hook_index, surface_id, &ephemeral).await
    }

    fn kind_from_bin(bin_name: &str) -> Option<&'static str> {
        crate::domain::agents::kind_from_bin(bin_name)
    }

    pub fn sanitize_hex_color(raw: &str) -> Option<String> {
        crate::domain::workspace_model::sanitize_hex_color(raw)
    }

    fn standby_info(agent_kind: &str) -> SurfaceAgentInfo {
        SurfaceAgentInfo {
            session_id: String::new(),
            agent_kind: agent_kind.to_string(),
            status: "ready".to_string(),
            transcript_path: None,
        }
    }

    /// Pure surface-agent resolution enforcing live TTY `agent_kind` before falling back to Kiro or standby.
    pub fn resolve_surface_agent_info(
        surf_id: &str,
        surf_title: &str,
        surf_type: &str,
        raw_tty: Option<&str>,
        hook_index: &HookStoreIndex,
        kiro_by_tty: &HashMap<String, crate::scanner::kiro_store::KiroSession>,
        live_kinds: &Option<HashSet<&'static str>>,
    ) -> Option<SurfaceAgentInfo> {
        let clean_tty = raw_tty.map(|t| t.trim_start_matches("/dev/"));
        let proc_alive = live_kinds.as_ref().map(|k| !k.is_empty());
        hook_index
            .get_active_session_for_surface_filtered(surf_id, live_kinds.as_ref())
            .map(|s| {
                let canonical_kind = crate::domain::agents::spec_for(s.resolved_agent_kind())
                    .map(|sp| sp.kind)
                    .unwrap_or_else(|| s.resolved_agent_kind());
                let mut lc = s.live_lifecycle_with_liveness(proc_alive);
                if canonical_kind == "opencode"
                    && lc != AgentLifecycleState::Waiting
                    && let Some(path) = s.transcript_path.as_deref()
                    && let Some(oc_st) =
                        crate::scanner::opencode_store::status_for_path(std::path::Path::new(path))
                {
                    lc = oc_st.lifecycle;
                }
                let status_str = match lc {
                    AgentLifecycleState::Working => "running",
                    AgentLifecycleState::Waiting => "waiting",
                    AgentLifecycleState::Error => "error",
                    AgentLifecycleState::Done | AgentLifecycleState::Idle => "idle",
                };
                SurfaceAgentInfo {
                    session_id: s.session_id.clone(),
                    agent_kind: canonical_kind.to_string(),
                    status: status_str.to_string(),
                    transcript_path: s.transcript_path.clone(),
                }
            })
            .or_else(|| {
                if surf_type != "terminal" {
                    return None;
                }
                if let Some(kinds) = live_kinds.as_ref()
                    && !kinds.contains("kiro")
                {
                    return None;
                }
                let k = clean_tty.and_then(|t| kiro_by_tty.get(t))?;
                Some(SurfaceAgentInfo {
                    session_id: k.session_id.clone(),
                    agent_kind: "kiro".to_string(),
                    status: match k.lifecycle {
                        AgentLifecycleState::Working => "running",
                        AgentLifecycleState::Waiting => "waiting",
                        AgentLifecycleState::Error => "error",
                        AgentLifecycleState::Done | AgentLifecycleState::Idle => "idle",
                    }
                    .to_string(),
                    transcript_path: Some(k.transcript_path.to_string_lossy().into_owned()),
                })
            })
            .or_else(|| {
                if surf_type != "terminal" {
                    return None;
                }
                match live_kinds {
                    Some(kinds) => kinds.iter().next().map(|k| Self::standby_info(k)),
                    None => Self::recognize_standby_agent(surf_title, surf_type),
                }
            })
    }

    /// Recognize an agent from a full process command line (argv0, or argv1 for interpreters).
    pub fn recognize_command_line(command: &str) -> Option<&'static str> {
        let mut tokens = command.split_whitespace();
        let base = |t: &str| t.rsplit('/').next().unwrap_or(t).to_lowercase();
        let argv0 = base(tokens.next()?);
        if matches!(argv0.as_str(), "node" | "bun" | "python" | "python3" | "deno" | "ruby") {
            let argv1 = base(tokens.next()?);
            return Self::kind_from_bin(&argv1);
        }
        Self::kind_from_bin(&argv0)
    }

    /// Single process snapshot producing both `pid -> tty` (for Kiro leases) and
    /// `tty -> agent kinds` (for surface liveness). Uses native `<libproc.h>` + `KERN_PROCARGS2`
    /// on macOS (< 1.5ms) with `ps` fallback on non-macOS or syscall failure.
    pub fn scan_processes_snapshot() -> (HashMap<u32, String>, Option<HashMap<String, HashSet<&'static str>>>) {
        #[cfg(target_os = "macos")]
        if let Some((pid_ttys, agents)) = crate::scanner::macos_proc::scan_processes_snapshot() {
            return (pid_ttys, Some(agents));
        }

        let Ok(out) = std::process::Command::new("ps")
            .args(["-axo", "pid=,tty=,command="])
            .output()
        else {
            return (HashMap::new(), None);
        };
        if !out.status.success() {
            return (HashMap::new(), None);
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut pid_ttys = HashMap::new();
        let mut agent_ps_lines = String::new();
        for line in stdout.lines() {
            let mut parts = line.split_whitespace();
            let (Some(pid_str), Some(tty)) = (parts.next(), parts.next()) else { continue };
            let clean_tty = tty.trim_start_matches("/dev/");
            if clean_tty.is_empty() || clean_tty.chars().all(|c| c == '?' || c == '-') {
                continue;
            }
            if let Ok(pid) = pid_str.parse::<u32>() {
                pid_ttys.insert(pid, clean_tty.to_string());
            }
            if let Some(pos) = line.find(tty) {
                let cmd = line[pos + tty.len()..].trim_start();
                if !cmd.is_empty() {
                    agent_ps_lines.push_str(clean_tty);
                    agent_ps_lines.push(' ');
                    agent_ps_lines.push_str(cmd);
                    agent_ps_lines.push('\n');
                }
            }
        }
        (pid_ttys, Some(Self::parse_agent_processes(&agent_ps_lines)))
    }

    /// Group agent processes by controlling tty (`ttys005` etc.). `None` when inspection fails.
    pub fn scan_agent_processes_by_tty() -> Option<HashMap<String, HashSet<&'static str>>> {
        #[cfg(target_os = "macos")]
        if let Some(agents) = crate::scanner::macos_proc::scan_agent_processes_by_tty() {
            return Some(agents);
        }

        let out = std::process::Command::new("ps").args(["-axo", "tty=,command="]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(Self::parse_agent_processes(&String::from_utf8_lossy(&out.stdout)))
    }

    /// Agent processes started within `max_age_secs`, as (tty, kind). Startup dialogs only exist before the
    /// first prompt (Orca: "Only dialogs that precede a first prompt", startup-dialog-screen.ts:17-19), so
    /// only young processes are worth reading the screen of.
    pub fn scan_recent_agent_ttys(max_age_secs: u64) -> Vec<(String, &'static str)> {
        #[cfg(target_os = "macos")]
        if let Some(recent) = crate::scanner::macos_proc::scan_recent_agent_ttys(max_age_secs) {
            return recent;
        }

        let Ok(out) = std::process::Command::new("ps").args(["-axo", "tty=,etime=,command="]).output() else {
            return Vec::new();
        };
        Self::parse_recent_agent_ttys(&String::from_utf8_lossy(&out.stdout), max_age_secs)
    }

    pub fn parse_recent_agent_ttys(ps_output: &str, max_age_secs: u64) -> Vec<(String, &'static str)> {
        let mut found: Vec<(String, &'static str)> = Vec::new();
        for line in ps_output.lines() {
            let mut parts = line.split_whitespace();
            let (Some(tty), Some(etime)) = (parts.next(), parts.next()) else { continue };
            if tty.chars().all(|c| c == '?' || c == '-') {
                continue;
            }
            let cmd: Vec<&str> = parts.collect();
            let Some(kind) = Self::recognize_command_line(&cmd.join(" ")) else { continue };
            if parse_etime_secs(etime).is_some_and(|age| age <= max_age_secs) {
                let tty = tty.trim_start_matches("/dev/").to_string();
                if !found.iter().any(|(t, k)| *t == tty && *k == kind) {
                    found.push((tty, kind));
                }
            }
        }
        found
    }

    pub fn parse_agent_processes(ps_output: &str) -> HashMap<String, HashSet<&'static str>> {
        let mut map: HashMap<String, HashSet<&'static str>> = HashMap::new();
        for line in ps_output.lines() {
            let mut parts = line.trim_start().splitn(2, char::is_whitespace);
            let (Some(tty), Some(cmd)) = (parts.next(), parts.next()) else { continue };
            if tty.chars().all(|c| c == '?' || c == '-') {
                continue;
            }
            if let Some(kind) = Self::recognize_command_line(cmd.trim_start()) {
                map.entry(tty.trim_start_matches("/dev/").to_string()).or_default().insert(kind);
            }
        }
        map
    }

    /// Live agent kinds on a tty. `None` => unknown (scan failed or surface has no tty);
    /// `Some(empty)` => tty inspected and no agent process is running.
    fn live_kinds_for<'a>(
        scan: &'a Option<HashMap<String, HashSet<&'static str>>>,
        tty: Option<&str>,
    ) -> Option<HashSet<&'static str>> {
        let scan = scan.as_ref()?;
        let tty = tty?.trim_start_matches("/dev/");
        Some(scan.get(tty).cloned().unwrap_or_default())
    }

    /// Title-based fallback, used only when the tty cannot be inspected. Only absolute paths
    /// are stripped: titles like `…/tool/tool-x` are cwd names, not commands.
    pub fn recognize_standby_agent(title: &str, surface_type: &str) -> Option<SurfaceAgentInfo> {
        if surface_type != "terminal" {
            return None;
        }
        let first_token = title.trim().split_whitespace().next()?.to_lowercase();
        let bin_name = if first_token.starts_with('/') {
            first_token.rsplit('/').next().unwrap_or(&first_token)
        } else if first_token.contains('/') {
            return None;
        } else {
            first_token.as_str()
        };
        Self::kind_from_bin(bin_name).map(Self::standby_info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recognize_standby_agent() {
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("agys run", "terminal"),
            Some(SurfaceAgentInfo {
                session_id: String::new(),
                agent_kind: "antigravity".to_string(),
                status: "ready".to_string(),
                transcript_path: None,
            })
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("/opt/homebrew/bin/agy", "terminal"),
            Some(SurfaceAgentInfo {
                session_id: String::new(),
                agent_kind: "antigravity".to_string(),
                status: "ready".to_string(),
                transcript_path: None,
            })
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("claude", "terminal"),
            Some(SurfaceAgentInfo {
                session_id: String::new(),
                agent_kind: "claude".to_string(),
                status: "ready".to_string(),
                transcript_path: None,
            })
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("codex", "terminal"),
            Some(SurfaceAgentInfo {
                session_id: String::new(),
                agent_kind: "codex".to_string(),
                status: "ready".to_string(),
                transcript_path: None,
            })
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("kiro-cli", "terminal"),
            Some(SurfaceAgentInfo {
                session_id: String::new(),
                agent_kind: "kiro".to_string(),
                status: "ready".to_string(),
                transcript_path: None,
            })
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("zsh", "terminal"),
            None
        );
        assert_eq!(
            WorkspaceTreeBuilder::recognize_standby_agent("agys run", "markdown"),
            None
        );
    }

    #[test]
    fn test_sanitize_hex_color() {
        assert_eq!(WorkspaceTreeBuilder::sanitize_hex_color("#c0392b"), Some("#C0392B".to_string()));
        assert_eq!(WorkspaceTreeBuilder::sanitize_hex_color("red"), None);
        assert_eq!(WorkspaceTreeBuilder::sanitize_hex_color("#fff;x:y"), None);
    }

    #[test]
    fn test_directory_title_is_not_agent() {
        assert_eq!(WorkspaceTreeBuilder::recognize_standby_agent("…/personal/tool/tool-x", "terminal"), None);
        assert_eq!(WorkspaceTreeBuilder::recognize_standby_agent("~/work/claude-notes", "terminal"), None);
    }

    #[test]
    fn test_parse_agent_processes_by_tty() {
        let ps = "ttys000  agys conv\nttys000  /opt/homebrew/bin/agy --log-file x\nttys004  kiro-cli chat --trust-all-tools\n\
                  ttys012  -zsh\n?? /Users/x/.local/bin/claude --chrome-native-host\nttys005  vim claude-notes.md\n\
                  ttys022  node /usr/local/bin/codex --foo\n";
        let m = WorkspaceTreeBuilder::parse_agent_processes(ps);
        assert!(m["ttys000"].contains("antigravity"));
        assert!(m["ttys004"].contains("kiro"));
        assert!(m["ttys022"].contains("codex"));
        assert!(!m.contains_key("ttys012"));
        assert!(!m.contains_key("ttys005"));
        assert!(!m.contains_key("??"));
    }

    #[test]
    fn test_deserialize_raw_cmux_tree_with_both_ids() {
        let raw_json = r#"{
            "windows": [
                {
                    "workspaces": [
                        {
                            "id": "4EA5F151-84D5-41E3-A92B-D9A082DD1EBC",
                            "ref": "workspace:1000080003",
                            "title": "Project A workspace",
                            "pinned": true,
                            "selected": false,
                            "panes": [
                                {
                                    "surfaces": [
                                        {
                                            "id": "4BEC6107-D94C-4DDE-93AF-3835F68B0E93",
                                            "ref": "surface:1000080008",
                                            "title": "Đồng bộ dữ liệu code hub",
                                            "type": "terminal",
                                            "tty": "ttys006",
                                            "selected": true,
                                            "focused": true
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        }"#;

        let parsed: RawCmuxTreeOutput = serde_json::from_str(raw_json).expect("parse tree");
        assert_eq!(parsed.windows.len(), 1);
        let ws = &parsed.windows[0].workspaces[0];
        assert_eq!(ws.id.as_deref(), Some("4EA5F151-84D5-41E3-A92B-D9A082DD1EBC"));
        assert_eq!(ws.title.as_deref(), Some("Project A workspace"));
        assert_eq!(ws.panes[0].surfaces[0].id.as_deref(), Some("4BEC6107-D94C-4DDE-93AF-3835F68B0E93"));
    }

    #[test]
    fn test_remembered_surface_identity_latching() {
        let store = WorkspaceRuntimeStore::new();
        let surf_id = "test-surface-latching-1";
        let info = SurfaceAgentInfo {
            session_id: "sess-1".to_string(),
            agent_kind: "antigravity".to_string(),
            status: "ready".to_string(),
            transcript_path: None,
        };
        store.remember_surface_agent(surf_id, info.clone());
        assert_eq!(store.remembered_surface_agent(surf_id), Some(info));
        store.forget_surface(surf_id);
        assert_eq!(store.remembered_surface_agent(surf_id), None);
    }

    #[test]
    fn test_parse_etime_and_recent_agent_ttys() {
        assert_eq!(parse_etime_secs("00:07"), Some(7));
        assert_eq!(parse_etime_secs("12:34"), Some(754));
        assert_eq!(parse_etime_secs("01:02:03"), Some(3723));
        assert_eq!(parse_etime_secs("2-00:00:01"), Some(172_801));
        assert_eq!(parse_etime_secs("x"), None);
        let ps = "ttys019       00:12 codex --foo\nttys000    03-01:00:00 /opt/homebrew/bin/agy --x\n??       00:05 /Users/x/claude --chrome\nttys012    00:04 -zsh\n";
        let recent = WorkspaceTreeBuilder::parse_recent_agent_ttys(ps, 300);
        assert_eq!(recent, vec![("ttys019".to_string(), "codex")]);
    }

    #[test]
    fn live_tty_tab_reuse_ignores_exited_claude_and_preserves_kiro_session() {
        use crate::scanner::hook_store::HookSessionRecord;
        use crate::scanner::kiro_store::KiroSession;
        use std::path::PathBuf;

        let mut hook_index = HookStoreIndex::default();
        let stale_claude = HookSessionRecord {
            session_id: "claude-old".into(),
            surface_id: "surf-reuse".into(),
            workspace_id: "ws-1".into(),
            cwd: None,
            agent_lifecycle: Some("idle".into()),
            runtime_status: Some("completed".into()),
            transcript_path: Some("/tmp/claude-old.jsonl".into()),
            last_body: None,
            last_subtitle: None,
            hook_event_name: Some("Stop".into()),
            updated_at: Some(100.0),
            started_at: None,
            pid: None,
            turn_settled: Some(true),
            launch_command: None,
            agent_kind: Some("claude".into()),
            tool_name: None,
            is_subagent: false,
        };
        hook_index
            .sessions_by_surface
            .insert("surf-reuse".into(), vec![stale_claude.clone()]);
        hook_index
            .sessions_by_id
            .insert("claude-old".into(), stale_claude);

        let mut kiro_by_tty = HashMap::new();
        kiro_by_tty.insert(
            "ttys042".to_string(),
            KiroSession {
                session_id: "sess_kiro_live".into(),
                transcript_path: PathBuf::from("/tmp/kiro/messages.jsonl"),
                tty: Some("ttys042".into()),
                lifecycle: AgentLifecycleState::Working,
                last_subtitle: Some("Running bash".into()),
                modified: None,
                turn_completed_at: None,
            },
        );

        // 1. Claude exited and Kiro is now live on `ttys042`: Kiro's live session wins (NOT stale Claude, NOT standby_info)!
        let kiro_live = Some(HashSet::from(["kiro"]));
        let resolved_kiro = WorkspaceTreeBuilder::resolve_surface_agent_info(
            "surf-reuse",
            "claude",
            "terminal",
            Some("/dev/ttys042"),
            &hook_index,
            &kiro_by_tty,
            &kiro_live,
        )
        .expect("resolved kiro");
        assert_eq!(resolved_kiro.agent_kind, "kiro");
        assert_eq!(resolved_kiro.session_id, "sess_kiro_live");
        assert_eq!(resolved_kiro.status, "running");
        assert_eq!(
            resolved_kiro.transcript_path.as_deref(),
            Some("/tmp/kiro/messages.jsonl")
        );

        // 2. Claude exited and Codex just launched (standby, no hook record yet): Codex standby wins!
        let codex_live = Some(HashSet::from(["codex"]));
        let resolved_codex = WorkspaceTreeBuilder::resolve_surface_agent_info(
            "surf-reuse",
            "claude",
            "terminal",
            Some("/dev/ttys042"),
            &hook_index,
            &kiro_by_tty,
            &codex_live,
        )
        .expect("resolved codex standby");
        assert_eq!(resolved_codex.agent_kind, "codex");
        assert_eq!(resolved_codex.status, "ready");

        // 3. Claude exited to plain `zsh` (`live_kinds` empty): returns `None`!
        let zsh_only: Option<HashSet<&'static str>> = Some(HashSet::new());
        assert!(
            WorkspaceTreeBuilder::resolve_surface_agent_info(
                "surf-reuse",
                "claude",
                "terminal",
                Some("/dev/ttys042"),
                &hook_index,
                &kiro_by_tty,
                &zsh_only,
            )
            .is_none()
        );
    }

    #[test]
    fn test_parse_unread_notification_counts() {
        let raw = r#"{
            "notifications": [
                {"id": "n1", "workspace_id": "ws-1", "surface_id": "s-1", "is_read": false},
                {"id": "n2", "workspace_id": "ws-1", "surface_id": "s-2", "is_read": false},
                {"id": "n3", "workspace_id": "ws-1", "surface_id": "s-1", "is_read": true},
                {"id": "n4", "workspace_id": "ws-2", "surface_id": "s-9", "is_read": true}
            ]
        }"#;
        let (by_ws, by_surf) = parse_unread_notification_counts(raw);
        assert_eq!(by_ws.get("ws-1"), Some(&2));
        assert_eq!(by_ws.get("ws-2"), None);
        assert_eq!(by_surf.get("s-1"), Some(&1));
        assert_eq!(by_surf.get("s-2"), Some(&1));
        assert_eq!(by_surf.get("s-9"), None);
    }
}
