//! Bounded 64 KiB reverse tail-window & incremental JSONL reader.
//!
//! Guarantees:
//! 1. Live `consumed_to` NEVER advances past the last `\n` (`0x0a`) byte, preventing partial or
//!    oversized trailing line corruption while an agent is mid-write.
//! 2. Stores a 64-byte boundary digest ending at `byte_offset` in the cache so file truncation,
//!    replacement, or rewrite is detected even when `new_len > old_offset`.
//! 3. Preserves consistent turn IDs (`turn-1..N` for files `<= 128 KiB`, `turn-@<byte_offset>` for
//!    files `> 128 KiB`) across both live tail reads and `before_offset` historical pagination.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use crate::protocol::event::{AgentEvent, AgentRole, AgentTurn};
use crate::providers::{parse_transcript_line, refresh_working_codex_subagents, ProviderParseState};

/// Reverse tail-chunk size (matches Orca `TAIL_CHUNK_BYTES = 64 * 1024` in `transcript-tail-boundary.ts:4`).
pub const TAIL_CHUNK_BYTES: u64 = 64 * 1024;
/// Files up to 128 KiB are read from byte 0 in one pass; larger transcripts seek from the tail.
pub const TAIL_WINDOW_THRESHOLD_BYTES: u64 = 128 * 1024;
/// Skip individual JSONL records over 2 MiB (matches Orca `MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES`).
pub const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
/// Maximum bytes scanned backwards in a single page request on pathological transcripts without user turns.
const MAX_WINDOW_SCAN_BYTES: u64 = 16 * 1024 * 1024;
/// Boundary sample size at `byte_offset` used to detect file rewrite/replacement.
const BOUNDARY_SAMPLE_BYTES: u64 = 64;

#[derive(Debug, Clone)]
pub struct TranscriptPage {
    pub turns: Vec<AgentTurn>,
    /// Earlier in-window turns (before `max_turns` cutoff) that contain `Subagents` or
    /// `BackgroundTasks` events so live child reconciliation can report long-running workers
    /// without breaking `before_offset` pagination.
    pub earlier_child_turns: Vec<AgentTurn>,
    pub has_more: bool,
    pub before_offset: Option<u64>,
    pub total_turns: usize,
}

struct CachedTranscript {
    mtime_ns: u128,
    window_start_offset: u64,
    byte_offset: u64,
    boundary_digest: u64,
    offset_anchored: bool,
    turns: Vec<AgentTurn>,
    turn_offsets: Vec<u64>,
    current_turn: Option<AgentTurn>,
    current_turn_offset: Option<u64>,
    state: ProviderParseState,
}

type CacheKey = (PathBuf, String);
type CacheSlot = Arc<Mutex<Option<CachedTranscript>>>;

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
        return Arc::clone(slot);
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
    let slot = Arc::new(Mutex::new(None));
    store.entries.insert(key, (tick, Arc::clone(&slot)));
    slot
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn compute_boundary_digest(file: &mut File, byte_offset: u64) -> Result<u64, std::io::Error> {
    if byte_offset == 0 {
        return Ok(0);
    }
    let start = byte_offset.saturating_sub(BOUNDARY_SAMPLE_BYTES);
    let sample_len = (byte_offset - start) as usize;
    let mut buf = vec![0u8; sample_len];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut buf)?;
    Ok(fnv1a_64(&buf))
}

/// Fast header-only check for records that genuinely open a new `User` turn while scanning 64 KiB
/// chunks backwards. Inspecting only the leading record header (`<= 320` bytes) prevents multi-KB
/// tool outputs containing `"user"` strings in source code from triggering $O(K^2)$ false boundaries!
fn is_likely_user_turn_record(line: &str) -> bool {
    let head_len = line.floor_char_boundary(line.len().min(320));
    let head = &line[..head_len];
    if head.contains("\"USER_INPUT\"")
        || head.contains("\"REQUEST\"")
        || head.contains("\"UserMessage\"")
        || head.contains("\"user_message\"")
    {
        return true;
    }
    if head.contains("\"response_item\"") && head.contains("\"role\":\"user\"") {
        return true;
    }
    (head.contains("\"type\":\"user\"") || head.contains("\"type\": \"user\""))
        && !head.contains("\"isSidechain\":true")
        && !head.contains("\"isMeta\":true")
        && !line.contains("\"tool_result\"")
}

