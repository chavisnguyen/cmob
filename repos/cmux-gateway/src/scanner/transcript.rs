use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, AskQuestionItem, AwaitingInput, BackgroundTaskEntry,
    BackgroundTaskKind, SubagentEntry, SubagentState,
};

/// Multi-Agent Transcript Reader
/// Normalizes Claude Code, Antigravity (AGY), and Codex transcripts into unified AgentTurn structures.
/// Sources:
/// - ref/cmux/agent-chat/test/transcript.test.ts:50-64
/// - ref/orca/src/shared/native-chat/native-chat-types.ts:34-175
pub struct TranscriptReader;

/// Max characters of a tool `detail` sent to clients. Large tool inputs/outputs made a single
/// `mobile.chat.readSession` response reach ~3 MB, which is re-fetched every second by the client.
const MAX_DETAIL_CHARS: usize = 4000;

/// Truncate `detail` on a char boundary, marking the cut so the UI is not misled.
fn cap_detail(s: String) -> String {
    if s.chars().count() <= MAX_DETAIL_CHARS {
        return s;
    }
    let mut out: String = s.chars().take(MAX_DETAIL_CHARS).collect();
    out.push_str("… [truncated]");
    out
}

/// Codex rollouts record the same conversation twice depending on `session_meta.history_mode`:
/// `paginated` uses `event_msg`/`item_completed` items, otherwise `response_item` records are used.
/// Only one family is consumed per file so messages are never duplicated.
#[derive(Default, Clone)]
struct CodexState {
    paginated: bool,
    /// `spawn_agent` call_id -> role label parsed from the prompt ("You are the `Role`").
    spawn_roles: std::collections::HashMap<String, String>,
    /// call_ids of spawn/wait/close_agent calls: folded into the subagent card, not shown as tool rows.
    hidden_calls: std::collections::HashSet<String>,
    /// Timestamp (ms) of the latest unsettled `Thinking` block in `current_turn`.
    open_thinking_ms: Option<u64>,
}

const CODEX_AGENT_TOOLS: [&str; 3] = ["spawn_agent", "wait_agent", "close_agent"];
/// A child rollout without `task_complete` that has not been written for this long is shown as unverifiable.
const CODEX_CHILD_QUIET_SECS: u64 = 600;

/// Role name from a spawn prompt such as "You are the `Flutter Mobile Specialist`. Audit ...".
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

/// Add a spawned child to the turn's single "codex-subagents" card.
fn codex_push_subagent(
    _state: &CodexState,
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
    agent_id: &str,
    nickname: &str,
    role: Option<&str>,
) {
    let label = match role {
        Some(role) => format!("{role} ({nickname})"),
        None => nickname.to_string(),
    };
    // Defer child rollout file I/O until `refresh_working_codex_subagents` runs on the final
    // visible slice so historical turns outside the window never touch child rollout files.
    let entry = SubagentEntry {
        id: agent_id.to_string(),
        label,
        state: SubagentState::Working,
        tokens: None,
        started_at: None,
        settled_at: None,
    };
    let turn = assistant_turn(surface_id, current_turn, turns);
    let group = turn.events.iter_mut().find_map(|e| match e {
        AgentEvent::Subagents { group_id, agents } if group_id == "codex-subagents" => Some(agents),
        _ => None,
    });
    match group {
        Some(agents) => agents.push(entry),
        None => turn.events.push(AgentEvent::Subagents {
            group_id: "codex-subagents".to_string(),
            agents: vec![entry],
        }),
    }
}

/// State of a Codex child from its own rollout. Verified on 10 local subagent rollouts: 8 end with an
/// `event_msg` `task_complete`, 2 with `token_count` (still running or abandoned). No `turn_aborted` /
/// failure marker was observed, so failures are not inferred.
fn codex_child_status(parent: &Path, agent_id: &str) -> (SubagentState, Option<u64>) {
    let Some(path) = crate::scanner::hook_store::find_codex_rollout(agent_id, parent) else {
        return (SubagentState::Unverifiable, None);
    };
    let Ok(mut f) = File::open(&path) else { return (SubagentState::Unverifiable, None) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let age = f
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(512 * 1024)));
    // Bytes, not read_to_string: the seek can land inside a multi-byte character, which would make a
    // UTF-8 read fail and throw the whole tail away.
    let mut raw = Vec::new();
    let _ = f.read_to_end(&mut raw);
    let buf = String::from_utf8_lossy(&raw).into_owned();
    let mut decided: Option<bool> = None; // Some(true) = last turn completed
    let mut tokens: Option<u64> = None;
    for line in buf.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        match p.get("type").and_then(|t| t.as_str()) {
            Some("task_complete") if decided.is_none() => decided = Some(true),
            Some("task_started") if decided.is_none() => decided = Some(false),
            Some("token_count") if tokens.is_none() => {
                tokens = p.pointer("/info/total_token_usage/total_tokens").and_then(|t| t.as_u64());
            }
            _ => {}
        }
        if decided.is_some() && tokens.is_some() {
            break;
        }
    }
    let state = match decided {
        Some(true) => SubagentState::Completed,
        _ if age <= CODEX_CHILD_QUIET_SECS => SubagentState::Working,
        _ => SubagentState::Unverifiable,
    };
    (state, tokens)
}

fn payload_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn start_user_turn(
    text: String,
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    if let Some(t) = current_turn.take() {
        turns.push(t);
    }
    if text.trim().is_empty() {
        return;
    }
    let mut turn = AgentTurn::new(format!("turn-{}", turns.len() + 1), surface_id, AgentRole::User);
    turn.events.push(AgentEvent::User { text });
    turns.push(turn);
}

fn assistant_turn<'a>(
    surface_id: &str,
    current_turn: &'a mut Option<AgentTurn>,
    turns: &[AgentTurn],
) -> &'a mut AgentTurn {
    current_turn.get_or_insert_with(|| {
        AgentTurn::new(format!("turn-{}", turns.len() + 1), surface_id, AgentRole::Assistant)
    })
}

/// Reverse tail-chunk size (matches Orca `TAIL_CHUNK_BYTES = 64 * 1024` in `transcript-tail-boundary.ts:4`).
const TAIL_CHUNK_BYTES: u64 = 64 * 1024;
/// Files up to 128 KiB are read from byte 0 in one pass; larger transcripts seek from the tail.
const TAIL_WINDOW_THRESHOLD_BYTES: u64 = 128 * 1024;
/// Skip individual JSONL records over 2 MiB (matches Orca `MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES`).
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
/// Maximum bytes scanned backwards in a single page request on pathological transcripts without user turns.
const MAX_WINDOW_SCAN_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct TranscriptPage {
    pub turns: Vec<AgentTurn>,
    pub has_more: bool,
    pub before_offset: Option<u64>,
    pub total_turns: usize,
}

struct CachedTranscript {
    mtime_ns: u128,
    window_start_offset: u64,
    byte_offset: u64,
    turns: Vec<AgentTurn>,
    turn_offsets: Vec<u64>,
    current_turn: Option<AgentTurn>,
    current_turn_offset: Option<u64>,
    codex: CodexState,
}

type CacheKey = (PathBuf, String);
type CacheSlot = std::sync::Arc<Mutex<Option<CachedTranscript>>>;

struct TranscriptCacheMap {
    clock: u64,
    entries: HashMap<CacheKey, (u64, CacheSlot)>,
}

static TRANSCRIPT_CACHE: LazyLock<Mutex<TranscriptCacheMap>> = LazyLock::new(|| {
    Mutex::new(TranscriptCacheMap {
        clock: 0,
        entries: HashMap::new(),
    })
});
const MAX_TRANSCRIPT_CACHE: usize = 64;

fn get_transcript_cache_slot(key: CacheKey) -> CacheSlot {
    let mut store = TRANSCRIPT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    store.clock = store.clock.wrapping_add(1);
    let tick = store.clock;
    if let Some((used_at, slot)) = store.entries.get_mut(&key) {
        *used_at = tick;
        return std::sync::Arc::clone(slot);
    }
    while store.entries.len() >= MAX_TRANSCRIPT_CACHE {
        let Some(oldest_key) = store
            .entries
            .iter()
            .min_by_key(|(_, (used_at, _))| *used_at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        store.entries.remove(&oldest_key);
    }
    let slot = std::sync::Arc::new(Mutex::new(None));
    store.entries.insert(key, (tick, std::sync::Arc::clone(&slot)));
    slot
}

/// Fast byte-level check for records that may open a new `User` turn, avoiding full JSON decode while
/// scanning `64 KiB` chunks backwards.
fn is_likely_user_turn_record(line: &str) -> bool {
    line.contains("\"USER_INPUT\"")
        || line.contains("\"UserMessage\"")
        || (line.contains("\"user\"") && !line.contains("\"tool_result\""))
}

/// Read line 1 (up to 4 KiB) to detect Codex `session_meta.history_mode == "paginated"` when tail-seeking.
fn read_codex_header_state(file: &mut File) -> CodexState {
    let mut codex = CodexState::default();
    if file.seek(SeekFrom::Start(0)).is_err() {
        return codex;
    }
    let mut header_buf = vec![0u8; 4096];
    let Ok(n) = file.read(&mut header_buf) else {
        return codex;
    };
    if n == 0 {
        return codex;
    }
    let slice = match header_buf[..n].iter().position(|&b| b == b'\n') {
        Some(nl) => &header_buf[..nl],
        None if n < header_buf.len() => &header_buf[..n],
        None => return codex,
    };
    let line = String::from_utf8_lossy(slice);
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line.trim()) {
        if val.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            codex.paginated = val
                .get("payload")
                .and_then(|p| p.get("history_mode"))
                .and_then(|m| m.as_str())
                == Some("paginated");
        }
    }
    codex
}

/// Feed one line while recording the file byte offset of every newly created turn and assigning
/// byte-anchored turn IDs (`turn-@<offset>`) whenever parsing starts mid-file (`offset_anchored`).
fn parse_line_with_offsets(
    trimmed: &str,
    line_offset: u64,
    offset_anchored: bool,
    surface_id: &str,
    codex: &mut CodexState,
    current_turn: &mut Option<AgentTurn>,
    current_turn_offset: &mut Option<u64>,
    turns: &mut Vec<AgentTurn>,
    turn_offsets: &mut Vec<u64>,
) {
    let prev_len = turns.len();
    let prev_had_current = current_turn.is_some();
    let prev_current_off = *current_turn_offset;

    parse_transcript_line(trimmed, surface_id, codex, current_turn, turns);

    let added = turns.len().saturating_sub(prev_len);
    if added > 0 {
        for i in 0..added {
            let idx = prev_len + i;
            let off = if i == 0 && prev_had_current {
                prev_current_off.unwrap_or(line_offset)
            } else {
                line_offset
            };
            if offset_anchored {
                turns[idx].id = format!("turn-@{off}");
            }
            turn_offsets.push(off);
        }
    }

    if let Some(ct) = current_turn.as_mut() {
        if !prev_had_current || added > 0 {
            *current_turn_offset = Some(line_offset);
            if offset_anchored {
                ct.id = format!("turn-@{line_offset}");
            }
        }
    } else {
        *current_turn_offset = None;
    }
}

/// Determine the last safe byte offset `<= end_limit` to consume. At live EOF (`check_partial_tail`),
/// an unterminated trailing line that is not yet valid JSON is held back for the next incremental read.
fn find_consumable_end(
    file: &mut File,
    end_limit: u64,
    check_partial_tail: bool,
) -> Result<u64, std::io::Error> {
    if end_limit == 0 {
        return Ok(0);
    }
    if !check_partial_tail {
        return Ok(end_limit);
    }
    let mut byte = [0u8; 1];
    file.seek(SeekFrom::Start(end_limit - 1))?;
    if file.read(&mut byte)? == 1 && byte[0] == b'\n' {
        return Ok(end_limit);
    }
    // Scan backwards in 64 KiB chunks to find the start of the unterminated trailing line.
    let mut cursor = end_limit;
    let mut tail_parts: Vec<Vec<u8>> = Vec::new();
    let mut total_tail = 0usize;
    while cursor > 0 {
        let start = cursor.saturating_sub(TAIL_CHUNK_BYTES);
        let chunk_len = (cursor - start) as usize;
        let mut buf = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        if let Some(pos) = buf.iter().rposition(|&b| b == b'\n') {
            let after_nl = &buf[pos + 1..];
            total_tail += after_nl.len();
            if total_tail > MAX_RECORD_BYTES {
                return Ok(end_limit);
            }
            let mut full = Vec::with_capacity(total_tail);
            full.extend_from_slice(after_nl);
            for part in tail_parts.into_iter().rev() {
                full.extend_from_slice(&part);
            }
            let s = String::from_utf8_lossy(&full);
            let trimmed = s.trim();
            if trimmed.is_empty() || serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
                return Ok(end_limit);
            }
            return Ok(start + pos as u64 + 1);
        }
        total_tail += chunk_len;
        if total_tail > MAX_RECORD_BYTES {
            return Ok(end_limit);
        }
        tail_parts.push(buf);
        cursor = start;
    }
    let mut full = Vec::with_capacity(total_tail);
    for part in tail_parts.into_iter().rev() {
        full.extend_from_slice(&part);
    }
    let s = String::from_utf8_lossy(&full);
    let trimmed = s.trim();
    if trimmed.is_empty() || serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        Ok(end_limit)
    } else {
        Ok(0)
    }
}

