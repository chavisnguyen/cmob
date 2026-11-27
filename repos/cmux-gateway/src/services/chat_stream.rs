//! Live chat transcript subscription manager & `turn_digest`-driven delta watcher.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::domain::canonical_turn::turn_digest;
use crate::domain::dialog::extract_approval_screen_context;
use crate::io::file_watch::TranscriptFileWatcher;
use crate::protocol::event::{AgentEvent, AgentLifecycleState, AgentTurn, SubagentState};
use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_CHAT_UNSUBSCRIBE};
use crate::scanner::kiro_store::KiroSessionIndex;
use crate::scanner::opencode_store;
use crate::server::AppState;
use crate::services::session_state::{ResolvedSession, SessionStateService};

pub const MAX_SUBSCRIPTIONS: usize = 8;
pub const EVENT_CHAT_UPDATE: &str = "mobile.chat.update";

pub fn handle_subscription(
    req: &JsonRpcRequest,
    state: &AppState,
    out_tx: &mpsc::Sender<String>,
    subs: &mut HashMap<String, JoinHandle<()>>,
) -> JsonRpcResponse {
    let Some(raw_surface_id) = req
        .params
        .get("surface_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Missing surface_id parameter"),
        );
    };
    let canonical_key = state
        .runtime
        .resolve_cached_surface_ref(&raw_surface_id)
        .unwrap_or_else(|| raw_surface_id.clone());

    if let Some(old) = subs.remove(&canonical_key) {
        old.abort();
    }
    if canonical_key != raw_surface_id
        && let Some(old_raw) = subs.remove(&raw_surface_id)
    {
        old_raw.abort();
    }

    if req.method == METHOD_CHAT_UNSUBSCRIBE {
        return JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "unsubscribed": true, "surface_id": canonical_key }),
        )
        .unwrap();
    }

    if subs.len() >= MAX_SUBSCRIPTIONS {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params(format!(
                "Too many subscriptions (max {MAX_SUBSCRIPTIONS} per connection)"
            )),
        );
    }

    let session_id = req.params.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let agent_kind = req.params.get("agent_kind").and_then(|v| v.as_str()).unwrap_or("agent").to_string();
    let max_turns = req.params.get("max_turns").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize;
    let delta_mode = req.params.pointer("/capabilities/delta").and_then(|v| v.as_bool()).unwrap_or(false);

    let handle = tokio::spawn(chat_watcher_stream(
        state.clone(),
        out_tx.clone(),
        canonical_key.clone(),
        session_id,
        agent_kind,
        max_turns,
        delta_mode,
    ));
    subs.insert(canonical_key.clone(), handle);

    JsonRpcResponse::result(
        req.id.clone(),
        serde_json::json!({ "subscribed": true, "surface_id": canonical_key, "event": EVENT_CHAT_UPDATE }),
    )
    .unwrap()
}

