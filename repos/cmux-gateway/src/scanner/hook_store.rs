use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::protocol::event::AgentLifecycleState;

/// Single session record stored in ~/.cmuxterm/*-hook-sessions.json
/// Sources:
/// - ref/cmux/agent-chat/transcript-sources.ts:1-60
/// - ref/cmux/CLI/cmux.swift:2337-2382
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookSessionRecord {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "surfaceId")]
    pub surface_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(rename = "agentLifecycle", default)]
    pub agent_lifecycle: Option<String>,
    #[serde(rename = "runtimeStatus", default)]
    pub runtime_status: Option<String>,
    #[serde(rename = "transcriptPath", default)]
    pub transcript_path: Option<String>,
    #[serde(rename = "lastBody", default)]
    pub last_body: Option<String>,
    #[serde(rename = "lastSubtitle", default)]
    pub last_subtitle: Option<String>,
    #[serde(rename = "hookEventName", default)]
    pub hook_event_name: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<f64>,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<f64>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(rename = "turnSettled", default)]
    pub turn_settled: Option<bool>,
    #[serde(rename = "launchCommand", default)]
    pub launch_command: Option<HookLaunchCommand>,
    /// Inferred or explicit agent kind ("claude", "antigravity", "codex", "kiro")
    #[serde(default)]
    pub agent_kind: Option<String>,
    #[serde(rename = "toolName", default)]
    pub tool_name: Option<String>,
}

const STALE_AFTER_SECS: f64 = 30.0 * 60.0;
const TAIL_BYTES: u64 = 512 * 1024;

fn unix_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Last complete JSON record of a JSONL file (reads only the tail).
fn last_jsonl_record(path: &str) -> Option<serde_json::Value> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines()
        .rev()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
}

/// Antigravity transcript_full.jsonl: a turn ends with `PLANNER_RESPONSE`, `status: DONE`, and no
/// `tool_calls`. Measured on 226 local transcripts: 1256/1257 records right before the next
/// `USER_INPUT` match; mid-turn matches (521) are followed by a `SYSTEM_MESSAGE` wake-up in 506 cases,
/// i.e. the agent finished and waits for helpers (Orca does not show working then either:
/// `workingMode: 'monitoring'` => null, native-chat-live-status.ts:100).
pub fn antigravity_record_is_final_reply(r: &serde_json::Value) -> bool {
    r.get("type").and_then(|t| t.as_str()) == Some("PLANNER_RESPONSE")
        && r.get("status").and_then(|t| t.as_str()) == Some("DONE")
        && r.get("tool_calls").map_or(true, |t| t.is_null() || t.as_array().is_some_and(|a| a.is_empty()))
}

/// Codex subagent rollouts (`thread_source: "subagent"`) carry their parent in `session_meta.payload`
/// (`parent_thread_id`, also `source.subagent.thread_spawn.parent_thread_id`). Verified on
/// ~/.codex/sessions/2026/11/14/rollout-*-01a1d922-7cdb-*.jsonl (parent `01a1d910-...`, source `cli`).
pub fn codex_parent_thread_id(first_line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    payload
        .get("parent_thread_id")
        .or_else(|| payload.pointer("/source/subagent/thread_spawn/parent_thread_id"))
        .and_then(|x| x.as_str())
        .map(str::to_string)
}

/// `~/.codex/sessions/<Y>/<M>/<D>/rollout-<timestamp>-<thread id>.jsonl` for a thread id.
pub fn find_codex_rollout(thread_id: &str, near: &Path) -> Option<PathBuf> {
    let suffix = format!("-{thread_id}.jsonl");
    let matches_in = |dir: &Path| -> Option<PathBuf> {
        fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
        })
    };
    // Parent and child are normally created on the same day.
    if let Some(found) = near.parent().and_then(matches_in) {
        return Some(found);
    }
    // Otherwise walk the date tree, newest first.
    let root = near.ancestors().find(|a| a.file_name().and_then(|n| n.to_str()) == Some("sessions"))?;
    let sorted_dirs = |dir: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = fs::read_dir(dir)
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        v.sort();
        v.reverse();
        v
    };
    for y in sorted_dirs(root) {
        for m in sorted_dirs(&y) {
            for d in sorted_dirs(&m) {
                if let Some(found) = matches_in(&d) {
                    return Some(found);
                }
            }
        }
    }
    None
}

