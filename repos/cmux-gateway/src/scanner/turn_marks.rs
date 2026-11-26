//! Where a turn stands according to the transcript itself, for agents whose hook `Stop` can be late or never
//! recorded (Esc interrupt, a crashed agent, a background-task `PostToolUse` after `Stop`). Without this the chat
//! kept showing "Thinking…" for up to 30 minutes (the staleness rule) although the agent had finished.
//!
//! Port of Orca's per-agent turn-lifecycle decoders (`ref/orca/src/main/native-chat/transcript-turn-lifecycle.ts`,
//! markers in `transcript-turn-markers.ts`): the transcript's *last lifecycle-bearing* record decides, other
//! records are skipped.
//!
//! Claude (checked against this machine's `~/.claude/projects`, 976 `end_turn`, 6 `interruptedMessageId`):
//! * `assistant` with `stop_reason` in {end_turn, max_tokens, stop_sequence, refusal} => completed. A legacy row
//!   without `stop_reason` counts only when it has prose and no `tool_use`. `tool_use` rows mean "still going".
//! * `user` with `interruptedMessageId` ("[Request interrupted by user]") => interrupted.
//! * a genuine `user` prompt => working. Tool-result rows, injected/meta rows and sidechain (subagent) rows are skipped.
//! * The LAST line of a Claude transcript is usually `cost-state`/`system`/`queue-operation` (36 of 40 files), so
//!   "look at the last line" does not work; scanning backwards does.
//!
//! Codex (`event_msg` payloads): `task_started` => working, `task_complete` => completed, `turn_aborted` => interrupted.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnMark {
    Working,
    Completed,
    Interrupted,
}

/// A mark and the record's own timestamp (unix seconds) when it has one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mark {
    pub state: TurnMark,
    pub at: Option<f64>,
}

/// Enough to reach past a few very large tool-result lines.
const TAIL_BYTES: u64 = 1024 * 1024;

pub fn read_tail(path: &str) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

