//! Pure lifecycle, workspace status, and awaiting-prompt / notification-preview derivation rules.

use std::collections::HashSet;

use crate::domain::notification_text::{
    is_generic_placeholder, normalize_text, strip_markdown_for_notification, BODY_MAX_CHARS,
};
use crate::domain::workspace_model::SurfaceNode;
use crate::protocol::event::{AgentEvent, AgentLifecycleState, AgentTurn};

pub const STALE_AFTER_SECS: f64 = 30.0 * 60.0;

/// Derives workspace badge status AFTER surface resolution so:
/// 1. Crashed or closed surfaces never keep a workspace `"running"` for 30 minutes.
/// 2. Hook-less agents (Kiro) and SQLite-backed agents (OpenCode) mark the workspace `"running"` / `"waiting"`.
pub fn derive_workspace_status(surfaces: &[SurfaceNode]) -> String {
    let mut has_waiting = false;
    for surf in surfaces {
        if let Some(agent) = &surf.agent {
            match agent.status.as_str() {
                "running" => return "running".to_string(),
                "waiting" => has_waiting = true,
                _ => {}
            }
        }
    }
    if has_waiting {
        "waiting".to_string()
    } else {
        "idle".to_string()
    }
}

/// Applies staleness and transcript overrides to a hook-derived lifecycle state:
/// - `Working` decays to `Idle` after 30m (`STALE_AFTER_SECS`) without hook updates.
/// - `Waiting` does NOT decay to `Idle` at 30m when `process_alive == Some(true)` (TTY liveness confirms
///   the agent process is still alive waiting on the user).
pub fn apply_staleness_and_override(
    base: AgentLifecycleState,
    age_secs: Option<f64>,
    process_alive: Option<bool>,
    transcript_override: Option<AgentLifecycleState>,
) -> AgentLifecycleState {
    if !matches!(base, AgentLifecycleState::Working | AgentLifecycleState::Waiting) {
        return base;
    }
    if let Some(override_state) = transcript_override {
        return override_state;
    }
    if let Some(age) = age_secs
        && age > STALE_AFTER_SECS
    {
        let keep_waiting = base == AgentLifecycleState::Waiting && process_alive == Some(true);
        if !keep_waiting {
            return AgentLifecycleState::Idle;
        }
    }
    base
}

/// True when `last_event` is an in-flight turn hook (`PreInvocation`, `UserPromptSubmit`, etc.) whose
/// `lastBody` is stale carryover from an earlier finished turn rather than a permission/waiting prompt.
pub fn is_stale_in_flight_hook_body(last_event: Option<&str>) -> bool {
    matches!(
        last_event,
        Some("PreInvocation" | "UserPromptSubmit" | "PostToolUse" | "PostInvocation")
    )
}

pub fn summarize_tool_detail(detail: &str) -> String {
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(detail) {
        let primary = [
            "cmd",
            "command",
            "CommandLine",
            "file_path",
            "path",
            "Path",
            "patch",
            "url",
            "pattern",
            "query",
            "script",
        ]
        .into_iter()
        .find_map(|k| {
            map.get(k)
                .and_then(|v| v.as_str())
                .map(|s| normalize_text(Some(s), 200))
        })
        .filter(|s| !s.is_empty());
        let reason = ["justification", "reason", "toolSummary", "description"]
            .into_iter()
            .find_map(|k| {
                map.get(k)
                    .and_then(|v| v.as_str())
                    .map(|s| normalize_text(Some(s), 120))
            })
            .filter(|s| !s.is_empty());
        match (primary, reason) {
            (Some(p), Some(r)) => return format!("{r}\n{p}"),
            (Some(p), None) => return p,
            (None, Some(r)) => return r,
            (None, None) => {}
        }
    }
    normalize_text(Some(detail), 220)
}

pub fn ended_tool_ids(turns: &[AgentTurn]) -> HashSet<&str> {
    let mut ended = HashSet::new();
    for turn in turns {
        for ev in &turn.events {
            if let AgentEvent::ToolEnd { tool_id, .. } = ev {
                ended.insert(tool_id.as_str());
            }
        }
    }
    ended
}