/// Read a bounded tail window ending at `end_limit` by stepping backwards in `64 KiB` chunks
/// (Orca `readNativeChatTranscriptTailFile` pattern) and assembling complete `AgentTurn`s.
fn read_tail_window(
    file: &mut File,
    surface_id: &str,
    end_limit: u64,
    needed_turns: usize,
    is_live_tail: bool,
) -> Result<CachedTranscript, std::io::Error> {
    let consumed_to = find_consumable_end(file, end_limit, is_live_tail)?;
    let base_codex = if consumed_to > TAIL_WINDOW_THRESHOLD_BYTES {
        read_codex_header_state(file)
    } else {
        CodexState::default()
    };

    if consumed_to == 0 {
        return Ok(CachedTranscript {
            mtime_ns: 0,
            window_start_offset: 0,
            byte_offset: 0,
            turns: Vec::new(),
            turn_offsets: Vec::new(),
            current_turn: None,
            current_turn_offset: None,
            codex: base_codex,
        });
    }

    // Small files (<= 128 KiB): single forward pass from byte 0 preserves sequential `turn-N` IDs.
    if consumed_to <= TAIL_WINDOW_THRESHOLD_BYTES && is_live_tail {
        file.seek(SeekFrom::Start(0))?;
        let mut reader = BufReader::new(file.try_clone()?);
        let mut offset = 0u64;
        let mut line_buf = Vec::new();
        let mut codex = base_codex;
        let mut turns = Vec::new();
        let mut turn_offsets = Vec::new();
        let mut current_turn = None;
        let mut current_turn_offset = None;

        while offset < consumed_to {
            line_buf.clear();
            let n = reader.read_until(b'\n', &mut line_buf)?;
            if n == 0 {
                break;
            }
            let line_start = offset;
            offset = (offset + n as u64).min(consumed_to);
            if line_buf.len() <= MAX_RECORD_BYTES {
                let text = String::from_utf8_lossy(&line_buf);
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parse_line_with_offsets(
                        trimmed,
                        line_start,
                        false,
                        surface_id,
                        &mut codex,
                        &mut current_turn,
                        &mut current_turn_offset,
                        &mut turns,
                        &mut turn_offsets,
                    );
                }
            }
        }
        return Ok(CachedTranscript {
            mtime_ns: 0,
            window_start_offset: 0,
            byte_offset: consumed_to,
            turns,
            turn_offsets,
            current_turn,
            current_turn_offset,
            codex,
        });
    }

    // Large files or `before_offset` cursor reads: walk backwards in 64 KiB chunks.
    let target_user_boundaries = (needed_turns / 2).saturating_add(3);
    let mut cursor = consumed_to;
    // Check if last byte is `\n` so we don't emit a bogus empty trailing segment.
    let mut last_byte = [0u8; 1];
    file.seek(SeekFrom::Start(consumed_to - 1))?;
    if file.read(&mut last_byte)? == 1 && last_byte[0] == b'\n' {
        cursor -= 1;
    }

    let mut carry_parts: Vec<Vec<u8>> = Vec::new();
    let mut carry_bytes = 0usize;
    let mut carry_oversized = false;
    let mut rev_lines: Vec<(u64, String)> = Vec::new();
    let mut user_boundaries = 0usize;
    let mut scanned_bytes = 0u64;

    let push_assembled_line = |line_offset: u64,
                               parts: &mut Vec<Vec<u8>>,
                               bytes_len: &mut usize,
                               oversized: &mut bool,
                               out: &mut Vec<(u64, String)>,
                               boundaries: &mut usize| {
        if !*oversized && *bytes_len > 0 {
            let text = if parts.len() == 1 {
                String::from_utf8_lossy(&parts[0]).into_owned()
            } else {
                let mut joined = Vec::with_capacity(*bytes_len);
                for p in parts.iter().rev() {
                    joined.extend_from_slice(p);
                }
                String::from_utf8_lossy(&joined).into_owned()
            };
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                if is_likely_user_turn_record(trimmed) {
                    *boundaries += 1;
                }
                out.push((line_offset, trimmed.to_string()));
            }
        }
        parts.clear();
        *bytes_len = 0;
        *oversized = false;
    };

    loop {
        while cursor > 0 && user_boundaries < target_user_boundaries && scanned_bytes < MAX_WINDOW_SCAN_BYTES {
            let start = cursor.saturating_sub(TAIL_CHUNK_BYTES);
            let chunk_len = (cursor - start) as usize;
            let mut buf = vec![0u8; chunk_len];
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut buf)?;
            scanned_bytes += chunk_len as u64;

            let mut seg_end = chunk_len;
            for idx in (0..chunk_len).rev() {
                if buf[idx] != b'\n' {
                    continue;
                }
                let seg = &buf[idx + 1..seg_end];
                if !carry_oversized {
                    carry_bytes += seg.len();
                    if carry_bytes > MAX_RECORD_BYTES {
                        carry_parts.clear();
                        carry_oversized = true;
                    } else if !seg.is_empty() {
                        carry_parts.push(seg.to_vec());
                    }
                }
                push_assembled_line(
                    start + idx as u64 + 1,
                    &mut carry_parts,
                    &mut carry_bytes,
                    &mut carry_oversized,
                    &mut rev_lines,
                    &mut user_boundaries,
                );
                seg_end = idx;
                if user_boundaries >= target_user_boundaries {
                    cursor = start + idx as u64;
                    break;
                }
            }

            if user_boundaries >= target_user_boundaries {
                break;
            }

            if seg_end > 0 && !carry_oversized {
                let rem = &buf[..seg_end];
                carry_bytes += rem.len();
                if carry_bytes > MAX_RECORD_BYTES {
                    carry_parts.clear();
                    carry_oversized = true;
                } else {
                    carry_parts.push(rem.to_vec());
                }
            }
            cursor = start;
        }

        if cursor == 0 && (carry_bytes > 0 || carry_oversized) {
            push_assembled_line(
                0,
                &mut carry_parts,
                &mut carry_bytes,
                &mut carry_oversized,
                &mut rev_lines,
                &mut user_boundaries,
            );
        }

        // Parse collected lines in chronological order.
        let offset_anchored = cursor > 0 || !is_live_tail;
        let mut codex = base_codex.clone();
        let mut turns = Vec::new();
        let mut turn_offsets = Vec::new();
        let mut current_turn = None;
        let mut current_turn_offset = None;

        for (line_off, trimmed) in rev_lines.iter().rev() {
            parse_line_with_offsets(
                trimmed,
                *line_off,
                offset_anchored,
                surface_id,
                &mut codex,
                &mut current_turn,
                &mut current_turn_offset,
                &mut turns,
                &mut turn_offsets,
            );
        }

        // When starting mid-file (`cursor > 0`), drop any leading partial assistant events that
        // preceded the first complete `User` or `System` boundary turn in our window.
        if cursor > 0 {
            if let Some(first_boundary_idx) = turns
                .iter()
                .position(|t| matches!(t.role, AgentRole::User | AgentRole::System))
            {
                if first_boundary_idx > 0 {
                    turns.drain(0..first_boundary_idx);
                    turn_offsets.drain(0..first_boundary_idx);
                }
            }
        }

        let total_parsed = turns.len() + usize::from(current_turn.is_some());
        if total_parsed >= needed_turns || cursor == 0 || scanned_bytes >= MAX_WINDOW_SCAN_BYTES {
            let window_start = if cursor == 0 {
                0
            } else {
                turn_offsets
                    .first()
                    .copied()
                    .or(current_turn_offset)
                    .unwrap_or(cursor)
            };
            return Ok(CachedTranscript {
                mtime_ns: 0,
                window_start_offset: window_start,
                byte_offset: consumed_to,
                turns,
                turn_offsets,
                current_turn,
                current_turn_offset,
                codex,
            });
        }

        // Some `"user"` lines were tool results/echoes; pull a couple more user boundaries.
        user_boundaries = 0;
    }
}

fn file_mtime_len(path: &Path) -> Result<(u128, u64), std::io::Error> {
    let meta = std::fs::metadata(path)?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok((mtime_ns, meta.len()))
}

fn settle_open_thinking(
    open_thinking_ms: &mut Option<u64>,
    end_ms: Option<u64>,
    current_turn: &mut Option<AgentTurn>,
) {
    let Some(start_ms) = open_thinking_ms.take() else {
        return;
    };
    let Some(now_ms) = end_ms.filter(|&n| n >= start_ms && n - start_ms <= 600_000) else {
        return;
    };
    let secs = ((now_ms - start_ms) / 1000).max(1);
    if let Some(turn) = current_turn.as_mut() {
        for ev in turn.events.iter_mut().rev() {
            if let AgentEvent::Thinking { duration_secs, .. } = ev
                && duration_secs.is_none()
            {
                *duration_secs = Some(secs);
                break;
            }
        }
    }
}

fn parse_transcript_line(
    trimmed: &str,
    surface_id: &str,
    codex: &mut CodexState,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };

    let line_ts = TranscriptReader::record_timestamp_ms(&val);
    settle_open_thinking(&mut codex.open_thinking_ms, line_ts, current_turn);

    if val.get("type").is_none() && val.get("payload").and_then(|p| p.get("type")).is_some() {
        TranscriptReader::parse_kiro_line(&val, surface_id, current_turn, turns);
    } else if val
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| matches!(t, "session_meta" | "event_msg" | "response_item" | "turn_context"))
    {
        TranscriptReader::parse_codex_line(&val, surface_id, codex, current_turn, turns);
    } else if val
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| matches!(t, "USER_INPUT" | "PLANNER_RESPONSE" | "GENERIC" | "SYSTEM_MESSAGE"))
    {
        TranscriptReader::parse_antigravity_line(val, surface_id, current_turn, turns);
    } else {
        TranscriptReader::parse_claude_line(val, surface_id, current_turn, turns);
    }

    if codex.open_thinking_ms.is_none()
        && line_ts.is_some()
        && current_turn.as_ref().is_some_and(|t| {
            t.events
                .iter()
                .rev()
                .any(|e| matches!(e, AgentEvent::Thinking { duration_secs: None, .. }))
        })
    {
        codex.open_thinking_ms = line_ts;
    }
}

