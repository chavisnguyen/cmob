use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::protocol::event::{AgentEvent, AgentLifecycleState};
use crate::scanner::hook_store::HookSessionRecord;
use crate::scanner::liveness::WorkspaceRuntimeStore;
use crate::scanner::transcript::TranscriptReader;

pub use crate::domain::notification_text::{
    is_generic_placeholder, normalize_text, strip_markdown_for_notification, BODY_MAX_CHARS,
    MAX_PUSH_TAG_LEN, TITLE_MAX_CHARS,
};

/// Wait out brief Done -> Working transitions (e.g. Antigravity mid-turn PLANNER_RESPONSE
/// followed by SYSTEM_MESSAGE wake-up) before announcing a finished turn.
/// Matches Orca `AGENT_DONE_QUIET_MS` (ref/orca/src/shared/agent-status/lifecycle/agent-transitions.ts:11).
pub const AGENT_DONE_QUIET_MS: u64 = 1_500;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SurfaceContext {
    pub workspace_title: Option<String>,
    pub workspace_dir: Option<String>,
    pub surface_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationContent {
    pub title: String,
    pub subtitle: Option<String>,
    pub body: String,
    pub tag: String,
    pub category: &'static str,
    pub urgent: bool,
    pub agent_kind: String,
    pub agent_display: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Alert {
        notification_id: String,
        surface_id: String,
        workspace_id: String,
        session_id: String,
        lifecycle: AgentLifecycleState,
        record: HookSessionRecord,
    },
    Dismiss {
        surface_id: String,
        tags: Vec<String>,
    },
}

#[derive(Debug, Clone)]
struct PendingDone {
    deadline: Instant,
    turn_stamp: Option<f64>,
    record: HookSessionRecord,
}

#[derive(Debug, Clone, Default)]
struct SurfaceTracker {
    session_id: String,
    last_lifecycle: Option<AgentLifecycleState>,
    working_seen: bool,
    announced_turn_stamp: Option<f64>,
    pending_done: Option<PendingDone>,
    active_alert: bool,
}

/// Stateful per-surface turn notification engine matching Orca's `TerminalAgentTurnNews`
/// (ref/orca/src/main/runtime/push/notifications/terminal-agent-turn-news.ts).
pub struct NotificationEngine {
    quiet_window: Duration,
    trackers: HashMap<String, SurfaceTracker>,
    seq: u64,
}

impl Default for NotificationEngine {
    fn default() -> Self {
        Self::new(Duration::from_millis(AGENT_DONE_QUIET_MS))
    }
}

impl NotificationEngine {
    pub fn new(quiet_window: Duration) -> Self {
        Self {
            quiet_window,
            trackers: HashMap::new(),
            seq: 0,
        }
    }

    /// Seeds baseline state from existing hook sessions without emitting notifications.
    pub fn seed(&mut self, sessions: &[&HookSessionRecord]) {
        self.seed_with(sessions, HookSessionRecord::live_lifecycle);
    }

    pub fn seed_in(&mut self, sessions: &[&HookSessionRecord], runtime: &WorkspaceRuntimeStore) {
        self.seed_with(sessions, |rec| rec.live_lifecycle_in(runtime));
    }

    fn seed_with(
        &mut self,
        sessions: &[&HookSessionRecord],
        lifecycle_fn: impl Fn(&HookSessionRecord) -> AgentLifecycleState,
    ) {
        for rec in sessions {
            let lifecycle = lifecycle_fn(rec);
            let mut tracker = SurfaceTracker {
                session_id: rec.session_id.clone(),
                last_lifecycle: Some(lifecycle),
                working_seen: lifecycle == AgentLifecycleState::Working,
                announced_turn_stamp: None,
                pending_done: None,
                active_alert: false,
            };
            if lifecycle == AgentLifecycleState::Done {
                tracker.announced_turn_stamp = rec.turn_completed_stamp();
            }
            self.trackers.insert(rec.surface_id.clone(), tracker);
        }
    }

    /// Processes the latest active top-level sessions per surface and returns any immediate alerts,
    /// matured quiet-window alerts, or dismissals.
    pub fn step(&mut self, sessions: &[&HookSessionRecord], now: Instant) -> Vec<EngineEvent> {
        self.step_with(sessions, now, HookSessionRecord::live_lifecycle)
    }

    pub fn step_in(
        &mut self,
        sessions: &[&HookSessionRecord],
        now: Instant,
        runtime: &WorkspaceRuntimeStore,
    ) -> Vec<EngineEvent> {
        self.step_with(sessions, now, |rec| rec.live_lifecycle_in(runtime))
    }

    fn step_with(
        &mut self,
        sessions: &[&HookSessionRecord],
        now: Instant,
        lifecycle_fn: impl Fn(&HookSessionRecord) -> AgentLifecycleState,
    ) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        let mut present_surfaces = std::collections::HashSet::with_capacity(sessions.len());

        for rec in sessions {
            present_surfaces.insert(rec.surface_id.clone());
            let lifecycle = lifecycle_fn(rec);
            let tracker = self.trackers.entry(rec.surface_id.clone()).or_default();

            if !tracker.session_id.is_empty() && tracker.session_id != rec.session_id {
                tracker.pending_done = None;
                tracker.announced_turn_stamp = None;
                tracker.last_lifecycle = None;
                tracker.working_seen = false;
                if tracker.active_alert && matches!(lifecycle, AgentLifecycleState::Working | AgentLifecycleState::Idle) {
                    tracker.active_alert = false;
                    events.push(EngineEvent::Dismiss {
                        surface_id: rec.surface_id.clone(),
                        tags: all_surface_tags(&rec.surface_id),
                    });
                }
            }
            tracker.session_id = rec.session_id.clone();
            let prev = tracker.last_lifecycle;

            match lifecycle {
                AgentLifecycleState::Working => {
                    tracker.working_seen = true;
                    tracker.announced_turn_stamp = None;
                    tracker.pending_done = None;
                    if tracker.active_alert && prev != Some(AgentLifecycleState::Working) {
                        tracker.active_alert = false;
                        events.push(EngineEvent::Dismiss {
                            surface_id: rec.surface_id.clone(),
                            tags: all_surface_tags(&rec.surface_id),
                        });
                    }
                }
                AgentLifecycleState::Idle => {
                    tracker.working_seen = false;
                    tracker.announced_turn_stamp = None;
                    tracker.pending_done = None;
                    if tracker.active_alert && prev != Some(AgentLifecycleState::Idle) {
                        tracker.active_alert = false;
                        events.push(EngineEvent::Dismiss {
                            surface_id: rec.surface_id.clone(),
                            tags: all_surface_tags(&rec.surface_id),
                        });
                    }
                }
                AgentLifecycleState::Waiting => {
                    tracker.pending_done = None;
                    if prev != Some(AgentLifecycleState::Waiting) {
                        tracker.active_alert = true;
                        let id = next_notification_id(&mut self.seq, &rec.surface_id);
                        events.push(EngineEvent::Alert {
                            notification_id: id,
                            surface_id: rec.surface_id.clone(),
                            workspace_id: rec.workspace_id.clone(),
                            session_id: rec.session_id.clone(),
                            lifecycle,
                            record: (*rec).clone(),
                        });
                    }
                }
                AgentLifecycleState::Error => {
                    tracker.pending_done = None;
                    if prev != Some(AgentLifecycleState::Error) {
                        tracker.active_alert = true;
                        let id = next_notification_id(&mut self.seq, &rec.surface_id);
                        events.push(EngineEvent::Alert {
                            notification_id: id,
                            surface_id: rec.surface_id.clone(),
                            workspace_id: rec.workspace_id.clone(),
                            session_id: rec.session_id.clone(),
                            lifecycle,
                            record: (*rec).clone(),
                        });
                    }
                }
                AgentLifecycleState::Done => {
                    let turn_stamp = rec.turn_completed_stamp();
                    let new_turn_between_polls = prev == Some(AgentLifecycleState::Done)
                        && turn_stamp.is_some()
                        && tracker.announced_turn_stamp.is_some()
                        && turn_stamp != tracker.announced_turn_stamp;
                    let entered_done = matches!(
                        prev,
                        Some(AgentLifecycleState::Working | AgentLifecycleState::Waiting)
                    ) || new_turn_between_polls;

                    if entered_done {
                        let already_announced = turn_stamp.is_some()
                            && tracker.announced_turn_stamp == turn_stamp;
                        if !already_announced {
                            let wait_quiet = tracker.working_seen && !self.quiet_window.is_zero();
                            if wait_quiet {
                                let should_schedule = tracker
                                    .pending_done
                                    .as_ref()
                                    .is_none_or(|p| p.turn_stamp != turn_stamp);
                                if should_schedule {
                                    tracker.pending_done = Some(PendingDone {
                                        deadline: now + self.quiet_window,
                                        turn_stamp,
                                        record: (*rec).clone(),
                                    });
                                } else if let Some(pending) = tracker.pending_done.as_mut() {
                                    // Refresh record during the 1.5s quiet window so a late `lastBody`
                                    // update is included when the matured notification fires!
                                    pending.record = (*rec).clone();
                                }
                            } else {
                                tracker.working_seen = false;
                                tracker.pending_done = None;
                                if let Some(stamp) = turn_stamp {
                                    tracker.announced_turn_stamp = Some(stamp);
                                }
                                tracker.active_alert = true;
                                let id = next_notification_id(&mut self.seq, &rec.surface_id);
                                events.push(EngineEvent::Alert {
                                    notification_id: id,
                                    surface_id: rec.surface_id.clone(),
                                    workspace_id: rec.workspace_id.clone(),
                                    session_id: rec.session_id.clone(),
                                    lifecycle,
                                    record: (*rec).clone(),
                                });
                            }
                        }
                    }
                }
            }

            tracker.last_lifecycle = Some(lifecycle);
        }

        // Remove surfaces that no longer have an active top-level session.
        self.trackers.retain(|surface_id, tracker| {
            if present_surfaces.contains(surface_id) {
                return true;
            }
            if tracker.active_alert {
                events.push(EngineEvent::Dismiss {
                    surface_id: surface_id.clone(),
                    tags: all_surface_tags(surface_id),
                });
            }
            false
        });

        // Fire matured quiet windows.
        let ready_surfaces: Vec<String> = self
            .trackers
            .iter()
            .filter_map(|(sid, t)| {
                t.pending_done
                    .as_ref()
                    .filter(|p| now >= p.deadline)
                    .map(|_| sid.clone())
            })
            .collect();

        for surface_id in ready_surfaces {
            let id = next_notification_id(&mut self.seq, &surface_id);
            if let Some(tracker) = self.trackers.get_mut(&surface_id) {
                if let Some(pending) = tracker.pending_done.take() {
                    tracker.working_seen = false;
                    if let Some(stamp) = pending.turn_stamp {
                        tracker.announced_turn_stamp = Some(stamp);
                    }
                    tracker.active_alert = true;
                    events.push(EngineEvent::Alert {
                        notification_id: id,
                        surface_id,
                        workspace_id: pending.record.workspace_id.clone(),
                        session_id: pending.record.session_id.clone(),
                        lifecycle: AgentLifecycleState::Done,
                        record: pending.record,
                    });
                }
            }
        }

        events
    }

}

