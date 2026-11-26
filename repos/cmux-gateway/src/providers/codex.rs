//! Codex (`~/.codex/sessions/*/*/*/rollout-*.jsonl`) transcript line decoder.
//!
//! Sources:
//! - `ref/orca/src/main/native-chat/transcript-line-decoders-codex.ts`
//! - `ref/orca/src/main/ai-vault/scanners/codex/session-scanner-codex-tool-records.test.ts:35-60`

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use crate::domain::canonical_turn::parse_ask_event;
use crate::domain::noise_filter::{
    is_codex_skill_block, is_known_harness_injected_user_turn_text, record_timestamp_ms,
    strip_codex_skill_blocks,
};
use crate::domain::receipt_normalizer::clean_question_answer_text;
use crate::protocol::event::{AgentEvent, AgentTurn, SubagentEntry, SubagentState};
use crate::providers::common::{
    assistant_turn, cap_detail, emit_interrupted_status, payload_text, push_subagent_to_turn,
    push_system_divider, start_user_turn_with_ts,
};

#[derive(Default, Clone)]
pub struct CodexState {
    pub paginated: bool,
    pub model: Option<String>,
    /// `spawn_agent` call_id -> role label parsed from prompt ("You are the `Role`").
    pub spawn_roles: HashMap<String, String>,
    /// call_ids of spawn/wait/close_agent calls: folded into the subagent card.
    pub hidden_calls: HashSet<String>,
    /// Deduplicates tool calls across `CommandExecution` and `response_item` (`call_id` / `id`).
    pub seen_tool_ids: HashSet<String>,
    pub ended_tool_ids: HashSet<String>,
}

const CODEX_AGENT_TOOLS: [&str; 3] = ["spawn_agent", "wait_agent", "close_agent"];
const CODEX_CHILD_QUIET_SECS: u64 = 600;
const MAX_CHILD_CACHE: usize = 256;

fn codex_spawn_role(arguments: &str) -> Option<String> {
    let args: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let msg = args.get("message").and_then(|m| m.as_str())?;
    codex_role_from_prompt(msg)
}

fn codex_role_from_prompt(msg: &str) -> Option<String> {
    let start = msg.find("You are the `")? + "You are the `".len();
    let end = msg[start..].find('`')?;
    let role = msg[start..start + end].trim();
    (!role.is_empty()).then(|| role.to_string())
}

fn codex_push_subagent(
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
    agent_id: &str,
    nickname: &str,
    role: Option<&str>,
    ts_ms: Option<u64>,
) {
    let label = match role {
        Some(role) => format!("{role} ({nickname})"),
        None => nickname.to_string(),
    };
    let entry = SubagentEntry {
        id: agent_id.to_string(),
        label,
        state: SubagentState::Working,
        tokens: None,
        started_at: ts_ms,
        settled_at: None,
    };
    let turn = assistant_turn(surface_id, current_turn, turns);
    push_subagent_to_turn(turn, "codex-subagents", entry);
}

type ChildTailCacheEntry = (u128, u64, Option<bool>, Option<u64>);

static CODEX_CHILD_PATH_CACHE: LazyLock<Mutex<HashMap<(PathBuf, String), PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CODEX_CHILD_TAIL_CACHE: LazyLock<Mutex<HashMap<PathBuf, ChildTailCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn resolve_cached_child_path(parent: &Path, agent_id: &str) -> Option<PathBuf> {
    let parent_dir = parent.parent().unwrap_or(parent).to_path_buf();
    let key = (parent_dir, agent_id.to_string());
    if let Ok(cache) = CODEX_CHILD_PATH_CACHE.lock()
        && let Some(hit) = cache.get(&key)
        && hit.is_file()
    {
        return Some(hit.clone());
    }
    let found = crate::scanner::hook_store::find_codex_rollout(agent_id, parent)?;
    if let Ok(mut cache) = CODEX_CHILD_PATH_CACHE.lock() {
        if cache.len() >= MAX_CHILD_CACHE {
            cache.clear();
        }
        cache.insert(key, found.clone());
    }
    Some(found)
}

/// Returns `(mtime_ns, len)` of a Codex child rollout file for `chat_watcher_stream` fingerprinting.
pub fn codex_child_rollout_stamp(parent: &Path, agent_id: &str) -> Option<(u128, u64)> {
    let path = resolve_cached_child_path(parent, agent_id)?;
    let meta = std::fs::metadata(&path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime_ns, meta.len()))
}

