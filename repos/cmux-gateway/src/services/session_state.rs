//! Unified session resolution and surface-ref canonicalization.

use std::collections::HashSet;
use std::path::Path;

use crate::domain::child_work_fsm::SurfaceRunEpoch;
use crate::domain::lifecycle::derive_awaiting_prompt_from_parts;
use crate::protocol::event::{AgentLifecycleState, AgentTurn};
use crate::scanner::child_reconciler::{extract_active_child_work, reconcile_session_child_work};
use crate::scanner::hook_store::{HookSessionRecord, HookStoreIndex};
use crate::scanner::kiro_store::KiroSessionIndex;
use crate::scanner::opencode_store;
use crate::scanner::transcript::{TranscriptPage, TranscriptReader};
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;
use crate::server::AppState;

/// A transcript-backed agent session resolved for a surface.
#[derive(Debug, Clone)]
pub struct ResolvedSession {
    pub session_id: String,
    pub surface_id: String,
    pub agent_kind: String,
    pub transcript_path: Option<String>,
    pub lifecycle: AgentLifecycleState,
    pub last_event: Option<String>,
    pub last_subtitle: Option<String>,
    pub last_body: Option<String>,
    pub tool_name: Option<String>,
    /// Live activity derived from active tool execution (OpenCode SQLite / Kiro transcript).
    pub live_activity: Option<String>,
    /// OS process run-epoch for the surface's controlling TTY (backing child-work FSM reconciliation).
    pub epoch: SurfaceRunEpoch,
    /// Resolved through the cmux tree rather than the hook store.
    pub from_tree: bool,
}

pub struct SessionStateService;

impl SessionStateService {
    /// Canonicalizes `surface:N` refs to their durable cmux surface UUID when known.
    pub async fn canonicalize_surface_id(state: &AppState, raw_id: &str) -> String {
        if raw_id.is_empty() || !raw_id.starts_with("surface:") {
            return raw_id.to_string();
        }
        if let Some(cached) = state.runtime.resolve_cached_surface_ref(raw_id) {
            return cached;
        }
        let hook_index = HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
        if let Ok(Some(surf)) = WorkspaceTreeBuilder::get_surface_in(
            &state.cmux_bridge,
            &hook_index,
            raw_id,
            &state.runtime,
        )
        .await
        {
            return surf.id;
        }
        raw_id.to_string()
    }

    fn kind_matches_live(live_kinds: &HashSet<&'static str>, raw_kind: &str) -> bool {
        if live_kinds.is_empty() {
            return false;
        }
        if raw_kind == "agent" {
            return true;
        }
        let canonical = crate::cmux::agents::spec_for(raw_kind)
            .map(|s| s.kind)
            .unwrap_or(raw_kind);
        live_kinds.contains(canonical)
    }

    pub async fn resolve_session(
        state: &AppState,
        raw_surface_id: &str,
        session_id: &str,
    ) -> Option<ResolvedSession> {
        Self::resolve_session_inner(state, raw_surface_id, session_id, true).await
    }

    pub async fn resolve_session_raw(
        state: &AppState,
        raw_surface_id: &str,
        session_id: &str,
    ) -> Option<ResolvedSession> {
        Self::resolve_session_inner(state, raw_surface_id, session_id, false).await
    }