fn next_notification_id(seq: &mut u64, surface_id: &str) -> String {
    *seq = seq.wrapping_add(1);
    format!("notif-{}-{}", sanitize_id_part(surface_id, 12), *seq)
}

/// Deterministic, <= 32-char `[A-Za-z0-9_-]` Web Push & Service Worker tag per `(surface_id, category)`.
pub fn make_push_tag(surface_id: &str, category: &str) -> String {
    let prefix = match category {
        "needs-permission" => "cmux_p_",
        "turn-finished" => "cmux_d_",
        "agent-error" => "cmux_e_",
        "cmux-dialog" => "cmux_g_",
        _ => "cmux_a_",
    };
    let hash = fnv1a_64(format!("{surface_id}:{category}").as_bytes());
    let short_surf = sanitize_id_part(surface_id, 8);
    let tag = if short_surf.is_empty() {
        format!("{prefix}{hash:016x}")
    } else {
        format!("{prefix}{short_surf}_{hash:016x}")
    };
    tag.chars().take(MAX_PUSH_TAG_LEN).collect()
}

pub fn all_surface_tags(surface_id: &str) -> Vec<String> {
    ["needs-permission", "turn-finished", "agent-error", "cmux-dialog"]
        .into_iter()
        .map(|cat| make_push_tag(surface_id, cat))
        .collect()
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn sanitize_id_part(raw: &str, max_len: usize) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(max_len)
        .collect()
}