/// Cached Codex child status by `(mtime_ns, len)` so 500ms polls do not re-read 512 KiB per child.
pub fn codex_child_status(parent: &Path, agent_id: &str) -> (SubagentState, Option<u64>) {
    let Some(path) = resolve_cached_child_path(parent, agent_id) else {
        return (SubagentState::Unverifiable, None);
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return (SubagentState::Unverifiable, None);
    };
    let len = meta.len();
    let modified = meta.modified().ok();
    let mtime_ns = modified
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let age_secs = modified
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);

    if let Ok(cache) = CODEX_CHILD_TAIL_CACHE.lock()
        && let Some((c_mtime, c_len, decided, tokens)) = cache.get(&path).copied()
        && c_mtime == mtime_ns
        && c_len == len
    {
        let state = match decided {
            Some(true) => SubagentState::Completed,
            _ if age_secs <= CODEX_CHILD_QUIET_SECS => SubagentState::Working,
            _ => SubagentState::Unverifiable,
        };
        return (state, tokens);
    }

    let Ok(mut f) = File::open(&path) else {
        return (SubagentState::Unverifiable, None);
    };
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(512 * 1024)));
    let mut raw = Vec::new();
    let _ = f.read_to_end(&mut raw);
    let buf = String::from_utf8_lossy(&raw).into_owned();
    let mut decided: Option<bool> = None;
    let mut tokens: Option<u64> = None;
    for line in buf.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        match p.get("type").and_then(|t| t.as_str()) {
            Some("task_complete") if decided.is_none() => decided = Some(true),
            Some("task_started") if decided.is_none() => decided = Some(false),
            Some("token_count") if tokens.is_none() => {
                tokens = p
                    .pointer("/info/total_token_usage/total_tokens")
                    .and_then(|t| t.as_u64());
            }
            _ => {}
        }
        if decided.is_some() && tokens.is_some() {
            break;
        }
    }

    if let Ok(mut cache) = CODEX_CHILD_TAIL_CACHE.lock() {
        if cache.len() >= MAX_CHILD_CACHE {
            cache.clear();
        }
        cache.insert(path, (mtime_ns, len, decided, tokens));
    }

    let state = match decided {
        Some(true) => SubagentState::Completed,
        _ if age_secs <= CODEX_CHILD_QUIET_SECS => SubagentState::Working,
        _ => SubagentState::Unverifiable,
    };
    (state, tokens)
}

pub fn refresh_working_codex_subagents(parent: &Path, turns: &mut [AgentTurn]) {
    for turn in turns.iter_mut() {
        for ev in turn.events.iter_mut() {
            if let AgentEvent::Subagents { group_id, agents } = ev
                && group_id == "codex-subagents"
            {
                for agent in agents.iter_mut() {
                    if agent.state == SubagentState::Working {
                        let (state, tokens) = codex_child_status(parent, &agent.id);
                        agent.state = state;
                        if tokens.is_some() {
                            agent.tokens = tokens;
                        }
                    }
                }
            }
        }
    }
}

