//! Kiro CLI (`<KIRO_HOME>/sessions/*/*/messages.jsonl`) transcript line decoder.

use crate::domain::noise_filter::record_timestamp_ms;
use crate::domain::receipt_normalizer::extract_kiro_resolved_answer;
use crate::protocol::event::{
    AgentEvent, AgentTurn, AwaitingInput, SubagentEntry, SubagentState,
};
use crate::providers::common::{
    assistant_turn, cap_detail, mutate_subagent_by_ids, push_subagent_to_turn,
    start_user_turn_with_ts,
};

pub fn parse_line(
    val: &serde_json::Value,
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let ts_ms = record_timestamp_ms(val);
    let Some(p) = val.get("payload") else { return };
    let s = |k: &str| p.get(k).and_then(|v| v.as_str());
    match s("type").unwrap_or("") {
        "user" => {
            let text = s("content").unwrap_or("").to_string();
            start_user_turn_with_ts(text, ts_ms, surface_id, current_turn, turns);
        }
        "assistant" => {
            let text = s("content").unwrap_or("");
            if text.trim().is_empty() {
                return;
            }
            let ev = match s("operationType") {
                Some("Reasoning") if text.trim() == "..." => return,
                Some("Reasoning") => AgentEvent::Thinking {
                    text: text.to_string(),
                    duration_secs: None,
                },
                Some("Summary") => return,
                _ => AgentEvent::Assistant {
                    text: text.to_string(),
                },
            };
            let turn = assistant_turn(surface_id, current_turn, turns);
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }
            turn.events.push(ev);
        }
        "tool_call" => {
            let id = s("toolCallId").unwrap_or("tool").to_string();
            let name = s("toolName").or(s("title")).unwrap_or("tool").to_string();
            let detail = p.get("args").map(|a| cap_detail(a.to_string()));
            let turn = assistant_turn(surface_id, current_turn, turns);
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }
            let seen = turn
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ToolStart { tool_id, .. } if *tool_id == id));
            if !seen {
                turn.events
                    .push(AgentEvent::ToolStart { tool_id: id, name, detail });
            }
        }
        "tool_result" => {
            let id = s("toolCallId").unwrap_or("tool").to_string();
            let ok = p.get("success").and_then(|b| b.as_bool()).unwrap_or(true);
            let detail = s("content").map(|c| cap_detail(c.to_string()));
            let turn = assistant_turn(surface_id, current_turn, turns);
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }
            turn.events.push(AgentEvent::ToolEnd {
                tool_id: id,
                name: None,
                detail,
                ok,
            });
        }
        "pending_interaction" => {
            let tool_id = s("toolCallId")
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            let prompt = s("question").unwrap_or("Approval required").to_string();
            let options = p
                .get("options")
                .and_then(|o| o.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| {
                            o.get("name")
                                .or_else(|| o.get("label"))
                                .and_then(|n| n.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|opts| !opts.is_empty());

            let turn = assistant_turn(surface_id, current_turn, turns);
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }
            turn.events.push(AgentEvent::AwaitingInput(AwaitingInput {
                tool_id,
                input_kind: "permission".into(),
                prompt,
                options,
                default_choice: None,
                multi_select: None,
                questions: None,
                answered: None,
            }));
        }
        "interaction_resolved" => {
            // Preserve `AwaitingInput` as an answered receipt matched by `toolCallId`!
            let target_id = s("toolCallId").map(str::trim).filter(|id| !id.is_empty());
            let resolve_in_turn = |turn: &mut AgentTurn, require_id_match: bool| -> bool {
                for ev in turn.events.iter_mut().rev() {
                    if let AgentEvent::AwaitingInput(ai) = ev
                        && ai.answered.is_none()
                    {
                        let matches = match (require_id_match, target_id) {
                            (true, Some(tid)) => ai.tool_id.as_deref() == Some(tid),
                            (false, _) => true,
                            _ => false,
                        };
                        if matches {
                            let answer = extract_kiro_resolved_answer(p, ai.options.as_deref());
                            ai.answered = Some(answer);
                            return true;
                        }
                    }
                }
                false
            };

            if target_id.is_some() {
                if let Some(ct) = current_turn.as_mut()
                    && resolve_in_turn(ct, true)
                {
                    return;
                }
                for t in turns.iter_mut().rev() {
                    if resolve_in_turn(t, true) {
                        return;
                    }
                }
            }
            if let Some(ct) = current_turn.as_mut()
                && resolve_in_turn(ct, false)
            {
                return;
            }
            for t in turns.iter_mut().rev() {
                if resolve_in_turn(t, false) {
                    return;
                }
            }
        }
        "sub_agent_start" => {
            let id = s("subSessionId").unwrap_or("subagent").to_string();
            let label = s("subAgentName").unwrap_or("Subagent").to_string();
            let turn = assistant_turn(surface_id, current_turn, turns);
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }
            let group_id = format!("kiro-subagents-{}", turn.id);
            push_subagent_to_turn(
                turn,
                &group_id,
                SubagentEntry {
                    id,
                    label,
                    state: SubagentState::Working,
                    tokens: None,
                    started_at: ts_ms,
                    settled_at: None,
                },
            );
        }
        "sub_agent_complete" => {
            let id = s("subSessionId").unwrap_or("");
            let failed = matches!(s("status"), Some("failed" | "error"));
            mutate_subagent_by_ids(turns, current_turn, &[id], |a| {
                a.state = if failed {
                    SubagentState::Failed
                } else {
                    SubagentState::Completed
                };
                a.settled_at = ts_ms.or(a.settled_at);
            });
        }
        "turn_end" if s("stopReason") == Some("error") => {
            assistant_turn(surface_id, current_turn, turns)
                .events
                .push(AgentEvent::Error {
                    message: "Turn ended with an error".into(),
                });
        }
        _ => {}
    }
}