static MARK_CACHE: LazyLock<Mutex<HashMap<(String, &'static str), (u128, u64, Option<Mark>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_MARK_CACHE: usize = 256;

fn cached_last_mark(path: &str, kind: &'static str, decode: fn(&str) -> Option<Mark>) -> Option<Mark> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let len = meta.len();
    let key = (path.to_string(), kind);
    if let Ok(cache) = MARK_CACHE.lock() {
        if let Some((cached_mtime, cached_len, cached_mark)) = cache.get(&key) {
            if *cached_mtime == mtime_ns && *cached_len == len {
                return *cached_mark;
            }
        }
    }
    let tail = read_tail(path)?;
    let mark = decode(&tail);
    if let Ok(mut cache) = MARK_CACHE.lock() {
        if cache.len() >= MAX_MARK_CACHE {
            cache.clear();
        }
        cache.insert(key, (mtime_ns, len, mark));
    }
    mark
}

/// Cached `claude_last_mark` keyed by `(path, mtime, len)` so 500ms scanners skip unchanged files.
pub fn cached_claude_mark(path: &str) -> Option<Mark> {
    cached_last_mark(path, "claude", claude_last_mark)
}

/// Cached `codex_last_mark` keyed by `(path, mtime, len)` so 500ms scanners skip unchanged files.
pub fn cached_codex_mark(path: &str) -> Option<Mark> {
    cached_last_mark(path, "codex", codex_last_mark)
}

/// `2026-11-12T10:47:18.363Z` (or `[+-]HH:MM` offset) -> unix seconds.
pub fn parse_rfc3339_secs(s: &str) -> Option<f64> {
    crate::domain::noise_filter::parse_rfc3339_secs(s)
}

fn record_time(v: &serde_json::Value) -> Option<f64> {
    v.get("timestamp").and_then(|t| t.as_str()).and_then(parse_rfc3339_secs)
}

fn user_texts(msg: &serde_json::Value) -> Vec<String> {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

fn claude_mark(v: &serde_json::Value) -> Option<Mark> {
    if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
        return None; // a subagent's own conversation, not this turn
    }
    let at = record_time(v);
    let msg = v.get("message");
    match v.get("type").and_then(|t| t.as_str())? {
        "user" => {
            if v.get("interruptedMessageId").is_some() {
                return Some(Mark { state: TurnMark::Interrupted, at });
            }
            if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) {
                return None;
            }
            let msg = msg?;
            let blocks = msg.get("content").and_then(|c| c.as_array());
            if let Some(arr) = blocks
                && arr
                    .iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
            {
                return None; // a tool result continues the turn
            }
            let has_image_block = blocks.is_some_and(|arr| {
                arr.iter()
                    .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("image"))
            });
            let texts = user_texts(msg);
            let has_non_injected_text = texts.iter().any(|t| {
                !t.trim().is_empty()
                    && !crate::domain::noise_filter::is_known_harness_injected_user_turn_text(t)
            });
            if !has_non_injected_text && !has_image_block {
                return None;
            }
            Some(Mark { state: TurnMark::Working, at })
        }
        "assistant" => {
            let msg = msg?;
            if crate::providers::claude::is_claude_synthetic_no_response_assistant(msg) {
                return None;
            }
            let terminal = match msg.get("stop_reason").and_then(|s| s.as_str()) {
                Some(r) => matches!(r, "end_turn" | "max_tokens" | "stop_sequence" | "refusal"),
                None if msg.get("stop_reason").is_none() || msg.get("stop_reason").is_some_and(|s| s.is_null()) => {
                    // Legacy rows: complete prose without tool_use.
                    let blocks = msg.get("content").and_then(|c| c.as_array());
                    let has_tool = blocks.is_some_and(|b| {
                        b.iter().any(|x| x.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                    });
                    let has_text = match msg.get("content") {
                        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
                        Some(serde_json::Value::Array(a)) => a.iter().any(|x| {
                            x.get("type").and_then(|t| t.as_str()) == Some("text")
                                && x.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty())
                        }),
                        _ => false,
                    };
                    has_text && !has_tool
                }
                None => false,
            };
            terminal.then_some(Mark { state: TurnMark::Completed, at })
        }
        _ => None,
    }
}

fn codex_mark(v: &serde_json::Value) -> Option<Mark> {
    if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
        return None;
    }
    let state = match v.pointer("/payload/type").and_then(|t| t.as_str())? {
        "task_started" => TurnMark::Working,
        "task_complete" => TurnMark::Completed,
        "turn_aborted" => TurnMark::Interrupted,
        _ => return None,
    };
    Some(Mark { state, at: record_time(v) })
}

fn last_mark(tail: &str, decode: fn(&serde_json::Value) -> Option<Mark>) -> Option<Mark> {
    tail.lines()
        .rev()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find_map(|v| decode(&v))
}

/// Latest turn mark of a Claude transcript tail.
pub fn claude_last_mark(tail: &str) -> Option<Mark> {
    last_mark(tail, claude_mark)
}