pub fn format_context_label(ctx: &SurfaceContext) -> String {
    let ws = normalize_text(ctx.workspace_title.as_deref(), TITLE_MAX_CHARS);
    let dir_name = ctx
        .workspace_dir
        .as_deref()
        .and_then(|d| Path::new(d).file_name())
        .and_then(|n| n.to_str())
        .map(|s| normalize_text(Some(s), TITLE_MAX_CHARS))
        .unwrap_or_default();
    let repo_label = if !ws.is_empty() { ws } else { dir_name };
    let surf_label = normalize_text(ctx.surface_title.as_deref(), TITLE_MAX_CHARS);

    let combined = match (repo_label.is_empty(), surf_label.is_empty()) {
        (false, false) if !repo_label.eq_ignore_ascii_case(&surf_label) => {
            format!("{repo_label} / {surf_label}")
        }
        (false, _) => repo_label,
        (true, false) => surf_label,
        (true, true) => "workspace".to_string(),
    };
    normalize_text(Some(&combined), TITLE_MAX_CHARS)
}

struct SnippetCacheMap {
    clock: u64,
    entries: HashMap<String, (u64, u128, u64, Option<String>)>,
}

static WORKSPACE_SNIPPET_CACHE: LazyLock<Mutex<SnippetCacheMap>> = LazyLock::new(|| {
    Mutex::new(SnippetCacheMap {
        clock: 0,
        entries: HashMap::new(),
    })
});
const MAX_WORKSPACE_SNIPPET_CACHE: usize = 128;