    async fn resolve_session_inner(
        state: &AppState,
        raw_surface_id: &str,
        session_id: &str,
        check_liveness: bool,
    ) -> Option<ResolvedSession> {
        let surface_id = Self::canonicalize_surface_id(state, raw_surface_id).await;
        let sid_owned = surface_id.clone();
        let req_session_id = session_id.to_string();
        let runtime = state.runtime.clone();

        // Coalesce HookStore scan, TTY liveness check, transcript tail lifecycle, and OpenCode SQLite
        // status into a single blocking hop instead of 3-4 sequential thread-pool round-trips.
        let (hook_index, live_kinds, hook_resolved) = tokio::task::spawn_blocking(move || {
            let hook_index = HookStoreIndex::scan_dir(&HookStoreIndex::default_cmuxterm_dir());
            let live_kinds = if check_liveness && !sid_owned.is_empty() {
                runtime.surface_live_agent_kinds(&sid_owned)
            } else {
                None
            };

            let hook_record = if !req_session_id.is_empty() {
                hook_index.sessions_by_id.get(&req_session_id).filter(|rec| {
                    if !check_liveness || sid_owned.is_empty() || rec.surface_id != sid_owned {
                        return true;
                    }
                    live_kinds
                        .as_ref()
                        .is_none_or(|kinds| Self::kind_matches_live(kinds, rec.resolved_agent_kind()))
                })
            } else {
                hook_index.get_active_session_for_surface_filtered(&sid_owned, live_kinds.as_ref())
            };

            let resolved = hook_record.map(|rec| {
                let mut lifecycle = if check_liveness {
                    rec.live_lifecycle_with_liveness(live_kinds.as_ref().map(|k| !k.is_empty()))
                } else {
                    rec.resolved_lifecycle()
                };
                if check_liveness
                    && matches!(lifecycle, AgentLifecycleState::Working | AgentLifecycleState::Waiting)
                    && live_kinds.as_ref().is_some_and(HashSet::is_empty)
                {
                    lifecycle = AgentLifecycleState::Idle;
                }

                let canonical_kind = crate::cmux::agents::spec_for(rec.resolved_agent_kind())
                    .map(|s| s.kind)
                    .unwrap_or_else(|| rec.resolved_agent_kind())
                    .to_string();

                let mut last_subtitle = rec.last_subtitle.clone();
                let mut live_activity = None;

                if canonical_kind == "opencode"
                    && lifecycle != AgentLifecycleState::Waiting
                    && let Some(path) = rec.transcript_path.as_deref()
                    && let Some(st) = opencode_store::status_for_path(Path::new(path))
                {
                    lifecycle = st.lifecycle;
                    if lifecycle == AgentLifecycleState::Working {
                        last_subtitle = st.last_subtitle.clone();
                        live_activity = st.last_subtitle;
                    }
                }

                ResolvedSession {
                    session_id: rec.session_id.clone(),
                    surface_id: rec.surface_id.clone(),
                    agent_kind: canonical_kind,
                    transcript_path: rec.transcript_path.clone(),
                    lifecycle,
                    last_event: rec.hook_event_name.clone(),
                    last_subtitle,
                    last_body: rec.last_body.clone(),
                    tool_name: rec.tool_name.clone(),
                    live_activity,
                    epoch: runtime.surface_run_epoch(&rec.surface_id),
                    from_tree: false,
                }
            });

            (hook_index, live_kinds, resolved)
        })
        .await
        .ok()?;

        if let Some(resolved) = hook_resolved {
            return Some(resolved);
        }

        if surface_id.is_empty() {
            return None;
        }

        let surface = WorkspaceTreeBuilder::get_surface_in(
            &state.cmux_bridge,
            &hook_index,
            &surface_id,
            &state.runtime,
        )
        .await
        .ok()
        .flatten()?;
        let agent = surface.agent?;
        let path = agent.transcript_path.clone()?;
        let path_for_kiro = path.clone();
        let kiro_status = if agent.agent_kind == "kiro" {
            tokio::task::spawn_blocking(move || {
                KiroSessionIndex::analyze_file(Path::new(&path_for_kiro))
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        };
        let (mut lifecycle, subtitle, live_activity) = match kiro_status {
            Some(s) => {
                let act = (s.lifecycle == AgentLifecycleState::Working)
                    .then(|| s.last_subtitle.clone())
                    .flatten();
                (s.lifecycle, s.last_subtitle, act)
            }
            None => (
                match agent.status.as_str() {
                    "running" => AgentLifecycleState::Working,
                    "waiting" => AgentLifecycleState::Waiting,
                    "error" => AgentLifecycleState::Error,
                    _ => AgentLifecycleState::Idle,
                },
                None,
                None,
            ),
        };
        if check_liveness
            && matches!(lifecycle, AgentLifecycleState::Working | AgentLifecycleState::Waiting)
            && live_kinds.as_ref().is_some_and(HashSet::is_empty)
        {
            lifecycle = AgentLifecycleState::Idle;
        }

        let epoch = state.runtime.surface_run_epoch(&surface.id);
        Some(ResolvedSession {
            session_id: agent.session_id,
            surface_id: surface.id,
            agent_kind: agent.agent_kind,
            transcript_path: Some(path),
            lifecycle,
            last_event: None,
            last_subtitle: subtitle,
            last_body: None,
            tool_name: None,
            live_activity,
            epoch,
            from_tree: true,
        })
    }

    pub fn derive_awaiting_prompt(
        res: &ResolvedSession,
        turns: &[AgentTurn],
        screen_context: Option<&str>,
    ) -> Option<String> {
        derive_awaiting_prompt_from_parts(
            res.lifecycle,
            res.last_event.as_deref(),
            res.last_body.as_deref(),
            res.last_subtitle.as_deref(),
            res.tool_name.as_deref(),
            turns,
            screen_context,
        )
    }

    pub fn empty_session_json(surface_id: &str, agent_kind: &str) -> serde_json::Value {
        serde_json::json!({
            "session_id": "",
            "surface_id": surface_id,
            "agent_kind": agent_kind,
            "is_working": false,
            "lifecycle_state": "ready",
            "last_event": serde_json::Value::Null,
            "last_subtitle": "Ready for prompt",
            "awaiting_prompt": serde_json::Value::Null,
            "turns": []
        })
    }

    pub fn session_json_with_turns(
        res: &ResolvedSession,
        max_turns: usize,
        before_offset: Option<u64>,
        screen_context: Option<&str>,
    ) -> Result<(serde_json::Value, TranscriptPage), std::io::Error> {
        let mut page = match &res.transcript_path {
            Some(p) => {
                TranscriptReader::read_turns_page(Path::new(p), &res.surface_id, max_turns, before_offset)?
            }
            None => TranscriptPage {
                turns: Vec::new(),
                earlier_child_turns: Vec::new(),
                has_more: false,
                before_offset: None,
                total_turns: 0,
            },
        };
        let session_working =
            matches!(res.lifecycle, AgentLifecycleState::Working | AgentLifecycleState::Waiting);
        if before_offset.is_none() && !page.earlier_child_turns.is_empty() {
            let earlier_len = page.earlier_child_turns.len();
            let mut combined = std::mem::take(&mut page.earlier_child_turns);
            combined.append(&mut page.turns);
            reconcile_session_child_work(
                res.transcript_path.as_deref().map(Path::new),
                &mut combined,
                res.epoch,
                session_working,
                false,
            );
            page.turns = combined.split_off(earlier_len);
            page.earlier_child_turns = combined;
        } else {
            reconcile_session_child_work(
                res.transcript_path.as_deref().map(Path::new),
                &mut page.turns,
                res.epoch,
                session_working,
                before_offset.is_some(),
            );
        }
        let (active_subagents, active_background_tasks) = if before_offset.is_none() {
            extract_active_child_work(&page.earlier_child_turns, &page.turns)
        } else {
            (Vec::new(), Vec::new())
        };
        let activity = (res.lifecycle == AgentLifecycleState::Working)
            .then(|| res.live_activity.clone())
            .flatten();
        let awaiting_prompt = if before_offset.is_none() {
            Self::derive_awaiting_prompt(res, &page.turns, screen_context)
        } else {
            None
        };
        let mut val = serde_json::json!({
            "update_kind": "snapshot",
            "activity": activity,
            "session_id": res.session_id,
            "surface_id": res.surface_id,
            "agent_kind": res.agent_kind,
            "is_working": res.lifecycle == AgentLifecycleState::Working,
            "lifecycle_state": res.lifecycle,
            "last_event": res.last_event,
            "last_subtitle": res.last_subtitle,
            "awaiting_prompt": awaiting_prompt,
            "has_more": page.has_more,
            "before_offset": page.before_offset,
            "total_turns": page.total_turns,
            "turns": page.turns
        });
        if before_offset.is_none()
            && let Some(obj) = val.as_object_mut()
        {
            obj.insert(
                "active_subagents".into(),
                serde_json::to_value(&active_subagents).unwrap_or_default(),
            );
            obj.insert(
                "active_background_tasks".into(),
                serde_json::to_value(&active_background_tasks).unwrap_or_default(),
            );
        }
        Ok((val, page))
    }

    pub fn is_dialog_waiting(state: &AppState, surface_id: &str) -> bool {
        state.runtime.is_dialog_waiting(surface_id)
    }

    pub async fn startup_dialog_value(state: &AppState, surface_id: &str) -> serde_json::Value {
        match state.cmux_bridge.current_dialog(Some(surface_id)).await {
            Some(d) => {
                state
                    .runtime
                    .set_dialog_waiting(surface_id, Some(&d.fingerprint));
                serde_json::json!({
                    "kind": d.kind.label(),
                    "title": d.title,
                    "description": d.description,
                    "fingerprint": d.fingerprint,
                    "aimed": !d.choices.is_empty(),
                    "choices": d.choices.iter().map(|c| serde_json::json!({ "label": c.label })).collect::<Vec<_>>(),
                })
            }
            None => {
                state.runtime.set_dialog_waiting(surface_id, None);
                serde_json::Value::Null
            }
        }
    }

    pub fn collect_notification_sessions(
        runtime: &crate::scanner::liveness::WorkspaceRuntimeStore,
    ) -> Vec<HookSessionRecord> {
        crate::services::notification_sources::collect_notification_sessions(runtime)
    }
}