fn refresh_working_codex_subagents(parent: &Path, turns: &mut [AgentTurn]) {
    for turn in turns.iter_mut() {
        for ev in turn.events.iter_mut() {
            if let AgentEvent::Subagents { group_id, agents } = ev {
                if group_id == "codex-subagents" {
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
}

impl TranscriptReader {
    /// Kiro CLI `messages.jsonl` records. Types and fields verified against real sessions:
    /// user, assistant(operationType Reasoning|Say|Summary), tool_call(toolCallId,toolName,args),
    /// tool_result(toolCallId,content,success), pending_interaction/interaction_resolved,
    /// sub_agent_start/sub_agent_complete, turn_end(stopReason).
    fn parse_kiro_line(
        val: &serde_json::Value,
        surface_id: &str,
        current_turn: &mut Option<AgentTurn>,
        turns: &mut Vec<AgentTurn>,
    ) {
        let Some(p) = val.get("payload") else { return };
        let s = |k: &str| p.get(k).and_then(|v| v.as_str());
        match s("type").unwrap_or("") {
            "user" => {
                let text = s("content").unwrap_or("").to_string();
                start_user_turn(text, surface_id, current_turn, turns);
            }
            "assistant" => {
                let text = s("content").unwrap_or("");
                if text.trim().is_empty() {
                    return;
                }
                let ev = match s("operationType") {
                    // Kiro writes a `"..."` Reasoning record carrying only `reasoningSignature` (the
                    // reasoning itself is not in the transcript). Measured on all local Kiro
                    // transcripts: 646/646 `"..."` reasoning records have a signature. Not content.
                    Some("Reasoning") if text.trim() == "..." => return,
                    Some("Reasoning") => AgentEvent::Thinking {
                        text: text.to_string(),
                        duration_secs: None,
                    },
                    Some("Summary") => return,
                    _ => AgentEvent::Assistant { text: text.to_string() },
                };
                assistant_turn(surface_id, current_turn, turns).events.push(ev);
            }
            "tool_call" => {
                let id = s("toolCallId").unwrap_or("tool").to_string();
                let name = s("toolName").or(s("title")).unwrap_or("tool").to_string();
                let detail = p.get("args").map(|a| cap_detail(a.to_string()));
                let turn = assistant_turn(surface_id, current_turn, turns);
                let seen = turn
                    .events
                    .iter()
                    .any(|e| matches!(e, AgentEvent::ToolStart { tool_id, .. } if *tool_id == id));
                if !seen {
                    turn.events.push(AgentEvent::ToolStart { tool_id: id, name, detail });
                }
            }
            "tool_result" => {
                let id = s("toolCallId").unwrap_or("tool").to_string();
                let ok = p.get("success").and_then(|b| b.as_bool()).unwrap_or(true);
                let detail = s("content").map(|c| cap_detail(c.to_string()));
                assistant_turn(surface_id, current_turn, turns).events.push(AgentEvent::ToolEnd {
                    tool_id: id,
                    name: None,
                    detail,
                    ok,
                });
            }
            "pending_interaction" => {
                let prompt = s("question").unwrap_or("Approval required").to_string();
                let options = p.get("options").and_then(|o| o.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.get("name").and_then(|n| n.as_str()).map(str::to_string))
                        .collect()
                });
                assistant_turn(surface_id, current_turn, turns)
                    .events
                    .push(AgentEvent::AwaitingInput(AwaitingInput {
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
                if let Some(turn) = current_turn.as_mut() {
                    if let Some(pos) = turn
                        .events
                        .iter()
                        .rposition(|e| matches!(e, AgentEvent::AwaitingInput(_)))
                    {
                        turn.events.remove(pos);
                    }
                }
            }
            "sub_agent_start" => {
                let id = s("subSessionId").unwrap_or("subagent").to_string();
                let label = s("subAgentName").unwrap_or("Subagent").to_string();
                assistant_turn(surface_id, current_turn, turns).events.push(AgentEvent::Subagents {
                    group_id: id.clone(),
                    agents: vec![SubagentEntry {
                        id,
                        label,
                        state: SubagentState::Working,
                        tokens: None,
                        started_at: None,
                        settled_at: None,
                    }],
                });
            }
            "sub_agent_complete" => {
                let id = s("subSessionId").unwrap_or("");
                let failed = matches!(s("status"), Some("failed" | "error"));
                if let Some(turn) = current_turn.as_mut() {
                    for ev in turn.events.iter_mut() {
                        if let AgentEvent::Subagents { agents, .. } = ev {
                            for a in agents.iter_mut().filter(|a| a.id == id) {
                                a.state = if failed { SubagentState::Failed } else { SubagentState::Completed };
                            }
                        }
                    }
                }
            }
            "turn_end" => {
                if s("stopReason") == Some("error") {
                    assistant_turn(surface_id, current_turn, turns)
                        .events
                        .push(AgentEvent::Error { message: "Turn ended with an error".into() });
                }
            }
            _ => {}
        }
    }

    /// Codex rollout JSONL. `paginated` history uses `event_msg`/`item_completed` items
    /// (UserMessage, AgentMessage, CommandExecution{command[],aggregated_output}); legacy history uses
    /// `response_item` (message, function_call{name,arguments}, function_call_output,
    /// custom_tool_call{name,input,call_id}, custom_tool_call_output{call_id,output}).
    /// Sources: ref/orca/src/main/codex/__fixtures__/codex-rollout-*.jsonl and
    /// ref/orca/src/main/ai-vault/scanners/codex/session-scanner-codex-tool-records.test.ts:35-60.
    fn parse_codex_line(
        val: &serde_json::Value,
        surface_id: &str,
        state: &mut CodexState,
        current_turn: &mut Option<AgentTurn>,
        turns: &mut Vec<AgentTurn>,
    ) {
        let Some(p) = val.get("payload") else { return };
        let ptype = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match val.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "session_meta" => {
                state.paginated = p.get("history_mode").and_then(|m| m.as_str()) == Some("paginated");
            }
            "event_msg" if state.paginated && ptype == "item_completed" => {
                let Some(item) = p.get("item") else { return };
                let content = item.get("content").map(payload_text).unwrap_or_default();
                match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "UserMessage" => start_user_turn(content, surface_id, current_turn, turns),
                    "AgentMessage" if !content.trim().is_empty() => {
                        assistant_turn(surface_id, current_turn, turns)
                            .events
                            .push(AgentEvent::Assistant { text: content });
                    }
                    // Codex paginated history has a first-class collab item (verified on a real rollout:
                    // `{type:"CollabAgentToolCall", tool:"spawn_agent", receiver_agents:[{thread_id,
                    // agent_nickname}], prompt}`). wait/close/send are ignored (folded into the card).
                    "CollabAgentToolCall" if item.get("tool").and_then(|t| t.as_str()) == Some("spawn_agent") => {
                        let role = item.get("prompt").and_then(|p| p.as_str()).and_then(codex_role_from_prompt);
                        for agent in item.get("receiver_agents").and_then(|a| a.as_array()).into_iter().flatten() {
                            let Some(id) = agent.get("thread_id").and_then(|t| t.as_str()) else { continue };
                            let nick = agent.get("agent_nickname").and_then(|n| n.as_str()).unwrap_or("Subagent");
                            codex_push_subagent(state, surface_id, current_turn, turns, id, nick, role.as_deref());
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
                            .map(|o| cap_detail(o.to_string()));
                        let turn = assistant_turn(surface_id, current_turn, turns);
                        let tool_id = item
                            .get("id")
                            .and_then(|i| i.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("exec-{}", turn.events.len()));
                        turn.events.push(AgentEvent::ToolStart {
                            tool_id: tool_id.clone(),
                            name: "command".into(),
                            detail: Some(cap_detail(cmd)),
                        });
                        turn.events.push(AgentEvent::ToolEnd {
                            tool_id,
                            name: Some("command".into()),
                            detail: out,
                            ok: true,
                        });
                    }
                    _ => {}
                }
            }
            "response_item" if !state.paginated => match ptype {
                "message" => {
                    let text = p.get("content").map(payload_text).unwrap_or_default();
                    match p.get("role").and_then(|r| r.as_str()) {
                        Some("user") => start_user_turn(text, surface_id, current_turn, turns),
                        Some("assistant") if !text.trim().is_empty() => {
                            assistant_turn(surface_id, current_turn, turns)
                                .events
                                .push(AgentEvent::Assistant { text });
                        }
                        _ => {}
                    }
                }
                "function_call" | "custom_tool_call" => {
                    let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    let id = p
                        .get("call_id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    if CODEX_AGENT_TOOLS.contains(&name.as_str()) {
                        if name == "spawn_agent" {
                            if let Some(role) = p.get("arguments").and_then(|a| a.as_str()).and_then(codex_spawn_role) {
                                state.spawn_roles.insert(id.clone(), role);
                            }
                        }
                        state.hidden_calls.insert(id);
                        return;
                    }
                    let detail = p
                        .get("arguments")
                        .or_else(|| p.get("input"))
                        .map(|a| cap_detail(a.as_str().map(str::to_string).unwrap_or_else(|| a.to_string())));
                    assistant_turn(surface_id, current_turn, turns)
                        .events
                        .push(AgentEvent::ToolStart { tool_id: id, name, detail });
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let id = p
                        .get("call_id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    if state.hidden_calls.contains(&id) {
                        // spawn_agent output: {"agent_id": "...", "nickname": "Plato"}
                        if let Some(out) = p
                            .get("output")
                            .map(payload_text)
                            .and_then(|o| serde_json::from_str::<serde_json::Value>(&o).ok())
                        {
                            if let Some(agent_id) = out.get("agent_id").and_then(|a| a.as_str()) {
                                let nick = out.get("nickname").and_then(|n| n.as_str()).unwrap_or("Subagent");
                                let role = state.spawn_roles.get(&id).cloned();
                                codex_push_subagent(state, surface_id, current_turn, turns, agent_id, nick, role.as_deref());
                            }
                        }
                        return;
                    }
                    let detail = p.get("output").map(|o| cap_detail(payload_text(o)));
                    assistant_turn(surface_id, current_turn, turns).events.push(AgentEvent::ToolEnd {
                        tool_id: id,
                        name: None,
                        detail,
                        ok: true,
                    });
                }
                _ => {}
            },
            _ => {}
        }
    }

    /// Read recent turns from a transcript file (JSONL), returning at most `max_turns`.
    pub fn read_recent_turns(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
    ) -> Result<Vec<AgentTurn>, std::io::Error> {
        Self::read_recent_turns_page(transcript_path, surface_id, max_turns).map(|(turns, _)| turns)
    }

    /// Incrementally parses JSONL transcripts by tracking byte offset per `(path, surface_id)`,
    /// seeking backwards in `64 KiB` chunks on cold opens and `before_offset` pagination.
    pub fn read_recent_turns_page(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
    ) -> Result<(Vec<AgentTurn>, usize), std::io::Error> {
        let page = Self::read_turns_page(transcript_path, surface_id, max_turns, None)?;
        Ok((page.turns, page.total_turns))
    }

    pub fn read_turns_page(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
        before_offset: Option<u64>,
    ) -> Result<TranscriptPage, std::io::Error> {
        if let Some((db, session_id)) = crate::scanner::opencode_store::parse_pseudo_path(transcript_path) {
            let (turns, total_turns) =
                crate::scanner::opencode_store::read_recent_turns_page(&db, &session_id, surface_id, max_turns)
                    .map_err(std::io::Error::other)?;
            let has_more = total_turns > turns.len();
            return Ok(TranscriptPage {
                turns,
                has_more,
                before_offset: None,
                total_turns,
            });
        }
        if !transcript_path.exists() {
            return Ok(TranscriptPage {
                turns: Vec::new(),
                has_more: false,
                before_offset: None,
                total_turns: 0,
            });
        }

        let (mtime_ns, len) = file_mtime_len(transcript_path)?;

        // Cursor-based historical page (`before_offset`): read backwards from `cursor` without
        // disturbing the live tail cache.
        if let Some(cursor) = before_offset {
            let capped_end = cursor.min(len);
            if capped_end == 0 || max_turns == 0 {
                return Ok(TranscriptPage {
                    turns: Vec::new(),
                    has_more: false,
                    before_offset: None,
                    total_turns: 0,
                });
            }
            let mut file = File::open(transcript_path)?;
            let mut win = read_tail_window(
                &mut file,
                surface_id,
                capped_end,
                max_turns,
                false,
            )?;
            if let Some(ct) = win.current_turn.take() {
                let off = win.current_turn_offset.unwrap_or(win.window_start_offset);
                win.turns.push(ct);
                win.turn_offsets.push(off);
            }
            let avail = win.turns.len();
            let start_idx = avail.saturating_sub(max_turns);
            let first_offset = win.turn_offsets.get(start_idx).copied().unwrap_or(0);
            let mut slice = win.turns[start_idx..].to_vec();
            refresh_working_codex_subagents(transcript_path, &mut slice);
            let has_more = (start_idx > 0 || win.window_start_offset > 0) && first_offset > 0;
            return Ok(TranscriptPage {
                total_turns: slice.len() + usize::from(has_more),
                turns: slice,
                has_more,
                before_offset: has_more.then_some(first_offset),
            });
        }

        // Live tail read: per-(path, surface_id) singleflight mutex inside a bounded LRU map.
        let cache_key = (transcript_path.to_path_buf(), surface_id.to_string());
        let slot = get_transcript_cache_slot(cache_key);
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());

        let needs_rebuild = match guard.as_ref() {
            None => true,
            Some(hit) => {
                let reusable = len > hit.byte_offset || (len == hit.byte_offset && mtime_ns == hit.mtime_ns);
                let have_turns = hit.turns.len() + usize::from(hit.current_turn.is_some());
                !reusable || (hit.window_start_offset > 0 && have_turns < max_turns)
            }
        };

        if needs_rebuild {
            let mut file = File::open(transcript_path)?;
            let mut fresh = read_tail_window(
                &mut file,
                surface_id,
                len,
                max_turns,
                true,
            )?;
            fresh.mtime_ns = mtime_ns;
            *guard = Some(fresh);
        } else if let Some(cached) = guard.as_mut() {
            if len > cached.byte_offset {
                let mut file = File::open(transcript_path)?;
                file.seek(SeekFrom::Start(cached.byte_offset))?;
                let mut reader = BufReader::new(file);
                let mut offset = cached.byte_offset;
                let mut line_buf = Vec::new();
                let offset_anchored = cached.window_start_offset > 0;
                loop {
                    line_buf.clear();
                    let n = reader.read_until(b'\n', &mut line_buf)?;
                    if n == 0 {
                        break;
                    }
                    let ends_nl = line_buf.ends_with(b"\n");
                    if line_buf.len() > MAX_RECORD_BYTES {
                        if !ends_nl {
                            break;
                        }
                        offset += n as u64;
                        continue;
                    }
                    let text = String::from_utf8_lossy(&line_buf);
                    let trimmed = text.trim();
                    if !ends_nl && !trimmed.is_empty() && serde_json::from_str::<serde_json::Value>(trimmed).is_err() {
                        // Partial line still being written; stop advancing offset here so next tick finishes it.
                        break;
                    }
                    let line_start = offset;
                    offset += n as u64;
                    if !trimmed.is_empty() {
                        parse_line_with_offsets(
                            trimmed,
                            line_start,
                            offset_anchored,
                            surface_id,
                            &mut cached.codex,
                            &mut cached.current_turn,
                            &mut cached.current_turn_offset,
                            &mut cached.turns,
                            &mut cached.turn_offsets,
                        );
                    }
                }
                cached.byte_offset = offset;
                cached.mtime_ns = mtime_ns;
            }
        }

        let cached = guard.as_mut().expect("cached transcript populated");
        let total_in_window = cached.turns.len() + usize::from(cached.current_turn.is_some());
        let tail_start = total_in_window.saturating_sub(max_turns);

        let first_offset = if tail_start < cached.turn_offsets.len() {
            cached.turn_offsets[tail_start]
        } else {
            cached.current_turn_offset.unwrap_or(cached.window_start_offset)
        };

        // Refresh working Codex subagents directly on the cached tail turns so completed children
        // stay cached as Completed on subsequent ticks.
        if tail_start < cached.turns.len() {
            refresh_working_codex_subagents(transcript_path, &mut cached.turns[tail_start..]);
        }
        if let Some(ct) = cached.current_turn.as_mut() {
            refresh_working_codex_subagents(transcript_path, std::slice::from_mut(ct));
        }

        let slice: Vec<AgentTurn> = if max_turns == 0 {
            Vec::new()
        } else if tail_start < cached.turns.len() {
            let mut out = cached.turns[tail_start..].to_vec();
            if let Some(t) = &cached.current_turn {
                out.push(t.clone());
            }
            out
        } else if let Some(t) = &cached.current_turn {
            vec![t.clone()]
        } else {
            Vec::new()
        };

        let has_more = (tail_start > 0 || cached.window_start_offset > 0) && first_offset > 0;
        let total_turns = if cached.window_start_offset == 0 {
            total_in_window
        } else {
            total_in_window.max(slice.len() + usize::from(has_more))
        };

        Ok(TranscriptPage {
            turns: slice,
            has_more,
            before_offset: has_more.then_some(first_offset),
            total_turns,
        })
    }

    fn parse_ask_event(name: &str, args: Option<&serde_json::Value>) -> Option<AgentEvent> {
        if matches!(
            name,
            "ask_question" | "ask_permission" | "AskUserQuestion" | "ask_user_question"
        ) {
            let args = args?;
            let owned_questions: Option<Vec<serde_json::Value>> =
                match args.get("questions") {
                    Some(serde_json::Value::Array(arr)) => Some(arr.clone()),
                    Some(serde_json::Value::String(raw)) => {
                        serde_json::from_str::<Vec<serde_json::Value>>(raw).ok()
                    }
                    _ => None,
                };
            if let Some(questions) = owned_questions
                && let Some(first) = questions.first()
            {
                let extract_opts = |q: &serde_json::Value| -> Vec<String> {
                    q.get("options")
                        .and_then(|opts| opts.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|o| {
                                    if let Some(s) = o.as_str() {
                                        Some(Self::clean_agy_arg_str(s))
                                    } else {
                                        o.get("label")
                                            .and_then(|l| l.as_str())
                                            .map(Self::clean_agy_arg_str)
                                    }
                                })
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let parsed_items: Vec<AskQuestionItem> = questions
                    .iter()
                    .filter_map(|q| {
                        let q_text = q
                            .get("question")
                            .and_then(|v| v.as_str())
                            .map(Self::clean_agy_arg_str)
                            .unwrap_or_default();
                        if q_text.is_empty() {
                            return None;
                        }
                        let multi = q
                            .get("is_multi_select")
                            .and_then(|m| m.as_bool())
                            .or_else(|| q.get("multiSelect").and_then(|m| m.as_bool()));
                        Some(AskQuestionItem {
                            question: q_text,
                            options: extract_opts(q),
                            multi_select: multi,
                        })
                    })
                    .collect();

                if let Some(first_item) = parsed_items.first().cloned() {
                    let _ = first;
                    return Some(AgentEvent::AwaitingInput(AwaitingInput {
                        input_kind: "question".into(),
                        prompt: first_item.question.clone(),
                        options: (!first_item.options.is_empty()).then_some(first_item.options.clone()),
                        default_choice: None,
                        multi_select: first_item.multi_select,
                        questions: (parsed_items.len() > 1).then_some(parsed_items),
                        answered: None,
                    }));
                }
            } else if let Some(question) = args
                .get("question")
                .and_then(|q| q.as_str())
                .map(Self::clean_agy_arg_str)
                .filter(|s| !s.is_empty())
            {
                let options = args
                    .get("options")
                    .and_then(|opts| opts.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|o| {
                                if let Some(s) = o.as_str() {
                                    Some(Self::clean_agy_arg_str(s))
                                } else {
                                    o.get("label")
                                        .and_then(|l| l.as_str())
                                        .map(Self::clean_agy_arg_str)
                                }
                            })
                            .collect()
                    });
                return Some(AgentEvent::AwaitingInput(AwaitingInput {
                    input_kind: "question".into(),
                    prompt: question,
                    options,
                    default_choice: None,
                    multi_select: None,
                    questions: None,
                    answered: None,
                }));
            }
        }
        None
    }

    fn push_system_divider(
        label: &str,
        surface_id: &str,
        current_turn: &mut Option<AgentTurn>,
        turns: &mut Vec<AgentTurn>,
    ) {
        if let Some(t) = current_turn.take() {
            turns.push(t);
        }
        let already_last = turns.last().is_some_and(|t| {
            t.role == AgentRole::System
                && matches!(t.events.first(), Some(AgentEvent::Status { text }) if text == label)
        });
        if already_last {
            return;
        }
        let mut turn = AgentTurn::new(
            format!("turn-{}", turns.len() + 1),
            surface_id,
            AgentRole::System,
        );
        turn.events.push(AgentEvent::Status {
            text: label.to_string(),
        });
        turns.push(turn);
    }

    fn record_timestamp_ms(val: &serde_json::Value) -> Option<u64> {
        for key in ["timestamp", "created_at"] {
            let Some(v) = val.get(key) else { continue };
            if let Some(s) = v.as_str() {
                if let Some(secs) = crate::scanner::turn_marks::parse_rfc3339_secs(s) {
                    return Some((secs * 1000.0) as u64);
                }
            } else if let Some(n) = v.as_u64() {
                return Some(if n > 10_000_000_000 { n } else { n * 1000 });
            } else if let Some(f) = v.as_f64()
                && f.is_finite()
                && f >= 0.0
            {
                return Some(if f > 10_000_000_000.0 {
                    f as u64
                } else {
                    (f * 1000.0) as u64
                });
            }
        }
        None
    }

    fn push_subagent_to_turn(turn: &mut AgentTurn, group_id: &str, entry: SubagentEntry) {
        for ev in turn.events.iter_mut() {
            if let AgentEvent::Subagents {
                group_id: gid,
                agents,
            } = ev
                && gid == group_id
            {
                if let Some(existing) = agents.iter_mut().find(|a| a.id == entry.id) {
                    if !entry.label.is_empty() && entry.label != "Subagent" {
                        existing.label = entry.label;
                    }
                    existing.state = entry.state;
                    existing.tokens = entry.tokens.or(existing.tokens);
                    existing.started_at = existing.started_at.or(entry.started_at);
                    existing.settled_at = entry.settled_at.or(existing.settled_at);
                } else {
                    agents.push(entry);
                }
                return;
            }
        }
        turn.events.push(AgentEvent::Subagents {
            group_id: group_id.to_string(),
            agents: vec![entry],
        });
    }

    fn mutate_subagent_by_ids(
        turns: &mut [AgentTurn],
        current_turn: &mut Option<AgentTurn>,
        ids: &[&str],
        mut f: impl FnMut(&mut SubagentEntry),
    ) -> bool {
        let matches_id = |candidate: &str| ids.iter().any(|k| !k.is_empty() && *k == candidate);
        if let Some(t) = current_turn.as_mut() {
            for ev in t.events.iter_mut().rev() {
                if let AgentEvent::Subagents { agents, .. } = ev {
                    for a in agents.iter_mut() {
                        if matches_id(&a.id) {
                            f(a);
                            return true;
                        }
                    }
                }
            }
        }
        for t in turns.iter_mut().rev() {
            for ev in t.events.iter_mut().rev() {
                if let AgentEvent::Subagents { agents, .. } = ev {
                    for a in agents.iter_mut() {
                        if matches_id(&a.id) {
                            f(a);
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    fn push_bg_task_to_turn(turn: &mut AgentTurn, entry: BackgroundTaskEntry) {
        for ev in turn.events.iter_mut() {
            if let AgentEvent::BackgroundTasks { tasks } = ev {
                if let Some(existing) = tasks.iter_mut().find(|t| t.id == entry.id) {
                    if !entry.label.is_empty() {
                        existing.label = entry.label;
                    }
                    existing.state = entry.state;
                    existing.summary = entry.summary.or_else(|| existing.summary.take());
                    existing.tokens = entry.tokens.or(existing.tokens);
                    existing.started_at = existing.started_at.or(entry.started_at);
                    existing.settled_at = entry.settled_at.or(existing.settled_at);
                } else {
                    tasks.push(entry);
                }
                return;
            }
        }
        turn.events.push(AgentEvent::BackgroundTasks { tasks: vec![entry] });
    }

    fn mutate_bg_task_by_ids(
        turns: &mut [AgentTurn],
        current_turn: &mut Option<AgentTurn>,
        ids: &[&str],
        mut f: impl FnMut(&mut BackgroundTaskEntry),
    ) -> bool {
        let matches_id = |candidate: &str| {
            ids.iter().any(|k| {
                !k.is_empty()
                    && (*k == candidate
                        || k.ends_with(&format!("/{candidate}"))
                        || candidate.ends_with(&format!("/{k}")))
            })
        };
        if let Some(t) = current_turn.as_mut() {
            for ev in t.events.iter_mut().rev() {
                if let AgentEvent::BackgroundTasks { tasks } = ev {
                    for item in tasks.iter_mut() {
                        if matches_id(&item.id) {
                            f(item);
                            return true;
                        }
                    }
                }
            }
        }
        for t in turns.iter_mut().rev() {
            for ev in t.events.iter_mut().rev() {
                if let AgentEvent::BackgroundTasks { tasks } = ev {
                    for item in tasks.iter_mut() {
                        if matches_id(&item.id) {
                            f(item);
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Classify Claude's `task_type` / `subagent_type` matching Orca
    /// (`ref/orca/src/shared/claude-background-task-kind.ts` & `claude-subagent-task-frames.ts`).
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
    fn parse_claude_task_notification_xml(text: &str) -> Option<(String, Option<String>, Option<String>)> {
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

    fn parse_claude_line(
        val: serde_json::Value,
        surface_id: &str,
        current_turn: &mut Option<AgentTurn>,
        turns: &mut Vec<AgentTurn>,
    ) {
        // Skip sidechain child frames (`isSidechain: true` or non-empty `parent_tool_use_id`),
        // which belong to a subagent's internal execution rather than the parent conversation.
        if val.get("isSidechain").and_then(|b| b.as_bool()) == Some(true)
            || val
                .get("parent_tool_use_id")
                .or_else(|| val.get("parentToolUseID"))
                .and_then(|s| s.as_str())
                .is_some_and(|s| !s.trim().is_empty())
        {
            return;
        }

        let ts_ms = Self::record_timestamp_ms(&val);
        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match msg_type {
            "user" => {
                // Structured metadata attached by Claude on tool_result rows (`toolUseResult` / `tool_use_result`).
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

                // Claude records tool results as `user` lines whose content blocks are
                // `{"type":"tool_result","tool_use_id":..,"content":<string|[{type:text,text}]>,"is_error":bool}`
                // (tests/fixtures/claude_transcript.jsonl). They belong to the assistant turn that issued the
                // call, so attach a ToolEnd to it instead of closing the turn.
                let blocks = val
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                let mut had_tool_result = false;
                let mut has_text = false;
                for block in blocks.into_iter().flatten() {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("tool_result") => {
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
                            let ok = !block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);

                            // Rebind background Bash `tool_use_id` -> `backgroundTaskId` when launched asynchronously.
                            if let Some(bg_id) = meta_bg_id {
                                Self::mutate_bg_task_by_ids(
                                    turns,
                                    current_turn,
                                    &[tool_id.as_str(), bg_id],
                                    |item| {
                                        item.id = bg_id.to_string();
                                    },
                                );
                            }

                            // Update Claude `Agent` / `Task` subagent entry if this result answers one.
                            let lookup_ids: Vec<&str> = match meta_agent_id {
                                Some(aid) => vec![tool_id.as_str(), aid],
                                None => vec![tool_id.as_str()],
                            };
                            let matched_subagent = Self::mutate_subagent_by_ids(
                                turns,
                                current_turn,
                                &lookup_ids,
                                |agent| {
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
                                            Self::claude_status_to_state(meta_status)
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
                                },
                            );
                            if matched_subagent {
                                continue;
                            }

                            // Normally the result belongs to the open assistant turn. If a user text line
                            // already closed that turn, find the finished turn that issued the call.
                            let issued_here = |t: &AgentTurn| {
                                t.events
                                    .iter()
                                    .any(|e| matches!(e, AgentEvent::ToolStart { tool_id: id, .. } if *id == tool_id))
                            };
                            let target = match current_turn.as_mut() {
                                Some(t) => Some(t),
                                None => turns.iter_mut().rev().find(|t| issued_here(t)),
                            };
                            if let Some(turn) = target {
                                let has_matching_tool = turn.events.iter().any(|e| {
                                    matches!(e, AgentEvent::ToolStart { tool_id: id, .. } if *id == tool_id)
                                });
                                if has_matching_tool {
                                    turn.events.push(AgentEvent::ToolEnd { tool_id, name: None, detail, ok });
                                } else if let Some(AgentEvent::AwaitingInput(ai)) = turn
                                    .events
                                    .iter_mut()
                                    .rev()
                                    .find(|e| matches!(e, AgentEvent::AwaitingInput(a) if a.answered.is_none()))
                                {
                                    // `AskUserQuestion` tool_result settles the open AwaitingInput receipt.
                                    ai.answered = detail
                                        .as_deref()
                                        .map(Self::clean_question_answer_text)
                                        .filter(|s| !s.is_empty())
                                        .or_else(|| Some("Answered".to_string()));
                                }
                            }
                        }
                        Some("text") => has_text = true,
                        _ => {}
                    }
                }
                if had_tool_result && !has_text {
                    return;
                }

                let mut text = String::new();
                if let Some(msg) = val.get("message") {
                    if let Some(c) = msg.get("content").and_then(|c| c.as_str()) {
                        text = c.to_string();
                    } else if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
                        for item in arr {
                            if let (Some("text"), Some(t)) = (
                                item.get("type").and_then(|t| t.as_str()),
                                item.get("text").and_then(|t| t.as_str()),
                            ) {
                                text.push_str(t);
                            }
                        }
                    }
                }

                // Settle background subagents/commands from `<task-notification>` XML user turns.
                if let Some((task_id, status, summary)) = Self::parse_claude_task_notification_xml(&text) {
                    let next_state = Self::claude_status_to_state(status.as_deref())
                        .unwrap_or(SubagentState::Completed);
                    if !Self::mutate_subagent_by_ids(turns, current_turn, &[task_id.as_str()], |a| {
                        a.state = next_state;
                        a.settled_at = ts_ms.or(a.settled_at);
                    }) {
                        Self::mutate_bg_task_by_ids(turns, current_turn, &[task_id.as_str()], |t| {
                            t.state = next_state;
                            if summary.is_some() {
                                t.summary = summary.clone();
                            }
                            t.settled_at = ts_ms.or(t.settled_at);
                        });
                    }
                    return;
                }

                let is_compact_summary = val
                    .get("isCompactSummary")
                    .and_then(|b| b.as_bool())
                    == Some(true)
                    || text
                        .trim_start()
                        .starts_with("This session is being continued from a previous conversation");
                if is_compact_summary {
                    Self::push_system_divider("Context compacted", surface_id, current_turn, turns);
                    return;
                }

                // Skip Claude harness-injected meta/synthetic rows (Orca `isClaudeInjectedUserMessage`).
                let is_injected_meta = val.get("isMeta").and_then(|b| b.as_bool()) == Some(true)
                    || val.get("isSynthetic").and_then(|b| b.as_bool()) == Some(true)
                    || val.pointer("/origin/kind").and_then(|k| k.as_str()) == Some("task-notification");
                if is_injected_meta {
                    return;
                }

                if let Some(t) = current_turn.take() {
                    turns.push(t);
                }

                if !text.is_empty() {
                    let mut turn = AgentTurn::new(
                        format!("turn-{}", turns.len() + 1),
                        surface_id,
                        AgentRole::User,
                    );
                    turn.timestamp = ts_ms;
                    turn.events.push(AgentEvent::User { text });
                    turns.push(turn);
                }
            }
            "system" => {
                let subtype = val.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
                if subtype == "compact_boundary" {
                    Self::push_system_divider("Context compacted", surface_id, current_turn, turns);
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
                    let kind = Self::classify_claude_task_kind(&val);
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
                        Some(
                            Self::claude_status_to_state(status_str)
                                .unwrap_or(SubagentState::Completed),
                        )
                    } else {
                        Self::claude_status_to_state(status_str)
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

                    // Revise existing subagent or background task in place first.
                    if Self::mutate_subagent_by_ids(turns, current_turn, &lookup_ids, |a| {
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

                    if Self::mutate_bg_task_by_ids(turns, current_turn, &lookup_ids, |t| {
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

                    // Otherwise open a new entry when `task_started` announces an agent or background job.
                    if subtype == "task_started" {
                        let turn = assistant_turn(surface_id, current_turn, turns);
                        if kind == BackgroundTaskKind::Agent {
                            Self::push_subagent_to_turn(
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
                            Self::push_bg_task_to_turn(
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

                if let Some(msg) = val.get("message") {
                    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                        for block in content {
                            let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            match block_type {
                                "thinking" => {
                                    if let Some(think) = block.get("thinking").and_then(|t| t.as_str()) {
                                        turn.events.push(AgentEvent::Thinking {
                                            text: think.to_string(),
                                            duration_secs: None,
                                        });
                                    }
                                }
                                "text" => {
                                    if let Some(txt) = block.get("text").and_then(|t| t.as_str()) {
                                        turn.events.push(AgentEvent::Assistant {
                                            text: txt.to_string(),
                                        });
                                    }
                                }
                                "tool_use" => {
                                    let tool_id = block.get("id").and_then(|i| i.as_str()).unwrap_or("tool").to_string();
                                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                                    let inp = block.get("input");
                                    let detail = inp.map(|i| cap_detail(i.to_string()));

                                    if let Some(ask_ev) = Self::parse_ask_event(&name, inp) {
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
                                        Self::push_subagent_to_turn(
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
                                    } else {
                                        if name == "Bash"
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
                                            Self::push_bg_task_to_turn(
                                                &mut turn,
                                                BackgroundTaskEntry {
                                                    id: tool_id.clone(),
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
                    } else if let Some(txt) = msg.get("content").and_then(|c| c.as_str()) {
                        turn.events.push(AgentEvent::Assistant {
                            text: txt.to_string(),
                        });
                    }

                    // Claude repeats the same `usage` on every line of one message; keep one event per change.
                    if let Some(u) = msg.get("usage") {
                        let n = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                        let usage = AgentEvent::Usage {
                            model: msg.get("model").and_then(|m| m.as_str()).map(str::to_string),
                            input_tokens: n("input_tokens"),
                            output_tokens: n("output_tokens"),
                            cache_read_tokens: n("cache_read_input_tokens"),
                            cache_creation_tokens: n("cache_creation_input_tokens"),
                        };
                        let last = turn.events.iter().rev().find(|e| matches!(e, AgentEvent::Usage { .. }));
                        if last != Some(&usage) {
                            turn.events.push(usage);
                        }
                    }
                }

                *current_turn = Some(turn);
            }
            _ => {}
        }
    }

    /// Extracts user prompt text, stripping internal Antigravity & Claude XML envelopes.
    /// Source: ref/orca/out/shared/agent-hook-listener/transcript-lines.js:9-17 (`extractAntigravityUserRequest`)
    pub fn clean_user_prompt(text: &str) -> String {
        let s = text.trim();
        if let Some(start) = s.find("<USER_REQUEST>") {
            let after_start = &s[start + "<USER_REQUEST>".len()..];
            if let Some(end) = after_start.find("</USER_REQUEST>") {
                return after_start[..end].trim().to_string();
            }
        }
        if let Some(start) = s.find("<user_prompt>") {
            let after_start = &s[start + "<user_prompt>".len()..];
            if let Some(end) = after_start.find("</user_prompt>") {
                return after_start[..end].trim().to_string();
            }
        }
        if let Some(meta_start) = s.find("<ADDITIONAL_METADATA>") {
            if let Some(meta_end) = s.find("</ADDITIONAL_METADATA>") {
                let prefix = &s[..meta_start];
                let suffix = &s[meta_end + "</ADDITIONAL_METADATA>".len()..];
                return format!("{}{}", prefix.trim(), suffix.trim()).trim().to_string();
            }
        }
        s.to_string()
    }

    /// Alias matching Orca's exact function name: `extractAntigravityUserRequest`
    pub fn extract_antigravity_user_request(text: &str) -> String {
        Self::clean_user_prompt(text)
    }

    /// `"conversationId":  "<uuid>"` inside the `Created the following subagent: {...}` result.
    fn subagent_conversation_id(content: &str) -> Option<String> {
        let key = content.find("\"conversationId\"")?;
        let rest = &content[key + "\"conversationId\"".len()..];
        let open = rest.find('"')? + 1;
        let close = rest[open..].find('"')?;
        let id = &rest[open..open + close];
        (id.len() == 36).then(|| id.to_string())
    }

    /// Strip leading `Created At: ...` / `Completed At: ...` lines that Antigravity prefixes onto
    /// every `GENERIC` tool result (often duplicated twice).
    pub fn strip_agy_tool_headers(raw: &str) -> &str {
        let mut rest = raw;
        loop {
            let trimmed = rest.trim_start_matches(['\r', '\n']);
            if let Some(nl) = trimmed.find('\n') {
                let line = trimmed[..nl].trim();
                if line.starts_with("Created At:") || line.starts_with("Completed At:") {
                    rest = &trimmed[nl + 1..];
                    continue;
                }
            } else {
                let line = trimmed.trim();
                if line.starts_with("Created At:") || line.starts_with("Completed At:") {
                    return "";
                }
            }
            return trimmed;
        }
    }

    /// Normalize question tool answers (`A1: ...` from Antigravity or `"User has answered..."` from Claude)
    /// into clean human-readable answer text for the `AwaitingInput.answered` receipt.
    pub fn clean_question_answer_text(raw: &str) -> String {
        let stripped = Self::strip_agy_tool_headers(raw).trim();
        if stripped.is_empty() {
            return String::new();
        }
        // Single-question Antigravity answer: `A1: <selected label>`
        let lines: Vec<&str> = stripped.lines().collect();
        let a_prefixed: Vec<(usize, &str)> = lines
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                let t = l.trim();
                let after_a = t.strip_prefix('A')?;
                let colon = after_a.find(':')?;
                let num = &after_a[..colon];
                (!num.is_empty() && num.chars().all(|c| c.is_ascii_digit()))
                    .then_some((i, after_a[colon + 1..].trim()))
            })
            .collect();
        if a_prefixed.len() == 1 && a_prefixed[0].0 == 0 {
            let first_line = a_prefixed[0].1;
            if lines.len() == 1 {
                return first_line.to_string();
            }
            let mut out = first_line.to_string();
            for extra in &lines[1..] {
                out.push('\n');
                out.push_str(extra);
            }
            return out.trim().to_string();
        }
        stripped.to_string()
    }

    /// Unquote JSON-stringified argument strings that Antigravity writes in `tool_calls[].args`
    /// (e.g. `"\"Client lint, test, and build\""` -> `"Client lint, test, and build"`).
    fn clean_agy_arg_str(raw: &str) -> String {
        let trimmed = raw.trim();
        if trimmed.starts_with('"')
            && trimmed.ends_with('"')
            && let Ok(unquoted) = serde_json::from_str::<String>(trimmed)
        {
            return unquoted;
        }
        trimmed.to_string()
    }

    fn parse_antigravity_line(
        val: serde_json::Value,
        surface_id: &str,
        current_turn: &mut Option<AgentTurn>,
        turns: &mut Vec<AgentTurn>,
    ) {
        let ts_ms = Self::record_timestamp_ms(&val);
        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match msg_type {
            "USER_INPUT" => {
                let agent_replied = current_turn.is_some();
                if let Some(t) = current_turn.take() {
                    turns.push(t);
                }
                if let Some(content) = val.get("content").and_then(|c| c.as_str()) {
                    let cleaned = Self::clean_user_prompt(content);
                    // Antigravity logs the same prompt twice (e.g. one step_index re-written a minute
                    // later); the same text again with no agent reply in between is that echo.
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
                    turn.events.push(AgentEvent::User {
                        text: cleaned,
                    });
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

                if let Some(thinking) = val.get("thinking").and_then(|t| t.as_str()) {
                    if !thinking.trim().is_empty() {
                        turn.events.push(AgentEvent::Thinking {
                            text: thinking.to_string(),
                            duration_secs: None,
                        });
                    }
                }

                // If PLANNER_RESPONSE contains assistant text content, add as Assistant event
                if let Some(content) = val.get("content").and_then(|c| c.as_str()) {
                    if !content.trim().is_empty() {
                        turn.events.push(AgentEvent::Assistant {
                            text: content.to_string(),
                        });
                    }
                }

                if let Some(tool_calls) = val.get("tool_calls").and_then(|tc| tc.as_array()) {
                    for tc in tool_calls {
                        let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                        let args = tc.get("args");
                        let detail = args.map(|a| cap_detail(a.to_string()));

                        if let Some(ask_ev) = Self::parse_ask_event(&name, args) {
                            turn.events.push(ask_ev);
                        } else if name == "invoke_subagent" {
                            let role = args
                                .and_then(|a| a.get("Role"))
                                .and_then(|r| r.as_str())
                                .map(Self::clean_agy_arg_str)
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "Subagent".to_string());
                            let type_name = args
                                .and_then(|a| a.get("TypeName"))
                                .and_then(|t| t.as_str())
                                .map(Self::clean_agy_arg_str)
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| "subagent".to_string());
                            let group_id = format!("agy-subagents-{}", turn.id);
                            let entry_id = format!("{}-{}", type_name, turn.events.len());
                            Self::push_subagent_to_turn(
                                &mut turn,
                                &group_id,
                                SubagentEntry {
                                    id: entry_id,
                                    label: role,
                                    state: SubagentState::Working,
                                    tokens: None,
                                    started_at: ts_ms,
                                    settled_at: None,
                                },
                            );
                        } else if name == "manage_subagents" {
                            let action = args
                                .and_then(|a| a.get("Action"))
                                .and_then(|s| s.as_str())
                                .map(Self::clean_agy_arg_str)
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
                                && let Some(raw_ids) = args.and_then(|a| a.get("ConversationIds"))
                            {
                                let parsed_ids: Vec<String> = if let Some(arr) = raw_ids.as_array() {
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(Self::clean_agy_arg_str))
                                        .collect()
                                } else if let Some(s) = raw_ids.as_str() {
                                    serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
                                } else {
                                    Vec::new()
                                };
                                for cid in &parsed_ids {
                                    let mut cur = Some(turn);
                                    Self::mutate_subagent_by_ids(
                                        turns,
                                        &mut cur,
                                        &[cid.as_str()],
                                        |a| {
                                            a.state = SubagentState::Stopped;
                                            a.settled_at = ts_ms.or(a.settled_at);
                                        },
                                    );
                                    turn = cur.unwrap();
                                }
                            }
                            turn.events.push(AgentEvent::ToolStart {
                                tool_id: format!("{}-call-{}", name, turn.events.len()),
                                name,
                                detail,
                            });
                        } else if name == "manage_task" {
                            let action = args
                                .and_then(|a| a.get("Action"))
                                .and_then(|s| s.as_str())
                                .map(Self::clean_agy_arg_str)
                                .unwrap_or_default();
                            if action == "kill"
                                && let Some(tid) = args
                                    .and_then(|a| a.get("TaskId"))
                                    .and_then(|s| s.as_str())
                                    .map(Self::clean_agy_arg_str)
                            {
                                let mut cur = Some(turn);
                                Self::mutate_bg_task_by_ids(turns, &mut cur, &[tid.as_str()], |t| {
                                    t.state = SubagentState::Stopped;
                                    t.settled_at = ts_ms.or(t.settled_at);
                                });
                                turn = cur.unwrap();
                            }
                            turn.events.push(AgentEvent::ToolStart {
                                tool_id: format!("{}-call-{}", name, turn.events.len()),
                                name,
                                detail,
                            });
                        } else {
                            turn.events.push(AgentEvent::ToolStart {
                                tool_id: format!("{}-call-{}", name, turn.events.len()),
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
                // A subagent (`sender=<uuid>`) or background task (`sender=<conv>/task-XXXX`) reports back.
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
                            let code: String =
                                after.chars().take_while(|c| c.is_ascii_digit()).collect();
                            !code.is_empty() && code != "0"
                        })
                        .unwrap_or(false);
                    if !Self::mutate_subagent_by_ids(turns, current_turn, &[sender.as_str()], |a| {
                        a.state = SubagentState::Completed;
                        a.settled_at = ts_ms.or(a.settled_at);
                    }) {
                        Self::mutate_bg_task_by_ids(turns, current_turn, &[sender.as_str()], |t| {
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
                if let Some(content) = val.get("content").and_then(|c| c.as_str()) {
                    // Result of `invoke_subagent`: bind the child's conversation id to the card, and do
                    // not render the raw "Created the following subagent: {...}" text as chat.
                    if content.contains("Created the following subagent") {
                        if let Some(child_id) = Self::subagent_conversation_id(content) {
                            if let Some(t) = current_turn.as_mut() {
                                for ev in t.events.iter_mut().rev() {
                                    if let AgentEvent::Subagents { agents, .. } = ev {
                                        if let Some(a) = agents
                                            .iter_mut()
                                            .find(|a| !a.id.contains('-') || a.id.len() != 36)
                                        {
                                            a.id = child_id.clone();
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        return;
                    }

                    let mut turn = current_turn.take().unwrap_or_else(|| {
                        AgentTurn::new(
                            format!("turn-{}", turns.len() + 1),
                            surface_id,
                            AgentRole::Assistant,
                        )
                    });

                    // Check if there is an unclosed ToolStart in this turn
                    let open_tool = turn.events.iter().rev().find_map(|ev| {
                        if let AgentEvent::ToolStart { tool_id, name, detail } = ev {
                            let is_closed = turn.events.iter().any(|other| {
                                if let AgentEvent::ToolEnd { tool_id: end_id, .. } = other {
                                    end_id == tool_id
                                } else {
                                    false
                                }
                            });
                            if !is_closed {
                                return Some((tool_id.clone(), name.clone(), detail.clone()));
                            }
                        }
                        None
                    });

                    // Antigravity background command launch:
                    // `"Tool is running as a background task with task id: <conv>/task-XXXX"`
                    if let Some(marker_idx) =
                        content.find("Tool is running as a background task with task id:")
                    {
                        let after =
                            &content[marker_idx + "Tool is running as a background task with task id:".len()..];
                        let task_id = after
                            .lines()
                            .next()
                            .map(str::trim)
                            .unwrap_or("")
                            .to_string();
                        if !task_id.is_empty() {
                            let desc_from_output = content
                                .lines()
                                .find_map(|l| l.strip_prefix("Task Description:").map(str::trim))
                                .filter(|s| !s.is_empty())
                                .map(str::to_string);
                            let desc_from_tool = open_tool
                                .as_ref()
                                .and_then(|(_, _, d)| d.as_deref())
                                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                                .and_then(|v| {
                                    v.get("toolSummary")
                                        .or_else(|| v.get("CommandLine"))
                                        .and_then(|s| s.as_str())
                                        .map(Self::clean_agy_arg_str)
                                });
                            let bg_label = desc_from_tool
                                .or(desc_from_output)
                                .unwrap_or_else(|| "Background command".to_string())
                                .chars()
                                .take(120)
                                .collect::<String>();
                            Self::push_bg_task_to_turn(
                                &mut turn,
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
                    }

                    let cleaned_body = Self::strip_agy_tool_headers(content);
                    if let Some((tool_id, name, _)) = open_tool {
                        let is_err = val.get("status").and_then(|s| s.as_str()).is_some_and(|s| s == "ERROR");
                        turn.events.push(AgentEvent::ToolEnd {
                            tool_id,
                            name: Some(name),
                            detail: Some(cap_detail(cleaned_body.to_string())),
                            ok: !is_err,
                        });
                    } else if let Some(AgentEvent::AwaitingInput(ai)) = turn
                        .events
                        .iter_mut()
                        .rev()
                        .find(|ev| matches!(ev, AgentEvent::AwaitingInput(a) if a.answered.is_none()))
                    {
                        // Result of `ask_question` / `ask_permission`: record as the resolved answer
                        // receipt on `AwaitingInput` instead of dumping `Created At: ... A1: ...` as prose!
                        let answer = Self::clean_question_answer_text(content);
                        ai.answered = Some(if answer.is_empty() {
                            "Answered".to_string()
                        } else {
                            answer
                        });
                    } else if !cleaned_body.trim().is_empty() {
                        turn.events.push(AgentEvent::Assistant {
                            text: cleaned_body.to_string(),
                        });
                    }
                    *current_turn = Some(turn);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_parse_claude_jsonl() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("test_claude_transcript.jsonl");
        {
            let mut file = File::create(&file_path).expect("create temp file");
            writeln!(file, r#"{{"type":"user","message":{{"content":"npm run build"}}}}"#).unwrap();
            writeln!(
                file,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":"Checking bundle"}},{{"type":"text","text":"Build completed successfully."}}]}}}}"#
            ).unwrap();
        }

        let turns = TranscriptReader::read_recent_turns(&file_path, "surf-1", 10).expect("read turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, AgentRole::User);
        assert_eq!(turns[0].events.len(), 1);
        assert_eq!(turns[1].role, AgentRole::Assistant);
        assert_eq!(turns[1].events.len(), 2);
    }

    fn write_jsonl(name: &str, lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("{}-{}.jsonl", name, uuid::Uuid::new_v4()));
        let mut f = File::create(&p).expect("create");
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    #[test]
    fn test_parse_kiro_messages_jsonl() {
        let p = write_jsonl(
            "kiro",
            &[
                r#"{"id":"1","timestamp":"t","payload":{"type":"session_start","agentType":"x"}}"#,
                r#"{"id":"2","timestamp":"t","payload":{"type":"user","content":"run ls"}}"#,
                r#"{"id":"3","timestamp":"t","payload":{"type":"turn_start","turnId":"a"}}"#,
                r#"{"id":"4","timestamp":"t","payload":{"type":"assistant","operationType":"Reasoning","content":"plan"}}"#,
                r#"{"id":"4b","timestamp":"t","payload":{"type":"assistant","operationType":"Reasoning","content":"...","reasoningSignature":".KTR~~x"}}"#,
                r#"{"id":"5","timestamp":"t","payload":{"type":"assistant","operationType":"Say","content":"Running"}}"#,
                r#"{"id":"6","timestamp":"t","payload":{"type":"tool_call","toolCallId":"c1","toolName":"shell","args":{"command":"ls"}}}"#,
                r#"{"id":"7","timestamp":"t","payload":{"type":"pending_interaction","toolCallId":"c1","question":"Allow ls?","options":[{"optionId":"o","name":"Allow once","kind":"allow_once"}]}}"#,
                r#"{"id":"8","timestamp":"t","payload":{"type":"interaction_resolved","toolCallId":"c1","outcome":"selected"}}"#,
                r#"{"id":"9","timestamp":"t","payload":{"type":"tool_result","toolCallId":"c1","content":"a.txt","success":true}}"#,
                r#"{"id":"10","timestamp":"t","payload":{"type":"assistant","operationType":"Summary","content":"skip me"}}"#,
                r#"{"id":"11","timestamp":"t","payload":{"type":"turn_end","stopReason":"end_turn"}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, AgentRole::User);
        let ev = &turns[1].events;
        assert!(matches!(ev[0], AgentEvent::Thinking { .. }));
        assert!(matches!(ev[1], AgentEvent::Assistant { .. }));
        assert!(matches!(ev[2], AgentEvent::ToolStart { .. }));
        assert!(matches!(ev[3], AgentEvent::ToolEnd { ok: true, .. }));
        // resolved approval is removed; Summary is dropped
        assert_eq!(ev.len(), 4);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_kiro_unresolved_approval_stays_awaiting() {
        let p = write_jsonl(
            "kiro-wait",
            &[
                r#"{"id":"1","timestamp":"t","payload":{"type":"user","content":"go"}}"#,
                r#"{"id":"2","timestamp":"t","payload":{"type":"pending_interaction","toolCallId":"c1","question":"Allow?","options":[]}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        assert!(matches!(turns[1].events[0], AgentEvent::AwaitingInput(_)));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_parse_codex_paginated_rollout() {
        let p = write_jsonl(
            "codex-pg",
            &[
                r#"{"type":"session_meta","payload":{"id":"s","history_mode":"paginated"}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"hello"}]}}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"hi there"}]}}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["ls","-la"],"aggregated_output":"out"}}}"#,
                // response_item must be ignored in paginated mode (would duplicate)
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":"hello"}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        assert_eq!(turns.len(), 2);
        assert!(matches!(&turns[0].events[0], AgentEvent::User { text } if text == "hello"));
        assert!(matches!(&turns[1].events[0], AgentEvent::Assistant { text } if text == "hi there"));
        assert!(matches!(&turns[1].events[1], AgentEvent::ToolStart { detail: Some(d), .. } if d == "ls -la"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_parse_codex_legacy_rollout() {
        let p = write_jsonl(
            "codex-legacy",
            &[
                r#"{"type":"session_meta","payload":{"id":"s"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":"do it"}}"#,
                r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":\"ls\"}","call_id":"c1"}}"#,
                r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"done"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].events.len(), 3);
        assert!(matches!(&turns[1].events[2], AgentEvent::Assistant { text } if text == "ok"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn test_codex_spawn_agent_becomes_subagent_card() {
        let dir = std::env::temp_dir().join(format!("cmux-spawn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let parent_id = "01a1d910-1e30-7e92-ac12-4130aeed880f";
        let done_id = "01a1d922-7bcd-7770-ad19-ae1adb1196d4";
        let busy_id = "01a1d922-7c48-7300-8380-35688fac84d7";
        let parent = dir.join(format!("rollout-2026-11-14T15-17-54-{parent_id}.jsonl"));
        let meta = |id: &str| format!(r#"{{"type":"session_meta","payload":{{"id":"{id}"}}}}"#);
        let write = |path: &std::path::Path, lines: Vec<String>| std::fs::write(path, lines.join("\n") + "\n").unwrap();
        write(&dir.join(format!("rollout-2026-11-14T15-17-58-{done_id}.jsonl")), vec![
            meta(done_id),
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":13642}}}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#.into(),
        ]);
        write(&dir.join(format!("rollout-2026-11-14T15-17-58-{busy_id}.jsonl")), vec![
            meta(busy_id),
            r#"{"type":"event_msg","payload":{"type":"task_started"}}"#.into(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":500}}}}"#.into(),
        ]);
        write(&parent, vec![
            meta(parent_id),
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"scan"}]}}"#.into(),
            r#"{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"c1","arguments":"{\"message\":\"You are the `Flutter Mobile Specialist`. Audit.\"}"}}"#.into(),
            format!(r#"{{"type":"response_item","payload":{{"type":"function_call_output","call_id":"c1","output":"{{\"agent_id\":\"{done_id}\",\"nickname\":\"Plato\"}}"}}}}"#),
            r#"{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"c2","arguments":"{\"message\":\"do it\"}"}}"#.into(),
            format!(r#"{{"type":"response_item","payload":{{"type":"function_call_output","call_id":"c2","output":"{{\"agent_id\":\"{busy_id}\",\"nickname\":\"Kuhn\"}}"}}}}"#),
            r#"{"type":"response_item","payload":{"type":"function_call","name":"wait_agent","call_id":"c3","arguments":"{}"}}"#.into(),
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c3","output":"waiting"}}"#.into(),
        ]);
        let turns = TranscriptReader::read_recent_turns(&parent, "s", 10).unwrap();
        let events: Vec<&AgentEvent> = turns.iter().flat_map(|t| t.events.iter()).collect();
        // No raw spawn/wait tool rows; one grouped card with both children.
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::ToolStart { .. } | AgentEvent::ToolEnd { .. })));
        let agents = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents),
                _ => None,
            })
            .expect("subagent card");
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].label, "Flutter Mobile Specialist (Plato)");
        assert_eq!(agents[0].state, SubagentState::Completed);
        assert_eq!(agents[0].tokens, Some(13642));
        assert_eq!(agents[1].label, "Kuhn");
        assert_eq!(agents[1].state, SubagentState::Working);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_antigravity_repeated_user_input_without_reply_is_one_turn() {
        let p = write_jsonl("agy-dup", &[
            r#"{"type":"USER_INPUT","content":"<USER_REQUEST>go</USER_REQUEST>"}"#,
            r#"{"type":"USER_INPUT","content":"<USER_REQUEST>go</USER_REQUEST><ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>"}"#,
            r#"{"type":"PLANNER_RESPONSE","content":"ok"}"#,
            r#"{"type":"USER_INPUT","content":"<USER_REQUEST>go</USER_REQUEST>"}"#,
        ]);
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        let users = turns.iter().filter(|t| t.role == AgentRole::User).count();
        // The echo right after the first prompt is dropped; asking "go" again after a reply is kept.
        assert_eq!(users, 2);
    }

    #[test]
    fn test_antigravity_invoke_subagent_binds_id_and_completes() {
        let child = "d63fc013-961a-4ff5-9eef-d68d5c96b07c";
        let p = write_jsonl("agy-sub", &[
            r#"{"type":"USER_INPUT","status":"DONE","content":"spawn a reviewer"}"#,
            r#"{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{"Role":"Fresh-Context Auditor","TypeName":"general"}}]}"#,
            &format!(r#"{{"type":"GENERIC","status":"DONE","content":"Created At: x\nCreated the following subagent: {{\n  \"conversationId\":  \"{child}\",\n  \"logAbsoluteUri\": \"file:///x\"\n}}"}}"#),
        ]);
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        let evs: Vec<&AgentEvent> = turns.iter().flat_map(|t| t.events.iter()).collect();
        // The raw "Created the following subagent" text is not chat content.
        assert!(!evs.iter().any(|e| matches!(e, AgentEvent::Assistant { text } if text.contains("Created the following"))));
        let agents = evs.iter().find_map(|e| match e { AgentEvent::Subagents { agents, .. } => Some(agents), _ => None }).unwrap();
        assert_eq!(agents[0].id, child);
        assert_eq!(agents[0].state, SubagentState::Working);

        // Child reports back => completed
        let mut lines: Vec<String> = std::fs::read_to_string(&p).unwrap().lines().map(String::from).collect();
        lines.push(format!(r#"{{"type":"SYSTEM_MESSAGE","status":"DONE","content":"<SYSTEM_MESSAGE>\n[Message] timestamp=t sender={child} priority=HIGH content=report"}}"#));
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let turns = TranscriptReader::read_recent_turns(&p, "s", 10).unwrap();
        let agents = turns.iter().flat_map(|t| t.events.iter()).find_map(|e| match e { AgentEvent::Subagents { agents, .. } => Some(agents.clone()), _ => None }).unwrap();
        assert_eq!(agents[0].state, SubagentState::Completed);
    }

    #[test]
    fn test_codex_paginated_collab_item_becomes_subagent_card() {
        let dir = std::env::temp_dir().join(format!("cmux-collab-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let parent_id = "01a1d910-1e30-7e92-ac12-4130aeed880f";
        let child_id = "01a1d922-7bcd-7770-ad19-ae1adb1196d4";
        let parent = dir.join(format!("rollout-2026-11-14T15-17-54-{parent_id}.jsonl"));
        std::fs::write(
            dir.join(format!("rollout-2026-11-14T15-17-58-{child_id}.jsonl")),
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{child_id}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}\n"),
        )
        .unwrap();
        let item = format!(
            r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"CollabAgentToolCall","tool":"spawn_agent","receiver_agents":[{{"thread_id":"{child_id}","agent_nickname":"Plato"}}],"prompt":"You are the `Flutter Mobile Specialist`. Audit."}}}}}}"#
        );
        let wait = r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CollabAgentToolCall","tool":"wait_agent"}}}"#;
        std::fs::write(
            &parent,
            [
                r#"{"type":"session_meta","payload":{"id":"x","history_mode":"paginated"}}"#.to_string(),
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"text":"scan"}]}}}"#.to_string(),
                item,
                wait.to_string(),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let turns = TranscriptReader::read_recent_turns(&parent, "s", 10).unwrap();
        let agents = turns
            .iter()
            .flat_map(|t| t.events.iter())
            .find_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents.clone()),
                _ => None,
            })
            .expect("card");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].label, "Flutter Mobile Specialist (Plato)");
        assert_eq!(agents[0].state, SubagentState::Completed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn claude_tool_result_attaches_to_assistant_turn() {
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"run it"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"a.txt","is_error":false}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"false"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t2","type":"tool_result","content":[{"type":"text","text":"boom"}],"is_error":true}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#,
        ];
        let mut cur = None;
        let mut turns = Vec::new();
        for l in lines {
            Self_parse(serde_json::from_str(l).unwrap(), &mut cur, &mut turns);
        }
        if let Some(t) = cur.take() {
            turns.push(t);
        }
        // user prompt + ONE assistant turn holding both tool calls, both results and the reply.
        assert_eq!(turns.len(), 2);
        let ev = &turns[1].events;
        let ends: Vec<_> = ev
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolEnd { tool_id, detail, ok, .. } => Some((tool_id.as_str(), detail.as_deref(), *ok)),
                _ => None,
            })
            .collect();
        assert_eq!(ends, vec![("t1", Some("a.txt"), true), ("t2", Some("boom"), false)]);
        assert!(matches!(ev.last(), Some(AgentEvent::Assistant { .. })));
    }

    #[test]
    fn claude_tool_result_after_interrupting_user_line_still_attaches() {
        let lines = [
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Bash","input":{"command":"sleep 5"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"never mind, status?"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t9","type":"tool_result","content":"done","is_error":false}]}}"#,
        ];
        let mut cur = None;
        let mut turns = Vec::new();
        for l in lines {
            Self_parse(serde_json::from_str(l).unwrap(), &mut cur, &mut turns);
        }
        let issued = turns
            .iter()
            .find(|t| t.events.iter().any(|e| matches!(e, AgentEvent::ToolStart { .. })))
            .expect("assistant turn");
        assert!(issued
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { tool_id, ok: true, .. } if tool_id == "t9")));
    }

    #[test]
    fn claude_usage_becomes_one_event_per_message() {
        let line = |text: &str| {
            format!(
                r#"{{"type":"assistant","message":{{"model":"claude-sonnet-5-5","content":[{{"type":"text","text":"{text}"}}],"usage":{{"input_tokens":4,"output_tokens":9,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}}}}"#
            )
        };
        let mut cur = None;
        let mut turns = Vec::new();
        for l in [line("a"), line("b")] {
            Self_parse(serde_json::from_str(&l).unwrap(), &mut cur, &mut turns);
        }
        let events = &cur.unwrap().events;
        let usages: Vec<_> = events.iter().filter(|e| matches!(e, AgentEvent::Usage { .. })).collect();
        assert_eq!(usages.len(), 1, "identical usage on consecutive lines is deduplicated");
        assert!(matches!(
            usages[0],
            AgentEvent::Usage { model: Some(m), input_tokens: 4, output_tokens: 9, cache_read_tokens: 1000, cache_creation_tokens: 50 }
                if m == "claude-sonnet-5-5"
        ));
    }

    #[allow(non_snake_case)]
    fn Self_parse(v: serde_json::Value, cur: &mut Option<AgentTurn>, turns: &mut Vec<AgentTurn>) {
        TranscriptReader::parse_claude_line(v, "s", cur, turns);
    }

    #[test]
    fn large_transcript_tail_window_and_before_offset_pagination() {
        let path = std::env::temp_dir().join(format!("cmux-tail-win-{}.jsonl", uuid::Uuid::new_v4()));
        let mut f = File::create(&path).unwrap();
        let padding = "x".repeat(4500);
        // 40 exchanges = 80 turns (~380 KiB > 128 KiB tail-window threshold).
        for idx in 0..40 {
            writeln!(
                f,
                r#"{{"type":"user","message":{{"role":"user","content":"prompt-{idx} {padding}"}}}}"#
            )
            .unwrap();
            writeln!(
                f,
                r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"reply-{idx} {padding}"}}]}}}}"#
            )
            .unwrap();
        }
        drop(f);

        // Cold tail read of last 10 turns.
        let tail_page = TranscriptReader::read_turns_page(&path, "surf-tail", 10, None).unwrap();
        assert_eq!(tail_page.turns.len(), 10);
        assert!(tail_page.has_more);
        assert!(tail_page.before_offset.is_some());
        assert!(tail_page.turns[0].id.starts_with("turn-@"));
        assert!(matches!(
            &tail_page.turns[9].events[0],
            AgentEvent::Assistant { text } if text.starts_with("reply-39 ")
        ));

        // Walk backwards via `before_offset` cursor until beginning of file.
        let mut all_turns = tail_page.turns.clone();
        let mut cursor = tail_page.before_offset;
        let mut safety = 0;
        while let Some(off) = cursor {
            safety += 1;
            assert!(safety <= 20, "pagination did not converge");
            let older = TranscriptReader::read_turns_page(&path, "surf-tail", 14, Some(off)).unwrap();
            assert!(!older.turns.is_empty());
            let mut combined = older.turns;
            combined.extend(all_turns);
            all_turns = combined;
            cursor = if older.has_more { older.before_offset } else { None };
        }

        assert_eq!(all_turns.len(), 80);
        assert!(matches!(
            &all_turns[0].events[0],
            AgentEvent::User { text } if text.starts_with("prompt-0 ")
        ));
        assert!(matches!(
            &all_turns[79].events[0],
            AgentEvent::Assistant { text } if text.starts_with("reply-39 ")
        ));

        // Incremental append after cold tail open keeps byte-anchored turn IDs.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"role":"user","content":"prompt-40"}}}}"#
        )
        .unwrap();
        drop(f);

        let updated = TranscriptReader::read_turns_page(&path, "surf-tail", 10, None).unwrap();
        assert_eq!(updated.turns.len(), 10);
        assert!(updated.turns[9].id.starts_with("turn-@"));
        assert!(matches!(
            &updated.turns[9].events[0],
            AgentEvent::User { text } if text == "prompt-40"
        ));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn claude_compact_summary_and_meta_lines_become_system_divider() {
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}"#,
            r#"{"type":"system","subtype":"compact_boundary"}"#,
            r#"{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. Summary..."}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>ignore</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"after compact"}}"#,
        ];
        let mut cur = None;
        let mut turns = Vec::new();
        for l in lines {
            Self_parse(serde_json::from_str(l).unwrap(), &mut cur, &mut turns);
        }
        if let Some(t) = cur.take() {
            turns.push(t);
        }
        // user("hello"), assistant("world"), ONE deduplicated System("Context compacted"), user("after compact")
        assert_eq!(turns.len(), 4);
        assert_eq!(turns[2].role, AgentRole::System);
        assert_eq!(
            turns[2].events,
            vec![AgentEvent::Status {
                text: "Context compacted".to_string()
            }]
        );
        assert_eq!(turns[3].role, AgentRole::User);
    }

    #[test]
    fn claude_subagents_and_background_tasks_lifecycle() {
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-25T10:00:00.000Z","message":{"role":"user","content":"audit and start dev server"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-25T10:00:02.000Z","message":{"content":[{"type":"tool_use","id":"toolu_agent_1","name":"Agent","input":{"description":"Audit auth module","subagent_type":"Explore","run_in_background":true}},{"type":"tool_use","id":"toolu_bash_1","name":"Bash","input":{"command":"pnpm dev","description":"Start dev server","run_in_background":true}}]}}"#,
            r#"{"type":"system","subtype":"task_started","timestamp":"2026-11-25T10:00:02.100Z","task_id":"agent_abc","tool_use_id":"toolu_agent_1","description":"Audit auth module","subagent_type":"Explore","task_type":"local_agent","is_backgrounded":true}"#,
            r#"{"type":"user","parent_tool_use_id":"toolu_agent_1","message":{"role":"user","content":"internal child prompt should be skipped"}}"#,
            r#"{"type":"system","subtype":"task_progress","timestamp":"2026-11-25T10:00:05.000Z","task_id":"agent_abc","tool_use_id":"toolu_agent_1","usage":{"total_tokens":14200,"duration_ms":3000}}"#,
            r#"{"type":"user","timestamp":"2026-11-25T10:00:03.000Z","toolUseResult":{"backgroundTaskId":"bg_srv_1"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bash_1","content":"Running in background"}]}}"#,
            r#"{"type":"system","subtype":"task_notification","timestamp":"2026-11-25T10:00:09.000Z","task_id":"agent_abc","tool_use_id":"toolu_agent_1","status":"completed","usage":{"total_tokens":18500,"duration_ms":7000}}"#,
        ];

        let mut cur = None;
        let mut turns = Vec::new();
        for l in lines {
            Self_parse(serde_json::from_str(l).unwrap(), &mut cur, &mut turns);
        }

        // Sidechain user row did NOT close the assistant turn or add a user bubble.
        assert_eq!(turns.len(), 1);
        let ast = cur.as_ref().expect("open assistant turn");

        let subagents = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents),
                _ => None,
            })
            .expect("claude subagent card");
        assert_eq!(subagents.len(), 1);
        assert_eq!(subagents[0].id, "agent_abc");
        assert_eq!(subagents[0].state, SubagentState::Completed);
        assert_eq!(subagents[0].tokens, Some(18500));
        assert!(subagents[0].started_at.is_some());
        assert!(subagents[0].settled_at.is_some());

        let bg_tasks = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::BackgroundTasks { tasks } => Some(tasks),
                _ => None,
            })
            .expect("claude background task");
        assert_eq!(bg_tasks.len(), 1);
        assert_eq!(bg_tasks[0].id, "bg_srv_1");
        assert_eq!(bg_tasks[0].state, SubagentState::Working);

        // Settle background shell via `<task-notification>` XML user turn.
        let xml_notif = r#"{"type":"user","timestamp":"2026-11-25T10:00:15.000Z","message":{"role":"user","content":"<task-notification>\n<task-id>bg_srv_1</task-id>\n<status>completed</status>\n<summary>Server exited cleanly</summary>\n</task-notification>"}}"#;
        Self_parse(serde_json::from_str(xml_notif).unwrap(), &mut cur, &mut turns);

        let ast = cur.as_ref().expect("assistant turn stays open");
        let bg_tasks = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::BackgroundTasks { tasks } => Some(tasks),
                _ => None,
            })
            .unwrap();
        assert_eq!(bg_tasks[0].state, SubagentState::Completed);
        assert_eq!(bg_tasks[0].summary.as_deref(), Some("Server exited cleanly"));
    }

    #[test]
    fn antigravity_background_command_and_parallel_subagents() {
        let c1 = "11111111-2222-3333-4444-555555555555";
        let c2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let p = write_jsonl(
            "agy-bg-sub",
            &[
                r#"{"type":"USER_INPUT","created_at":"2026-11-25T10:00:00Z","content":"run checks and audit"}"#,
                r#"{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T10:00:01Z","tool_calls":[{"name":"invoke_subagent","args":{"Role":"\"Protocol Auditor\"","TypeName":"\"research\""}},{"name":"invoke_subagent","args":{"Role":"\"UI Verifier\"","TypeName":"\"research\""}},{"name":"run_command","args":{"CommandLine":"\"cargo test --all\"","toolSummary":"\"Gateway test suite\""}}]}"#,
                &format!(
                    r#"{{"type":"GENERIC","created_at":"2026-11-25T10:00:02Z","content":"Created the following subagent: {{\"conversationId\": \"{c1}\"}}"}}"#
                ),
                &format!(
                    r#"{{"type":"GENERIC","created_at":"2026-11-25T10:00:02Z","content":"Created the following subagent: {{\"conversationId\": \"{c2}\"}}"}}"#
                ),
                r#"{"type":"GENERIC","status":"RUNNING","created_at":"2026-11-25T10:00:03Z","content":"Tool is running as a background task with task id: conv-9/task-1620\nTask Description: cargo test --all"}"#,
                r#"{"type":"SYSTEM_MESSAGE","created_at":"2026-11-25T10:00:12Z","content":"[Message] timestamp=2026-11-25T10:00:12Z sender=conv-9/task-1620 priority=HIGH content=Task finished:\nCommand exited with code 0."}"#,
                &format!(
                    r#"{{"type":"SYSTEM_MESSAGE","created_at":"2026-11-25T10:00:14Z","content":"[Message] timestamp=2026-11-25T10:00:14Z sender={c1} priority=HIGH content=done"}}"#
                ),
            ],
        );

        let turns = TranscriptReader::read_recent_turns(&p, "surf-agy", 10).unwrap();
        assert_eq!(turns.len(), 2);
        let ast = &turns[1];

        let subagents = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents),
                _ => None,
            })
            .expect("coalesced agy subagents card");
        assert_eq!(subagents.len(), 2);
        assert_eq!(subagents[0].id, c1);
        assert_eq!(subagents[0].label, "Protocol Auditor");
        assert_eq!(subagents[0].state, SubagentState::Completed);
        assert_eq!(subagents[1].id, c2);
        assert_eq!(subagents[1].label, "UI Verifier");
        assert_eq!(subagents[1].state, SubagentState::Working);

        let bg = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::BackgroundTasks { tasks } => Some(tasks),
                _ => None,
            })
            .expect("agy background command");
        assert_eq!(bg.len(), 1);
        assert_eq!(bg[0].label, "Gateway test suite");
        assert_eq!(bg[0].state, SubagentState::Completed);
        assert!(bg[0].settled_at.unwrap() > bg[0].started_at.unwrap());

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn antigravity_multi_ask_question_receipts_and_thinking_durations() {
        let q1 = r#"[{"question":"Xác nhận cơ chế brew?","options":["(Recommended) Chốt luôn brew","Dùng nix"],"is_multi_select":false}]"#;
        let q2 = r#"[{"question":"Quyết định 8 — Xử lý nhóm wrapper?","options":["(Recommended) Gom luôn vào gear-config","Tách riêng md2pdf","Giữ tất cả riêng biệt"],"is_multi_select":false}]"#;
        let p = write_jsonl(
            "agy-multi-ask",
            &[
                r#"{"type":"USER_INPUT","created_at":"2026-11-25T13:52:00Z","content":"tiếp tục"}"#,
                &format!(
                    r#"{{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T13:52:10Z","content":"Chốt Mức 1 nhé?","tool_calls":[{{"name":"ask_question","args":{{"questions":{}}}}}]}}"#,
                    serde_json::to_string(q1).unwrap()
                ),
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:53:20Z","content":"Created At: 2026-11-25T20:53:01+07:00\nCompleted At: 2026-11-25T20:53:21+07:00\nCreated At: 2026-11-25T20:53:01+07:00\nCompleted At: 2026-11-25T20:53:20+07:00\nA1: (Recommended) Chốt luôn brew"}"#,
                r#"{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T13:53:21Z","thinking":"I'm thinking through how to approach this.","tool_calls":[{"name":"read_file","args":{"Path":"\"/tmp/md2pdf.sh\""}},{"name":"read_file","args":{"Path":"\"/tmp/docker-compose.yml\""}}]}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:53:36Z","content":"Created At: 2026-11-25T20:53:36+07:00\nCompleted At: 2026-11-25T20:53:36+07:00\nShowing lines 1-34"}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:53:36Z","content":"Created At: 2026-11-25T20:53:36+07:00\nCompleted At: 2026-11-25T20:53:36+07:00\nShowing lines 1-38"}"#,
                &format!(
                    r#"{{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T13:54:14Z","thinking":"Detailed wrapper synthesis.","content":"Mình vừa mở code bên trong.","tool_calls":[{{"name":"ask_question","args":{{"questions":{}}}}}]}}"#,
                    serde_json::to_string(q2).unwrap()
                ),
            ],
        );

        let turns = TranscriptReader::read_recent_turns(&p, "surf-agy-q", 10).unwrap();
        assert_eq!(turns.len(), 2);
        let ast = &turns[1];

        // No raw `Created At:` or `A1:` leaked into Assistant prose events.
        for ev in &ast.events {
            if let AgentEvent::Assistant { text } = ev {
                assert!(!text.contains("Created At:"));
                assert!(!text.contains("A1:"));
            }
        }

        // First Thinking block lasted 15s (13:53:21Z -> 13:53:36Z).
        let thinkings: Vec<Option<u64>> = ast
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Thinking { duration_secs, .. } => Some(*duration_secs),
                _ => None,
            })
            .collect();
        assert_eq!(thinkings.first().copied().flatten(), Some(15));

        // Exactly two AwaitingInput events: first settled with clean answer, second still open!
        let asks: Vec<&crate::protocol::event::AwaitingInput> = ast
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::AwaitingInput(a) => Some(a),
                _ => None,
            })
            .collect();
        assert_eq!(asks.len(), 2);
        assert_eq!(
            asks[0].answered.as_deref(),
            Some("(Recommended) Chốt luôn brew")
        );
        assert!(asks[1].answered.is_none());
        assert_eq!(asks[1].options.as_ref().unwrap().len(), 3);

        let _ = std::fs::remove_file(&p);
    }
}