fn collect_working_children(
    earlier_child_turns: &[AgentTurn],
    turns: &[AgentTurn],
) -> (bool, Vec<(String, String)>, Vec<String>) {
    let mut any_working = false;
    let mut subagent_ids = Vec::new();
    let mut bg_task_ids = Vec::new();
    for turn in earlier_child_turns.iter().chain(turns.iter()) {
        for ev in &turn.events {
            match ev {
                AgentEvent::Subagents { group_id, agents } => {
                    for entry in agents {
                        if entry.state == SubagentState::Working {
                            any_working = true;
                            if !entry.id.is_empty() {
                                subagent_ids.push((group_id.clone(), entry.id.clone()));
                            }
                        }
                    }
                }
                AgentEvent::BackgroundTasks { tasks } => {
                    for t in tasks {
                        if t.state == SubagentState::Working {
                            any_working = true;
                            if !t.id.is_empty() {
                                bg_task_ids.push(t.id.clone());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    (any_working, subagent_ids, bg_task_ids)
}

async fn fingerprint(
    res: &Option<ResolvedSession>,
    working_subagents: &[(String, String)],
    working_bg_tasks: &[String],
) -> String {
    let Some(r) = res else { return "none".to_string() };
    let transcript_stamp = match r.transcript_path.as_deref() {
        Some(p) if opencode_store::parse_pseudo_path(Path::new(p)).is_some() => {
            let p_owned = p.to_string();
            tokio::task::spawn_blocking(move || opencode_store::change_token_for_path(Path::new(&p_owned)))
                .await
                .ok()
                .flatten()
                .unwrap_or_default()
        }
        Some(p) => tokio::fs::metadata(p)
            .await
            .ok()
            .map(|m| {
                let t = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                format!("{t}|{}", m.len())
            })
            .unwrap_or_else(|| "0|0".to_string()),
        None => "0|0".to_string(),
    };
    let child_stamp = if !working_subagents.is_empty() || !working_bg_tasks.is_empty() {
        let parent = r.transcript_path.clone();
        let subs = working_subagents.to_vec();
        let bgs = working_bg_tasks.to_vec();
        let epoch = r.epoch;
        tokio::task::spawn_blocking(move || {
            crate::scanner::child_reconciler::working_children_stamp(
                parent.as_deref().map(Path::new),
                &subs,
                &bgs,
                epoch,
            )
        })
        .await
        .unwrap_or_default()
    } else {
        format!("{:?}", r.epoch)
    };
    format!(
        "{}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}|{transcript_stamp}|{child_stamp}",
        r.session_id, r.lifecycle, r.last_event, r.last_subtitle, r.last_body, r.tool_name, r.live_activity
    )
}

pub fn apply_delta_or_snapshot(
    snap_val: &mut serde_json::Value,
    turns: &[AgentTurn],
    prev_digests: &[(String, u64)],
    next_digests: &[(String, u64)],
    delta_mode: bool,
) {
    if !delta_mode
        || prev_digests.is_empty()
        || turns.is_empty()
        || turns.len() < prev_digests.len()
        || turns[0].id != prev_digests[0].0
    {
        return;
    }
    let first_mismatch = (0..prev_digests.len()).find(|&i| next_digests[i] != prev_digests[i]);
    let diff_idx = first_mismatch.unwrap_or(prev_digests.len());
    if diff_idx >= 1 {
        let anchor_id = &prev_digests[diff_idx - 1].0;
        let tail_turns = turns[diff_idx..].to_vec();
        if let Some(obj) = snap_val.as_object_mut() {
            obj.remove("turns");
            obj.insert("update_kind".into(), serde_json::json!("delta"));
            obj.insert("after_turn_id".into(), serde_json::json!(anchor_id));
            obj.insert("tail_turns".into(), serde_json::to_value(tail_turns).unwrap_or_default());
        }
    }
}

#[cfg(test)]
pub async fn chat_watcher(
    state: AppState,
    out_tx: mpsc::Sender<String>,
    surface_id: String,
    session_id: String,
    fallback_agent: String,
    max_turns: usize,
) {
    chat_watcher_stream(state, out_tx, surface_id, session_id, fallback_agent, max_turns, false).await;
}

pub async fn chat_watcher_stream(
    state: AppState,
    out_tx: mpsc::Sender<String>,
    raw_surface_id: String,
    session_id: String,
    fallback_agent: String,
    max_turns: usize,
    delta_mode: bool,
) {
    const TICK: Duration = Duration::from_millis(500);
    const TREE_REFRESH: Duration = Duration::from_secs(3);
    const DIALOG_POLL: Duration = Duration::from_secs(2);
    const SUBAGENT_REFRESH: Duration = Duration::from_secs(2);

    let mut file_watcher = TranscriptFileWatcher::new();
    let mut watched_transcript_path: Option<std::path::PathBuf> = None;
    let mut last_fp: Option<String> = None;
    let mut cached_tree: Option<(ResolvedSession, Instant)> = None;
    let mut dialog: (serde_json::Value, Option<Instant>) = (serde_json::Value::Null, None);
    let mut approval_screen: (Option<String>, Option<Instant>) = (None, None);
    let mut is_first_tick = true;
    let mut prev_digests: Vec<(String, u64)> = Vec::new();
    let mut prev_earlier_digests: Vec<(String, u64)> = Vec::new();
    let mut working_subagents: Vec<(String, String)> = Vec::new();
    let mut working_bg_tasks: Vec<String> = Vec::new();
    let mut has_working_subagents = false;
    let mut last_subagent_poll = Instant::now();

    loop {
        let first_tick = std::mem::replace(&mut is_first_tick, false);
        if !first_tick {
            let max_wait = match watched_transcript_path.as_deref() {
                Some(p) if opencode_store::parse_pseudo_path(p).is_some() => {
                    Duration::from_millis(250)
                }
                _ => TICK,
            };
            file_watcher
                .wait_for_change(watched_transcript_path.as_deref(), max_wait)
                .await;
        }

        let resolved = match cached_tree.as_ref().filter(|(_, at)| at.elapsed() < TREE_REFRESH) {
            Some((r, _)) => {
                let mut r = r.clone();
                r.epoch = state.runtime.surface_run_epoch(&r.surface_id);
                if let Some(p) = &r.transcript_path
                    && r.agent_kind == "kiro"
                {
                    let p_owned = p.clone();
                    if let Ok(Some(s)) = tokio::task::spawn_blocking(move || {
                        KiroSessionIndex::analyze_file(Path::new(&p_owned))
                    })
                    .await
                    {
                        r.lifecycle = s.lifecycle;
                        r.last_subtitle = s.last_subtitle.clone();
                        r.live_activity = (s.lifecycle == AgentLifecycleState::Working)
                            .then_some(s.last_subtitle)
                            .flatten();
                    }
                }
                Some(r)
            }
            None => {
                let r = SessionStateService::resolve_session(&state, &raw_surface_id, &session_id).await;
                cached_tree = r.clone().filter(|r| r.from_tree).map(|r| (r, Instant::now()));
                r
            }
        };

        let target_surface_id = resolved
            .as_ref()
            .map(|r| r.surface_id.clone())
            .unwrap_or_else(|| raw_surface_id.clone());
        watched_transcript_path = resolved
            .as_ref()
            .and_then(|r| r.transcript_path.as_deref())
            .map(std::path::PathBuf::from);
        let has_transcript = watched_transcript_path.is_some();
        let known_dialog_waiting = state.runtime.is_dialog_waiting(&target_surface_id);
        let defer_screen_probes = first_tick && has_transcript && !known_dialog_waiting;

        let working = resolved.as_ref().is_some_and(|r| r.lifecycle == AgentLifecycleState::Working);
        if working {
            dialog = (serde_json::Value::Null, None);
            state.runtime.set_dialog_waiting(&target_surface_id, None);
        } else if !defer_screen_probes && dialog.1.is_none_or(|at| at.elapsed() >= DIALOG_POLL) {
            dialog = (
                SessionStateService::startup_dialog_value(&state, &target_surface_id).await,
                Some(Instant::now()),
            );
        }

        let waiting = resolved.as_ref().is_some_and(|r| r.lifecycle == AgentLifecycleState::Waiting);
        if !waiting {
            approval_screen = (None, None);
        } else if !defer_screen_probes && approval_screen.1.is_none_or(|at| at.elapsed() >= DIALOG_POLL) {
            let extracted = state
                .cmux_bridge
                .capture_pane(Some(&target_surface_id), 35, false)
                .await
                .ok()
                .as_deref()
                .and_then(extract_approval_screen_context);
            approval_screen = (extracted, Some(Instant::now()));
        }

        let dialog_fp = dialog.0.get("fingerprint").and_then(|f| f.as_str()).unwrap_or("");
        let screen_fp = approval_screen.0.as_deref().unwrap_or("");
        let fp = format!(
            "{}|{dialog_fp}|{screen_fp}",
            fingerprint(&resolved, &working_subagents, &working_bg_tasks).await
        );
        // Re-check every 2s whenever any child item is still `Working` (even if parent turn paused/died),
        // then drop to 0% idle kqueue sleep immediately once `has_working_subagents` becomes false.
        let force_subagent_check =
            has_working_subagents && last_subagent_poll.elapsed() >= SUBAGENT_REFRESH;

        if last_fp.as_deref() == Some(fp.as_str()) && !force_subagent_check {
            continue;
        }
        if force_subagent_check {
            last_subagent_poll = Instant::now();
        }

        let payload = match resolved {
            Some(res) => {
                let screen_ctx = approval_screen.0.clone();
                let built = tokio::task::spawn_blocking(move || {
                    SessionStateService::session_json_with_turns(&res, max_turns, None, screen_ctx.as_deref())
                })
                .await;
                let Ok(Ok((mut snap_val, page))) = built else { continue };
                let (any_working, sub_ids, bg_ids) =
                    collect_working_children(&page.earlier_child_turns, &page.turns);
                has_working_subagents = any_working;
                working_subagents = sub_ids;
                working_bg_tasks = bg_ids;

                let next_digests: Vec<(String, u64)> =
                    page.turns.iter().map(|t| (t.id.clone(), turn_digest(t))).collect();
                let next_earlier_digests: Vec<(String, u64)> = page
                    .earlier_child_turns
                    .iter()
                    .map(|t| (t.id.clone(), turn_digest(t)))
                    .collect();
                if last_fp.as_deref() == Some(fp.as_str())
                    && next_digests == prev_digests
                    && next_earlier_digests == prev_earlier_digests
                {
                    continue;
                }
                apply_delta_or_snapshot(&mut snap_val, &page.turns, &prev_digests, &next_digests, delta_mode);
                prev_digests = next_digests;
                prev_earlier_digests = next_earlier_digests;
                snap_val
            }
            None => {
                has_working_subagents = false;
                working_subagents.clear();
                working_bg_tasks.clear();
                prev_digests.clear();
                prev_earlier_digests.clear();
                SessionStateService::empty_session_json(&target_surface_id, &fallback_agent)
            }
        };

        let mut payload = payload;
        payload["startup_dialog"] = dialog.0.clone();
        last_fp = Some(fp);

        let frame = JsonRpcResponse::event_value(EVENT_CHAT_UPDATE, payload);
        let Ok(text) = serde_json::to_string(&frame) else { continue };
        if out_tx.send(text).await.is_err() {
            return;
        }
    }
}
