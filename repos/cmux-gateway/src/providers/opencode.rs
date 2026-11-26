//! OpenCode (`opencode.db` `session_message` rows) turn builder.
//!
//! Sources:
//! - `ref/orca/src/main/native-chat/transcript-opencode2-sqlite.ts`
//! - `ref/orca/src/main/native-chat/transcript-opencode-part-blocks.ts`

use crate::domain::canonical_turn::parse_ask_event;
use crate::domain::noise_filter::record_timestamp_ms;
use crate::domain::receipt_normalizer::extract_opencode_question_answer;
use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, SubagentEntry, SubagentState,
};
use crate::providers::common::{cap_detail, emit_interrupted_status, push_subagent_to_turn};

fn text_of_parts(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn format_state_error(err: Option<&serde_json::Value>) -> Option<String> {
    let e = err?;
    if e.is_null() {
        return None;
    }
    if let Some(s) = e.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(cap_detail(s.to_string()));
    }
    if let Some(m) = e
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(cap_detail(m.to_string()));
    }
    Some(cap_detail(e.to_string()))
}

fn tool_event(part: &serde_json::Value, turn: &mut AgentTurn) {
    let name = part
        .get("name")
        .or_else(|| part.get("tool"))
        .and_then(|n| n.as_str())
        .unwrap_or("tool")
        .to_string();
    let tool_id = part
        .get("callID")
        .or_else(|| part.get("id"))
        .and_then(|i| i.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("tool-{}", turn.events.len()));
    let state = part.get("state");
    let status = state
        .and_then(|s| s.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("completed");
    let state_err = format_state_error(state.and_then(|s| s.get("error")));
    let is_running = matches!(status, "running" | "pending");
    let is_error = status == "error" || state_err.is_some();

    // OpenCode's `question` tool: keep BOTH running AND completed question parts as `AwaitingInput`
    // (completed parts carry `answered: Some(...)` receipt instead of degrading into a raw tool card).
    if name == "question"
        && let Some(mut ask_ev) =
            parse_ask_event(Some(tool_id.clone()), "question", state.and_then(|s| s.get("input")))
    {
        if !is_running
            && let AgentEvent::AwaitingInput(ref mut ai) = ask_ev
        {
            if is_error {
                ai.answered = Some(state_err.unwrap_or_else(|| "Cancelled".to_string()));
            } else {
                ai.answered = Some(
                    extract_opencode_question_answer(state)
                        .unwrap_or_else(|| "Answered".to_string()),
                );
            }
        }
        turn.events.push(ask_ev);
        return;
    }

    if matches!(name.as_str(), "task" | "subagent") {
        let inp = state.and_then(|s| s.get("input"));
        let label = inp
            .and_then(|i| i.get("description").or_else(|| i.get("subagent_type")))
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Subagent")
            .to_string();
        let sub_state = if is_running {
            SubagentState::Working
        } else if is_error {
            SubagentState::Failed
        } else {
            SubagentState::Completed
        };
        let entry = SubagentEntry {
            id: tool_id,
            label,
            state: sub_state,
            tokens: None,
            started_at: None,
            settled_at: None,
        };
        let gid = format!("opencode-subagents-{}", turn.id);
        push_subagent_to_turn(turn, &gid, entry);
        return;
    }

    let detail = state
        .and_then(|s| s.get("input"))
        .map(|i| cap_detail(i.to_string()));
    turn.events.push(AgentEvent::ToolStart {
        tool_id: tool_id.clone(),
        name: name.clone(),
        detail,
    });
    if !is_running {
        let out_detail = state
            .and_then(|s| s.get("output"))
            .and_then(|o| o.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| cap_detail(s.to_string()))
            .or_else(|| {
                state
                    .and_then(|s| s.get("content"))
                    .map(|c| cap_detail(text_of_parts(Some(c))))
                    .filter(|s| !s.trim().is_empty())
            })
            .or(state_err);
        turn.events.push(AgentEvent::ToolEnd {
            tool_id,
            name: Some(name),
            detail: out_detail,
            ok: !is_error,
        });
    }
}

fn assistant_events(data: &serde_json::Value, turn: &mut AgentTurn) {
    for part in data.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        match part.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "reasoning" => {
                if let Some(text) = part
                    .get("text")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.trim().is_empty())
                {
                    turn.events.push(AgentEvent::Thinking {
                        text: text.to_string(),
                        duration_secs: None,
                    });
                }
            }
            "text" => {
                if part.get("synthetic").and_then(|s| s.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(text) = part
                    .get("text")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.trim().is_empty())
                {
                    turn.events.push(AgentEvent::Assistant {
                        text: text.to_string(),
                    });
                }
            }
            "tool" => tool_event(part, turn),
            _ => {}
        }
    }

    if let Some(err_msg) = data
        .pointer("/error/message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        turn.events.push(AgentEvent::Error {
            message: err_msg.to_string(),
        });
    }

    if let Some(tokens) = data.get("tokens") {
        let n = |k: &str| tokens.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let input_tokens = n("input");
        let output_tokens = n("output");
        let cache_read_tokens = tokens
            .pointer("/cache/read")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_creation_tokens = tokens
            .pointer("/cache/write")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if input_tokens > 0
            || output_tokens > 0
            || cache_read_tokens > 0
            || cache_creation_tokens > 0
        {
            turn.events.push(AgentEvent::Usage {
                model: data
                    .pointer("/model/id")
                    .and_then(|m| m.as_str())
                    .map(str::to_string),
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            });
        }
    }
}