fn transcript_stamp_for_snippet(transcript_path: &str) -> Option<(u128, u64)> {
    let target = match crate::scanner::opencode_store::parse_pseudo_path(Path::new(transcript_path)) {
        Some((db, _)) => db,
        None => std::path::PathBuf::from(transcript_path),
    };
    let meta = std::fs::metadata(target).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime_ns, meta.len()))
}

fn is_bare_image_placeholder(text: &str) -> bool {
    let t = text.trim();
    t.starts_with("[Image") && t.ends_with(']') && !t[1..t.len() - 1].contains(']')
}

/// Cached latest conversation snippet from a session transcript (matching cmux desktop sidebar:
/// prefers the newest assistant reply / active prompt over stale `latest_conversation_message`).
pub fn cached_transcript_workspace_snippet(transcript_path: &str, surface_id: &str) -> Option<String> {
    let (mtime_ns, len) = transcript_stamp_for_snippet(transcript_path)?;
    if let Ok(mut store) = WORKSPACE_SNIPPET_CACHE.lock() {
        store.clock = store.clock.wrapping_add(1);
        let tick = store.clock;
        if let Some((used_at, c_mtime, c_len, cached)) = store.entries.get_mut(transcript_path) {
            if *c_mtime == mtime_ns && *c_len == len {
                *used_at = tick;
                return cached.clone();
            }
        }
    }

    let computed = (|| -> Option<String> {
        let turns = TranscriptReader::read_recent_turns(Path::new(transcript_path), surface_id, 6).ok()?;
        // 1. Newest assistant reply / awaiting-input / error across recent turns.
        for turn in turns.iter().rev() {
            for ev in turn.events.iter().rev() {
                match ev {
                    AgentEvent::AwaitingInput(ai) => {
                        let s = normalize_text(Some(&ai.prompt), BODY_MAX_CHARS);
                        if !s.is_empty() && !is_generic_placeholder(&s) {
                            return Some(s);
                        }
                    }
                    AgentEvent::Error { message } => {
                        let s = normalize_text(Some(message), BODY_MAX_CHARS);
                        if !s.is_empty() && !is_generic_placeholder(&s) {
                            return Some(s);
                        }
                    }
                    AgentEvent::Assistant { text } => {
                        let stripped = strip_markdown_for_notification(text);
                        let s = normalize_text(Some(&stripped), BODY_MAX_CHARS);
                        if !s.is_empty() && !is_generic_placeholder(&s) {
                            return Some(s);
                        }
                    }
                    _ => {}
                }
            }
        }
        // 2. Brand-new session before any assistant reply: use the user's prompt unless it is a bare image chip.
        for turn in turns.iter().rev() {
            for ev in turn.events.iter().rev() {
                if let AgentEvent::User { text } = ev {
                    let cleaned = TranscriptReader::clean_user_prompt(text);
                    let stripped = strip_markdown_for_notification(&cleaned);
                    let s = normalize_text(Some(&stripped), BODY_MAX_CHARS);
                    if !s.is_empty() && !is_generic_placeholder(&s) && !is_bare_image_placeholder(&s) {
                        return Some(s);
                    }
                }
            }
        }
        None
    })();

    if let Ok(mut store) = WORKSPACE_SNIPPET_CACHE.lock() {
        store.clock = store.clock.wrapping_add(1);
        let tick = store.clock;
        while store.entries.len() >= MAX_WORKSPACE_SNIPPET_CACHE
            && !store.entries.contains_key(transcript_path)
        {
            let Some(oldest) = store
                .entries
                .iter()
                .min_by_key(|(_, (used_at, _, _, _))| *used_at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            store.entries.remove(&oldest);
        }
        store.entries.insert(
            transcript_path.to_string(),
            (tick, mtime_ns, len, computed.clone()),
        );
    }

    computed
}

/// Extracts a concise preview from the session transcript when hook metadata lacks rich text.
pub fn extract_transcript_preview(
    transcript_path: &str,
    surface_id: &str,
    lifecycle: AgentLifecycleState,
) -> Option<String> {
    let turns = TranscriptReader::read_recent_turns(Path::new(transcript_path), surface_id, 6).ok()?;
    crate::domain::lifecycle::extract_transcript_preview_from_turns(&turns, lifecycle)
}

/// Builds Orca-style notification title, subtitle, body, and tag for an agent lifecycle event.
pub fn build_notification_content(
    record: &HookSessionRecord,
    lifecycle: AgentLifecycleState,
    ctx: &SurfaceContext,
) -> NotificationContent {
    let agent_kind = record.resolved_agent_kind().to_string();
    let agent_display = crate::cmux::agents::display_name(&agent_kind);
    let context_label = format_context_label(ctx);

    let (category, urgent, verb) = match lifecycle {
        AgentLifecycleState::Waiting => {
            let is_permission = record.hook_event_name.as_deref() == Some("PermissionRequest")
                || record.tool_name.as_deref().is_some_and(|t| !t.trim().is_empty())
                || record
                    .last_body
                    .as_deref()
                    .is_some_and(|b| b.to_ascii_lowercase().contains("permission"));
            (
                "needs-permission",
                true,
                if is_permission { "needs approval" } else { "needs input" },
            )
        }
        AgentLifecycleState::Error => ("agent-error", true, "failed"),
        _ => ("turn-finished", false, "finished"),
    };

    let title = format!("{context_label} - {agent_display} {verb}");

    let subtitle_candidate = ctx
        .surface_title
        .as_deref()
        .or(ctx.workspace_title.as_deref());
    let subtitle = {
        let s = normalize_text(subtitle_candidate, TITLE_MAX_CHARS);
        (!s.is_empty()).then_some(s)
    };

    let stale_waiting_hook = lifecycle == AgentLifecycleState::Waiting
        && crate::domain::lifecycle::is_stale_in_flight_hook_body(record.hook_event_name.as_deref());

    let rich_hook_text = if stale_waiting_hook {
        None
    } else {
        [record.last_body.as_deref(), record.last_subtitle.as_deref()]
            .into_iter()
            .flatten()
            .map(|s| normalize_text(Some(s), BODY_MAX_CHARS))
            .find(|s| !is_generic_placeholder(s))
    };

    let transcript_preview = if rich_hook_text.is_none() {
        record
            .transcript_path
            .as_deref()
            .and_then(|p| extract_transcript_preview(p, &record.surface_id, lifecycle))
    } else {
        None
    };

    let tool_fallback = if lifecycle == AgentLifecycleState::Waiting {
        record
            .tool_name
            .as_deref()
            .map(|t| normalize_text(Some(t), 60))
            .filter(|t| !t.is_empty())
            .map(|t| format!("Approve tool: {t}"))
    } else {
        None
    };

    let body = rich_hook_text
        .or(transcript_preview)
        .or(tool_fallback)
        .unwrap_or_else(|| format!("{agent_display} {verb}."));

    NotificationContent {
        title,
        subtitle,
        body,
        tag: make_push_tag(&record.surface_id, category),
        category,
        urgent,
        agent_kind,
        agent_display,
    }
}

pub fn build_dialog_notification_content(
    surface_id: &str,
    agent_kind: &str,
    dialog_title: &str,
    ctx: &SurfaceContext,
) -> NotificationContent {
    let agent_display = crate::cmux::agents::display_name(agent_kind);
    let context_label = format_context_label(ctx);
    let body = {
        let b = normalize_text(Some(dialog_title), BODY_MAX_CHARS);
        if b.is_empty() {
            format!("{agent_display} needs your answer.")
        } else {
            b
        }
    };
    let subtitle = {
        let s = normalize_text(
            ctx.surface_title.as_deref().or(ctx.workspace_title.as_deref()),
            TITLE_MAX_CHARS,
        );
        (!s.is_empty()).then_some(s)
    };

    NotificationContent {
        title: format!("{context_label} - {agent_display} needs your answer"),
        subtitle,
        body,
        tag: make_push_tag(surface_id, "cmux-dialog"),
        category: "cmux-dialog",
        urgent: true,
        agent_kind: agent_kind.to_string(),
        agent_display,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_markdown_for_notification ──────────────────────────────────────

    #[test]
    fn strip_bold_and_italic() {
        assert_eq!(strip_markdown_for_notification("**bold** and *italic*"), "bold and italic");
        assert_eq!(strip_markdown_for_notification("__bold__ and _italic_"), "bold and italic");
    }

    #[test]
    fn strip_headings() {
        assert_eq!(strip_markdown_for_notification("# Title\nSome text."), "Title Some text.");
        assert_eq!(strip_markdown_for_notification("## Sub\nBody."), "Sub Body.");
    }

    #[test]
    fn strip_inline_code() {
        assert_eq!(strip_markdown_for_notification("Run `cargo test` to verify."), "Run cargo test to verify.");
    }

    #[test]
    fn strip_links() {
        assert_eq!(
            strip_markdown_for_notification("See [the docs](https://example.com) for details."),
            "See the docs for details."
        );
    }

    #[test]
    fn strip_tables() {
        let md = "| col1 | col2 |\n| --- | --- |\n| a | b |\nDone.";
        let out = strip_markdown_for_notification(md);
        assert!(!out.contains('|'), "table pipes should be gone: {out}");
        assert!(out.contains("Done"), "prose should survive: {out}");
    }

    #[test]
    fn strip_blockquotes() {
        assert_eq!(strip_markdown_for_notification("> Note: be careful."), "Note: be careful.");
    }

    #[test]
    fn strip_hr() {
        let out = strip_markdown_for_notification("Above\n---\nBelow");
        assert!(!out.contains("---"), "hr should be dropped: {out}");
        assert!(out.contains("Above") && out.contains("Below"));
    }

    #[test]
    fn plain_text_passthrough() {
        let plain = "Refactored push dispatcher and all tests pass.";
        assert_eq!(strip_markdown_for_notification(plain), plain);
    }

    #[test]
    fn realistic_claude_response() {
        let md = "## Summary\n\nI've updated `server.rs` to:\n\n- **Fix** the token reload bug\n- Add `muted_categories` support\n\n| File | Change |\n| --- | --- |\n| server.rs | patched |\n\nAll tests pass.";
        let out = strip_markdown_for_notification(md);
        assert!(!out.contains("##"), "headings stripped: {out}");
        assert!(!out.contains("**"), "bold stripped: {out}");
        assert!(!out.contains('|'), "table stripped: {out}");
        assert!(!out.contains('`'), "code stripped: {out}");
        assert!(out.contains("server.rs"), "filenames kept: {out}");
        assert!(out.contains("All tests pass"), "prose kept: {out}");
    }

    fn write_temp_transcript(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cmux-notif-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn make_record(surface_id: &str, session_id: &str, hook_event: &str) -> HookSessionRecord {
        HookSessionRecord {
            session_id: session_id.to_string(),
            surface_id: surface_id.to_string(),
            workspace_id: "ws-1".to_string(),
            cwd: Some("/tmp/cmux-mobile".to_string()),
            agent_lifecycle: None,
            runtime_status: None,
            transcript_path: None,
            last_body: None,
            last_subtitle: None,
            hook_event_name: Some(hook_event.to_string()),
            updated_at: Some(9_999_999_999.0),
            started_at: Some(9_999_999_900.0),
            pid: None,
            turn_settled: None,
            launch_command: None,
            agent_kind: Some("claude".to_string()),
            tool_name: None,
            is_subagent: false,
        }
    }

    #[test]
    fn quiet_window_cancels_when_working_resumes_and_fires_when_quiet_expires() {
        let mut engine = NotificationEngine::new(Duration::from_millis(1500));
        let t0 = Instant::now();
        let rec_work = make_record("surf-1", "sess-1", "PreInvocation");
        engine.seed(&[&rec_work]);

        // Mid-turn Done starts quiet window, does not alert yet.
        let rec_done = make_record("surf-1", "sess-1", "Stop");
        let evs = engine.step(&[&rec_done], t0 + Duration::from_millis(200));
        assert!(evs.is_empty(), "Done should wait out quiet window");

        // Resuming Working within 1500ms cancels the pending Done.
        let evs = engine.step(&[&rec_work], t0 + Duration::from_millis(900));
        assert!(evs.is_empty(), "Working within quiet window must cancel Done");

        // Waiting past original deadline still produces nothing because it was cancelled.
        let evs = engine.step(&[&rec_work], t0 + Duration::from_millis(2000));
        assert!(evs.is_empty());

        // Now transition to Done again and let the quiet window expire.
        let evs = engine.step(&[&rec_done], t0 + Duration::from_millis(2100));
        assert!(evs.is_empty());
        let evs = engine.step(&[&rec_done], t0 + Duration::from_millis(3700));
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            EngineEvent::Alert { lifecycle, surface_id, .. } => {
                assert_eq!(*lifecycle, AgentLifecycleState::Done);
                assert_eq!(surface_id, "surf-1");
            }
            other => panic!("expected Alert, got {other:?}"),
        }
    }

    #[test]
    fn waiting_and_error_alert_immediately_and_dismiss_on_working() {
        let mut engine = NotificationEngine::new(Duration::from_millis(1500));
        let t0 = Instant::now();
        let rec_work = make_record("surf-1", "sess-1", "UserPromptSubmit");
        engine.seed(&[&rec_work]);

        let mut rec_wait = make_record("surf-1", "sess-1", "PermissionRequest");
        rec_wait.tool_name = Some("Bash".to_string());
        let evs = engine.step(&[&rec_wait], t0 + Duration::from_millis(100));
        assert_eq!(evs.len(), 1);
        assert!(matches!(
            &evs[0],
            EngineEvent::Alert { lifecycle: AgentLifecycleState::Waiting, .. }
        ));

        // Returning to Working emits Dismiss for that surface's tags.
        let evs = engine.step(&[&rec_work], t0 + Duration::from_millis(200));
        assert_eq!(evs.len(), 1);
        assert!(matches!(&evs[0], EngineEvent::Dismiss { surface_id, .. } if surface_id == "surf-1"));

        // StopFailure emits Error immediately.
        let rec_err = make_record("surf-1", "sess-1", "StopFailure");
        let evs = engine.step(&[&rec_err], t0 + Duration::from_millis(300));
        assert_eq!(evs.len(), 1);
        assert!(matches!(
            &evs[0],
            EngineEvent::Alert { lifecycle: AgentLifecycleState::Error, .. }
        ));
    }

    #[test]
    fn idle_or_session_created_does_not_fire_done_alert() {
        let mut engine = NotificationEngine::new(Duration::from_millis(1500));
        let t0 = Instant::now();
        // Brand-new session starting in Done (e.g. OpenCode session.created) must not notify.
        let rec_created = make_record("surf-new", "sess-new", "session.created");
        let evs = engine.step(&[&rec_created], t0 + Duration::from_millis(100));
        assert!(evs.is_empty());
        let evs = engine.step(&[&rec_created], t0 + Duration::from_millis(3000));
        assert!(evs.is_empty());
    }

    #[test]
    fn turn_stamp_deduplicates_already_announced_turn() {
        let f = write_temp_transcript(
            "dedupe.jsonl",
            r#"{"type":"assistant","timestamp":"2026-11-16T00:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"Patched server.rs and verified."}]}}
"#,
        );
        let path = f.to_string_lossy().into_owned();

        let mut engine = NotificationEngine::new(Duration::from_millis(1500));
        let t0 = Instant::now();
        let mut rec_done = make_record("surf-1", "sess-1", "Stop");
        rec_done.transcript_path = Some(path.clone());
        // Seed already-finished session: stamp is latched, no alert.
        engine.seed(&[&rec_done]);

        let evs = engine.step(&[&rec_done], t0 + Duration::from_millis(2000));
        assert!(evs.is_empty());
    }

    #[test]
    fn build_notification_content_enriches_with_workspace_and_transcript() {
        let f = write_temp_transcript(
            "enrich.jsonl",
            r#"{"type":"assistant","timestamp":"2026-11-16T00:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"Refactored push dispatcher and all tests pass."}]}}
"#,
        );

        let mut rec = make_record("surf-123", "sess-1", "Stop");
        rec.last_body = Some("Turn finished".to_string()); // generic placeholder should be bypassed
        rec.transcript_path = Some(f.to_string_lossy().into_owned());

        let ctx = SurfaceContext {
            workspace_title: Some("cmux-mobile".to_string()),
            workspace_dir: Some("/Users/test/cmux-mobile".to_string()),
            surface_title: Some("Notification Engine".to_string()),
        };

        let content = build_notification_content(&rec, AgentLifecycleState::Done, &ctx);
        assert_eq!(content.title, "cmux-mobile / Notification Engine - Claude finished");
        assert_eq!(content.body, "Refactored push dispatcher and all tests pass.");
        assert_eq!(content.category, "turn-finished");
        assert!(!content.urgent);
        assert!(content.tag.len() <= MAX_PUSH_TAG_LEN);
        assert!(content.tag.starts_with("cmux_d_"));
    }

    #[test]
    fn build_notification_content_permission_uses_tool_fallback() {
        let mut rec = make_record("surf-abc", "sess-2", "PermissionRequest");
        rec.agent_kind = Some("codex".to_string());
        rec.tool_name = Some("Bash".to_string());
        rec.last_body = Some("Permission".to_string()); // generic placeholder

        let ctx = SurfaceContext {
            workspace_title: Some("cmux-mobile".to_string()),
            workspace_dir: None,
            surface_title: None,
        };

        let content = build_notification_content(&rec, AgentLifecycleState::Waiting, &ctx);
        assert_eq!(content.title, "cmux-mobile - Codex needs approval");
        assert_eq!(content.body, "Approve tool: Bash");
        assert_eq!(content.category, "needs-permission");
        assert!(content.urgent);
    }

    #[test]
    fn push_tags_are_distinct_and_rfc8030_safe() {
        let t1 = make_push_tag("7D3B5E12-AAAA-BBBB-CCCC-111122223333", "needs-permission");
        let t2 = make_push_tag("7D3B5E12-AAAA-BBBB-CCCC-111122223333", "turn-finished");
        let t3 = make_push_tag("99999999-AAAA-BBBB-CCCC-111122223333", "needs-permission");
        for t in [&t1, &t2, &t3] {
            assert!(t.len() <= MAX_PUSH_TAG_LEN);
            assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        }
        assert_ne!(t1, t2);
        assert_ne!(t1, t3);
    }

    #[test]
    fn strip_markdown_preserves_snake_case_while_stripping_emphasis() {
        let out = strip_markdown_for_notification(
            "Updated **turn_digest** and _italic text_ in chat_watcher_stream_v2.",
        );
        assert_eq!(
            out,
            "Updated turn_digest and italic text in chat_watcher_stream_v2."
        );
    }
}
