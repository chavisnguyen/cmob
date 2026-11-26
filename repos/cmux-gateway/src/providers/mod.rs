pub mod antigravity;
pub mod claude;
pub mod codex;
pub mod common;
pub mod kiro;
pub mod opencode;

use crate::domain::noise_filter::record_timestamp_ms;
use crate::protocol::event::{AgentEvent, AgentTurn};

pub use codex::{codex_child_rollout_stamp, codex_child_status, refresh_working_codex_subagents};

#[derive(Default, Clone)]
pub struct ProviderParseState {
    pub codex: codex::CodexState,
    pub antigravity: antigravity::AntigravityState,
    pub open_thinking_ms: Option<u64>,
}

/// Dispatches a single JSONL record to its owning provider parser and tracks pure-thinking durations.
pub fn parse_transcript_line(
    trimmed: &str,
    surface_id: &str,
    state: &mut ProviderParseState,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };

    let line_ts = record_timestamp_ms(&val);
    common::settle_open_thinking(&mut state.open_thinking_ms, line_ts, current_turn);

    let prev_turn_id = current_turn.as_ref().map(|t| t.id.clone());
    let prev_events_len = current_turn.as_ref().map_or(0, |t| t.events.len());

    if val.get("type").is_none() && val.get("payload").and_then(|p| p.get("type")).is_some() {
        kiro::parse_line(&val, surface_id, current_turn, turns);
    } else if val
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| matches!(t, "session_meta" | "event_msg" | "response_item" | "turn_context"))
    {
        codex::parse_line(&val, surface_id, &mut state.codex, current_turn, turns);
    } else if val
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| {
            matches!(
                t,
                "USER_INPUT" | "REQUEST" | "PLANNER_RESPONSE" | "GENERIC" | "SYSTEM_MESSAGE"
            )
        })
    {
        antigravity::parse_line(
            val,
            surface_id,
            &mut state.antigravity,
            current_turn,
            turns,
        );
    } else {
        claude::parse_line(val, surface_id, current_turn, turns);
    }

    // Only keep `open_thinking_ms` open when THIS record ended on pure thinking without tool calls
    // or assistant prose on the same record (ignoring trailing `Usage` metadata events).
    let ended_pure_thinking = if let Some(ct) = current_turn.as_ref() {
        let start_idx = if prev_turn_id.as_deref() == Some(ct.id.as_str()) {
            prev_events_len.min(ct.events.len())
        } else {
            0
        };
        let added_non_usage: Vec<&AgentEvent> = ct.events[start_idx..]
            .iter()
            .filter(|e| !matches!(e, AgentEvent::Usage { .. }))
            .collect();
        !added_non_usage.is_empty()
            && added_non_usage
                .iter()
                .all(|e| matches!(e, AgentEvent::Thinking { duration_secs: None, .. }))
    } else {
        false
    };

    if ended_pure_thinking {
        if state.open_thinking_ms.is_none() {
            state.open_thinking_ms = line_ts;
        }
    } else {
        state.open_thinking_ms = None;
    }
}