/// Read line 1 (up to 4 KiB) to detect Codex `session_meta.history_mode == "paginated"` and `model` when tail-seeking.
fn read_header_state(file: &mut File) -> ProviderParseState {
    let mut state = ProviderParseState::default();
    if file.seek(SeekFrom::Start(0)).is_err() {
        return state;
    }
    let mut header_buf = vec![0u8; 4096];
    let Ok(n) = file.read(&mut header_buf) else {
        return state;
    };
    if n == 0 {
        return state;
    }
    let slice = match header_buf[..n].iter().position(|&b| b == b'\n') {
        Some(nl) => &header_buf[..nl],
        None if n < header_buf.len() => &header_buf[..n],
        None => return state,
    };
    let line = String::from_utf8_lossy(slice);
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line.trim())
        && val.get("type").and_then(|t| t.as_str()) == Some("session_meta")
    {
        state.codex.paginated = val
            .pointer("/payload/history_mode")
            .and_then(|m| m.as_str())
            == Some("paginated");
    }
    state
}

#[allow(clippy::too_many_arguments)]
fn parse_line_with_offsets(
    trimmed: &str,
    line_offset: u64,
    offset_anchored: bool,
    surface_id: &str,
    state: &mut ProviderParseState,
    current_turn: &mut Option<AgentTurn>,
    current_turn_offset: &mut Option<u64>,
    turns: &mut Vec<AgentTurn>,
    turn_offsets: &mut Vec<u64>,
) {
    let prev_len = turns.len();
    let prev_had_current = current_turn.is_some();
    let prev_current_off = *current_turn_offset;

    parse_transcript_line(trimmed, surface_id, state, current_turn, turns);

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

/// Determines the last safe byte offset `<= end_limit` to consume.
/// When `require_newline` is true (live tail), NEVER advances past the last `\n` (`0x0a`) byte,
/// holding back any incomplete or oversized trailing record until its terminating newline lands.
fn find_consumable_end(
    file: &mut File,
    end_limit: u64,
    require_newline: bool,
) -> Result<u64, std::io::Error> {
    if end_limit == 0 {
        return Ok(0);
    }
    if !require_newline {
        return Ok(end_limit);
    }
    let mut byte = [0u8; 1];
    file.seek(SeekFrom::Start(end_limit - 1))?;
    if file.read(&mut byte)? == 1 && byte[0] == b'\n' {
        return Ok(end_limit);
    }
    let mut cursor = end_limit;
    while cursor > 0 {
        let start = cursor.saturating_sub(TAIL_CHUNK_BYTES);
        let chunk_len = (cursor - start) as usize;
        let mut buf = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        if let Some(pos) = buf.iter().rposition(|&b| b == b'\n') {
            return Ok(start + pos as u64 + 1);
        }
        cursor = start;
    }
    Ok(0)
}

fn read_forward_from_zero(
    file: &mut File,
    surface_id: &str,
    consumed_to: u64,
    offset_anchored: bool,
    mut state: ProviderParseState,
) -> Result<CachedTranscript, std::io::Error> {
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file.try_clone()?);
    let mut offset = 0u64;
    let mut line_buf = Vec::new();
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
        let next_offset = (offset + n as u64).min(consumed_to);
        let usable_len = (next_offset - line_start) as usize;
        offset = next_offset;
        if usable_len <= MAX_RECORD_BYTES {
            let text = String::from_utf8_lossy(&line_buf[..usable_len]);
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parse_line_with_offsets(
                    trimmed,
                    line_start,
                    offset_anchored,
                    surface_id,
                    &mut state,
                    &mut current_turn,
                    &mut current_turn_offset,
                    &mut turns,
                    &mut turn_offsets,
                );
            }
        }
    }

    let boundary_digest = compute_boundary_digest(file, consumed_to)?;
    Ok(CachedTranscript {
        mtime_ns: 0,
        window_start_offset: 0,
        byte_offset: consumed_to,
        boundary_digest,
        offset_anchored,
        turns,
        turn_offsets,
        current_turn,
        current_turn_offset,
        state,
    })
}