/// Latest turn mark of a Codex rollout tail.
pub fn codex_last_mark(tail: &str) -> Option<Mark> {
    last_mark(tail, codex_mark)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(lines: &[&str]) -> String {
        lines.join("\n")
    }

    const PROMPT: &str = r#"{"type":"user","timestamp":"2026-11-15T01:00:00.000Z","message":{"role":"user","content":"fix it"}}"#;
    const TOOL_USE: &str = r#"{"type":"assistant","timestamp":"2026-11-15T01:00:05.000Z","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#;
    const TOOL_RESULT: &str = r#"{"type":"user","timestamp":"2026-11-15T01:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
    const END_TURN: &str = r#"{"type":"assistant","timestamp":"2026-11-15T01:00:09.500Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}"#;
    const COST: &str = r#"{"type":"cost-state","timestamp":"2026-11-15T01:00:10.000Z"}"#;

    #[test]
    fn claude_last_line_is_usually_bookkeeping_so_it_scans_backwards() {
        let m = claude_last_mark(&tail(&[PROMPT, TOOL_USE, TOOL_RESULT, END_TURN, COST, r#"{"type":"system"}"#])).unwrap();
        assert_eq!(m.state, TurnMark::Completed);
        assert_eq!(m.at, parse_rfc3339_secs("2026-11-15T01:00:09.500Z"));
    }

    #[test]
    fn claude_mid_turn_is_working() {
        // prompt, tool call, tool result: the turn goes on
        assert_eq!(claude_last_mark(&tail(&[PROMPT, TOOL_USE, TOOL_RESULT, COST])).unwrap().state, TurnMark::Working);
        // an unfinished assistant row (tool_use) alone says nothing; the prompt before it does
        assert_eq!(claude_last_mark(&tail(&[END_TURN, PROMPT, TOOL_USE])).unwrap().state, TurnMark::Working);
    }

    #[test]
    fn claude_interrupt_and_injected_rows() {
        let interrupted = r#"{"type":"user","interruptedMessageId":"x","timestamp":"2026-11-15T01:00:07.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert_eq!(claude_last_mark(&tail(&[PROMPT, TOOL_USE, interrupted])).unwrap().state, TurnMark::Interrupted);
        // injected reminders / meta / sidechain rows after the reply must not restart the spinner
        let reminder = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>be brief</system-reminder>"}]}}"#;
        let meta = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}"#;
        let side = r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagent prompt"}}"#;
        assert_eq!(claude_last_mark(&tail(&[PROMPT, END_TURN, reminder, meta, side])).unwrap().state, TurnMark::Completed);

        // Mixed [user text + <system-reminder>] AND image-only user prompts MUST mark Working!
        let mixed_prompt = r#"{"type":"user","timestamp":"2026-11-15T01:02:00Z","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>hook</system-reminder>"},{"type":"text","text":"fix bug"}]}}"#;
        assert_eq!(claude_last_mark(&tail(&[END_TURN, mixed_prompt])).unwrap().state, TurnMark::Working);
        let image_prompt = r#"{"type":"user","timestamp":"2026-11-15T01:03:00Z","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"abc"}}]}}"#;
        assert_eq!(claude_last_mark(&tail(&[END_TURN, image_prompt])).unwrap().state, TurnMark::Working);
    }

    #[test]
    fn claude_legacy_rows_without_stop_reason() {
        let prose = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}"#;
        let tool = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"X","input":{}}]}}"#;
        assert_eq!(claude_last_mark(&tail(&[PROMPT, prose])).unwrap().state, TurnMark::Completed);
        assert_eq!(claude_last_mark(&tail(&[PROMPT, tool])).unwrap().state, TurnMark::Working);
        assert!(claude_last_mark("not json\n\n").is_none());
    }

    #[test]
    fn codex_markers() {
        let started = r#"{"timestamp":"2026-11-14T18:56:07.705Z","type":"event_msg","payload":{"type":"task_started"}}"#;
        let done = r#"{"timestamp":"2026-11-14T18:56:20.000Z","type":"event_msg","payload":{"type":"task_complete"}}"#;
        let aborted = r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#;
        let noise = r#"{"type":"response_item","payload":{"type":"message"}}"#;
        assert_eq!(codex_last_mark(&tail(&[started, noise])).unwrap().state, TurnMark::Working);
        assert_eq!(codex_last_mark(&tail(&[started, done, noise])).unwrap().state, TurnMark::Completed);
        assert_eq!(codex_last_mark(&tail(&[started, aborted])).unwrap().state, TurnMark::Interrupted);
        assert!(codex_last_mark(noise).is_none());
    }

    #[test]
    fn rfc3339() {
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse_rfc3339_secs("2000-03-01T00:00:00Z"), Some(951_868_800.0));
        assert_eq!(parse_rfc3339_secs("2026-11-12T10:47:18.500Z"), Some(1_794_480_438.5));
        assert!(parse_rfc3339_secs("2026-11-12 10:47:18").is_none());
        assert!(parse_rfc3339_secs("2026-13-01T00:00:00Z").is_none());
    }
}
