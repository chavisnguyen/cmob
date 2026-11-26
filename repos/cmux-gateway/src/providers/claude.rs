//! Claude Code (`~/.claude/projects/*/*.jsonl`) transcript line decoder.
//!
//! Sources:
//! - `ref/orca/src/main/native-chat/transcript-line-decoders-claude.ts`
//! - `ref/orca/src/main/claude/structured/journal/claude-internal-message-content.ts`
//! - `ref/orca/src/shared/harness-injected-user-turns.ts`

use crate::domain::canonical_turn::parse_ask_event;
use crate::domain::noise_filter::{
    is_compact_continuation_user_turn_text, is_interrupted_user_turn_text,
    normalize_claude_user_block_text, record_timestamp_ms,
};
use crate::domain::receipt_normalizer::{
    clean_question_answer_text, extract_claude_tool_use_answers,
};
use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, BackgroundTaskEntry, BackgroundTaskKind, SubagentEntry,
    SubagentState,
};
use crate::providers::common::{
    assistant_turn, cap_detail, emit_interrupted_status, mutate_bg_task_by_ids,
    mutate_subagent_by_ids, push_bg_task_to_turn, push_subagent_to_turn, push_system_divider,
};

fn classify_claude_task_kind(val: &serde_json::Value) -> BackgroundTaskKind {
    match val.get("task_type").and_then(|t| t.as_str()) {
        Some("local_agent" | "local_subagent" | "subagent" | "teammate") => {
            BackgroundTaskKind::Agent
        }
        Some("local_bash" | "shell" | "background_shell") => BackgroundTaskKind::Command,
        Some("local_workflow") => BackgroundTaskKind::Workflow,
        Some("monitor") => BackgroundTaskKind::Monitor,
        Some(_) => BackgroundTaskKind::Unknown,
        None if val
            .get("subagent_type")
            .and_then(|s| s.as_str())
            .is_some_and(|s| !s.trim().is_empty()) =>
        {
            BackgroundTaskKind::Agent
        }
        None => BackgroundTaskKind::Unknown,
    }
}

fn claude_status_to_state(status: Option<&str>) -> Option<SubagentState> {
    match status {
        Some("completed") => Some(SubagentState::Completed),
        Some("failed" | "error") => Some(SubagentState::Failed),
        Some("killed" | "stopped") => Some(SubagentState::Stopped),
        Some("pending" | "running" | "paused") => Some(SubagentState::Working),
        _ => None,
    }
}

/// Parse `<task-notification>` XML user rows emitted by Claude Code when background tasks finish
/// (`ref/orca/src/shared/claude-task-notification-text.ts:7-20`).
fn parse_claude_task_notification_xml(
    text: &str,
) -> Option<(String, Option<String>, Option<String>)> {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("<task-notification>") {
        return None;
    }
    fn xml_tag<'a>(src: &'a str, tag: &str) -> Option<&'a str> {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let start = src.find(&open)? + open.len();
        let end = src[start..].find(&close)?;
        let val = src[start..start + end].trim();
        (!val.is_empty()).then_some(val)
    }
    let task_id = xml_tag(trimmed, "task-id")?.to_string();
    let summary_at = trimmed.find("<summary>");
    let header_slice = summary_at.map_or(trimmed, |idx| &trimmed[..idx]);
    let status = xml_tag(header_slice, "status").map(str::to_string);
    let summary = xml_tag(trimmed, "summary").map(str::to_string);
    Some((task_id, status, summary))
}

fn raw_user_text_blocks(msg: Option<&serde_json::Value>) -> Vec<String> {
    match msg.and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str()).map(str::to_string)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Rewrite queued human prompt attachments into `user` records (`transcript-line-decoders-claude.ts:144-165`).
fn claude_queued_prompt_as_user_record(val: serde_json::Value) -> serde_json::Value {
    if val.get("type").and_then(|t| t.as_str()) != Some("attachment") {
        return val;
    }
    let Some(att) = val.get("attachment") else {
        return val;
    };
    if att.get("type").and_then(|t| t.as_str()) != Some("queued_command")
        || att.get("commandMode").and_then(|m| m.as_str()) != Some("prompt")
    {
        return val;
    }
    if let Some(origin_kind) = att.pointer("/origin/kind").and_then(|k| k.as_str())
        && origin_kind != "human"
    {
        return val;
    }
    let Some(prompt) = att.get("prompt").cloned() else {
        return val;
    };
    if !prompt.is_string() && !prompt.is_array() {
        return val;
    }
    let mut out = val;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("type".into(), serde_json::json!("user"));
        obj.insert(
            "message".into(),
            serde_json::json!({ "role": "user", "content": prompt }),
        );
    }
    out
}

