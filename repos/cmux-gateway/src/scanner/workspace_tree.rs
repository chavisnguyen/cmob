use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

use crate::cmux::bridge::{CmuxBridgeError, DualTransportCmuxBridge};
use crate::protocol::event::AgentLifecycleState;
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::kiro_store::KiroSessionIndex;

/// In-memory durable identity latching cache: surface_id -> SurfaceAgentInfo
/// Matches Orca's `withRememberedNativeChatIdentity` (ref/orca/mobile/src/session/native-chat/mobile-native-chat-eligibility.ts:88-113)
/// "Missing status is not proof of pane change: retain identity until a new PTY handle replaces it."
static REMEMBERED_SURFACES: LazyLock<RwLock<HashMap<String, SurfaceAgentInfo>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Level 1: Workspace Node matching cmux macOS Sidebar
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceNode {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    pub pinned: bool,
    pub selected: bool,
    /// Status badge: "running" (⚡ Running) or "idle" (⚪ Idle)
    pub status: String,
    pub current_directory: String,
    /// User-chosen sidebar color from cmux (`workspace.list` -> `custom_color`), `#RRGGBB`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Latest notification or turn summary snippet
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Level 2 surfaces inside this workspace
    pub surfaces: Vec<SurfaceNode>,
}

/// Summary item for mobile.workspace.list
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    pub pinned: bool,
    pub selected: bool,
    pub status: String,
    pub current_directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub surface_count: usize,
    pub has_running_agent: bool,
}

/// Level 2: Surface Node (Terminal, Markdown, or Browser tab)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurfaceNode {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    /// "terminal" | "markdown" | "browser"
    pub surface_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<String>,
    pub selected: bool,
    pub focused: bool,
    /// Level 3 Agent metadata if active on this surface
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<SurfaceAgentInfo>,
}

/// Level 3: Active AI Agent metadata
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceAgentInfo {
    pub session_id: String,
    pub agent_kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
}

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

/// Short-lived cache of the last built workspace tree so Kiro / hook-miss `get_surface` calls
/// during conversation open reuse the recent tree instead of re-spawning `cmux tree` + `ps`.
static LAST_TREE_SNAPSHOT: LazyLock<RwLock<Option<(Vec<WorkspaceNode>, std::time::Instant)>>> =
    LazyLock::new(|| RwLock::new(None));
const SURFACE_LOOKUP_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(4);

/// Builder responsible for merging cmux CLI output with HookStoreIndex
pub struct WorkspaceTreeBuilder;

impl WorkspaceTreeBuilder {
    /// Build the full 3-level tree from live cmux instance and hook index
    pub async fn build_tree(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
    ) -> Result<Vec<WorkspaceNode>, CmuxBridgeError> {
        // Run `cmux tree`, `cmux rpc workspace.list`, and `ps` + Kiro lease scan concurrently
        // instead of sequentially so cold-boot tree latency equals max(...) rather than sum(...).
        let tree_fut = bridge.run_command("tree", &["--json", "--id-format", "both"]);
        let ws_list_fut = bridge.rpc_call("workspace.list", None);
        let proc_kiro_fut = tokio::task::spawn_blocking(|| {
            let (pid_ttys, live_agents_by_tty) = Self::scan_processes_snapshot();
            let kiro_by_tty = KiroSessionIndex::scan_default_by_pid_map(&pid_ttys);
            (live_agents_by_tty, kiro_by_tty)
        });

        let (tree_res, ws_list_res, proc_kiro_res) =
            tokio::join!(tree_fut, ws_list_fut, proc_kiro_fut);

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
        crate::scanner::liveness::store_proc_scan(&live_agents_by_tty);

        // Step 3: Combine raw tree, workspace dirs, and hook store index
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

                // Build surface list
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
                        crate::scanner::liveness::record_surface_meta(
                            &surf_id,
                            &surf_ref,
                            &ws_id,
                            Some(&current_directory),
                        );
                        if let Some(tty) = raw_surf.tty.as_deref() {
                            crate::scanner::liveness::record_surface_tty(&surf_id, tty);
                        }

                        // Compute live agent kinds on this TTY FIRST so stale hook records from an
                        // exited agent (e.g. Claude exited, Kiro/Codex/zsh now running) are ignored
                        // and NEVER shadow Kiro's live session!
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
                            if let Ok(mut cache) = REMEMBERED_SURFACES.write() {
                                cache.insert(surf_id.clone(), info.clone());
                            }
                            Some(info)
                        } else if live_kinds.as_ref().is_some_and(|k| k.is_empty()) {
                            if let Ok(mut cache) = REMEMBERED_SURFACES.write() {
                                cache.remove(&surf_id);
                            }
                            None
                        } else if let Ok(cache) = REMEMBERED_SURFACES.read() {
                            cache.get(&surf_id).cloned().filter(|i| still_alive(i))
                        } else {
                            None
                        };

                        let agent_info = agent_info.map(|mut a| {
                            if crate::cmux::startup_dialog::registry::is_waiting(&surf_id) {
                                a.status = "waiting".to_string();
                            }
                            a
                        });

