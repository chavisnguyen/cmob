//! Post-projection reconciler connecting `crate::domain::child_work_fsm` to on-disk child artifacts
//! (Antigravity `tasks/task-N.log` + subagent `transcript.jsonl` + nested `/teamwork` subtrees,
//! Claude subagent `.jsonl`, and Codex child rollouts) without mutating `CachedTranscript` inside
//! `jsonl_window`.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::child_work_fsm::{
    reconcile_subagent, reconcile_turns_with, ChildArtifactEvidence, ChildReconcileContext,
    SurfaceRunEpoch, CHILD_ARTIFACT_QUIET_MS, EPOCH_SKEW_MARGIN_MS, STALE_CHILD_WORK_MS,
};
use crate::domain::noise_filter::record_timestamp_ms;
use crate::protocol::event::{
    AgentEvent, AgentTurn, BackgroundTaskEntry, BackgroundTaskKind, SubagentEntry, SubagentState,
};
use crate::providers::antigravity::{self, AntigravityState};
use crate::providers::{codex_child_rollout_stamp, codex_child_status};
use crate::scanner::hook_store::{antigravity_record_is_final_reply, last_jsonl_record};

const MAX_ARTIFACT_STAMP_CACHE: usize = 512;
const MAX_AGY_GRAPH_CACHE: usize = 256;
const MAX_AGY_SUBTREE_DEPTH: usize = 6;
/// Grace window between a child's `send_message` timestamp and its trailing final `PLANNER_RESPONSE`.
const SEND_MESSAGE_FINALIZE_GRACE_MS: u64 = 5_000;

type ClaudeChildCacheEntry = (u128, u64, Option<bool>, Option<u64>);

/// Lightweight `(mtime_ns, len) -> ChildArtifactEvidence` cache for Claude subagent `.jsonl` tails.
static CLAUDE_CHILD_CACHE: LazyLock<Mutex<HashMap<PathBuf, ClaudeChildCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct AgyChildNode {
    subagent_groups: Vec<Vec<SubagentEntry>>,
    bg_tasks: Vec<BackgroundTaskEntry>,
    has_final_reply: bool,
    has_error: bool,
    mtime_ms: u64,
    last_rec_ts_ms: Option<u64>,
    last_tokens: Option<u64>,
}

/// `(mtime_ns, len) -> AgyChildNode` cache so repeated 2s stream polls pay `0` disk reads when unchanged.
static AGY_NODE_CACHE: LazyLock<Mutex<HashMap<PathBuf, (u128, u64, AgyChildNode)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn metadata_mtime_ms_and_stamp(path: &Path) -> Option<(u64, u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((dur.as_millis() as u64, dur.as_nanos(), meta.len()))
}

/// Resolves `<brain_root>` given `<brain_root>/<conv_id>/.system_generated/logs/transcript*.jsonl`.
fn agy_brain_root_and_conv_dir(parent_transcript: &Path) -> Option<(PathBuf, PathBuf)> {
    let logs_dir = parent_transcript.parent()?;
    if logs_dir.file_name().and_then(|n| n.to_str()) != Some("logs") {
        return None;
    }
    let sys_dir = logs_dir.parent()?;
    if sys_dir.file_name().and_then(|n| n.to_str()) != Some(".system_generated") {
        return None;
    }
    let conv_dir = sys_dir.parent()?.to_path_buf();
    let brain_root = conv_dir.parent()?.to_path_buf();
    Some((brain_root, conv_dir))
}

/// Resolves Antigravity background command log path (`<conv_dir>/.system_generated/tasks/<task_name>.log`).
pub fn resolve_agy_task_log_path(parent_transcript: &Path, task_id: &str) -> Option<PathBuf> {
    let (brain_root, conv_dir) = agy_brain_root_and_conv_dir(parent_transcript)?;
    let (owner_dir, short_id) = match task_id.split_once('/') {
        Some((conv, tid)) if conv.len() == 36 && !tid.contains('/') && !tid.contains("..") => {
            (brain_root.join(conv), tid)
        }
        None if !task_id.is_empty() && !task_id.contains("..") => (conv_dir, task_id),
        _ => return None,
    };
    Some(
        owner_dir
            .join(".system_generated")
            .join("tasks")
            .join(format!("{short_id}.log")),
    )
}

