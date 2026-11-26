//! Post-projection reconciler connecting `crate::domain::child_work_fsm` to on-disk child artifacts
//! (Antigravity `tasks/task-N.log` + subagent `transcript.jsonl`, Claude subagent `.jsonl`, and Codex
//! child rollouts) without mutating `CachedTranscript` inside `jsonl_window`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::child_work_fsm::{
    reconcile_turns_with, ChildArtifactEvidence, SurfaceRunEpoch, CHILD_ARTIFACT_QUIET_MS,
};
use crate::domain::noise_filter::record_timestamp_ms;
use crate::protocol::event::{
    AgentEvent, AgentTurn, BackgroundTaskEntry, SubagentEntry, SubagentState,
};
use crate::providers::{codex_child_rollout_stamp, codex_child_status};
use crate::scanner::hook_store::{antigravity_record_is_final_reply, last_jsonl_record};

const MAX_ARTIFACT_STAMP_CACHE: usize = 512;

type ClaudeChildCacheEntry = (u128, u64, Option<bool>, Option<u64>);

/// Lightweight `(mtime_ns, len) -> ChildArtifactEvidence` cache for Claude subagent `.jsonl` tails.
static CLAUDE_CHILD_CACHE: LazyLock<Mutex<HashMap<PathBuf, ClaudeChildCacheEntry>>> =
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

/// Reconciles all `Working` subagents and background tasks in `turns` against OS process-epoch
/// liveness and on-disk child artifacts. Runs in `O(working_items)` outside `CachedTranscript`.
pub fn reconcile_session_child_work(
    transcript_path: Option<&Path>,
    turns: &mut [AgentTurn],
    epoch: SurfaceRunEpoch,
    session_working: bool,
    is_historical_page: bool,
) {
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

    let now_ms = now_epoch_ms();
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
                probe_agy_subagent(parent, &agent.id, now_ms)
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
}