                        surfaces.push(SurfaceNode {
                            id: surf_id,
                            r#ref: surf_ref,
                            title: surf_title,
                            surface_type: surf_type,
                            tty: raw_surf.tty,
                            selected: surf_selected,
                            focused: surf_focused,
                            agent: agent_info,
                        });
                    }
                }

                // Derive workspace status AFTER surface resolution so closed/crashed tabs don't keep
                // workspace "running" for 30m, and Kiro/OpenCode tabs mark workspace "running"/"waiting"!
                let status = crate::domain::lifecycle::derive_workspace_status(&surfaces);

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
                    surfaces,
                });
            }
        }

        // Resolve workspace snippets on a blocking worker (cached by `(path, mtime, len)`):
        // 1. Newest hook session `lastBody` or its `transcriptPath`
        // 2. Discovered surface `agent.transcript_path` (covers hook-less agents like Kiro)
        // 3. Fallback to `cmux rpc workspace.list`'s `latest_conversation_message`
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

        // Prune remembered surfaces and tty cache that no longer exist in cmux
        if let Ok(mut cache) = REMEMBERED_SURFACES.write() {
            cache.retain(|k, _| all_surface_ids.contains(k));
        }
        crate::scanner::liveness::prune_surfaces(&all_surface_ids);

        if let Ok(mut snap) = LAST_TREE_SNAPSHOT.write() {
            *snap = Some((result_workspaces.clone(), std::time::Instant::now()));
        }

        Ok(result_workspaces)
    }

    /// Lightweight workspace summary list for `mobile.workspace.list` (skips `ps` and Kiro scans).
    pub async fn list_workspaces(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
    ) -> Result<Vec<WorkspaceSummary>, CmuxBridgeError> {
        let tree_output = bridge.run_command("tree", &["--json", "--id-format", "both"]).await?;
        let tree_data: RawCmuxTreeOutput = serde_json::from_str(&tree_output)
            .map_err(|e| CmuxBridgeError::JsonParseError(format!("cmux tree: {e}")))?;

        let mut dirs_by_id: HashMap<String, String> = HashMap::new();
        let mut latest_msg_by_id: HashMap<String, String> = HashMap::new();
        let mut color_by_id: HashMap<String, String> = HashMap::new();
        if let Ok(ws_list) = bridge.rpc_call("workspace.list", None).await.and_then(|out| {
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

    /// Retrieve detail for a single surface (reuses recent tree snapshot when fresh to avoid
    /// redundant `cmux tree` + `ps` + Kiro directory scans on conversation open).
    pub async fn get_surface(
        bridge: &DualTransportCmuxBridge,
        hook_index: &HookStoreIndex,
        surface_id: &str,
    ) -> Result<Option<SurfaceNode>, CmuxBridgeError> {
        if let Ok(guard) = LAST_TREE_SNAPSHOT.read() {
            if let Some((cached_tree, built_at)) = guard.as_ref() {
                if built_at.elapsed() < SURFACE_LOOKUP_CACHE_TTL {
                    for ws in cached_tree {
                        for surf in &ws.surfaces {
                            if surf.id == surface_id || surf.r#ref == surface_id {
                                return Ok(Some(surf.clone()));
                            }
                        }
                    }
                }
            }
        }
        let tree = Self::build_tree(bridge, hook_index).await?;
        for ws in tree {
            for surf in ws.surfaces {
                if surf.id == surface_id || surf.r#ref == surface_id {
                    return Ok(Some(surf));
                }
            }
        }
        Ok(None)
    }
    /// Map an executable name to an agent kind, matching Orca's
    /// `recognizeAgentProcessFromCommandLine` (ref/orca/src/shared/agent-status/process/agent-process-recognition.ts:53-71).
    fn kind_from_bin(bin_name: &str) -> Option<&'static str> {
        crate::cmux::agents::kind_from_bin(bin_name)
    }

    /// Accept only `#RRGGBB` (the client puts it into CSS); anything else is dropped.
    pub fn sanitize_hex_color(raw: &str) -> Option<String> {
        let t = raw.trim();
        let hex = t.strip_prefix('#')?;
        (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_uppercase()))
    }

    fn standby_info(agent_kind: &str) -> SurfaceAgentInfo {
        SurfaceAgentInfo {
            session_id: String::new(),
            agent_kind: agent_kind.to_string(),
            status: "ready".to_string(),
            transcript_path: None,
        }
    }

    /// Immediately purges a closed surface from `REMEMBERED_SURFACES` and invalidates `LAST_TREE_SNAPSHOT`.
    pub fn forget_surface(surface_id: &str) {
        if let Ok(mut cache) = REMEMBERED_SURFACES.write() {
            cache.remove(surface_id);
        }
        if let Ok(mut snap) = LAST_TREE_SNAPSHOT.write() {
            *snap = None;
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
        hook_index
            .get_active_session_for_surface_filtered(surf_id, live_kinds.as_ref())
            .map(|s| {
                let canonical_kind = crate::cmux::agents::spec_for(s.resolved_agent_kind())
                    .map(|sp| sp.kind)
                    .unwrap_or_else(|| s.resolved_agent_kind());
                let mut lc = s.live_lifecycle();
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

    /// Single `ps -axo pid=,tty=,command=` scan producing both `pid -> tty` (for Kiro leases) and
    /// `tty -> agent kinds` (for surface liveness).
    pub fn scan_processes_snapshot() -> (HashMap<u32, String>, Option<HashMap<String, HashSet<&'static str>>>) {
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

    /// Group agent processes by controlling tty (`ttys005` etc.). `None` when `ps` fails.
    pub fn scan_agent_processes_by_tty() -> Option<HashMap<String, HashSet<&'static str>>> {
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
        let surf_id = "test-surface-latching-1";
        // Latch an identity
        let info = SurfaceAgentInfo {
            session_id: "sess-1".to_string(),
            agent_kind: "antigravity".to_string(),
            status: "ready".to_string(),
            transcript_path: None,
        };
        if let Ok(mut cache) = REMEMBERED_SURFACES.write() {
            cache.insert(surf_id.to_string(), info.clone());
        }

        // Check that cache retains it even if title would no longer match (e.g. renamed to "git commit")
        if let Ok(cache) = REMEMBERED_SURFACES.read() {
            let remembered = cache.get(surf_id);
            assert_eq!(remembered, Some(&info));
        }
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
}