fn user_text(data: &serde_json::Value) -> String {
    if let Some(t) = data.get("text").and_then(|t| t.as_str()) {
        return t.to_string();
    }
    data.get("content")
        .and_then(|c| c.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|i| {
                    i.get("type").and_then(|t| t.as_str()) == Some("text")
                        && i.get("synthetic").and_then(|s| s.as_bool()) != Some(true)
                })
                .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn row_turn_id_and_seq(row: &serde_json::Value, fallback_idx: usize) -> (String, u64) {
    if let Some(seq) = row.get("seq").and_then(|s| s.as_u64()) {
        return (format!("turn-oc-{seq}"), seq);
    }
    if let Some(id) = row
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.is_empty())
    {
        return (format!("turn-oc-{id}"), fallback_idx as u64);
    }
    let idx = fallback_idx + 1;
    (format!("turn-oc-{idx}"), idx as u64)
}

/// Builds `AgentTurn`s and their corresponding DB `seq` cursors from chronological `session_message` rows.
pub fn build_turns_with_seqs(
    rows: &[serde_json::Value],
    surface_id: &str,
) -> (Vec<AgentTurn>, Vec<u64>) {
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut seqs: Vec<u64> = Vec::new();
    let mut current: Option<(AgentTurn, u64)> = None;

    let flush_current = |cur: &mut Option<(AgentTurn, u64)>,
                         turns: &mut Vec<AgentTurn>,
                         seqs: &mut Vec<u64>| {
        if let Some((t, s)) = cur.take()
            && !t.events.is_empty()
        {
            turns.push(t);
            seqs.push(s);
        }
    };

    for (row_idx, row) in rows.iter().enumerate() {
        let kind = row.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let ts_ms = record_timestamp_ms(row);
        let (stable_id, row_seq) = row_turn_id_and_seq(row, turns.len() + row_idx);
        let Ok(data) = serde_json::from_str::<serde_json::Value>(
            row.get("data").and_then(|d| d.as_str()).unwrap_or("{}"),
        ) else {
            continue;
        };

        match kind {
            "user" => {
                flush_current(&mut current, &mut turns, &mut seqs);
                let text = user_text(&data);
                let err_msg = data
                    .pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if text.trim().is_empty() && err_msg.is_none() {
                    continue;
                }
                let mut turn = AgentTurn::new(stable_id, surface_id, AgentRole::User);
                turn.timestamp = ts_ms;
                if !text.trim().is_empty() {
                    turn.events.push(AgentEvent::User { text });
                }
                if let Some(em) = err_msg {
                    turn.events.push(AgentEvent::Error {
                        message: em.to_string(),
                    });
                }
                turns.push(turn);
                seqs.push(row_seq);
            }
            "assistant" => {
                let (turn, _) = current.get_or_insert_with(|| {
                    let mut t = AgentTurn::new(stable_id, surface_id, AgentRole::Assistant);
                    t.timestamp = ts_ms;
                    (t, row_seq)
                });
                assistant_events(&data, turn);
            }
            "idle" => {
                if data.get("outcome").and_then(|o| o.as_str()) == Some("interrupted") {
                    if let Some((cur_turn, cur_seq)) = current.take() {
                        let mut cur_opt = Some(cur_turn);
                        emit_interrupted_status(ts_ms, surface_id, &mut cur_opt, &mut turns);
                        if seqs.len() < turns.len() {
                            seqs.push(cur_seq);
                        }
                    } else {
                        let mut cur_opt = None;
                        let prev_len = turns.len();
                        emit_interrupted_status(ts_ms, surface_id, &mut cur_opt, &mut turns);
                        if turns.len() > prev_len {
                            if let Some(last) = turns.last_mut() {
                                last.id = stable_id;
                            }
                            seqs.push(row_seq);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    flush_current(&mut current, &mut turns, &mut seqs);
    (turns, seqs)
}

pub fn build_turns(rows: &[serde_json::Value], surface_id: &str) -> Vec<AgentTurn> {
    build_turns_with_seqs(rows, surface_id).0
}