/// Finds the latest unanswered `AwaitingInput` prompt across `turns`.
pub fn latest_unanswered_awaiting_prompt(turns: &[AgentTurn], max_chars: usize) -> Option<String> {
    for turn in turns.iter().rev() {
        for ev in turn.events.iter().rev() {
            if let AgentEvent::AwaitingInput(ai) = ev
                && ai.answered.is_none()
            {
                let s = normalize_text(Some(&ai.prompt), max_chars);
                if !s.is_empty() && !is_generic_placeholder(&s) {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// Finds the latest `ToolStart` that has NOT been paired with a `ToolEnd`.
pub fn derive_pending_tool_prompt(turns: &[AgentTurn], include_summary: bool) -> Option<String> {
    let ended = ended_tool_ids(turns);
    for turn in turns.iter().rev() {
        for ev in turn.events.iter().rev() {
            if let AgentEvent::ToolStart { tool_id, name, detail } = ev {
                if ended.contains(tool_id.as_str()) {
                    continue;
                }
                let tool = normalize_text(Some(name), 60);
                if include_summary {
                    let summary = detail.as_deref().map(summarize_tool_detail).unwrap_or_default();
                    if !tool.is_empty() && !summary.is_empty() {
                        return Some(format!("{tool}: {summary}"));
                    }
                }
                if !tool.is_empty() {
                    return Some(format!("Approve tool: {tool}"));
                }
            }
        }
    }
    None
}

/// Unified `awaiting_prompt` derivation for `readSession` / `chat.update`.
pub fn derive_awaiting_prompt_from_parts(
    lifecycle: AgentLifecycleState,
    last_event: Option<&str>,
    last_body: Option<&str>,
    last_subtitle: Option<&str>,
    tool_name: Option<&str>,
    turns: &[AgentTurn],
    screen_context: Option<&str>,
) -> Option<String> {
    if lifecycle != AgentLifecycleState::Waiting {
        return None;
    }

    let stale_hook_body = is_stale_in_flight_hook_body(last_event);
    let body = if stale_hook_body {
        String::new()
    } else {
        normalize_text(last_body, 240)
    };

    if !body.is_empty()
        && !is_generic_placeholder(&body)
        && !body.eq_ignore_ascii_case("approval needed")
    {
        return Some(body);
    }
    if let Some(ask_prompt) = latest_unanswered_awaiting_prompt(turns, 240) {
        return Some(ask_prompt);
    }
    if let Some(screen_text) = screen_context.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(screen_text.to_string());
    }
    if let Some(pending) = derive_pending_tool_prompt(turns, true) {
        return Some(pending);
    }
    let tool = normalize_text(tool_name, 60);
    if !tool.is_empty() {
        return Some(format!("Approve tool: {tool}"));
    }
    if !body.is_empty() {
        return Some(body);
    }
    if !stale_hook_body {
        let subtitle = normalize_text(last_subtitle, 160);
        if !subtitle.is_empty() && !is_generic_placeholder(&subtitle) {
            return Some(subtitle);
        }
    }
    Some("Agent requested approval".to_string())
}

/// Unified transcript preview extraction for push/desktop notifications (skips `ToolStart`s already
/// paired with `ToolEnd` and skips already-answered `AwaitingInput` events).
pub fn extract_transcript_preview_from_turns(
    turns: &[AgentTurn],
    lifecycle: AgentLifecycleState,
) -> Option<String> {
    if lifecycle == AgentLifecycleState::Waiting
        && let Some(ask_prompt) = latest_unanswered_awaiting_prompt(turns, BODY_MAX_CHARS)
    {
        return Some(ask_prompt);
    }

    for turn in turns.iter().rev() {
        for ev in turn.events.iter().rev() {
            match (lifecycle, ev) {
                (AgentLifecycleState::Error, AgentEvent::Error { message }) => {
                    let s = normalize_text(Some(message), BODY_MAX_CHARS);
                    if !s.is_empty() && !is_generic_placeholder(&s) {
                        return Some(s);
                    }
                }
                (AgentLifecycleState::Done, AgentEvent::Assistant { text }) => {
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

    if lifecycle == AgentLifecycleState::Waiting
        && let Some(pending_tool) = derive_pending_tool_prompt(turns, false)
    {
        return Some(pending_tool);
    }

    for turn in turns.iter().rev() {
        for ev in turn.events.iter().rev() {
            match (lifecycle, ev) {
                (AgentLifecycleState::Waiting, AgentEvent::Assistant { text })
                | (AgentLifecycleState::Error, AgentEvent::Assistant { text }) => {
                    let stripped = strip_markdown_for_notification(text);
                    let s = normalize_text(Some(&stripped), BODY_MAX_CHARS);
                    if !s.is_empty() && !is_generic_placeholder(&s) {
                        return Some(s);
                    }
                }
                (AgentLifecycleState::Done, AgentEvent::Done { stats: Some(stats) }) => {
                    let s = normalize_text(Some(stats), BODY_MAX_CHARS);
                    if !s.is_empty() && !is_generic_placeholder(&s) {
                        return Some(s);
                    }
                }
                _ => {}
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::workspace_model::SurfaceAgentInfo;
    use crate::protocol::event::{AgentRole, AwaitingInput};

    #[test]
    fn workspace_status_reflects_live_surfaces_including_kiro() {
        let surf = |status: &str| SurfaceNode {
            id: "s1".into(),
            r#ref: "surface:1".into(),
            title: "kiro-cli".into(),
            surface_type: "terminal".into(),
            tty: Some("ttys001".into()),
            selected: true,
            focused: true,
            unread_count: 0,
            agent: Some(SurfaceAgentInfo {
                session_id: "sess_1".into(),
                agent_kind: "kiro".into(),
                status: status.into(),
                transcript_path: None,
            }),
        };
        assert_eq!(derive_workspace_status(&[]), "idle");
        assert_eq!(derive_workspace_status(&[surf("idle")]), "idle");
        assert_eq!(derive_workspace_status(&[surf("waiting")]), "waiting");
        assert_eq!(derive_workspace_status(&[surf("waiting"), surf("running")]), "running");
    }

    #[test]
    fn waiting_does_not_decay_at_30m_when_tty_agent_is_alive() {
        assert_eq!(
            apply_staleness_and_override(
                AgentLifecycleState::Waiting,
                Some(45.0 * 60.0),
                Some(true),
                None,
            ),
            AgentLifecycleState::Waiting
        );
        assert_eq!(
            apply_staleness_and_override(
                AgentLifecycleState::Waiting,
                Some(45.0 * 60.0),
                Some(false),
                None,
            ),
            AgentLifecycleState::Idle
        );
        assert_eq!(
            apply_staleness_and_override(
                AgentLifecycleState::Working,
                Some(45.0 * 60.0),
                Some(true),
                None,
            ),
            AgentLifecycleState::Idle
        );
    }

    #[test]
    fn ignores_stale_preinvocation_body_and_completed_tool_starts() {
        let mut turn = AgentTurn::new("t1", "s1", AgentRole::Assistant);
        turn.events.push(AgentEvent::ToolStart {
            tool_id: "done-1".into(),
            name: "read_file".into(),
            detail: Some(r#"{"Path":"/tmp/a.rs"}"#.into()),
        });
        turn.events.push(AgentEvent::ToolEnd {
            tool_id: "done-1".into(),
            name: Some("read_file".into()),
            detail: Some("ok".into()),
            ok: true,
        });
        turn.events.push(AgentEvent::AwaitingInput(AwaitingInput {
            tool_id: None,
            input_kind: "question".into(),
            prompt: "Which database should we use?".into(),
            options: Some(vec!["Postgres".into(), "SQLite".into()]),
            default_choice: None,
            multi_select: None,
            questions: None,
            answered: None,
        }));

        let prompt = derive_awaiting_prompt_from_parts(
            AgentLifecycleState::Waiting,
            Some("PreInvocation"),
            Some("Stale Turn 1 summary from Stop hook"),
            None,
            None,
            &[turn.clone()],
            None,
        );
        assert_eq!(prompt.as_deref(), Some("Which database should we use?"));

        // If AwaitingInput was already answered, paired ToolStart `read_file` must NOT be reported as pending!
        if let AgentEvent::AwaitingInput(ai) = &mut turn.events[2] {
            ai.answered = Some("SQLite".into());
        }
        assert_eq!(derive_pending_tool_prompt(&[turn], true), None);
    }
}