fn read_tail_window(
    file: &mut File,
    surface_id: &str,
    file_total_len: u64,
    end_limit: u64,
    needed_turns: usize,
    is_live_tail: bool,
) -> Result<CachedTranscript, std::io::Error> {
    let consumed_to = find_consumable_end(file, end_limit, is_live_tail)?;
    let offset_anchored = file_total_len > TAIL_WINDOW_THRESHOLD_BYTES;
    let base_state = if consumed_to > TAIL_WINDOW_THRESHOLD_BYTES {
        read_header_state(file)
    } else {
        ProviderParseState::default()
    };

    if consumed_to == 0 {
        return Ok(CachedTranscript {
            mtime_ns: 0,
            window_start_offset: 0,
            byte_offset: 0,
            boundary_digest: 0,
            offset_anchored,
            turns: Vec::new(),
            turn_offsets: Vec::new(),
            current_turn: None,
            current_turn_offset: None,
            state: base_state,
        });
    }

    // Small files (`<= 128 KiB`): single forward pass from byte 0 ensures identical sequential
    // `turn-1..N` IDs across both live tail reads and `before_offset` pagination.
    if file_total_len <= TAIL_WINDOW_THRESHOLD_BYTES {
        return read_forward_from_zero(file, surface_id, consumed_to, false, base_state);
    }

    let mut target_user_boundaries = (needed_turns / 2).saturating_add(3);
    let mut cursor = consumed_to;
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
        while cursor > 0
            && user_boundaries < target_user_boundaries
            && scanned_bytes < MAX_WINDOW_SCAN_BYTES
        {
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

        let mut state = base_state.clone();
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
                &mut state,
                &mut current_turn,
                &mut current_turn_offset,
                &mut turns,
                &mut turn_offsets,
            );
        }

        if cursor > 0
            && let Some(first_boundary_idx) = turns
                .iter()
                .position(|t| matches!(t.role, AgentRole::User | AgentRole::System))
            && first_boundary_idx > 0
        {
            turns.drain(0..first_boundary_idx);
            turn_offsets.drain(0..first_boundary_idx);
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
            let boundary_digest = compute_boundary_digest(file, consumed_to)?;
            return Ok(CachedTranscript {
                mtime_ns: 0,
                window_start_offset: window_start,
                byte_offset: consumed_to,
                boundary_digest,
                offset_anchored,
                turns,
                turn_offsets,
                current_turn,
                current_turn_offset,
                state,
            });
        }

        // Double the cumulative boundary target instead of resetting `user_boundaries = 0` by a
        // tiny constant step, guaranteeing at most O(log N) passes even on heavy harness noise.
        target_user_boundaries = user_boundaries
            .max(target_user_boundaries)
            .saturating_mul(2);
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