static CODEX_ROLLOUT_CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Upper bound when reading the first line of a transcript (a corrupt/huge single-line file must not
/// be pulled into memory every scan). Codex `session_meta` lines are far smaller than this.
const MAX_FIRST_LINE_BYTES: u64 = 1024 * 1024;

/// The hook record's `sessionId` is the user's conversation, but its `transcriptPath` is overwritten
/// by whichever thread fired the latest hook, including subagents. Follow `parent_thread_id` up to
/// the top-level rollout (max 4 hops). Returns the input path when it is already top-level or the
/// parent rollout cannot be found.
pub fn resolve_codex_top_level_rollout(path: &str) -> String {
    if let Some(hit) = CODEX_ROLLOUT_CACHE.lock().ok().and_then(|c| c.get(path).cloned()) {
        return hit;
    }
    let mut current = PathBuf::from(path);
    for _ in 0..4 {
        let Ok(file) = fs::File::open(&current) else { return path.to_string() };
        let mut first = String::new();
        if BufReader::new(std::io::Read::take(file, MAX_FIRST_LINE_BYTES)).read_line(&mut first).is_err() || first.trim().is_empty() {
            return path.to_string(); // not written yet: do not cache
        }
        match codex_parent_thread_id(&first).and_then(|id| find_codex_rollout(&id, &current)) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    let resolved = current.to_string_lossy().into_owned();
    if let Ok(mut c) = CODEX_ROLLOUT_CACHE.lock() {
        c.insert(path.to_string(), resolved.clone());
    }
    resolved
}

/// transcript path -> parent session id (`None` = top-level). The first transcript line never
/// changes, so it is read once per path.
static PARENT_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Parent conversation of a subagent transcript, from its first JSONL record.
/// Verified on real Antigravity transcripts (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
/// transcript_full.jsonl): a top-level conversation starts with `"type":"USER_INPUT"`; a subagent starts
/// with `"type":"SYSTEM_MESSAGE"` whose content contains `sender=<parent-uuid>`.
/// `sender=<uuid>` inside an Antigravity SYSTEM_MESSAGE `content`.
pub fn parse_system_message_sender(content: &str) -> Option<String> {
    let start = content.find("sender=")? + "sender=".len();
    let id: String = content[start..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect();
    (id.len() == 36).then_some(id)
}

pub fn parse_subagent_parent(first_line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(first_line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("SYSTEM_MESSAGE") {
        return None;
    }
    let content = v.get("content").and_then(|c| c.as_str())?;
    let start = content.find("sender=")? + "sender=".len();
    let id: String = content[start..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect();
    (id.len() == 36).then_some(id)
}

impl HookSessionRecord {
    /// `Some(parent_id)` when this session is a subagent spawned by another conversation.
    pub fn parent_session_id(&self) -> Option<String> {
        let path = self.transcript_path.as_deref()?;
        if let Some(hit) = PARENT_CACHE.lock().ok().and_then(|c| c.get(path).cloned()) {
            return hit;
        }
        let file = fs::File::open(path).ok()?;
        let mut first = String::new();
        BufReader::new(std::io::Read::take(file, MAX_FIRST_LINE_BYTES)).read_line(&mut first).ok()?;
        if first.trim().is_empty() {
            return None; // not written yet; do not cache
        }
        let parent = parse_subagent_parent(&first);
        if let Ok(mut c) = PARENT_CACHE.lock() {
            c.insert(path.to_string(), parent.clone());
        }
        parent
    }

    /// Resolved agent lifecycle matching Orca's multi-lane status feed:
    /// Idle, Working, Waiting, Done, Error.
    /// Sources:
    /// - ref/orca/src/shared/agent-status/contracts/agent-status-types.ts:29-35
    /// - ref/orca/src/shared/agent-hook-listener/providers/antigravity-events.ts:80-125
    pub fn resolved_lifecycle(&self) -> AgentLifecycleState {
        // 1. Errors
        if let Some(event) = self.hook_event_name.as_deref() {
            if event == "StopFailure" {
                return AgentLifecycleState::Error;
            }
        }
        if matches!(self.runtime_status.as_deref(), Some("error")) {
            return AgentLifecycleState::Error;
        }

        // 2. Waiting (needsInput, permission prompt, or ask_question tool)
        if matches!(
            self.agent_lifecycle.as_deref(),
            Some("needsInput")
        ) || matches!(
            self.runtime_status.as_deref(),
            Some("needsInput")
        ) {
            return AgentLifecycleState::Waiting;
        }
        if let Some(event) = self.hook_event_name.as_deref() {
            if event == "PermissionRequest" {
                return AgentLifecycleState::Waiting;
            }
            if event == "PreToolUse" {
                if let Some(tool) = self.tool_name.as_deref() {
                    if matches!(
                        tool,
                        "ask_question" | "ask_permission" | "AskUserQuestion" | "ask_user_question"
                    ) {
                        return AgentLifecycleState::Waiting;
                    }
                }
            }
        }

        // 3. Done / Finished
        if let Some(event) = self.hook_event_name.as_deref() {
            if matches!(event, "Stop" | "session.created") {
                return AgentLifecycleState::Done;
            }
        }
        if self.turn_settled == Some(true) {
            return AgentLifecycleState::Done;
        }

        // 4. Working / In-flight
        if matches!(
            self.hook_event_name.as_deref(),
            Some("PreInvocation" | "UserPromptSubmit" | "PostToolUse" | "PostInvocation")
        ) || self.turn_settled == Some(false)
            || self.runtime_status.as_deref() == Some("running")
            || self.agent_lifecycle.as_deref() == Some("running")
        {
            return AgentLifecycleState::Working;
        }

        AgentLifecycleState::Idle
    }

    /// `resolved_lifecycle` (last hook event only) corrected with evidence the hook store misses:
    /// 1. Staleness (Orca `AGENT_STATUS_STALE_AFTER_MS`, ref/orca/src/shared/agent-status/contracts/
    ///    agent-status-freshness.ts:3-4): Working/Waiting with no hook update for 30 min => Idle.
    /// 2. Transcript override (Orca `liveStatusOverride`, src/shared/native-chat/native-chat-live-status.ts:
    ///    133-167): the transcript was written after the last hook event and shows a finished reply => Done.
    ///    Fixes turns whose `Stop` hook was never recorded (live case: last event `PreInvocation`).
    pub fn live_lifecycle(&self) -> AgentLifecycleState {
        let base = self.resolved_lifecycle();
        if !matches!(base, AgentLifecycleState::Working | AgentLifecycleState::Waiting) {
            return base;
        }
        if let Some(updated) = self.updated_at {
            if unix_now() - updated > STALE_AFTER_SECS {
                return AgentLifecycleState::Idle;
            }
        }
        if base == AgentLifecycleState::Working {
            if let Some(state) = self.transcript_override() {
                return state;
            }
        }
        base
    }

    /// What the transcript says about a turn the hook still reports as Working (see `turn_marks`):
    /// finished => Done, interrupted (Esc) => Idle, still going / no evidence => None (trust the hook).
    fn transcript_override(&self) -> Option<AgentLifecycleState> {
        use crate::scanner::turn_marks::{claude_last_mark, codex_last_mark, read_tail, TurnMark};
        let kind = crate::cmux::agents::spec_for(self.resolved_agent_kind()).map(|s| s.kind)?;
        if kind == "antigravity" {
            return self.transcript_shows_finished_reply().then_some(AgentLifecycleState::Done);
        }
        let (path, updated) = (self.transcript_path.as_deref()?, self.updated_at?);
        let mark = match kind {
            "claude" => claude_last_mark(&read_tail(path)?),
            "codex" => codex_last_mark(&read_tail(path)?),
            _ => None,
        }?;
        // The mark must be newer than the hook event it would override. A new prompt fires its hook before the
        // agent writes anything, so a previous turn's "completed" mark is older than that hook and is ignored.
        // Records carry their own timestamp; fall back to the file's mtime when one is missing.
        let newer = match mark.at {
            Some(at) => at >= updated - 1.0,
            None => fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|d| d.as_secs_f64() >= updated),
        };
        if !newer {
            return None;
        }
        match mark.state {
            TurnMark::Completed => Some(AgentLifecycleState::Done),
            TurnMark::Interrupted => Some(AgentLifecycleState::Idle),
            TurnMark::Working => None,
        }
    }

    /// True when the transcript is newer than the last hook event and its last record is a
    /// completed final reply. Antigravity only; Claude and Codex are decoded in `turn_marks`
    /// (Orca src/main/native-chat/transcript-turn-lifecycle.ts).
    fn transcript_shows_finished_reply(&self) -> bool {
        if self.resolved_agent_kind() != "antigravity" {
            return false;
        }
        let (Some(path), Some(updated)) = (self.transcript_path.as_deref(), self.updated_at) else {
            return false;
        };
        let Some(mtime) = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
        else {
            return false;
        };
        // A new prompt fires the hook before its USER_INPUT reaches the transcript: trust the hook.
        if mtime < updated {
            return false;
        }
        last_jsonl_record(path).is_some_and(|r| antigravity_record_is_final_reply(&r))
    }

    /// Check if this session is currently active/running.
    pub fn is_running(&self) -> bool {
        self.live_lifecycle() == AgentLifecycleState::Working
    }

    /// Best effort detection of agent kind
    pub fn resolved_agent_kind(&self) -> &str {
        if let Some(kind) = &self.agent_kind {
            return kind.as_str();
        }
        if let Some(launcher) = self.launch_command.as_ref().and_then(|cmd| cmd.launcher.as_deref()) {
            return launcher;
        }
        "agent"
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookLaunchCommand {
    #[serde(default)]
    pub launcher: Option<String>,
    #[serde(rename = "executablePath", default)]
    pub executable_path: Option<String>,
    #[serde(rename = "workingDirectory", default)]
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveSurfaceEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveWorkspaceEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<f64>,
}

/// Structure of a ~/.cmuxterm/*-hook-sessions.json file
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HookSessionsFile {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub sessions: HashMap<String, HookSessionRecord>,
    #[serde(rename = "activeSessionsBySurface", default)]
    pub active_sessions_by_surface: HashMap<String, ActiveSurfaceEntry>,
    #[serde(rename = "activeSessionsByWorkspace", default)]
    pub active_sessions_by_workspace: HashMap<String, ActiveWorkspaceEntry>,
}

/// Consolidated hook store indexing all discovered agent sessions across surfaces and workspaces.
#[derive(Debug, Clone, Default)]
pub struct HookStoreIndex {
    pub sessions_by_id: HashMap<String, HookSessionRecord>,
    pub sessions_by_surface: HashMap<String, Vec<HookSessionRecord>>,
    pub sessions_by_workspace: HashMap<String, Vec<HookSessionRecord>>,
}

impl HookStoreIndex {
    /// Return the default directory where cmux stores hook session JSON files (~/.cmuxterm/)
    pub fn default_cmuxterm_dir() -> PathBuf {
        if let Ok(override_dir) = std::env::var("CMUX_HOOK_SESSIONS_DIR") {
            return PathBuf::from(override_dir);
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".cmuxterm")
    }

    /// Load and scan hook files from the given directory (e.g. ~/.cmuxterm)
    pub fn scan_dir(dir: &Path) -> Self {
        let mut index = Self::default();
        if !dir.exists() || !dir.is_dir() {
            return index;
        }

        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return index,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(agent_kind) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|name| name.strip_suffix("-hook-sessions.json"))
            {
                index.load_file(&path, agent_kind);
            }
        }

        index
    }

    /// Load a single hook sessions file and merge into the index
    pub fn load_file(&mut self, path: &Path, agent_kind: &str) {
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return,
        };

        let file_data: HookSessionsFile = match serde_json::from_str(&content) {
            Ok(d) => d,
            Err(_) => return,
        };

        for (_, mut record) in file_data.sessions {
            if record.agent_kind.is_none() {
                record.agent_kind = Some(agent_kind.to_string());
            }
            if record.agent_kind.as_deref() == Some("codex") {
                if let Some(path) = record.transcript_path.take() {
                    record.transcript_path = Some(resolve_codex_top_level_rollout(&path));
                }
            }

            self.sessions_by_surface
                .entry(record.surface_id.clone())
                .or_default()
                .push(record.clone());

            self.sessions_by_workspace
                .entry(record.workspace_id.clone())
                .or_default()
                .push(record.clone());

            self.sessions_by_id
                .insert(record.session_id.clone(), record);
        }
    }

    /// Retrieve the most relevant (latest updated) session for a given surface
    /// Latest-updated session on the surface, walking up from a subagent to its top-level
    /// conversation: subagents share the surface/pid with their parent and are updated more
    /// recently, but they are not the chat the user is having.
    pub fn get_active_session_for_surface(&self, surface_id: &str) -> Option<&HookSessionRecord> {
        let list = self.sessions_by_surface.get(surface_id)?;
        let mut current = list.iter().max_by(|a, b| {
            let a_time = a.updated_at.unwrap_or(0.0);
            let b_time = b.updated_at.unwrap_or(0.0);
            a_time
                .partial_cmp(&b_time)
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;
        for _ in 0..8 {
            match current.parent_session_id().and_then(|p| self.sessions_by_id.get(&p)) {
                Some(parent) => current = parent,
                None => break,
            }
        }
        Some(current)
    }

    /// Check if any session belonging to this workspace is currently running
    /// Mirrors Swift cmux logic: ref/cmux/CLI/cmux.swift:2337-2382
    pub fn is_workspace_running(&self, workspace_id: &str) -> bool {
        if let Some(sessions) = self.sessions_by_workspace.get(workspace_id) {
            sessions.iter().any(|s| s.is_running())
        } else {
            false
        }
    }

    /// Get the latest turn snippet (lastBody) for a workspace, if available
    pub fn get_workspace_snippet(&self, workspace_id: &str) -> Option<String> {
        let sessions = self.sessions_by_workspace.get(workspace_id)?;
        let mut sorted = sessions.clone();
        sorted.sort_by(|a, b| {
            let b_time = b.updated_at.unwrap_or(0.0);
            let a_time = a.updated_at.unwrap_or(0.0);
            b_time
                .partial_cmp(&a_time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for s in sorted {
            if let Some(body) = s.last_body {
                let trimmed = body.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_claude_hook_session() {
        let json = r#"{
            "activeSessionsBySurface": {
                "4BEC6107-D94C-4DDE-93AF-3835F68B0E93": {
                    "sessionId": "f6c4368e-faef-4b60-9432-e1ca1a198168",
                    "updatedAt": 1794480443.85
                }
            },
            "sessions": {
                "f6c4368e-faef-4b60-9432-e1ca1a198168": {
                    "sessionId": "f6c4368e-faef-4b60-9432-e1ca1a198168",
                    "surfaceId": "4BEC6107-D94C-4DDE-93AF-3835F68B0E93",
                    "workspaceId": "4EA5F151-84D5-41E3-A92B-D9A082DD1EBC",
                    "cwd": "/Users/dev/project-a",
                    "agentLifecycle": "idle",
                    "runtimeStatus": "idle",
                    "lastBody": "Đã lưu vào work/, commit và push (3cb442d).",
                    "updatedAt": 1794480443.85,
                    "transcriptPath": "/tmp/f6c4368e.jsonl"
                }
            }
        }"#;

        let parsed: HookSessionsFile = serde_json::from_str(json).expect("parse hook file");
        assert_eq!(parsed.sessions.len(), 1);
        let s = parsed.sessions.get("f6c4368e-faef-4b60-9432-e1ca1a198168").unwrap();
        assert_eq!(s.surface_id, "4BEC6107-D94C-4DDE-93AF-3835F68B0E93");
        assert_eq!(s.workspace_id, "4EA5F151-84D5-41E3-A92B-D9A082DD1EBC");
        assert_eq!(s.is_running(), false);
        assert_eq!(s.last_body.as_deref(), Some("Đã lưu vào work/, commit và push (3cb442d)."));
    }

    #[test]
    fn test_running_state_detection() {
        let mut index = HookStoreIndex::default();
        let record_running = HookSessionRecord {
            session_id: "s1".to_string(),
            surface_id: "surf1".to_string(),
            workspace_id: "ws1".to_string(),
            cwd: None,
            agent_lifecycle: Some("running".to_string()),
            runtime_status: Some("running".to_string()),
            transcript_path: None,
            last_body: Some("Working on tests...".to_string()),
            last_subtitle: None,
            hook_event_name: None,
            updated_at: Some(unix_now()) /* fresh: live_lifecycle decays records idle > 30 min */,
            started_at: None,
            pid: None,
            turn_settled: None,
            launch_command: None,
            agent_kind: Some("antigravity".to_string()),
            tool_name: None,
        };

        index.sessions_by_workspace.entry("ws1".to_string()).or_default().push(record_running.clone());
        index.sessions_by_surface.entry("surf1".to_string()).or_default().push(record_running.clone());

        assert!(index.is_workspace_running("ws1"));
        assert!(!index.is_workspace_running("ws-unknown"));
        assert_eq!(index.get_workspace_snippet("ws1").as_deref(), Some("Working on tests..."));
        assert_eq!(record_running.resolved_lifecycle(), AgentLifecycleState::Working);

        // Test waiting state on needsInput
        let mut record_waiting = record_running.clone();
        record_waiting.agent_lifecycle = Some("needsInput".to_string());
        assert_eq!(record_waiting.resolved_lifecycle(), AgentLifecycleState::Waiting);
        assert!(!record_waiting.is_running());

        // Test waiting state on PreToolUse with ask_question
        let mut record_ask = record_running.clone();
        record_ask.hook_event_name = Some("PreToolUse".to_string());
        record_ask.tool_name = Some("ask_question".to_string());
        assert_eq!(record_ask.resolved_lifecycle(), AgentLifecycleState::Waiting);
        assert!(!record_ask.is_running());

        // Test error state on StopFailure
        let mut record_err = record_running.clone();
        record_err.hook_event_name = Some("StopFailure".to_string());
        assert_eq!(record_err.resolved_lifecycle(), AgentLifecycleState::Error);
        assert!(!record_err.is_running());

        // Verify that Stop hook event marks session as NOT running even if process is running
        let record_stopped = HookSessionRecord {
            hook_event_name: Some("Stop".to_string()),
            turn_settled: Some(false),
            ..record_running.clone()
        };
        assert!(!record_stopped.is_running());

        // Verify that StopFailure marks session as NOT running
        let record_failed = HookSessionRecord {
            hook_event_name: Some("StopFailure".to_string()),
            ..record_stopped.clone()
        };
        assert!(!record_failed.is_running());

        // Verify that PreInvocation marks session as running
        let record_in_flight = HookSessionRecord {
            hook_event_name: Some("PreInvocation".to_string()),
            ..record_stopped
        };
        assert!(record_in_flight.is_running());
    }

    #[test]
    fn test_parse_subagent_parent() {
        let sub = r#"{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"x <SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T00:22:30Z sender=56296f97-9a38-4be0-8aac-c1d2f9fc36da priority=HIGH"}"#;
        assert_eq!(parse_subagent_parent(sub).as_deref(), Some("56296f97-9a38-4be0-8aac-c1d2f9fc36da"));
        let main = r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>pull</USER_REQUEST>"}"#;
        assert_eq!(parse_subagent_parent(main), None);
    }

    #[test]
    fn test_active_session_prefers_parent_over_subagent() {
        let dir = std::env::temp_dir().join(format!("cmux-sub-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let parent_id = "56296f97-9a38-4be0-8aac-c1d2f9fc36da";
        let main_t = dir.join("main.jsonl");
        let sub_t = dir.join("sub.jsonl");
        fs::write(&main_t, "{\"type\":\"USER_INPUT\",\"content\":\"hi\"}\n").unwrap();
        fs::write(&sub_t, format!("{{\"type\":\"SYSTEM_MESSAGE\",\"content\":\"sender={parent_id} x\"}}\n")).unwrap();
        let json = serde_json::json!({
            "sessions": {
                parent_id: {"sessionId": parent_id, "surfaceId": "S", "workspaceId": "W", "updatedAt": 1.0,
                            "transcriptPath": main_t.to_string_lossy()},
                "sub": {"sessionId": "sub", "surfaceId": "S", "workspaceId": "W", "updatedAt": 2.0,
                        "transcriptPath": sub_t.to_string_lossy()}
            }
        });
        let f = dir.join("antigravity-hook-sessions.json");
        fs::write(&f, json.to_string()).unwrap();
        let mut idx = HookStoreIndex::default();
        idx.load_file(&f, "antigravity");
        assert_eq!(idx.get_active_session_for_surface("S").unwrap().session_id, parent_id);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_antigravity_final_reply_detection() {
        let done = serde_json::json!({"type":"PLANNER_RESPONSE","status":"DONE","content":"1, 2, 3"});
        let tool = serde_json::json!({"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"read_file"}]});
        let generic = serde_json::json!({"type":"GENERIC","status":"RUNNING"});
        assert!(antigravity_record_is_final_reply(&done));
        assert!(!antigravity_record_is_final_reply(&tool));
        assert!(!antigravity_record_is_final_reply(&generic));
    }

    fn working_record(updated_at: f64, transcript: Option<String>) -> HookSessionRecord {
        serde_json::from_value(serde_json::json!({
            "sessionId": "s", "surfaceId": "S", "workspaceId": "W",
            "hookEventName": "PreInvocation", "agentLifecycle": "running", "turnSettled": false,
            "updatedAt": updated_at, "agent_kind": "antigravity", "transcriptPath": transcript
        }))
        .unwrap()
    }

    #[test]
    fn test_live_lifecycle_stale_and_transcript_override() {
        // Stale working => idle
        let stale = working_record(unix_now() - 31.0 * 60.0, None);
        assert_eq!(stale.resolved_lifecycle(), AgentLifecycleState::Working);
        assert_eq!(stale.live_lifecycle(), AgentLifecycleState::Idle);

        let dir = std::env::temp_dir().join(format!("cmux-lc-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let t = dir.join("t.jsonl");
        fs::write(&t, "{\"type\":\"USER_INPUT\",\"status\":\"DONE\"}\n{\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"ok\"}\n").unwrap();
        let path = t.to_string_lossy().into_owned();

        // Transcript written after the last hook event with a final reply => done
        let finished = working_record(unix_now() - 60.0, Some(path.clone()));
        assert_eq!(finished.live_lifecycle(), AgentLifecycleState::Done);

        // Hook newer than transcript (new prompt just submitted) => still working
        let new_turn = working_record(unix_now() + 5.0, Some(path));
        assert_eq!(new_turn.live_lifecycle(), AgentLifecycleState::Working);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_codex_subagent_rollout_resolves_to_parent() {
        let dir = std::env::temp_dir().join(format!("cmux-codex-{}", std::process::id())).join("sessions/2026/11/14");
        let _ = fs::create_dir_all(&dir);
        let parent = "01a1d910-1e30-7e92-ac12-4130aeed880f";
        let child = "01a1d922-7cdb-7410-87e9-07e98987d18d";
        let parent_f = dir.join(format!("rollout-2026-11-14T15-17-54-{parent}.jsonl"));
        let child_f = dir.join(format!("rollout-2026-11-14T15-17-58-{child}.jsonl"));
        fs::write(&parent_f, format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{parent}\",\"source\":\"cli\"}}}}\n")).unwrap();
        fs::write(
            &child_f,
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{child}\",\"thread_source\":\"subagent\",\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{parent}\"}}}}}}}}}}\n"),
        )
        .unwrap();
        assert_eq!(
            resolve_codex_top_level_rollout(&child_f.to_string_lossy()),
            parent_f.to_string_lossy()
        );
        // Top-level stays as is
        assert_eq!(resolve_codex_top_level_rollout(&parent_f.to_string_lossy()), parent_f.to_string_lossy());
        let first = fs::read_to_string(&child_f).unwrap();
        assert_eq!(codex_parent_thread_id(&first).as_deref(), Some(parent));
        let _ = fs::remove_dir_all(dir.parent().unwrap().parent().unwrap().parent().unwrap().parent().unwrap());
    }

    fn claude_record(updated_at: f64, transcript: &str, event: &str) -> HookSessionRecord {
        serde_json::from_value(serde_json::json!({
            "sessionId": "s", "surfaceId": "S", "workspaceId": "W",
            "hookEventName": event, "agentLifecycle": "running", "turnSettled": false,
            "updatedAt": updated_at, "agent_kind": "claude", "transcriptPath": transcript
        }))
        .unwrap()
    }

    /// The reported bug: the agent finished (and wrote `end_turn`) but the hook still says Working, so the chat
    /// kept showing "Thinking…" for up to 30 minutes.
    #[test]
    fn claude_finished_turn_is_done_even_if_the_hook_still_says_working() {
        let dir = std::env::temp_dir().join(format!("cmux-claude-lc-{}-{}", std::process::id(), line!()));
        let _ = fs::create_dir_all(&dir);
        let t = dir.join("t.jsonl");
        let now = unix_now();
        let iso = |secs: f64| {
            // seconds -> RFC3339 via the same civil-date math, inverted for the test
            let days = (secs / 86400.0).floor() as i64;
            let rem = secs - days as f64 * 86400.0;
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:06.3}Z", (rem / 3600.0) as i64, ((rem % 3600.0) / 60.0) as i64, rem % 60.0)
        };
        let prompt = format!(r#"{{"type":"user","timestamp":"{}","message":{{"role":"user","content":"go"}}}}"#, iso(now - 50.0));
        let reply = format!(r#"{{"type":"assistant","timestamp":"{}","message":{{"stop_reason":"end_turn","content":[{{"type":"text","text":"done"}}]}}}}"#, iso(now - 10.0));
        fs::write(&t, format!("{prompt}\n{reply}\n{{\"type\":\"cost-state\"}}\n")).unwrap();
        let path = t.to_string_lossy().into_owned();

        // hook last heard from 60 s ago (PostToolUse), the reply landed 10 s ago => finished
        let rec = claude_record(now - 60.0, &path, "PostToolUse");
        assert_eq!(rec.resolved_lifecycle(), AgentLifecycleState::Working);
        assert_eq!(rec.live_lifecycle(), AgentLifecycleState::Done);

        // a NEW prompt's hook (5 s ago) is newer than that reply: the old "completed" mark must not win
        let new_turn = claude_record(now - 5.0, &path, "UserPromptSubmit");
        assert_eq!(new_turn.live_lifecycle(), AgentLifecycleState::Working);

        // interrupted with Esc => idle, not "working" and not "turn finished"
        let intr = format!(r#"{{"type":"user","interruptedMessageId":"x","timestamp":"{}","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}}}}"#, iso(now - 3.0));
        fs::write(&t, format!("{prompt}\n{intr}\n{{\"type\":\"cost-state\"}}\n")).unwrap();
        assert_eq!(claude_record(now - 20.0, &path, "PreToolUse").live_lifecycle(), AgentLifecycleState::Idle);
        let _ = fs::remove_dir_all(dir);
    }
}