fn codex_user_prompt_text(content: Option<&serde_json::Value>) -> Option<String> {
    let mut parts = Vec::new();
    let mut image_count = 0usize;
    match content {
        Some(serde_json::Value::String(s)) => {
            let stripped = strip_codex_skill_blocks(s);
            if !stripped.is_empty() && !is_known_harness_injected_user_turn_text(&stripped) {
                parts.push(stripped);
            }
        }
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                let itype = item.get("type").and_then(|t| t.as_str()).unwrap_or("text");
                if matches!(itype, "image" | "Image" | "input_image" | "local_image" | "LocalImage") {
                    image_count += 1;
                    continue;
                }
                if let Some(txt) = item.get("text").and_then(|t| t.as_str()) {
                    if is_codex_skill_block(txt) || is_known_harness_injected_user_turn_text(txt) {
                        continue;
                    }
                    let stripped = strip_codex_skill_blocks(txt);
                    if !stripped.is_empty() && !is_known_harness_injected_user_turn_text(&stripped) {
                        parts.push(stripped);
                    }
                }
            }
        }
        _ => {}
    }
    if parts.is_empty() && image_count > 0 {
        parts.push(
            (1..=image_count)
                .map(|i| format!("[Image #{i}]"))
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    let joined = parts.join("\n").trim().to_string();
    (!joined.is_empty()).then_some(joined)
}

fn codex_summary_text(val: Option<&serde_json::Value>) -> Option<String> {
    match val? {
        serde_json::Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .or_else(|| item.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn parse_exit_code_from_text(s: &str) -> Option<i64> {
    for line in s.lines().take(6) {
        let t = line.trim();
        if let Some(rest) = t
            .strip_prefix("Process exited with code ")
            .or_else(|| t.strip_prefix("Exit code: "))
        {
            let digits: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            if let Ok(code) = digits.parse::<i64>() {
                return Some(code);
            }
        }
    }
    None
}

fn extract_codex_tool_output(raw: Option<&serde_json::Value>) -> (Option<String>, bool) {
    let Some(val) = raw else {
        return (None, true);
    };
    if let Some(obj) = val.as_object() {
        let is_err = obj.get("is_error").and_then(|b| b.as_bool()) == Some(true)
            || obj.get("success").and_then(|b| b.as_bool()) == Some(false)
            || obj
                .get("exit_code")
                .or_else(|| val.pointer("/metadata/exit_code"))
                .and_then(|c| c.as_i64())
                .is_some_and(|c| c != 0);
        let text = obj
            .get("output")
            .or_else(|| obj.get("content"))
            .map(payload_text)
            .unwrap_or_else(|| val.to_string());
        let ok = !is_err && parse_exit_code_from_text(&text).is_none_or(|c| c == 0);
        return (Some(cap_detail(text)), ok);
    }

    let text = payload_text(val);
    if let Ok(parsed_obj) = serde_json::from_str::<serde_json::Value>(&text)
        && parsed_obj.is_object()
    {
        return extract_codex_tool_output(Some(&parsed_obj));
    }
    let ok = parse_exit_code_from_text(&text).is_none_or(|c| c == 0);
    let detail = (!text.is_empty()).then(|| cap_detail(text));
    (detail, ok)
}

fn format_local_shell_detail(p: &serde_json::Value) -> Option<String> {
    if let Some(cmd_val) = p.pointer("/action/command").or_else(|| p.get("command")) {
        match cmd_val {
            serde_json::Value::Array(arr) => {
                let s = arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !s.is_empty() {
                    return Some(cap_detail(s));
                }
            }
            serde_json::Value::String(s) if !s.is_empty() => {
                return Some(cap_detail(s.clone()));
            }
            _ => {}
        }
    }
    p.get("arguments")
        .or_else(|| p.get("input"))
        .or_else(|| p.get("action"))
        .map(|a| cap_detail(a.as_str().map(str::to_string).unwrap_or_else(|| a.to_string())))
}

pub fn parse_line(
    val: &serde_json::Value,
    surface_id: &str,
    state: &mut CodexState,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let ts_ms = record_timestamp_ms(val);
    let Some(p) = val.get("payload") else { return };
    let ptype = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match val.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "session_meta" => {
            state.paginated = p.get("history_mode").and_then(|m| m.as_str()) == Some("paginated");
        }
        "turn_context" => {
            if let Some(m) = p
                .get("model")
                .and_then(|m| m.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                state.model = Some(m.to_string());
            }
        }
        "event_msg" => match ptype {
            "turn_aborted" => {
                emit_interrupted_status(ts_ms, surface_id, current_turn, turns);
            }
            "context_compacted" => {
                push_system_divider("Context compacted", ts_ms, surface_id, current_turn, turns);
            }
            "token_count" => {
                let Some(last_u) = p.pointer("/info/last_token_usage") else {
                    return;
                };
                let n = |k: &str| last_u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                let total_in = n("input_tokens");
                let cached = last_u
                    .get("cached_input_tokens")
                    .or_else(|| last_u.get("cache_read_input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let input_tokens = total_in.saturating_sub(cached);
                let output_tokens = n("output_tokens");
                if input_tokens == 0 && cached == 0 && output_tokens == 0 {
                    return;
                }
                if let Some(turn) = current_turn.as_mut() {
                    let usage = AgentEvent::Usage {
                        model: state.model.clone(),
                        input_tokens,
                        output_tokens,
                        cache_read_tokens: cached,
                        cache_creation_tokens: 0,
                    };
                    let prev_u = turn
                        .events
                        .iter()
                        .rev()
                        .find(|e| matches!(e, AgentEvent::Usage { .. }));
                    if prev_u != Some(&usage) {
                        turn.events.push(usage);
                    }
                }
            }
            "item_completed" if state.paginated => {
                let Some(item) = p.get("item") else { return };
                match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "UserMessage" | "user_message" => {
                        if let Some(text) = codex_user_prompt_text(item.get("content")) {
                            start_user_turn_with_ts(text, ts_ms, surface_id, current_turn, turns);
                        }
                    }
                    "AgentMessage" | "agent_message" => {
                        let content = item.get("content").map(payload_text).unwrap_or_default();
                        if !content.trim().is_empty() {
                            let turn = assistant_turn(surface_id, current_turn, turns);
                            if turn.timestamp.is_none() {
                                turn.timestamp = ts_ms;
                            }
                            turn.events.push(AgentEvent::Assistant { text: content });
                        }
                    }
                    "Reasoning" => {
                        if let Some(think) = codex_summary_text(item.get("summary_text"))
                            .or_else(|| codex_summary_text(item.get("raw_content")))
                            .or_else(|| codex_summary_text(item.get("content")))
                        {
                            let turn = assistant_turn(surface_id, current_turn, turns);
                            if turn.timestamp.is_none() {
                                turn.timestamp = ts_ms;
                            }
                            turn.events.push(AgentEvent::Thinking {
                                text: think,
                                duration_secs: None,
                            });
                        }
                    }
                    "ContextCompaction" => {
                        push_system_divider(
                            "Context compacted",
                            ts_ms,
                            surface_id,
                            current_turn,
                            turns,
                        );
                    }
                    "CollabAgentToolCall"
                        if item.get("tool").and_then(|t| t.as_str()) == Some("spawn_agent") =>
                    {
                        let role = item
                            .get("prompt")
                            .and_then(|p| p.as_str())
                            .and_then(codex_role_from_prompt);
                        for agent in item
                            .get("receiver_agents")
                            .and_then(|a| a.as_array())
                            .into_iter()
                            .flatten()
                        {
                            let Some(id) = agent.get("thread_id").and_then(|t| t.as_str()) else {
                                continue;
                            };
                            let nick = agent
                                .get("agent_nickname")
                                .and_then(|n| n.as_str())
                                .unwrap_or("Subagent");
                            codex_push_subagent(
                                surface_id,
                                current_turn,
                                turns,
                                id,
                                nick,
                                role.as_deref(),
                                ts_ms,
                            );
                        }
                    }
                    "CommandExecution" => {
                        let cmd = match item.get("command") {
                            Some(serde_json::Value::Array(a)) => a
                                .iter()
                                .filter_map(|x| x.as_str())
                                .collect::<Vec<_>>()
                                .join(" "),
                            Some(serde_json::Value::String(s)) => s.clone(),
                            _ => String::new(),
                        };
                        let out = item
                            .get("aggregated_output")
                            .and_then(|o| o.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|o| cap_detail(o.to_string()));
                        let exit_ok = item
                            .get("exit_code")
                            .and_then(|c| c.as_i64())
                            .is_none_or(|c| c == 0)
                            && item.get("status").and_then(|s| s.as_str()) != Some("failed");

                        let turn = assistant_turn(surface_id, current_turn, turns);
                        if turn.timestamp.is_none() {
                            turn.timestamp = ts_ms;
                        }
                        let tool_id = item
                            .get("id")
                            .or_else(|| item.get("call_id"))
                            .and_then(|i| i.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("exec-{}", turn.events.len()));

                        if state.seen_tool_ids.insert(tool_id.clone()) {
                            turn.events.push(AgentEvent::ToolStart {
                                tool_id: tool_id.clone(),
                                name: "command".into(),
                                detail: Some(cap_detail(cmd)),
                            });
                        }
                        if state.ended_tool_ids.insert(tool_id.clone()) {
                            turn.events.push(AgentEvent::ToolEnd {
                                tool_id,
                                name: Some("command".into()),
                                detail: out,
                                ok: exit_ok,
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        },
        "response_item" => match ptype {
            "message" if !state.paginated => match p.get("role").and_then(|r| r.as_str()) {
                Some("user") => {
                    if let Some(text) = codex_user_prompt_text(p.get("content")) {
                        start_user_turn_with_ts(text, ts_ms, surface_id, current_turn, turns);
                    }
                }
                Some("assistant") => {
                    let text = p.get("content").map(payload_text).unwrap_or_default();
                    if !text.trim().is_empty() {
                        let turn = assistant_turn(surface_id, current_turn, turns);
                        if turn.timestamp.is_none() {
                            turn.timestamp = ts_ms;
                        }
                        turn.events.push(AgentEvent::Assistant { text });
                    }
                }
                _ => {}
            },
            "reasoning" if !state.paginated => {
                if let Some(think) = p
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| codex_summary_text(p.get("summary")))
                {
                    let turn = assistant_turn(surface_id, current_turn, turns);
                    if turn.timestamp.is_none() {
                        turn.timestamp = ts_ms;
                    }
                    turn.events.push(AgentEvent::Thinking {
                        text: think,
                        duration_secs: None,
                    });
                }
            }
            // Tool calls & outputs remain active even when `state.paginated == true`
            // (`ref/orca/src/main/native-chat/transcript-line-decoders-codex.ts:14-29`).
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let default_name = if ptype == "local_shell_call" {
                    "command"
                } else {
                    "tool"
                };
                let name = p
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(default_name)
                    .to_string();
                let id = p
                    .get("call_id")
                    .or_else(|| p.get("id"))
                    .and_then(|i| i.as_str())
                    .unwrap_or("tool")
                    .to_string();

                if CODEX_AGENT_TOOLS.contains(&name.as_str()) {
                    if name == "spawn_agent"
                        && let Some(role) = p
                            .get("arguments")
                            .and_then(|a| a.as_str())
                            .and_then(codex_spawn_role)
                    {
                        state.spawn_roles.insert(id.clone(), role);
                    }
                    state.hidden_calls.insert(id);
                    return;
                }

                if !state.seen_tool_ids.insert(id.clone()) {
                    return;
                }

                let parsed_args = p
                    .get("arguments")
                    .and_then(|a| a.as_str())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .or_else(|| p.get("input").cloned());
                if let Some(ask_ev) =
                    parse_ask_event(Some(id.clone()), &name, parsed_args.as_ref())
                {
                    let turn = assistant_turn(surface_id, current_turn, turns);
                    if turn.timestamp.is_none() {
                        turn.timestamp = ts_ms;
                    }
                    turn.events.push(ask_ev);
                    return;
                }

                let detail = format_local_shell_detail(p);
                let turn = assistant_turn(surface_id, current_turn, turns);
                if turn.timestamp.is_none() {
                    turn.timestamp = ts_ms;
                }
                turn.events
                    .push(AgentEvent::ToolStart { tool_id: id, name, detail });
            }
            "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
                let id = p
                    .get("call_id")
                    .or_else(|| p.get("id"))
                    .and_then(|i| i.as_str())
                    .unwrap_or("tool")
                    .to_string();

                if state.hidden_calls.contains(&id) {
                    if let Some(out) = p
                        .get("output")
                        .map(payload_text)
                        .and_then(|o| serde_json::from_str::<serde_json::Value>(&o).ok())
                        && let Some(agent_id) = out.get("agent_id").and_then(|a| a.as_str())
                    {
                        let nick = out
                            .get("nickname")
                            .and_then(|n| n.as_str())
                            .unwrap_or("Subagent");
                        let role = state.spawn_roles.get(&id).cloned();
                        codex_push_subagent(
                            surface_id,
                            current_turn,
                            turns,
                            agent_id,
                            nick,
                            role.as_deref(),
                            ts_ms,
                        );
                    }
                    return;
                }

                if !state.ended_tool_ids.insert(id.clone()) {
                    return;
                }

                let (detail, ok) = extract_codex_tool_output(p.get("output"));

                // Settle matching AwaitingInput if this call_id was a question tool.
                let settle_ask = |t: &mut AgentTurn| -> bool {
                    if let Some(AgentEvent::AwaitingInput(ai)) = t.events.iter_mut().rev().find(|e| {
                        matches!(
                            e,
                            AgentEvent::AwaitingInput(a)
                                if a.answered.is_none() && a.tool_id.as_deref() == Some(id.as_str())
                        )
                    }) {
                        ai.answered = detail
                            .as_deref()
                            .map(clean_question_answer_text)
                            .filter(|s| !s.is_empty())
                            .or_else(|| Some("Answered".to_string()));
                        return true;
                    }
                    false
                };
                if let Some(ct) = current_turn.as_mut()
                    && settle_ask(ct)
                {
                    return;
                }
                for t in turns.iter_mut().rev() {
                    if settle_ask(t) {
                        return;
                    }
                }

                // Drop orphaned `ToolEnd`s at window start when no matching `ToolStart` exists.
                let has_start = |t: &AgentTurn| {
                    t.events.iter().any(|e| {
                        matches!(e, AgentEvent::ToolStart { tool_id, .. } if *tool_id == id)
                    })
                };
                let target = match current_turn.as_mut() {
                    Some(ct) if has_start(ct) => Some(ct),
                    _ => turns.iter_mut().rev().find(|t| has_start(t)),
                };
                if let Some(turn) = target {
                    turn.events.push(AgentEvent::ToolEnd {
                        tool_id: id,
                        name: None,
                        detail,
                        ok,
                    });
                }
            }
            _ => {}
        },
        _ => {}
    }
}