pub fn read_jsonl_turns_page(
    transcript_path: &Path,
    surface_id: &str,
    max_turns: usize,
    before_offset: Option<u64>,
) -> Result<TranscriptPage, std::io::Error> {
    if !transcript_path.exists() {
        return Ok(TranscriptPage {
            turns: Vec::new(),
            earlier_child_turns: Vec::new(),
            has_more: false,
            before_offset: None,
            total_turns: 0,
        });
    }

    let (mtime_ns, len) = file_mtime_len(transcript_path)?;

    if let Some(cursor) = before_offset {
        let capped_end = cursor.min(len);
        if capped_end == 0 || max_turns == 0 {
            return Ok(TranscriptPage {
                turns: Vec::new(),
                earlier_child_turns: Vec::new(),
                has_more: false,
                before_offset: None,
                total_turns: 0,
            });
        }
        let mut file = File::open(transcript_path)?;
        let mut win = read_tail_window(&mut file, surface_id, len, capped_end, max_turns, false)?;
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
            earlier_child_turns: Vec::new(),
            has_more,
            before_offset: has_more.then_some(first_offset),
        });
    }

    let cache_key = (transcript_path.to_path_buf(), surface_id.to_string());
    let slot = get_transcript_cache_slot(cache_key);
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());

    let mut open_file: Option<File> = None;
    let needs_rebuild = match guard.as_ref() {
        None => true,
        Some(hit) => {
            let have_turns = hit.turns.len() + usize::from(hit.current_turn.is_some());
            if len < hit.byte_offset || (hit.window_start_offset > 0 && have_turns < max_turns) {
                true
            } else if len == hit.byte_offset && mtime_ns == hit.mtime_ns {
                false
            } else if hit.byte_offset == 0 {
                true
            } else {
                let mut f = File::open(transcript_path)?;
                let digest_ok = compute_boundary_digest(&mut f, hit.byte_offset)? == hit.boundary_digest;
                open_file = Some(f);
                !digest_ok
            }
        }
    };

    if needs_rebuild {
        let mut file = match open_file {
            Some(f) => f,
            None => File::open(transcript_path)?,
        };
        let mut fresh = read_tail_window(&mut file, surface_id, len, len, max_turns, true)?;
        fresh.mtime_ns = mtime_ns;
        *guard = Some(fresh);
    } else if let Some(cached) = guard.as_mut() {
        if len > cached.byte_offset {
            let mut file = match open_file {
                Some(f) => f,
                None => File::open(transcript_path)?,
            };
            let consumable_end = find_consumable_end(&mut file, len, true)?;
            if consumable_end > cached.byte_offset {
                file.seek(SeekFrom::Start(cached.byte_offset))?;
                let mut reader = BufReader::new(file.try_clone()?);
                let mut offset = cached.byte_offset;
                let mut line_buf = Vec::new();
                let offset_anchored = cached.offset_anchored;

                while offset < consumable_end {
                    line_buf.clear();
                    let n = reader.read_until(b'\n', &mut line_buf)?;
                    if n == 0 || !line_buf.ends_with(b"\n") {
                        break;
                    }
                    let line_start = offset;
                    offset += n as u64;
                    if line_buf.len() > MAX_RECORD_BYTES {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&line_buf);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        parse_line_with_offsets(
                            trimmed,
                            line_start,
                            offset_anchored,
                            surface_id,
                            &mut cached.state,
                            &mut cached.current_turn,
                            &mut cached.current_turn_offset,
                            &mut cached.turns,
                            &mut cached.turn_offsets,
                        );
                    }
                }
                cached.byte_offset = offset;
                cached.boundary_digest = compute_boundary_digest(&mut file, offset)?;
            }
            cached.mtime_ns = mtime_ns;
        } else {
            cached.mtime_ns = mtime_ns;
        }
    }

    let (mut slice, mut earlier_child_turns, has_more, first_offset, total_turns) = {
        let cached = guard.as_ref().expect("cached transcript populated");
        let total_in_window = cached.turns.len() + usize::from(cached.current_turn.is_some());
        let tail_start = total_in_window.saturating_sub(max_turns);

        let first_offset = if tail_start < cached.turn_offsets.len() {
            cached.turn_offsets[tail_start]
        } else {
            cached
                .current_turn_offset
                .unwrap_or(cached.window_start_offset)
        };

        let earlier_child_turns: Vec<AgentTurn> = if tail_start > 0 {
            let end = tail_start.min(cached.turns.len());
            cached.turns[..end]
                .iter()
                .filter(|t| {
                    t.events.iter().any(|ev| {
                        matches!(
                            ev,
                            AgentEvent::Subagents { .. } | AgentEvent::BackgroundTasks { .. }
                        )
                    })
                })
                .cloned()
                .collect()
        } else {
            Vec::new()
        };

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
        (slice, earlier_child_turns, has_more, first_offset, total_turns)
    };
    drop(guard);

    // Refresh Codex child subagents OUTSIDE the main transcript cache lock!
    if !earlier_child_turns.is_empty() {
        refresh_working_codex_subagents(transcript_path, &mut earlier_child_turns);
    }
    refresh_working_codex_subagents(transcript_path, &mut slice);

    Ok(TranscriptPage {
        turns: slice,
        earlier_child_turns,
        has_more,
        before_offset: has_more.then_some(first_offset),
        total_turns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Instant;

    #[test]
    fn user_turn_boundary_check_ignores_large_tool_outputs_with_user_strings() {
        let agy_user = r#"{"idx":1,"type":"USER_INPUT","step":{"timestamp":"2026-11-26T04:00:00Z","userInput":{"userResponse":"fix bug"}}}"#;
        assert!(is_likely_user_turn_record(agy_user));

        let claude_user = r#"{"type":"user","message":{"role":"user","content":"hello"}}"#;
        assert!(is_likely_user_turn_record(claude_user));

        // Large Antigravity GENERIC tool output containing `"type":"user"` inside read_file output body:
        let padding = "x".repeat(400);
        let generic_tool_output = format!(
            r#"{{"idx":42,"type":"GENERIC","step":{{"timestamp":"2026-11-26T04:01:00Z","generic":{{"output":"{padding} \"type\":\"user\" \"USER_INPUT\" \"UserMessage\""}}}}}}"#
        );
        assert!(!is_likely_user_turn_record(&generic_tool_output));
    }

    #[test]
    fn multi_mb_transcript_with_noisy_tool_outputs_parses_in_milliseconds() {
        let path = std::env::temp_dir().join(format!("cmux-perf-{}.jsonl", uuid::Uuid::new_v4()));
        {
            let mut f = File::create(&path).unwrap();
            writeln!(
                f,
                r#"{{"idx":0,"type":"USER_INPUT","step":{{"timestamp":"2026-11-26T04:00:00Z","userInput":{{"userResponse":"initial prompt"}}}}}}"#
            )
            .unwrap();
            let noisy_chunk = "const role = {\"type\":\"user\",\"USER_INPUT\":true}; ".repeat(650);
            for i in 1..=110 {
                writeln!(
                    f,
                    r#"{{"idx":{i},"type":"GENERIC","step":{{"timestamp":"2026-11-26T04:00:01Z","generic":{{"toolCall":{{"id":"c-{i}","name":"read_file","argsJson":"{{\"Path\":\"/tmp/a.ts\"}}"}},"output":"{noisy_chunk}"}}}}}}"#
                )
                .unwrap();
            }
            writeln!(
                f,
                r#"{{"idx":111,"type":"PLANNER_RESPONSE","step":{{"timestamp":"2026-11-26T04:00:05Z","plannerResponse":{{"response":"All done!"}}}}}}"#
            )
            .unwrap();
        }

        let meta_len = std::fs::metadata(&path).unwrap().len();
        assert!(meta_len > 3_000_000, "expected >3MB transcript, got {meta_len}");

        let t0 = Instant::now();
        let page = read_jsonl_turns_page(&path, "surf-perf", 15, None).unwrap();
        let elapsed = t0.elapsed();
        let _ = std::fs::remove_file(&path);

        assert!(!page.turns.is_empty());
        assert!(
            elapsed.as_millis() < 500,
            "expected fast O(log N) tail window read (<500ms), took {}ms",
            elapsed.as_millis()
        );
    }
}