/// Resolves Antigravity child subagent transcript path (`<brain_root>/<child_uuid>/.system_generated/logs/transcript.jsonl`).
pub fn resolve_agy_subagent_transcript(parent_transcript: &Path, child_id: &str) -> Option<PathBuf> {
    if child_id.len() != 36 || child_id.contains('/') || child_id.contains("..") {
        return None;
    }
    let (brain_root, _) = agy_brain_root_and_conv_dir(parent_transcript)?;
    Some(
        brain_root
            .join(child_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

fn load_agy_child_node(path: &Path, child_id: &str) -> Option<AgyChildNode> {
    let (mtime_ms, mtime_ns, len) = metadata_mtime_ms_and_stamp(path)?;
    if let Ok(cache) = AGY_NODE_CACHE.lock()
        && let Some((cm, cl, node)) = cache.get(path)
        && *cm == mtime_ns
        && *cl == len
    {
        return Some(node.clone());
    }

    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut state = AntigravityState::default();
    let mut current_turn = None;
    let mut turns = Vec::new();
    let mut last_val: Option<serde_json::Value> = None;

    loop {
        line.clear();
        let Ok(n) = reader.read_line(&mut line) else {
            break;
        };
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        last_val = Some(val.clone());
        antigravity::parse_line(val, child_id, &mut state, &mut current_turn, &mut turns);
    }

    if let Some(t) = current_turn.take() {
        turns.push(t);
    }

    let mut subagent_groups = Vec::new();
    let mut bg_tasks = Vec::new();
    for t in &turns {
        for ev in &t.events {
            match ev {
                AgentEvent::Subagents { agents, .. } => subagent_groups.push(agents.clone()),
                AgentEvent::BackgroundTasks { tasks } => bg_tasks.extend(tasks.iter().cloned()),
                _ => {}
            }
        }
    }

    let (has_final_reply, has_error, last_rec_ts_ms, last_tokens) = match last_val.as_ref() {
        Some(last) => {
            let final_reply = antigravity_record_is_final_reply(last);
            let err = last.get("status").and_then(|s| s.as_str()) == Some("ERROR");
            let rec_ts = record_timestamp_ms(last).or(Some(mtime_ms));
            let tok = last
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .zip(last.get("output_tokens").and_then(|v| v.as_u64()))
                .map(|(i, o)| i + o);
            (final_reply, err, rec_ts, tok)
        }
        None => (false, false, Some(mtime_ms), None),
    };

    let node = AgyChildNode {
        subagent_groups,
        bg_tasks,
        has_final_reply,
        has_error,
        mtime_ms,
        last_rec_ts_ms,
        last_tokens,
    };

    if let Ok(mut cache) = AGY_NODE_CACHE.lock() {
        if cache.len() >= MAX_AGY_GRAPH_CACHE {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (mtime_ns, len, node.clone()));
    }
    Some(node)
}

fn node_is_within_epoch(node: &AgyChildNode, entry: &SubagentEntry, epoch: SurfaceRunEpoch, now_ms: u64) -> bool {
    let activity_ms = node
        .mtime_ms
        .max(entry.started_at.unwrap_or(0))
        .max(entry.settled_at.unwrap_or(0));
    match epoch {
        SurfaceRunEpoch::LocalNoAgent => false,
        SurfaceRunEpoch::LocalAgentAlive { start_ms, .. } => {
            activity_ms.saturating_add(EPOCH_SKEW_MARGIN_MS) >= start_ms
        }
        SurfaceRunEpoch::RemoteOrUnknown => now_ms.saturating_sub(activity_ms) <= STALE_CHILD_WORK_MS,
    }
}

fn monitor_bg_tasks_alive(
    node: &AgyChildNode,
    parent_transcript: &Path,
    epoch: SurfaceRunEpoch,
    now_ms: u64,
) -> bool {
    let _ = (parent_transcript, now_ms);
    if epoch == SurfaceRunEpoch::LocalNoAgent {
        return false;
    }
    let epoch_start_ms = match epoch {
        SurfaceRunEpoch::LocalAgentAlive { start_ms, .. } => Some(start_ms),
        _ => None,
    };
    node.bg_tasks.iter().any(|t| {
        if t.state != SubagentState::Working {
            return false;
        }
        let started_ok = match (epoch_start_ms, t.started_at) {
            (Some(est), Some(st)) => st.saturating_add(EPOCH_SKEW_MARGIN_MS) >= est,
            (Some(_), None) => node.mtime_ms.saturating_add(EPOCH_SKEW_MARGIN_MS) >= epoch_start_ms.unwrap_or(0),
            _ => true,
        };
        if !started_ok {
            return false;
        }
        matches!(epoch, SurfaceRunEpoch::LocalAgentAlive { has_live_children: true, .. })
            || t.kind == BackgroundTaskKind::Monitor
    })
}

fn format_nested_label(depth: usize, raw_label: &str) -> String {
    if depth == 0 {
        return raw_label.to_string();
    }
    let prefix = "↳".repeat(depth.min(3));
    format!("{prefix} {raw_label}")
}

/// Evaluates whether `entry` (an AGY child conversation) is currently live (including nested subtrees
/// and interim `send_message` coordinators) and returns flattened active-branch descendants to display.
fn evaluate_agy_subtree(
    root_transcript: &Path,
    entry: &mut SubagentEntry,
    epoch: SurfaceRunEpoch,
    now_ms: u64,
    depth: usize,
    visited: &mut HashSet<String>,
) -> Vec<SubagentEntry> {
    if entry.id.len() != 36 || depth >= MAX_AGY_SUBTREE_DEPTH || !visited.insert(entry.id.clone()) {
        return Vec::new();
    }
    let Some(child_path) = resolve_agy_subagent_transcript(root_transcript, &entry.id) else {
        return Vec::new();
    };
    let Some(node) = load_agy_child_node(&child_path, &entry.id) else {
        return Vec::new();
    };

    if let Some(tok) = node.last_tokens {
        entry.tokens = Some(tok);
    }

    let in_epoch = node_is_within_epoch(&node, entry, epoch, now_ms);
    let mut active_descendants: Vec<SubagentEntry> = Vec::new();
    let mut has_live_descendant = false;

    if in_epoch && !matches!(entry.state, SubagentState::Stopped | SubagentState::Failed) {
        for group in &node.subagent_groups {
            let mut evaluated_group: Vec<(SubagentEntry, Vec<SubagentEntry>)> = Vec::new();
            for raw_child in group {
                let mut child = raw_child.clone();
                if matches!(child.state, SubagentState::Stopped | SubagentState::Failed) {
                    evaluated_group.push((child, Vec::new()));
                    continue;
                }
                let nested = evaluate_agy_subtree(
                    root_transcript,
                    &mut child,
                    epoch,
                    now_ms,
                    depth + 1,
                    visited,
                );
                if child.state == SubagentState::Working && nested.is_empty() && child.id.len() != 36 {
                    // Unspawned placeholder inside a child coordinator.
                    let ctx = ChildReconcileContext {
                        now_ms,
                        epoch,
                        session_working: false,
                        has_later_turn: true,
                        next_turn_ts_ms: None,
                        is_historical_page: false,
                    };
                    reconcile_subagent("agy-subagents-nested", &mut child, &ctx, ChildArtifactEvidence::Missing);
                }
                evaluated_group.push((child, nested));
            }

            let group_has_working = evaluated_group
                .iter()
                .any(|(c, n)| c.state == SubagentState::Working || !n.is_empty());
            if !group_has_working {
                continue;
            }
            has_live_descendant = true;
            let is_leaf_wave = evaluated_group.iter().all(|(_, nested)| nested.is_empty());

            for (mut child, nested) in evaluated_group {
                let keep = child.state == SubagentState::Working
                    || !nested.is_empty()
                    || (is_leaf_wave
                        && matches!(
                            child.state,
                            SubagentState::Completed | SubagentState::Failed | SubagentState::Stopped
                        ));
                if keep {
                    child.label = format_nested_label(depth + 1, &child.label);
                    active_descendants.push(child);
                    active_descendants.extend(nested);
                }
            }
        }
    }

    let has_monitors = in_epoch && monitor_bg_tasks_alive(&node, &child_path, epoch, now_ms);
    let wrote_after_provisional_msg = entry
        .settled_at
        .is_some_and(|s| node.mtime_ms > s.saturating_add(SEND_MESSAGE_FINALIZE_GRACE_MS));
    let actively_executing_non_final = !node.has_final_reply
        && !node.has_error
        && now_ms.saturating_sub(node.mtime_ms) <= CHILD_ARTIFACT_QUIET_MS;

    let still_live = in_epoch
        && (has_live_descendant
            || has_monitors
            || actively_executing_non_final
            || (wrote_after_provisional_msg && !node.has_final_reply && !node.has_error));

    if matches!(entry.state, SubagentState::Working | SubagentState::Completed) {
        if still_live {
            entry.state = SubagentState::Working;
            entry.settled_at = None;
        } else if node.has_final_reply {
            entry.state = SubagentState::Completed;
            entry.settled_at = entry
                .settled_at
                .or(node.last_rec_ts_ms)
                .map(|t| entry.started_at.map_or(t, |s| t.max(s)));
        } else if node.has_error {
            entry.state = SubagentState::Failed;
            entry.settled_at = entry
                .settled_at
                .or(node.last_rec_ts_ms)
                .map(|t| entry.started_at.map_or(t, |s| t.max(s)));
        } else if entry.state == SubagentState::Working {
            let evidence = if now_ms.saturating_sub(node.mtime_ms) <= CHILD_ARTIFACT_QUIET_MS && in_epoch {
                ChildArtifactEvidence::Active {
                    last_modified_ms: Some(node.mtime_ms),
                    tokens: node.last_tokens,
                }
            } else {
                ChildArtifactEvidence::Quiet {
                    last_modified_ms: Some(node.mtime_ms),
                    tokens: node.last_tokens,
                }
            };
            let ctx = ChildReconcileContext {
                now_ms,
                epoch,
                session_working: false,
                has_later_turn: true,
                next_turn_ts_ms: None,
                is_historical_page: false,
            };
            reconcile_subagent("agy-subagents-nested", entry, &ctx, evidence);
        }
    }

    active_descendants
}

fn probe_agy_subagent(parent_transcript: &Path, child_id: &str, now_ms: u64) -> ChildArtifactEvidence {
    let Some(path) = resolve_agy_subagent_transcript(parent_transcript, child_id) else {
        return ChildArtifactEvidence::Missing;
    };
    let Some((mtime_ms, _, _)) = metadata_mtime_ms_and_stamp(&path) else {
        return ChildArtifactEvidence::Missing;
    };
    if let Some(last) = last_jsonl_record(path.to_string_lossy().as_ref()) {
        let rec_ts = record_timestamp_ms(&last).or(Some(mtime_ms));
        let tokens = last
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .zip(last.get("output_tokens").and_then(|v| v.as_u64()))
            .map(|(i, o)| i + o);
        if antigravity_record_is_final_reply(&last) {
            return ChildArtifactEvidence::Completed {
                settled_at: rec_ts,
                tokens,
            };
        }
        if last.get("status").and_then(|s| s.as_str()) == Some("ERROR") {
            return ChildArtifactEvidence::Failed {
                settled_at: rec_ts,
                tokens,
            };
        }
        if now_ms.saturating_sub(mtime_ms) <= CHILD_ARTIFACT_QUIET_MS {
            return ChildArtifactEvidence::Active {
                last_modified_ms: Some(mtime_ms),
                tokens,
            };
        }
        return ChildArtifactEvidence::Quiet {
            last_modified_ms: Some(mtime_ms),
            tokens,
        };
    }
    if now_ms.saturating_sub(mtime_ms) <= CHILD_ARTIFACT_QUIET_MS {
        ChildArtifactEvidence::Active {
            last_modified_ms: Some(mtime_ms),
            tokens: None,
        }
    } else {
        ChildArtifactEvidence::Quiet {
            last_modified_ms: Some(mtime_ms),
            tokens: None,
        }
    }
}

fn resolve_claude_subagent_transcript(parent_transcript: &Path, agent_id: &str) -> Option<PathBuf> {
    if agent_id.is_empty() || agent_id.contains('/') || agent_id.contains("..") {
        return None;
    }
    let stem = parent_transcript.file_stem()?.to_str()?;
    let session_dir = parent_transcript.parent()?.join(stem).join("subagents");
    let direct = session_dir.join(format!("agent-{agent_id}.jsonl"));
    if direct.exists() {
        return Some(direct);
    }
    let plain = session_dir.join(format!("{agent_id}.jsonl"));
    plain.exists().then_some(plain)
}

fn probe_claude_subagent(
    parent_transcript: &Path,
    agent_id: &str,
    now_ms: u64,
) -> ChildArtifactEvidence {
    let Some(path) = resolve_claude_subagent_transcript(parent_transcript, agent_id) else {
        return ChildArtifactEvidence::Missing;
    };
    let Some((mtime_ms, mtime_ns, len)) = metadata_mtime_ms_and_stamp(&path) else {
        return ChildArtifactEvidence::Missing;
    };

    let cached = CLAUDE_CHILD_CACHE
        .lock()
        .ok()
        .and_then(|c| c.get(&path).copied())
        .filter(|(cm, cl, _, _)| *cm == mtime_ns && *cl == len);

    let (decided, rec_ts) = if let Some((_, _, d, ts)) = cached {
        (d, ts)
    } else {
        let last = last_jsonl_record(path.to_string_lossy().as_ref());
        let ts = last.as_ref().and_then(record_timestamp_ms).or(Some(mtime_ms));
        let d = last.as_ref().and_then(|v| {
            let t = v.get("type").and_then(|s| s.as_str())?;
            if t == "assistant" {
                let stop = v.pointer("/message/stop_reason").and_then(|s| s.as_str());
                if stop == Some("end_turn") {
                    return Some(true);
                }
            }
            None
        });
        if let Ok(mut cache) = CLAUDE_CHILD_CACHE.lock() {
            if cache.len() >= MAX_ARTIFACT_STAMP_CACHE {
                cache.clear();
            }
            cache.insert(path, (mtime_ns, len, d, ts));
        }
        (d, ts)
    };

    if decided == Some(true) {
        return ChildArtifactEvidence::Completed {
            settled_at: rec_ts,
            tokens: None,
        };
    }
    if now_ms.saturating_sub(mtime_ms) <= CHILD_ARTIFACT_QUIET_MS {
        ChildArtifactEvidence::Active {
            last_modified_ms: Some(mtime_ms),
            tokens: None,
        }
    } else {
        ChildArtifactEvidence::Quiet {
            last_modified_ms: Some(mtime_ms),
            tokens: None,
        }
    }
}

fn probe_codex_subagent(
    parent_transcript: &Path,
    agent_id: &str,
    _now_ms: u64,
) -> ChildArtifactEvidence {
    let (state, tokens) = codex_child_status(parent_transcript, agent_id);
    let settled_ms = codex_child_rollout_stamp(parent_transcript, agent_id)
        .map(|(mtime_ns, _)| (mtime_ns / 1_000_000) as u64);
    match state {
        SubagentState::Completed => ChildArtifactEvidence::Completed {
            settled_at: settled_ms,
            tokens,
        },
        SubagentState::Failed => ChildArtifactEvidence::Failed {
            settled_at: settled_ms,
            tokens,
        },
        SubagentState::Working => ChildArtifactEvidence::Active {
            last_modified_ms: settled_ms,
            tokens,
        },
        _ => match settled_ms {
            Some(ms) => ChildArtifactEvidence::Quiet {
                last_modified_ms: Some(ms),
                tokens,
            },
            None => ChildArtifactEvidence::Missing,
        },
    }
}

fn probe_bg_task_artifact(
    parent_transcript: &Path,
    entry: &BackgroundTaskEntry,
    now_ms: u64,
) -> ChildArtifactEvidence {
    if let Some(log_path) = resolve_agy_task_log_path(parent_transcript, &entry.id)
        && let Some((mtime_ms, _, _)) = metadata_mtime_ms_and_stamp(&log_path)
    {
        if now_ms.saturating_sub(mtime_ms) <= CHILD_ARTIFACT_QUIET_MS {
            return ChildArtifactEvidence::Active {
                last_modified_ms: Some(mtime_ms),
                tokens: None,
            };
        }
        return ChildArtifactEvidence::Quiet {
            last_modified_ms: Some(mtime_ms),
            tokens: None,
        };
    }
    ChildArtifactEvidence::Missing
}

fn should_inspect_agy_subagent(
    entry: &SubagentEntry,
    epoch: SurfaceRunEpoch,
    is_historical_page: bool,
) -> bool {
    if entry.id.len() != 36 {
        return false;
    }
    if entry.state == SubagentState::Working {
        return true;
    }
    // Reopen provisionally Completed AGY subagents only in live views when OS runtime could still own them
    // (long-lived /teamwork coordinators send progress `send_message` updates while children keep running).
    if entry.state == SubagentState::Completed && !is_historical_page {
        return epoch != SurfaceRunEpoch::LocalNoAgent;
    }
    false
}

/// Reconciles all `Working` subagents and background tasks in `turns` against OS process-epoch
/// liveness and on-disk child artifacts, and expands live nested AGY `/teamwork` subtrees.
pub fn reconcile_session_child_work(
    transcript_path: Option<&Path>,
    turns: &mut [AgentTurn],
    epoch: SurfaceRunEpoch,
    session_working: bool,
    is_historical_page: bool,
) {
    let now_ms = now_epoch_ms();

    // First pass: evaluate live AGY subagent transcripts (reopening interim-message coordinators and
    // bubbling active nested descendants such as `/teamwork` orchestrators & wave workers).
    let mut evaluated_agy_ids: HashSet<String> = HashSet::new();
    if let Some(root_path) = transcript_path {
        for turn in turns.iter_mut() {
            for ev in turn.events.iter_mut() {
                let AgentEvent::Subagents { group_id, agents } = ev else {
                    continue;
                };
                if !group_id.starts_with("agy-subagents-") {
                    continue;
                }
                let mut expanded: Vec<SubagentEntry> = Vec::with_capacity(agents.len());
                let mut seen_in_group: HashSet<String> = HashSet::new();
                for orig in agents.drain(..) {
                    let mut entry = orig;
                    let nested = if should_inspect_agy_subagent(&entry, epoch, is_historical_page) {
                        evaluate_agy_subtree(
                            root_path,
                            &mut entry,
                            epoch,
                            now_ms,
                            0,
                            &mut evaluated_agy_ids,
                        )
                    } else {
                        Vec::new()
                    };
                    if seen_in_group.insert(entry.id.clone()) {
                        expanded.push(entry);
                    }
                    for desc in nested {
                        if seen_in_group.insert(desc.id.clone()) {
                            expanded.push(desc);
                        }
                    }
                }
                *agents = expanded;
            }
        }
    }

    let has_any_working = turns.iter().any(|t| {
        t.events.iter().any(|ev| match ev {
            AgentEvent::Subagents { agents, .. } => {
                agents.iter().any(|a| a.state == SubagentState::Working)
            }
            AgentEvent::BackgroundTasks { tasks } => {
                tasks.iter().any(|b| b.state == SubagentState::Working)
            }
            _ => false,
        })
    });
    if !has_any_working {
        return;
    }

    reconcile_turns_with(
        turns,
        now_ms,
        epoch,
        session_working,
        is_historical_page,
        |group_id: &str, agent: &SubagentEntry| {
            let Some(parent) = transcript_path else {
                return ChildArtifactEvidence::Missing;
            };
            if group_id == "codex-subagents" {
                probe_codex_subagent(parent, &agent.id, now_ms)
            } else if group_id.starts_with("agy-subagents-") {
                if evaluated_agy_ids.contains(&agent.id) {
                    // Pass 1 already reconciled this UUID recursively (descendants + monitors);
                    // avoid downgrading coordinator turns back to single-file `Completed`.
                    ChildArtifactEvidence::Active {
                        last_modified_ms: Some(now_ms),
                        tokens: agent.tokens,
                    }
                } else {
                    probe_agy_subagent(parent, &agent.id, now_ms)
                }
            } else if group_id == "claude-subagents" {
                probe_claude_subagent(parent, &agent.id, now_ms)
            } else {
                ChildArtifactEvidence::Missing
            }
        },
        |task: &BackgroundTaskEntry| match transcript_path {
            Some(parent) => probe_bg_task_artifact(parent, task, now_ms),
            None => ChildArtifactEvidence::Missing,
        },
    );
}

/// Extracts currently-active subagent groups (preserving sibling entries within any turn whose
/// group contains at least one `Working` subagent) and active `Working` background tasks across
/// reconciled turns so live UI trays reflect long-running child work even when its spawning turn
/// predates the `max_turns` tail page.
pub fn extract_active_child_work(
    earlier_child_turns: &[AgentTurn],
    tail_turns: &[AgentTurn],
) -> (Vec<SubagentEntry>, Vec<BackgroundTaskEntry>) {
    let mut active_subagent_map: HashMap<String, usize> = HashMap::new();
    let mut active_subagents: Vec<SubagentEntry> = Vec::new();
    let mut active_bg_map: HashMap<String, usize> = HashMap::new();
    let mut active_bg_tasks: Vec<BackgroundTaskEntry> = Vec::new();

    for turn in earlier_child_turns.iter().chain(tail_turns.iter()) {
        for ev in &turn.events {
            match ev {
                AgentEvent::Subagents { agents, .. } => {
                    if !agents.iter().any(|a| a.state == SubagentState::Working) {
                        continue;
                    }
                    for a in agents {
                        if let Some(&idx) = active_subagent_map.get(&a.id) {
                            active_subagents[idx] = a.clone();
                        } else {
                            active_subagent_map.insert(a.id.clone(), active_subagents.len());
                            active_subagents.push(a.clone());
                        }
                    }
                }
                AgentEvent::BackgroundTasks { tasks } => {
                    for t in tasks {
                        if t.state != SubagentState::Working {
                            continue;
                        }
                        if let Some(&idx) = active_bg_map.get(&t.id) {
                            active_bg_tasks[idx] = t.clone();
                        } else {
                            active_bg_map.insert(t.id.clone(), active_bg_tasks.len());
                            active_bg_tasks.push(t.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    }

    (active_subagents, active_bg_tasks)
}

/// Computes a compact fingerprint over `epoch` and any currently-working child artifacts so
/// `chat_watcher_stream` detects child completion or process exit even when the parent transcript
/// file has not been written.
pub fn working_children_stamp(
    transcript_path: Option<&Path>,
    subagent_ids: &[(String, String)],
    bg_task_ids: &[String],
    epoch: SurfaceRunEpoch,
) -> String {
    let mut parts = vec![format!("{epoch:?}")];
    if let Some(parent) = transcript_path {
        for (group_id, id) in subagent_ids {
            if group_id == "codex-subagents" {
                if let Some((m, l)) = codex_child_rollout_stamp(parent, id) {
                    parts.push(format!("cx:{id}:{m}:{l}"));
                }
            } else if group_id.starts_with("agy-subagents-") {
                if let Some(p) = resolve_agy_subagent_transcript(parent, id)
                    && let Some((_, m, l)) = metadata_mtime_ms_and_stamp(&p)
                {
                    parts.push(format!("ag:{id}:{m}:{l}"));
                }
            } else if group_id == "claude-subagents"
                && let Some(p) = resolve_claude_subagent_transcript(parent, id)
                && let Some((_, m, l)) = metadata_mtime_ms_and_stamp(&p)
            {
                parts.push(format!("cl:{id}:{m}:{l}"));
            }
        }
        for tid in bg_task_ids {
            if let Some(p) = resolve_agy_task_log_path(parent, tid)
                && let Some((_, m, l)) = metadata_mtime_ms_and_stamp(&p)
            {
                parts.push(format!("bg:{tid}:{m}:{l}"));
            }
        }
    }
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::transcript::TranscriptReader;
    use std::io::Write;

    #[test]
    fn reconciles_real_agy_quota_aborted_background_task_and_child_subagent_on_disk() {
        let root = std::env::temp_dir().join(format!("cmob-agy-reconcile-{}", uuid::Uuid::new_v4()));
        let conv_id = "a95fc438-67a1-4923-b027-c67bb9be9393";
        let child_id = "b1111111-2222-3333-4444-555555555555";

        let parent_logs = root.join(conv_id).join(".system_generated").join("logs");
        let parent_tasks = root.join(conv_id).join(".system_generated").join("tasks");
        let child_logs = root.join(child_id).join(".system_generated").join("logs");
        fs::create_dir_all(&parent_logs).unwrap();
        fs::create_dir_all(&parent_tasks).unwrap();
        fs::create_dir_all(&child_logs).unwrap();

        let task_log = parent_tasks.join("task-264.log");
        fs::write(&task_log, "Starting MatchMove Slack sync...\n").unwrap();
        let task_log_mtime_ms = metadata_mtime_ms_and_stamp(&task_log).unwrap().0;

        let child_transcript = child_logs.join("transcript.jsonl");
        fs::write(
            &child_transcript,
            "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-11-25T07:12:00Z\",\"input_tokens\":1000,\"output_tokens\":250,\"content\":\"Subagent done.\"}\n",
        )
        .unwrap();

        let parent_transcript = parent_logs.join("transcript.jsonl");
        let mut f = fs::File::create(&parent_transcript).unwrap();
        for line in [
            r#"{"step_index":261,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-11-25T07:09:52Z","content":"<USER_REQUEST>\nsync tin nhắn\n</USER_REQUEST>"}"#,
            r#"{"step_index":263,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-25T07:09:53Z","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"make sync-slack-mm\"","toolSummary":"\"Sync MatchMove Slack messages\""}},{"name":"invoke_subagent","args":{"TypeName":"\"research\"","Role":"\"Slack Auditor\"","Prompt":"\"Check threads\""}}]}"#,
            r#"{"step_index":264,"source":"MODEL","type":"GENERIC","status":"RUNNING","created_at":"2026-11-25T07:10:01Z","content":"Tool is running as a background task with task id: a95fc438-67a1-4923-b027-c67bb9be9393/task-264\nTask Description: make sync-slack-mm"}"#,
            r#"{"step_index":265,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-25T07:10:02Z","content":"Created the following subagent: {\"conversationId\": \"b1111111-2222-3333-4444-555555555555\"}"}"#,
            r#"{"step_index":266,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-11-25T07:10:22Z","content":"<USER_REQUEST>\ncontinue\n</USER_REQUEST>"}"#,
            r#"{"step_index":285,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-25T07:16:44Z","content":"Đã đồng bộ Slack xong."}"#,
        ] {
            writeln!(f, "{line}").unwrap();
        }
        drop(f);

        let mut turns = TranscriptReader::read_recent_turns(&parent_transcript, "surf-mm", 20).unwrap();
        // Raw transcript parse leaves `task-264` and `child_id` in `Working` because no `SYSTEM_MESSAGE` wakeup arrived.
        reconcile_session_child_work(
            Some(&parent_transcript),
            &mut turns,
            SurfaceRunEpoch::LocalAgentAlive {
                pid: 48078,
                start_ms: now_epoch_ms().saturating_add(60_000), // Current PID started in a newer epoch
                has_live_children: false,
            },
            false,
            false,
        );

        let bg_state = turns[1]
            .events
            .iter()
            .find_map(|ev| match ev {
                AgentEvent::BackgroundTasks { tasks } => Some(tasks[0].clone()),
                _ => None,
            })
            .expect("background task present");
        assert_eq!(bg_state.state, SubagentState::Unverifiable);
        assert_eq!(bg_state.settled_at, Some(task_log_mtime_ms));

        let sub_state = turns[1]
            .events
            .iter()
            .find_map(|ev| match ev {
                AgentEvent::Subagents { agents, .. } => Some(agents[0].clone()),
                _ => None,
            })
            .expect("subagent present");
        assert_eq!(sub_state.state, SubagentState::Completed);
        assert_eq!(sub_state.tokens, Some(1250));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reopens_long_lived_teamwork_coordinator_after_progress_messages_and_surfaces_active_leaf_wave() {
        let root = std::env::temp_dir().join(format!("cmob-teamwork-tree-{}", uuid::Uuid::new_v4()));
        let caller_id = "d6a63b8f-7e66-47a4-b0e6-47da24283521";
        let coord_id = "cc7f9ac4-7f59-416d-8867-e491d1b9b009";
        let orch_id = "7e0e20b8-ced6-49d7-a80a-2e02b1d622c1";
        let sub_orch_id = "083a9f1a-9a31-4341-8373-568d8f402e25";
        let old_worker_id = "7924c877-5124-4552-9000-000000000001";
        let icons_id = "0bdbd7ed-0a11-4093-80ca-c90bc873353d";
        let data_id = "a5ef50bf-f95f-42f6-b4db-8d2c92f61888";

        for id in [caller_id, coord_id, orch_id, sub_orch_id, old_worker_id, icons_id, data_id] {
            fs::create_dir_all(root.join(id).join(".system_generated").join("logs")).unwrap();
        }
        let transcript_of = |id: &str| {
            root.join(id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl")
        };

        // Leaf 1 (`old_worker_id`): finished in earlier phase -> MUST NOT clutter caller view.
        fs::write(
            transcript_of(old_worker_id),
            "{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-11-26T14:00:00Z\",\"content\":\"Phase 1 done.\"}\n",
        )
        .unwrap();

        // Leaf 2 (`w2b_icons`): finished in current active wave -> keep as completed sibling alongside `w2b_data`.
        fs::write(
            transcript_of(icons_id),
            "{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"2026-11-26T18:13:35Z\",\"content\":\"96/96 SVG icons done.\"}\n",
        )
        .unwrap();

        // Leaf 3 (`w2b_data`): actively running right now (`tool_calls` in flight, mtime = now).
        fs::write(
            transcript_of(data_id),
            "{\"step_index\":1,\"type\":\"SYSTEM_MESSAGE\",\"status\":\"DONE\",\"content\":\"Build data modules\"}\n{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"tool_calls\":[{\"name\":\"write_file\",\"args\":{\"Path\":\"\\\"a.ts\\\"\"}}]}\n",
        )
        .unwrap();

        // Level 3 (`sub_orch_phase2b`): spawned `w2b_icons` (completed via SYSTEM_MESSAGE) & `w2b_data` (active).
        let mut f_sub = fs::File::create(transcript_of(sub_orch_id)).unwrap();
        for l in [
            r#"{"step_index":1,"type":"SYSTEM_MESSAGE","status":"DONE","content":"Run Phase 2B"}"#,
            r#"{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{"TypeName":"\"teamwork_worker\"","Role":"\"Wave 2B-2A Icons Worker\""}},{"name":"invoke_subagent","args":{"TypeName":"\"teamwork_worker\"","Role":"\"Wave 2B-2A Data/i18n Worker\""}}]}"#,
            &format!(r#"{{"step_index":3,"type":"GENERIC","status":"DONE","content":"Created the following subagent: {{\"conversationId\": \"{icons_id}\"}}"}}"#),
            &format!(r#"{{"step_index":4,"type":"GENERIC","status":"DONE","content":"Created the following subagent: {{\"conversationId\": \"{data_id}\"}}"}}"#),
            &format!(r#"{{"step_index":5,"type":"SYSTEM_MESSAGE","status":"DONE","content":"[Message] sender={icons_id} content=Done icons"}}"#),
            r#"{"step_index":6,"type":"PLANNER_RESPONSE","status":"DONE","content":"Waiting for `w2b_data` to finish Wave 2B-2A."}"#,
        ] {
            writeln!(f_sub, "{l}").unwrap();
        }
        drop(f_sub);

        // Level 2 (`orch`): finished Phase 1 worker + active Phase 2B sub-orch.
        let mut f_orch = fs::File::create(transcript_of(orch_id)).unwrap();
        for l in [
            r#"{"step_index":1,"type":"SYSTEM_MESSAGE","status":"DONE","content":"Orchestrate"}"#,
            r#"{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{"TypeName":"\"self\"","Role":"\"Phase 1 Backend Sub-Orch\""}},{"name":"invoke_subagent","args":{"TypeName":"\"self\"","Role":"\"Phase 2B Shell Sub-Orch\""}}]}"#,
            &format!(r#"{{"step_index":3,"type":"GENERIC","status":"DONE","content":"Created the following subagent: {{\"conversationId\": \"{old_worker_id}\"}}"}}"#),
            &format!(r#"{{"step_index":4,"type":"GENERIC","status":"DONE","content":"Created the following subagent: {{\"conversationId\": \"{sub_orch_id}\"}}"}}"#),
            &format!(r#"{{"step_index":5,"type":"SYSTEM_MESSAGE","status":"DONE","content":"[Message] sender={old_worker_id} content=Phase 1 done"}}"#),
            r#"{"step_index":6,"type":"PLANNER_RESPONSE","status":"DONE","content":"Phase 2B running."}"#,
        ] {
            writeln!(f_orch, "{l}").unwrap();
        }
        drop(f_orch);

        // Level 1 (`coord_id` `/teamwork` sentinel): sent progress message & waits for updates.
        let mut f_coord = fs::File::create(transcript_of(coord_id)).unwrap();
        for l in [
            r#"{"step_index":1,"type":"SYSTEM_MESSAGE","status":"DONE","content":"Run teamwork"}"#,
            r#"{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{"TypeName":"\"teamwork_orchestrator\"","Role":"\"Project Orchestrator\""}}]}"#,
            &format!(r#"{{"step_index":3,"type":"GENERIC","status":"DONE","content":"Created the following subagent: {{\"conversationId\": \"{orch_id}\"}}"}}"#),
            r#"{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","content":"Cron 1 tick 4 sent to caller. Waiting for updates."}"#,
        ] {
            writeln!(f_coord, "{l}").unwrap();
        }
        drop(f_coord);

        // Root caller (`d6a63b8f`): invoked `coord_id`, then received multiple progress `SYSTEM_MESSAGE`s!
        let caller_transcript = transcript_of(caller_id);
        let mut f_caller = fs::File::create(&caller_transcript).unwrap();
        for l in [
            r#"{"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-11-26T10:36:32Z","content":"<USER_REQUEST>\ntiếp theo là luyennoi.com\n</USER_REQUEST>"}"#,
            r#"{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-26T13:14:37Z","tool_calls":[{"name":"invoke_subagent","args":{"TypeName":"\"teamwork\"","Role":"\"Luyennoi Team\""}}]}"#,
            &format!(r#"{{"step_index":3,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-26T13:15:09Z","content":"Created the following subagent: {{\"conversationId\": \"{coord_id}\"}}"}}"#),
            &format!(r#"{{"step_index":4,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-11-26T18:14:09Z","content":"[Message] timestamp=2026-11-26T18:14:09Z sender={coord_id} priority=MESSAGE_PRIORITY_HIGH content=Progress update (Cron 1 — Tick 4)"}}"#),
            r#"{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-26T18:14:09Z","content":"Cập nhật tiến độ Teamwork Run..."}"#,
        ] {
            writeln!(f_caller, "{l}").unwrap();
        }
        drop(f_caller);

        let mut turns = TranscriptReader::read_recent_turns(&caller_transcript, "surf-en", 20).unwrap();
        // Raw parse marked `coord_id` Completed at step 4.
        let now_ms = now_epoch_ms();
        reconcile_session_child_work(
            Some(&caller_transcript),
            &mut turns,
            SurfaceRunEpoch::LocalAgentAlive {
                pid: 60534,
                start_ms: now_ms.saturating_sub(60 * 60 * 1_000), // Started 1h ago; child transcripts wrote now.
                has_live_children: false,
            },
            false,
            false,
        );

        let agents = turns[1]
            .events
            .iter()
            .find_map(|ev| match ev {
                AgentEvent::Subagents { agents, .. } => Some(agents.clone()),
                _ => None,
            })
            .expect("reopened teamwork tree present");

        let by_id: HashMap<&str, &SubagentEntry> = agents.iter().map(|a| (a.id.as_str(), a)).collect();
        assert_eq!(by_id.get(coord_id).map(|a| a.state), Some(SubagentState::Working));
        assert_eq!(by_id.get(orch_id).map(|a| a.state), Some(SubagentState::Working));
        assert_eq!(by_id.get(sub_orch_id).map(|a| a.state), Some(SubagentState::Working));
        assert_eq!(by_id.get(icons_id).map(|a| a.state), Some(SubagentState::Completed));
        assert_eq!(by_id.get(data_id).map(|a| a.state), Some(SubagentState::Working));
        assert!(!by_id.contains_key(old_worker_id), "finished earlier-phase workers should not clutter active subtree");
        assert_eq!(by_id.get(data_id).map(|a| a.label.as_str()), Some("↳↳↳ Wave 2B-2A Data/i18n Worker"));

        // If the parent OS process actually dies (`LocalNoAgent`), the entire nested tree settles cleanly!
        reconcile_session_child_work(
            Some(&caller_transcript),
            &mut turns,
            SurfaceRunEpoch::LocalNoAgent,
            false,
            false,
        );
        let dead_agents = turns[1]
            .events
            .iter()
            .find_map(|ev| match ev {
                AgentEvent::Subagents { agents, .. } => Some(agents.clone()),
                _ => None,
            })
            .unwrap();
        assert!(
            dead_agents.iter().all(|a| a.state != SubagentState::Working),
            "dead host epoch must settle every node cleanly"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