pub fn is_claude_synthetic_no_response_assistant(msg: &serde_json::Value) -> bool {
    if msg.get("model").and_then(|m| m.as_str()) != Some("<synthetic>") {
        return false;
    }
    let joined = match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .then(|| b.get("text").and_then(|t| t.as_str()))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    joined.eq_ignore_ascii_case("No response requested.")
}

pub fn parse_line(
    raw_val: serde_json::Value,
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let val = claude_queued_prompt_as_user_record(raw_val);

    // Skip sidechain child frames (`isSidechain: true` or non-empty `parent_tool_use_id`).
    if val.get("isSidechain").and_then(|b| b.as_bool()) == Some(true)
        || val
            .get("parent_tool_use_id")
            .or_else(|| val.get("parentToolUseID"))
            .and_then(|s| s.as_str())
            .is_some_and(|s| !s.trim().is_empty())
    {
        return;
    }

    let ts_ms = record_timestamp_ms(&val);
    let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match msg_type {
        "user" => {
            // 1. Interruption notice (`interruptedMessageId` or `[Request interrupted...]`) -> Status, never User bubble!
            if val
                .get("interruptedMessageId")
                .and_then(|id| id.as_str())
                .is_some_and(|s| !s.trim().is_empty())
            {
                emit_interrupted_status(ts_ms, surface_id, current_turn, turns);
                return;
            }

            let tool_meta = val.get("toolUseResult").or_else(|| val.get("tool_use_result"));
            let meta_agent_id = tool_meta
                .and_then(|m| m.get("agentId"))
                .and_then(|s| s.as_str());
            let meta_bg_id = tool_meta
                .and_then(|m| m.get("backgroundTaskId"))
                .and_then(|s| s.as_str());
            let meta_status = tool_meta
                .and_then(|m| m.get("status"))
                .and_then(|s| s.as_str());
            let meta_is_async = tool_meta
                .and_then(|m| m.get("isAsync"))
                .and_then(|b| b.as_bool())
                == Some(true)
                || meta_status == Some("async_launched");
            let meta_tokens = tool_meta
                .and_then(|m| {
                    m.get("totalTokens")
                        .or_else(|| m.pointer("/usage/total_tokens"))
                })
                .and_then(|v| v.as_u64());
            let meta_duration_ms = tool_meta
                .and_then(|m| m.get("totalDurationMs"))
                .and_then(|v| v.as_u64());

            let msg = val.get("message");
            let blocks = msg
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());
            let mut had_tool_result = false;

            for block in blocks.into_iter().flatten() {
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    had_tool_result = true;
                    let tool_id = block
                        .get("tool_use_id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let detail = match block.get("content") {
                        Some(serde_json::Value::String(t)) => Some(t.clone()),
                        Some(serde_json::Value::Array(items)) => {
                            let joined: String = items
                                .iter()
                                .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join("\n");
                            (!joined.is_empty()).then_some(joined)
                        }
                        _ => None,
                    }
                    .map(cap_detail);
                    let ok = !block
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);

                    // Rebind background Bash `tool_use_id` -> `backgroundTaskId` when launched asynchronously.
                    let matched_bg = if let Some(bg_id) = meta_bg_id {
                        mutate_bg_task_by_ids(
                            turns,
                            current_turn,
                            &[tool_id.as_str(), bg_id],
                            |item| {
                                item.id = bg_id.to_string();
                            },
                        )
                    } else {
                        mutate_bg_task_by_ids(turns, current_turn, &[tool_id.as_str()], |_| {})
                    };
                    if matched_bg {
                        continue;
                    }

                    // Update Claude `Agent` / `Task` subagent entry if this result answers one.
                    let lookup_ids: Vec<&str> = match meta_agent_id {
                        Some(aid) => vec![tool_id.as_str(), aid],
                        None => vec![tool_id.as_str()],
                    };
                    let matched_subagent =
                        mutate_subagent_by_ids(turns, current_turn, &lookup_ids, |agent| {
                            if let Some(aid) = meta_agent_id {
                                agent.id = aid.to_string();
                            }
                            if meta_tokens.is_some() {
                                agent.tokens = meta_tokens;
                            }
                            if !meta_is_async {
                                agent.state = if !ok {
                                    SubagentState::Failed
                                } else {
                                    claude_status_to_state(meta_status)
                                        .unwrap_or(SubagentState::Completed)
                                };
                                if agent.settled_at.is_none() {
                                    agent.settled_at = ts_ms.or_else(|| {
                                        agent
                                            .started_at
                                            .zip(meta_duration_ms)
                                            .map(|(s, d)| s + d)
                                    });
                                }
                            }
                        });
                    if matched_subagent {
                        continue;
                    }

                    // Match `AskUserQuestion` `AwaitingInput` by `tool_id` first, or `ToolStart` by `tool_id`.
                    let mut settled_ask = false;
                    let answer_from_meta = extract_claude_tool_use_answers(tool_meta);
                    let settle_ai = |turn: &mut AgentTurn| -> bool {
                        // Prefer exact `tool_id` match.
                        if let Some(AgentEvent::AwaitingInput(ai)) = turn
                            .events
                            .iter_mut()
                            .rev()
                            .find(|e| {
                                matches!(
                                    e,
                                    AgentEvent::AwaitingInput(a)
                                        if a.answered.is_none()
                                            && a.tool_id.as_deref() == Some(tool_id.as_str())
                                )
                            })
                        {
                            ai.answered = answer_from_meta
                                .clone()
                                .or_else(|| {
                                    detail
                                        .as_deref()
                                        .map(clean_question_answer_text)
                                        .filter(|s| !s.is_empty())
                                })
                                .or_else(|| Some("Answered".to_string()));
                            return true;
                        }
                        false
                    };

                    if let Some(ct) = current_turn.as_mut()
                        && settle_ai(ct)
                    {
                        settled_ask = true;
                    } else {
                        for t in turns.iter_mut().rev() {
                            if settle_ai(t) {
                                settled_ask = true;
                                break;
                            }
                        }
                    }
                    if settled_ask {
                        continue;
                    }

                    let issued_here = |t: &AgentTurn| {
                        t.events.iter().any(|e| {
                            matches!(e, AgentEvent::ToolStart { tool_id: id, .. } if *id == tool_id)
                        })
                    };
                    let target = match current_turn.as_mut() {
                        Some(t) if issued_here(t) => Some(t),
                        _ => turns.iter_mut().rev().find(|t| issued_here(t)),
                    };
                    if let Some(turn) = target {
                        turn.events.push(AgentEvent::ToolEnd {
                            tool_id,
                            name: None,
                            detail,
                            ok,
                        });
                    } else if let Some(ct) = current_turn.as_mut()
                        && let Some(AgentEvent::AwaitingInput(ai)) = ct
                            .events
                            .iter_mut()
                            .rev()
                            .find(|e| {
                                matches!(
                                    e,
                                    AgentEvent::AwaitingInput(a)
                                        if a.answered.is_none() && a.tool_id.is_none()
                                )
                            })
                    {
                        ai.answered = answer_from_meta
                            .or_else(|| {
                                detail
                                    .as_deref()
                                    .map(clean_question_answer_text)
                                    .filter(|s| !s.is_empty())
                            })
                            .or_else(|| Some("Answered".to_string()));
                    }
                }
            }

            // 2. Inspect raw text blocks for `<task-notification>`, compaction, and interruption notices
            // BEFORE stripping harness-injected blocks per-block.
            let raw_texts = raw_user_text_blocks(msg);
            for rt in &raw_texts {
                if let Some((task_id, status, summary)) = parse_claude_task_notification_xml(rt) {
                    let next_state =
                        claude_status_to_state(status.as_deref()).unwrap_or(SubagentState::Completed);
                    if !mutate_subagent_by_ids(turns, current_turn, &[task_id.as_str()], |a| {
                        a.state = next_state;
                        a.settled_at = ts_ms.or(a.settled_at);
                    }) {
                        mutate_bg_task_by_ids(turns, current_turn, &[task_id.as_str()], |t| {
                            t.state = next_state;
                            if summary.is_some() {
                                t.summary = summary.clone();
                            }
                            t.settled_at = ts_ms.or(t.settled_at);
                        });
                    }
                    return;
                }
            }

            let is_compact_summary = val
                .get("isCompactSummary")
                .and_then(|b| b.as_bool())
                == Some(true)
                || raw_texts
                    .iter()
                    .any(|t| is_compact_continuation_user_turn_text(t));
            if is_compact_summary {
                push_system_divider("Context compacted", ts_ms, surface_id, current_turn, turns);
                return;
            }

            if !had_tool_result
                && !raw_texts.is_empty()
                && raw_texts.iter().all(|t| is_interrupted_user_turn_text(t))
            {
                emit_interrupted_status(ts_ms, surface_id, current_turn, turns);
                return;
            }

            let is_injected_meta = val.get("isMeta").and_then(|b| b.as_bool()) == Some(true)
                || val.get("isSynthetic").and_then(|b| b.as_bool()) == Some(true)
                || val.pointer("/origin/kind").and_then(|k| k.as_str())
                    == Some("task-notification");
            if is_injected_meta {
                return;
            }

            // 3. Per-block unwrapping & harness noise stripping!
            // A mixed `[tool_result, <system-reminder>]` user message strips `<system-reminder>` to
            // empty, so `cleaned_parts` stays empty and NEVER closes `current_turn` or emits a User bubble!
            let mut cleaned_parts: Vec<String> = Vec::new();
            let mut image_count = 0usize;
            if let Some(m) = msg {
                match m.get("content") {
                    Some(serde_json::Value::String(s)) => {
                        if let Some(cleaned) = normalize_claude_user_block_text(s) {
                            cleaned_parts.push(cleaned);
                        }
                    }
                    Some(serde_json::Value::Array(arr)) => {
                        for item in arr {
                            match item.get("type").and_then(|t| t.as_str()) {
                                Some("text") => {
                                    if let Some(t) = item.get("text").and_then(|t| t.as_str())
                                        && let Some(cleaned) = normalize_claude_user_block_text(t)
                                    {
                                        cleaned_parts.push(cleaned);
                                    }
                                }
                                Some("image") => {
                                    image_count += 1;
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }

            if cleaned_parts.is_empty() && image_count > 0 {
                if image_count == 1 {
                    cleaned_parts.push("[Image #1]".to_string());
                } else {
                    cleaned_parts.push(
                        (1..=image_count)
                            .map(|i| format!("[Image #{i}]"))
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
            }

            if cleaned_parts.is_empty() {
                return;
            }

            let text = cleaned_parts.join("\n").trim().to_string();
            if text.is_empty() {
                return;
            }

            if let Some(t) = current_turn.take() {
                turns.push(t);
            }

            let mut turn = AgentTurn::new(
                format!("turn-{}", turns.len() + 1),
                surface_id,
                AgentRole::User,
            );
            turn.timestamp = ts_ms;
            turn.events.push(AgentEvent::User { text });
            turns.push(turn);
        }
        "system" => {
            let subtype = val.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            if subtype == "compact_boundary" {
                push_system_divider("Context compacted", ts_ms, surface_id, current_turn, turns);
                return;
            }
            if matches!(
                subtype,
                "task_started" | "task_progress" | "task_updated" | "task_notification"
            ) {
                if val.get("ambient").and_then(|b| b.as_bool()) == Some(true)
                    || val.get("skip_transcript").and_then(|b| b.as_bool()) == Some(true)
                    || val.get("owned_by_subagent").and_then(|b| b.as_bool()) == Some(true)
                {
                    return;
                }
                let Some(task_id) = val.get("task_id").and_then(|s| s.as_str()) else {
                    return;
                };
                let tool_use_id = val
                    .get("tool_use_id")
                    .or_else(|| val.pointer("/patch/tool_use_id"))
                    .and_then(|s| s.as_str());
                let lookup_ids: Vec<&str> = match tool_use_id {
                    Some(tu) => vec![task_id, tu],
                    None => vec![task_id],
                };
                let kind = classify_claude_task_kind(&val);
                let tokens = val.pointer("/usage/total_tokens").and_then(|v| v.as_u64());
                let duration_ms = val.pointer("/usage/duration_ms").and_then(|v| v.as_u64());
                let end_time = val
                    .pointer("/patch/end_time")
                    .and_then(|v| v.as_u64())
                    .or(ts_ms);
                let status_str = val
                    .pointer("/patch/status")
                    .or_else(|| val.get("status"))
                    .and_then(|s| s.as_str());
                let next_state = if subtype == "task_notification" {
                    Some(claude_status_to_state(status_str).unwrap_or(SubagentState::Completed))
                } else {
                    claude_status_to_state(status_str)
                };
                let label = val
                    .pointer("/patch/description")
                    .or_else(|| val.get("description"))
                    .or_else(|| val.get("name"))
                    .or_else(|| val.get("subagent_type"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let summary = val
                    .get("summary")
                    .or_else(|| val.get("error"))
                    .or_else(|| val.pointer("/patch/error"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());

                let is_terminal = matches!(
                    next_state,
                    Some(
                        SubagentState::Completed
                            | SubagentState::Failed
                            | SubagentState::Stopped
                    )
                );

                if mutate_subagent_by_ids(turns, current_turn, &lookup_ids, |a| {
                    a.id = task_id.to_string();
                    if subtype != "task_progress"
                        && let Some(ref l) = label
                    {
                        a.label = l.clone();
                    }
                    if let Some(st) = next_state {
                        a.state = st;
                    }
                    if tokens.is_some() {
                        a.tokens = tokens;
                    }
                    a.started_at = a.started_at.or(ts_ms);
                    if is_terminal {
                        a.settled_at = end_time
                            .or_else(|| a.started_at.zip(duration_ms).map(|(s, d)| s + d))
                            .or(a.settled_at);
                    }
                }) {
                    return;
                }

                if mutate_bg_task_by_ids(turns, current_turn, &lookup_ids, |t| {
                    t.id = task_id.to_string();
                    if subtype != "task_progress"
                        && let Some(ref l) = label
                    {
                        t.label = l.clone();
                    }
                    if kind != BackgroundTaskKind::Unknown {
                        t.kind = kind;
                    }
                    if let Some(st) = next_state {
                        t.state = st;
                    }
                    if summary.is_some() {
                        t.summary = summary.clone();
                    }
                    if tokens.is_some() {
                        t.tokens = tokens;
                    }
                    t.started_at = t.started_at.or(ts_ms);
                    if is_terminal {
                        t.settled_at = end_time
                            .or_else(|| t.started_at.zip(duration_ms).map(|(s, d)| s + d))
                            .or(t.settled_at);
                    }
                }) {
                    return;
                }

                if subtype == "task_started" {
                    let turn = assistant_turn(surface_id, current_turn, turns);
                    if kind == BackgroundTaskKind::Agent {
                        push_subagent_to_turn(
                            turn,
                            "claude-subagents",
                            SubagentEntry {
                                id: task_id.to_string(),
                                label: label.unwrap_or_else(|| "Subagent".to_string()),
                                state: next_state.unwrap_or(SubagentState::Working),
                                tokens,
                                started_at: ts_ms,
                                settled_at: None,
                            },
                        );
                    } else if val.get("is_backgrounded").and_then(|b| b.as_bool()) == Some(true)
                        || matches!(kind, BackgroundTaskKind::Monitor | BackgroundTaskKind::Workflow)
                    {
                        push_bg_task_to_turn(
                            turn,
                            BackgroundTaskEntry {
                                id: task_id.to_string(),
                                kind,
                                label: label.unwrap_or_else(|| "Background task".to_string()),
                                state: next_state.unwrap_or(SubagentState::Working),
                                summary,
                                tokens,
                                started_at: ts_ms,
                                settled_at: None,
                            },
                        );
                    }
                }
            }
        }
        "assistant" => {
            let Some(msg) = val.get("message") else {
                return;
            };
            let is_synthetic_model = msg.get("model").and_then(|m| m.as_str()) == Some("<synthetic>");
            let strip_synthetic_no_resp = is_claude_synthetic_no_response_assistant(msg);

            let had_existing_turn = current_turn.is_some();
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

            if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match block_type {
                        "thinking" => {
                            if let Some(think) = block
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .filter(|s| !s.trim().is_empty())
                            {
                                turn.events.push(AgentEvent::Thinking {
                                    text: think.to_string(),
                                    duration_secs: None,
                                });
                            }
                        }
                        "text" => {
                            if strip_synthetic_no_resp {
                                continue;
                            }
                            if let Some(txt) = block
                                .get("text")
                                .and_then(|t| t.as_str())
                                .filter(|s| !s.trim().is_empty())
                            {
                                if is_synthetic_model
                                    && txt.trim().eq_ignore_ascii_case("No response requested.")
                                {
                                    continue;
                                }
                                turn.events.push(AgentEvent::Assistant {
                                    text: txt.to_string(),
                                });
                            }
                        }
                        "tool_use" => {
                            let tool_id = block
                                .get("id")
                                .and_then(|i| i.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let inp = block.get("input");
                            let detail = inp.map(|i| cap_detail(i.to_string()));

                            if let Some(ask_ev) = parse_ask_event(Some(tool_id.clone()), &name, inp)
                            {
                                turn.events.push(ask_ev);
                            } else if matches!(name.as_str(), "Agent" | "Task") {
                                let desc = inp
                                    .and_then(|i| i.get("description"))
                                    .and_then(|s| s.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());
                                let sub_type = inp
                                    .and_then(|i| {
                                        i.get("subagent_type").or_else(|| i.get("agent_type"))
                                    })
                                    .and_then(|s| s.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());
                                let label = match (desc, sub_type) {
                                    (Some(d), Some(st)) if st != "general-purpose" => {
                                        format!("{d} ({st})")
                                    }
                                    (Some(d), _) => d.to_string(),
                                    (None, Some(st)) => st.to_string(),
                                    _ => "Subagent".to_string(),
                                };
                                push_subagent_to_turn(
                                    &mut turn,
                                    "claude-subagents",
                                    SubagentEntry {
                                        id: tool_id,
                                        label,
                                        state: SubagentState::Working,
                                        tokens: None,
                                        started_at: ts_ms,
                                        settled_at: None,
                                    },
                                );
                            } else if name == "Bash"
                                && inp
                                    .and_then(|i| i.get("run_in_background"))
                                    .and_then(|b| b.as_bool())
                                    == Some(true)
                            {
                                let bg_label = inp
                                    .and_then(|i| i.get("description"))
                                    .and_then(|s| s.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .or_else(|| {
                                        inp.and_then(|i| i.get("command"))
                                            .and_then(|s| s.as_str())
                                            .map(str::trim)
                                            .filter(|s| !s.is_empty())
                                    })
                                    .unwrap_or("Background shell")
                                    .chars()
                                    .take(120)
                                    .collect::<String>();
                                push_bg_task_to_turn(
                                    &mut turn,
                                    BackgroundTaskEntry {
                                        id: tool_id,
                                        kind: BackgroundTaskKind::Command,
                                        label: bg_label,
                                        state: SubagentState::Working,
                                        summary: None,
                                        tokens: None,
                                        started_at: ts_ms,
                                        settled_at: None,
                                    },
                                );
                            } else {
                                turn.events.push(AgentEvent::ToolStart {
                                    tool_id,
                                    name,
                                    detail,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            } else if let Some(txt) = msg
                .get("content")
                .and_then(|c| c.as_str())
                .filter(|s| !s.trim().is_empty())
                && !strip_synthetic_no_resp
            {
                turn.events.push(AgentEvent::Assistant {
                    text: txt.to_string(),
                });
            }

            if let Some(u) = msg.get("usage")
                && !is_synthetic_model
            {
                let n = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                let input_tokens = n("input_tokens");
                let output_tokens = n("output_tokens");
                let cache_read_tokens = n("cache_read_input_tokens");
                let cache_creation_tokens = n("cache_creation_input_tokens");
                if input_tokens > 0
                    || output_tokens > 0
                    || cache_read_tokens > 0
                    || cache_creation_tokens > 0
                {
                    let usage = AgentEvent::Usage {
                        model: msg.get("model").and_then(|m| m.as_str()).map(str::to_string),
                        input_tokens,
                        output_tokens,
                        cache_read_tokens,
                        cache_creation_tokens,
                    };
                    let last = turn
                        .events
                        .iter()
                        .rev()
                        .find(|e| matches!(e, AgentEvent::Usage { .. }));
                    if last != Some(&usage) {
                        turn.events.push(usage);
                    }
                }
            }

            if !turn.events.is_empty() || had_existing_turn {
                *current_turn = Some(turn);
            }
        }
        _ => {}
    }
}
