//! Antigravity (`~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript*.jsonl`) line decoder.

use std::collections::VecDeque;

use crate::domain::canonical_turn::{clean_agy_arg_str, clean_agy_args_json, parse_ask_event};
use crate::domain::noise_filter::{clean_user_prompt, record_timestamp_ms};
use crate::domain::receipt_normalizer::{clean_question_answer_text, strip_agy_tool_headers};
use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, BackgroundTaskEntry, BackgroundTaskKind, SubagentEntry,
    SubagentState,
};
use crate::providers::common::{
    cap_detail, mutate_bg_task_by_ids, mutate_subagent_by_ids, push_bg_task_to_turn,
    push_subagent_to_turn,
};

#[derive(Debug, Clone)]
pub enum AgyPendingCall {
    Tool {
        tool_id: String,
        name: String,
        detail: Option<String>,
    },
    SubagentInvoke {
        placeholder_id: String,
    },
    Ask,
    HiddenControl,
}

#[derive(Default, Clone)]
pub struct AntigravityState {
    /// Strict FIFO queue matching positional `GENERIC` records to `PLANNER_RESPONSE.tool_calls`.
    pub pending_calls: VecDeque<AgyPendingCall>,
}

/// `"conversationId": "<uuid>"` inside the `Created the following subagent: {...}` result.
fn subagent_conversation_id(content: &str) -> Option<String> {
    let key = content.find("\"conversationId\"")?;
    let rest = &content[key + "\"conversationId\"".len()..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')?;
    let id = &rest[open..open + close];
    (id.len() == 36).then(|| id.to_string())
}

fn try_extract_bg_task_id(content: &str) -> Option<String> {
    let marker = "Tool is running as a background task with task id:";
    let idx = content.find(marker)?;
    let after = &content[idx + marker.len()..];
    let task_id = after.lines().next().map(str::trim).unwrap_or("");
    (!task_id.is_empty()).then(|| task_id.to_string())
}

fn push_agy_bg_command(
    turn: &mut AgentTurn,
    task_id: String,
    content: &str,
    tool_detail: Option<&str>,
    ts_ms: Option<u64>,
) {
    let desc_from_output = content
        .lines()
        .find_map(|l| l.strip_prefix("Task Description:").map(str::trim))
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let desc_from_tool = tool_detail
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|v| {
            v.get("toolSummary")
                .or_else(|| v.get("CommandLine"))
                .and_then(|s| s.as_str())
                .map(clean_agy_arg_str)
        });
    let bg_label = desc_from_tool
        .or(desc_from_output)
        .unwrap_or_else(|| "Background command".to_string())
        .chars()
        .take(120)
        .collect::<String>();
    push_bg_task_to_turn(
        turn,
        BackgroundTaskEntry {
            id: task_id,
            kind: BackgroundTaskKind::Command,
            label: bg_label,
            state: SubagentState::Working,
            summary: None,
            tokens: None,
            started_at: ts_ms,
            settled_at: None,
        },
    );
}

pub fn parse_line(
    val: serde_json::Value,
    surface_id: &str,
    state: &mut AntigravityState,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let ts_ms = record_timestamp_ms(&val);
    let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match msg_type {
        "USER_INPUT" | "REQUEST" => {
            // If `REQUEST` comes from a non-user internal source, ignore unless `source` is absent or USER*.
            if msg_type == "REQUEST"
                && let Some(src) = val.get("source").and_then(|s| s.as_str())
                && !matches!(src, "USER" | "USER_EXPLICIT")
            {
                return;
            }
            let agent_replied = current_turn.is_some();
            if let Some(t) = current_turn.take() {
                turns.push(t);
            }
            state.pending_calls.clear();

            if let Some(content) = val.get("content").and_then(|c| c.as_str()) {
                let cleaned = clean_user_prompt(content);
                if cleaned.is_empty() {
                    return;
                }
                if !agent_replied
                    && matches!(
                        turns.last().and_then(|t| t.events.first()),
                        Some(AgentEvent::User { text }) if *text == cleaned
                    )
                {
                    return;
                }
                let mut turn = AgentTurn::new(
                    format!("turn-{}", turns.len() + 1),
                    surface_id,
                    AgentRole::User,
                );
                turn.timestamp = ts_ms;
                turn.events.push(AgentEvent::User { text: cleaned });
                turns.push(turn);
            }
        }
        "PLANNER_RESPONSE" => {
            let mut turn = current_turn.take().unwrap_or_else(|| {
                AgentTurn::new(
                    format!("turn-{}", turns.len() + 1),
                    surface_id,
                    AgentRole::Assistant,
                )
            });
            if turn.timestamp.is_none() {
                turn.timestamp = ts_ms;
            }

            if let Some(thinking) = val.get("thinking").and_then(|t| t.as_str())
                && !thinking.trim().is_empty()
            {
                turn.events.push(AgentEvent::Thinking {
                    text: thinking.to_string(),
                    duration_secs: None,
                });
            }

            if let Some(content) = val.get("content").and_then(|c| c.as_str())
                && !content.trim().is_empty()
            {
                turn.events.push(AgentEvent::Assistant {
                    text: content.to_string(),
                });
            }

            if let Some(tool_calls) = val.get("tool_calls").and_then(|tc| tc.as_array()) {
                for (tc_idx, tc) in tool_calls.iter().enumerate() {
                    let name = tc
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let cleaned_args = tc.get("args").map(clean_agy_args_json);
                    let detail = cleaned_args.as_ref().map(|a| cap_detail(a.to_string()));

                    if let Some(ask_ev) = parse_ask_event(None, &name, cleaned_args.as_ref()) {
                        turn.events.push(ask_ev);
                        state.pending_calls.push_back(AgyPendingCall::Ask);
                    } else if name == "invoke_subagent" {
                        let role = cleaned_args
                            .as_ref()
                            .and_then(|a| a.get("Role"))
                            .and_then(|r| r.as_str())
                            .map(clean_agy_arg_str)
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "Subagent".to_string());
                        let type_name = cleaned_args
                            .as_ref()
                            .and_then(|a| a.get("TypeName"))
                            .and_then(|t| t.as_str())
                            .map(clean_agy_arg_str)
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| "subagent".to_string());
                        let group_id = format!("agy-subagents-{}", turn.id);
                        let entry_id = format!("{}-{}-{}", type_name, turn.events.len(), tc_idx);
                        push_subagent_to_turn(
                            &mut turn,
                            &group_id,
                            SubagentEntry {
                                id: entry_id.clone(),
                                label: role,
                                state: SubagentState::Working,
                                tokens: None,
                                started_at: ts_ms,
                                settled_at: None,
                            },
                        );
                        state.pending_calls.push_back(AgyPendingCall::SubagentInvoke {
                            placeholder_id: entry_id,
                        });
                    } else if name == "manage_subagents" {
                        let action = cleaned_args
                            .as_ref()
                            .and_then(|a| a.get("Action"))
                            .and_then(|s| s.as_str())
                            .map(clean_agy_arg_str)
                            .unwrap_or_default();
                        if action == "kill_all" {
                            for t in turns.iter_mut().chain(std::iter::once(&mut turn)) {
                                for ev in t.events.iter_mut() {
                                    if let AgentEvent::Subagents { agents, .. } = ev {
                                        for a in agents.iter_mut() {
                                            if a.state == SubagentState::Working {
                                                a.state = SubagentState::Stopped;
                                                a.settled_at = ts_ms.or(a.settled_at);
                                            }
                                        }
                                    }
                                }
                            }
                        } else if action == "kill"
                            && let Some(raw_ids) =
                                cleaned_args.as_ref().and_then(|a| a.get("ConversationIds"))
                        {
                            let parsed_ids: Vec<String> = if let Some(arr) = raw_ids.as_array() {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(clean_agy_arg_str))
                                    .collect()
                            } else if let Some(s) = raw_ids.as_str() {
                                serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
                            } else {
                                Vec::new()
                            };
                            for cid in &parsed_ids {
                                let mut cur = Some(turn);
                                mutate_subagent_by_ids(turns, &mut cur, &[cid.as_str()], |a| {
                                    a.state = SubagentState::Stopped;
                                    a.settled_at = ts_ms.or(a.settled_at);
                                });
                                turn = cur.unwrap();
                            }
                        }
                        // Suppress duplicate `ToolStart` on `manage_subagents`, while preserving FIFO alignment!
                        state.pending_calls.push_back(AgyPendingCall::HiddenControl);
                    } else if name == "manage_task" {
                        let action = cleaned_args
                            .as_ref()
                            .and_then(|a| a.get("Action"))
                            .and_then(|s| s.as_str())
                            .map(clean_agy_arg_str)
                            .unwrap_or_default();
                        if action == "kill"
                            && let Some(tid) = cleaned_args
                                .as_ref()
                                .and_then(|a| a.get("TaskId"))
                                .and_then(|s| s.as_str())
                                .map(clean_agy_arg_str)
                        {
                            let mut cur = Some(turn);
                            mutate_bg_task_by_ids(turns, &mut cur, &[tid.as_str()], |t| {
                                t.state = SubagentState::Stopped;
                                t.settled_at = ts_ms.or(t.settled_at);
                            });
                            turn = cur.unwrap();
                        }
                        // Suppress duplicate `ToolStart` on `manage_task`, while preserving FIFO alignment!
                        state.pending_calls.push_back(AgyPendingCall::HiddenControl);
                    } else {
                        let tool_id = format!("{}-call-{}-{}", name, turn.events.len(), tc_idx);
                        turn.events.push(AgentEvent::ToolStart {
                            tool_id: tool_id.clone(),
                            name: name.clone(),
                            detail: detail.clone(),
                        });
                        state.pending_calls.push_back(AgyPendingCall::Tool {
                            tool_id,
                            name,
                            detail,
                        });
                    }
                }
            }

            *current_turn = Some(turn);
        }
        "SYSTEM_MESSAGE" => {
            let content = val.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let sender = content.find("sender=").and_then(|idx| {
                let raw: String = content[idx + "sender=".len()..]
                    .chars()
                    .take_while(|c| !c.is_whitespace())
                    .collect();
                (!raw.is_empty()).then_some(raw)
            });
            if let Some(sender) = sender {
                let failed = content
                    .find("Command exited with code ")
                    .map(|idx| {
                        let after = &content[idx + "Command exited with code ".len()..];
                        let code: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                        !code.is_empty() && code != "0"
                    })
                    .unwrap_or(false);
                if !mutate_subagent_by_ids(turns, current_turn, &[sender.as_str()], |a| {
                    a.state = SubagentState::Completed;
                    a.settled_at = ts_ms.or(a.settled_at);
                }) {
                    mutate_bg_task_by_ids(turns, current_turn, &[sender.as_str()], |t| {
                        t.state = if failed {
                            SubagentState::Failed
                        } else {
                            SubagentState::Completed
                        };
                        t.settled_at = ts_ms.or(t.settled_at);
                    });
                }
            }
        }
        "GENERIC" => {
            let Some(content) = val.get("content").and_then(|c| c.as_str()) else {
                return;
            };
            let is_err = val
                .get("status")
                .and_then(|s| s.as_str())
                .is_some_and(|s| s == "ERROR");
            let cleaned_body = strip_agy_tool_headers(content);

            match state.pending_calls.pop_front() {
                Some(AgyPendingCall::HiddenControl) => {
                    return;
                }
                Some(AgyPendingCall::SubagentInvoke { placeholder_id }) => {
                    if let Some(child_id) = subagent_conversation_id(content) {
                        mutate_subagent_by_ids(
                            turns,
                            current_turn,
                            &[placeholder_id.as_str()],
                            |a| {
                                a.id = child_id.clone();
                            },
                        );
                    }
                    return;
                }
                Some(AgyPendingCall::Ask) => {
                    if let Some(turn) = current_turn.as_mut()
                        && let Some(AgentEvent::AwaitingInput(ai)) = turn
                            .events
                            .iter_mut()
                            .find(|ev| matches!(ev, AgentEvent::AwaitingInput(a) if a.answered.is_none()))
                    {
                        let answer = clean_question_answer_text(content);
                        ai.answered = Some(if answer.is_empty() {
                            "Answered".to_string()
                        } else {
                            answer
                        });
                    }
                    return;
                }
                Some(AgyPendingCall::Tool {
                    tool_id,
                    name,
                    detail,
                }) => {
                    let Some(mut turn) = current_turn.take() else {
                        return;
                    };
                    if let Some(task_id) = try_extract_bg_task_id(content) {
                        // Backgrounded `run_command`: remove duplicate `ToolStart` and emit `BackgroundTasks` only!
                        turn.events.retain(|ev| {
                            !matches!(ev, AgentEvent::ToolStart { tool_id: id, .. } if *id == tool_id)
                        });
                        push_agy_bg_command(&mut turn, task_id, content, detail.as_deref(), ts_ms);
                    } else {
                        turn.events.push(AgentEvent::ToolEnd {
                            tool_id,
                            name: Some(name),
                            detail: Some(cap_detail(cleaned_body.to_string())),
                            ok: !is_err,
                        });
                    }
                    *current_turn = Some(turn);
                    return;
                }
                None => {}
            }

            // Fallback when tail-window started mid-turn without the preceding `PLANNER_RESPONSE`:
            if content.contains("Created the following subagent") {
                if let Some(child_id) = subagent_conversation_id(content)
                    && let Some(t) = current_turn.as_mut()
                {
                    for ev in t.events.iter_mut() {
                        if let AgentEvent::Subagents { agents, .. } = ev
                            && let Some(a) = agents
                                .iter_mut()
                                .find(|a| !a.id.contains('-') || a.id.len() != 36)
                        {
                            a.id = child_id;
                            break;
                        }
                    }
                }
                return;
            }

            let Some(mut turn) = current_turn.take() else {
                // Never create a fake Assistant prose turn from an orphaned `GENERIC` tool output!
                return;
            };

            // Strict FIFO scan (`.iter().find_map`, NEVER `.rev()`)!
            let open_tool = turn.events.iter().find_map(|ev| {
                if let AgentEvent::ToolStart {
                    tool_id,
                    name,
                    detail,
                } = ev
                {
                    let is_closed = turn.events.iter().any(|other| {
                        matches!(other, AgentEvent::ToolEnd { tool_id: end_id, .. } if end_id == tool_id)
                    });
                    if !is_closed {
                        return Some((tool_id.clone(), name.clone(), detail.clone()));
                    }
                }
                None
            });

            if let Some((tool_id, name, detail)) = open_tool {
                if let Some(task_id) = try_extract_bg_task_id(content) {
                    turn.events.retain(|ev| {
                        !matches!(ev, AgentEvent::ToolStart { tool_id: id, .. } if *id == tool_id)
                    });
                    push_agy_bg_command(&mut turn, task_id, content, detail.as_deref(), ts_ms);
                } else {
                    turn.events.push(AgentEvent::ToolEnd {
                        tool_id,
                        name: Some(name),
                        detail: Some(cap_detail(cleaned_body.to_string())),
                        ok: !is_err,
                    });
                }
            } else if let Some(AgentEvent::AwaitingInput(ai)) = turn
                .events
                .iter_mut()
                .find(|ev| matches!(ev, AgentEvent::AwaitingInput(a) if a.answered.is_none()))
            {
                let answer = clean_question_answer_text(content);
                ai.answered = Some(if answer.is_empty() {
                    "Answered".to_string()
                } else {
                    answer
                });
            }
            // Unmatched `GENERIC` records are NEVER emitted as `AgentEvent::Assistant` prose!
            *current_turn = Some(turn);
        }
        _ => {}
    }
}
