//! Pure Monotonic Finite State Machine (FSM) for Child Work (`SubagentEntry` & `BackgroundTaskEntry`).
//!
//! Grounded in Orca's child-work legality & reconciliation rules:
//! - `ref/orca/src/shared/agent-status/child-work/agent-status-child-work-legality.ts:25-56`
//! - `ref/orca/src/shared/agent-status/child-work/agent-status-child-work-reconciliation.ts:103-176`
//! - `ref/orca/src/shared/native-chat/input/native-chat-background-task-row.ts:10-47`
//! - `ref/orca/src/shared/agent-status/contracts/agent-status-freshness.ts:3-7`
//!
//! State lattice:
//! - In-flight: `SubagentState::Working`
//! - Settled (terminal, monotonic — never regresses to `Working` within the same invocation):
//!   `Completed | Failed | Stopped | Idle | Unverifiable`

use crate::protocol::event::{
    AgentEvent, AgentTurn, BackgroundTaskEntry, BackgroundTaskKind, SubagentEntry, SubagentState,
};

/// Tolerance between kernel `pbi_start_tvsec` (1s floor) and JSONL `created_at` (ms).
pub const EPOCH_SKEW_MARGIN_MS: u64 = 2_000;

/// Staleness bound matching Orca `AGENT_STATUS_STALE_AFTER_MS` (30 minutes) when OS epoch is unavailable.
pub const STALE_CHILD_WORK_MS: u64 = 30 * 60 * 1_000;

/// Quiet threshold for non-daemon child artifacts when parent turn has already moved on.
pub const CHILD_ARTIFACT_QUIET_MS: u64 = 60_000;

/// Kernel process-tree epoch observed for a terminal surface's controlling TTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceRunEpoch {
    /// Local TTY inspected and a leaf coding-agent process is alive.
    LocalAgentAlive {
        pid: u32,
        /// Process start timestamp in epoch milliseconds (`pbi_start_tvsec * 1000`).
        start_ms: u64,
        /// True when `pid` owns at least one non-ambient-helper descendant process in the OS PPID tree.
        has_live_children: bool,
    },
    /// Local TTY inspected and no coding-agent process (nor remote SSH shell) is running on it.
    LocalNoAgent,
    /// Remote SSH/Mosh session or OS process table unavailable — never assume local PID death.
    RemoteOrUnknown,
}

/// Direct evidence probed from a child's own on-disk artifact (`transcript.jsonl`, `task-N.log`, rollout).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildArtifactEvidence {
    /// Child artifact proves successful completion.
    Completed {
        settled_at: Option<u64>,
        tokens: Option<u64>,
    },
    /// Child artifact proves failure.
    Failed {
        settled_at: Option<u64>,
        tokens: Option<u64>,
    },
    /// Artifact was modified within `CHILD_ARTIFACT_QUIET_MS`.
    Active {
        last_modified_ms: Option<u64>,
        tokens: Option<u64>,
    },
    /// Artifact exists on disk and has not been written for more than `CHILD_ARTIFACT_QUIET_MS`.
    Quiet {
        last_modified_ms: Option<u64>,
        tokens: Option<u64>,
    },
    /// No child artifact file exists (or path is unknown).
    Missing,
}

impl ChildArtifactEvidence {
    pub fn artifact_timestamp_ms(self) -> Option<u64> {
        match self {
            Self::Completed { settled_at, .. } | Self::Failed { settled_at, .. } => settled_at,
            Self::Active {
                last_modified_ms, ..
            }
            | Self::Quiet {
                last_modified_ms, ..
            } => last_modified_ms,
            Self::Missing => None,
        }
    }

    pub fn tokens(self) -> Option<u64> {
        match self {
            Self::Completed { tokens, .. }
            | Self::Failed { tokens, .. }
            | Self::Active { tokens, .. }
            | Self::Quiet { tokens, .. } => tokens,
            Self::Missing => None,
        }
    }
}

/// Per-turn context supplied to the pure child-work state machine.
#[derive(Debug, Clone, Copy)]
pub struct ChildReconcileContext {
    pub now_ms: u64,
    pub epoch: SurfaceRunEpoch,
    /// True when the parent session's live lifecycle is `Working` or `Waiting`.
    pub session_working: bool,
    /// True when at least one subsequent turn exists after the turn containing this item.
    pub has_later_turn: bool,
    /// Timestamp of the next turn (if any), used only as a bounded fallback when artifact mtime is absent.
    pub next_turn_ts_ms: Option<u64>,
    /// True when serving a paginated historical slice (`before_offset.is_some()`).
    pub is_historical_page: bool,
}

/// Returns true for ambient helper daemons (`cmux hooks`, MCP stdio servers) that stay attached to an
/// idle `agy` / `claude` parent for the whole session and must not count as active background shell jobs.
pub fn is_ambient_helper_process(command: &str) -> bool {
    let lower = command.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    if lower.contains("cmux hooks ") || lower.contains("--chrome-native-host") {
        return true;
    }
    // Match `mcp` as a standalone word/segment (`agent-desktop mcp`, `mcp-jenkins`, `mcp_server`, `/mcp`).
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| tok == "mcp")
}

/// Returns true when a TTY's foreground/session command is a remote shell (`ssh`, `mosh`, `et`),
/// meaning the actual coding agent runs on a remote kernel invisible to local `libproc`.
pub fn is_remote_shell_command(command: &str) -> bool {
    let mut parts = command.split_whitespace();
    let Some(first) = parts.next() else {
        return false;
    };
    let bin = first.rsplit('/').next().unwrap_or(first).to_ascii_lowercase();
    if matches!(bin.as_str(), "ssh" | "mosh" | "mosh-client" | "et") {
        return true;
    }
    if bin == "tailscale" {
        return parts
            .next()
            .is_some_and(|sub| sub.eq_ignore_ascii_case("ssh"));
    }
    false
}

/// True when an Antigravity subagent entry still carries its pre-spawn placeholder ID (`<type>-<ev>-<idx>`)
/// rather than a 36-char UUID (crash/quota abort between `PLANNER_RESPONSE` and `GENERIC`).
pub fn is_unspawned_agy_placeholder(group_id: &str, agent_id: &str) -> bool {
    group_id.starts_with("agy-subagents-") && agent_id.len() != 36
}

fn clamp_settled_at(started_at: Option<u64>, candidate: Option<u64>) -> Option<u64> {
    match (started_at, candidate) {
        (Some(start), Some(end)) => Some(end.max(start)),
        (None, Some(end)) => Some(end),
        _ => None,
    }
}

fn settle_timestamp(
    started_at: Option<u64>,
    artifact: ChildArtifactEvidence,
    ctx: &ChildReconcileContext,
) -> Option<u64> {
    let from_artifact = artifact.artifact_timestamp_ms();
    let fallback = from_artifact.or_else(|| {
        // Only use `next_turn_ts_ms` if it is reasonably close (<= 30m) so a user returning 32h later
        // never stamps a 32h duration onto a command that died immediately before the pause.
        match (started_at, ctx.next_turn_ts_ms) {
            (Some(s), Some(nt)) if nt >= s && nt.saturating_sub(s) <= STALE_CHILD_WORK_MS => {
                Some(nt)
            }
            _ => None,
        }
    });
    clamp_settled_at(started_at, fallback)
}

fn spawned_in_prior_epoch(started_at: Option<u64>, epoch_start_ms: u64) -> bool {
    started_at.is_some_and(|s| s.saturating_add(EPOCH_SKEW_MARGIN_MS) < epoch_start_ms)
}

/// Pure monotonic FSM transition for a single `SubagentEntry`.
pub fn reconcile_subagent(
    group_id: &str,
    entry: &mut SubagentEntry,
    ctx: &ChildReconcileContext,
    artifact: ChildArtifactEvidence,
) {
    if let Some(tok) = artifact.tokens() {
        entry.tokens = Some(tok);
    }
    if entry.state != SubagentState::Working {
        return;
    }

    // 1. Definite child artifact outcome always wins.
    match artifact {
        ChildArtifactEvidence::Completed { settled_at, .. } => {
            entry.state = SubagentState::Completed;
            entry.settled_at = clamp_settled_at(entry.started_at, settled_at).or(entry.settled_at);
            return;
        }
        ChildArtifactEvidence::Failed { settled_at, .. } => {
            entry.state = SubagentState::Failed;
            entry.settled_at = clamp_settled_at(entry.started_at, settled_at).or(entry.settled_at);
            return;
        }
        ChildArtifactEvidence::Active { .. } => {
            // Child transcript is actively being written right now — stay Working unless local TTY has no agent at all.
            if ctx.epoch != SurfaceRunEpoch::LocalNoAgent {
                return;
            }
        }
        ChildArtifactEvidence::Quiet { .. } | ChildArtifactEvidence::Missing => {}
    }

    // 2. Unspawned AGY placeholder (aborted before `GENERIC` assigned a child conversation UUID).
    if is_unspawned_agy_placeholder(group_id, &entry.id)
        && (ctx.has_later_turn || !ctx.session_working || ctx.is_historical_page)
    {
        entry.state = SubagentState::Unverifiable;
        entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
        return;
    }

    // 3. OS Process Run-Epoch boundary.
    match ctx.epoch {
        SurfaceRunEpoch::LocalNoAgent => {
            entry.state = SubagentState::Unverifiable;
            entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
        }
        SurfaceRunEpoch::LocalAgentAlive { start_ms, .. } => {
            if spawned_in_prior_epoch(entry.started_at, start_ms) {
                entry.state = SubagentState::Unverifiable;
                entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
                return;
            }
            // In current epoch, if child artifact is Quiet/Missing and parent session is idle/moved on:
            if matches!(
                artifact,
                ChildArtifactEvidence::Quiet { .. } | ChildArtifactEvidence::Missing
            ) && (!ctx.session_working || ctx.is_historical_page)
            {
                let age_ms = entry
                    .started_at
                    .map(|s| ctx.now_ms.saturating_sub(s))
                    .unwrap_or(u64::MAX);
                if matches!(artifact, ChildArtifactEvidence::Quiet { .. })
                    || age_ms > CHILD_ARTIFACT_QUIET_MS
                    || ctx.is_historical_page
                {
                    entry.state = SubagentState::Unverifiable;
                    entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
                }
            }
        }
        SurfaceRunEpoch::RemoteOrUnknown => {
            let age_ms = entry
                .started_at
                .map(|s| ctx.now_ms.saturating_sub(s))
                .unwrap_or(u64::MAX);
            let stale_idle = !ctx.session_working && age_ms > STALE_CHILD_WORK_MS;
            if ctx.is_historical_page
                || stale_idle
                || (matches!(artifact, ChildArtifactEvidence::Quiet { .. }) && !ctx.session_working)
            {
                entry.state = SubagentState::Unverifiable;
                entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
            }
        }
    }
}

/// Pure monotonic FSM transition for a single `BackgroundTaskEntry`.
pub fn reconcile_bg_task(
    entry: &mut BackgroundTaskEntry,
    ctx: &ChildReconcileContext,
    artifact: ChildArtifactEvidence,
) {
    if let Some(tok) = artifact.tokens() {
        entry.tokens = Some(tok);
    }
    if entry.state != SubagentState::Working {
        return;
    }

    match artifact {
        ChildArtifactEvidence::Completed { settled_at, .. } => {
            entry.state = SubagentState::Completed;
            entry.settled_at = clamp_settled_at(entry.started_at, settled_at).or(entry.settled_at);
            return;
        }
        ChildArtifactEvidence::Failed { settled_at, .. } => {
            entry.state = SubagentState::Failed;
            entry.settled_at = clamp_settled_at(entry.started_at, settled_at).or(entry.settled_at);
            return;
        }
        _ => {}
    }

    match ctx.epoch {
        SurfaceRunEpoch::LocalNoAgent => {
            entry.state = SubagentState::Unverifiable;
            entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
        }
        SurfaceRunEpoch::LocalAgentAlive {
            start_ms,
            has_live_children,
            ..
        } => {
            // Prior OS process epoch: guaranteed no longer attached to the old agent instance.
            if spawned_in_prior_epoch(entry.started_at, start_ms) {
                entry.state = SubagentState::Unverifiable;
                entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
                return;
            }

            // Current OS epoch: if `has_live_children` is true (e.g. `IsDaemon: true` dev server on child PTY),
            // NEVER mark it dead even if its log has been quiet for hours across many turns!
            if has_live_children {
                return;
            }

            // `has_live_children == false`: the agent owns zero non-helper child processes right now.
            // Settle once the launching turn has moved on, the session is idle, or the log has gone quiet.
            if ctx.has_later_turn
                || !ctx.session_working
                || ctx.is_historical_page
                || matches!(artifact, ChildArtifactEvidence::Quiet { .. })
            {
                entry.state = SubagentState::Unverifiable;
                entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
            }
        }
        SurfaceRunEpoch::RemoteOrUnknown => {
            // Cannot inspect remote kernel PPIDs: never kill `Monitor` daemons on quiet logs alone,
            // only bound non-daemon tasks by staleness when session is idle or paginated history.
            let age_ms = entry
                .started_at
                .map(|s| ctx.now_ms.saturating_sub(s))
                .unwrap_or(u64::MAX);
            let stale_idle = !ctx.session_working && age_ms > STALE_CHILD_WORK_MS;
            let hist_non_daemon =
                ctx.is_historical_page && entry.kind != BackgroundTaskKind::Monitor && ctx.has_later_turn;
            if stale_idle || hist_non_daemon {
                entry.state = SubagentState::Unverifiable;
                entry.settled_at = settle_timestamp(entry.started_at, artifact, ctx);
            }
        }
    }
}

/// Applies the child-work FSM across a slice of `AgentTurn`s, invoking `probe_subagent` and
/// `probe_bg_task` ONLY for entries still in `SubagentState::Working` (`O(working_items)`).
pub fn reconcile_turns_with(
    turns: &mut [AgentTurn],
    now_ms: u64,
    epoch: SurfaceRunEpoch,
    session_working: bool,
    is_historical_page: bool,
    mut probe_subagent: impl FnMut(&str, &SubagentEntry) -> ChildArtifactEvidence,
    mut probe_bg_task: impl FnMut(&BackgroundTaskEntry) -> ChildArtifactEvidence,
) {
    let len = turns.len();
    // Pre-collect next-turn timestamps so we can borrow `turns[idx]` mutably cleanly.
    let next_timestamps: Vec<Option<u64>> = (0..len)
        .map(|i| turns.get(i + 1..).and_then(|rest| rest.iter().find_map(|t| t.timestamp)))
        .collect();

    for (idx, turn) in turns.iter_mut().enumerate() {
        let ctx = ChildReconcileContext {
            now_ms,
            epoch,
            session_working,
            has_later_turn: idx + 1 < len,
            next_turn_ts_ms: next_timestamps[idx],
            is_historical_page,
        };
        for ev in turn.events.iter_mut() {
            match ev {
                AgentEvent::Subagents { group_id, agents } => {
                    for agent in agents.iter_mut() {
                        if agent.state == SubagentState::Working {
                            let evidence = probe_subagent(group_id.as_str(), agent);
                            reconcile_subagent(group_id.as_str(), agent, &ctx, evidence);
                        }
                    }
                }
                AgentEvent::BackgroundTasks { tasks } => {
                    for task in tasks.iter_mut() {
                        if task.state == SubagentState::Working {
                            let evidence = probe_bg_task(task);
                            reconcile_bg_task(task, &ctx, evidence);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::event::AgentRole;

    fn bg_entry(id: &str, kind: BackgroundTaskKind, started_at: Option<u64>) -> BackgroundTaskEntry {
        BackgroundTaskEntry {
            id: id.to_string(),
            kind,
            label: "Sync MatchMove Slack messages".to_string(),
            state: SubagentState::Working,
            summary: None,
            tokens: None,
            started_at,
            settled_at: None,
        }
    }

    #[test]
    fn filters_ambient_mcp_and_cmux_helpers_but_keeps_user_jobs() {
        assert!(is_ambient_helper_process(
            "/Applications/cmux.app/Contents/Resources/bin/cmux hooks claude inbox-wait"
        ));
        assert!(is_ambient_helper_process("/Users/chavis/.gear/bin/agent-desktop mcp"));
        assert!(is_ambient_helper_process(
            "/opt/homebrew/bin/uv tool uvx mcp-jenkins --read-only"
        ));
        assert!(is_ambient_helper_process(
            "python /Users/chavis/.local/bin/mcp-proxy-for-aws https://aws-mcp.example/mcp"
        ));
        assert!(!is_ambient_helper_process(
            "node /opt/homebrew/bin/pnpm run dev --host 127.0.0.1"
        ));
        assert!(!is_ambient_helper_process("make sync-slack-mm"));
    }

    #[test]
    fn recognizes_remote_ssh_and_mosh_shells() {
        assert!(is_remote_shell_command("ssh chavis@linux-machine"));
        assert!(is_remote_shell_command("/usr/bin/mosh-client root@10.0.0.2"));
        assert!(is_remote_shell_command("tailscale ssh box-1"));
        assert!(!is_remote_shell_command("/bin/zsh -l"));
        assert!(!is_remote_shell_command("node scripts/ssh-helper.js"));
    }

    #[test]
    fn settles_prior_epoch_zombie_to_unverifiable_with_artifact_mtime_and_never_resurrects() {
        let mut task = bg_entry("conv/task-264", BackgroundTaskKind::Command, Some(1_000_000));
        let ctx_even_during_later_working_turn = ChildReconcileContext {
            now_ms: 118_000_000, // 32.5h later
            epoch: SurfaceRunEpoch::LocalAgentAlive {
                pid: 48078,
                start_ms: 80_000_000, // Restarted hours after task-264
                has_live_children: true, // Even if a NEW command is running in the new epoch!
            },
            session_working: true,
            has_later_turn: true,
            next_turn_ts_ms: Some(1_022_000),
            is_historical_page: false,
        };
        reconcile_bg_task(
            &mut task,
            &ctx_even_during_later_working_turn,
            ChildArtifactEvidence::Quiet {
                last_modified_ms: Some(1_003_000),
                tokens: None,
            },
        );
        assert_eq!(task.state, SubagentState::Unverifiable);
        assert_eq!(task.settled_at, Some(1_003_000));
    }

    #[test]
    fn keeps_daemon_working_across_many_turns_and_quiet_logs_while_child_pid_lives() {
        let mut daemon = bg_entry("conv/task-3768", BackgroundTaskKind::Monitor, Some(10_000_000));
        let ctx = ChildReconcileContext {
            now_ms: 25_000_000, // 4+ hours later!
            epoch: SurfaceRunEpoch::LocalAgentAlive {
                pid: 50864,
                start_ms: 9_000_000,
                has_live_children: true, // `pnpm run dev` on child PTY ttys013 is alive!
            },
            session_working: false,
            has_later_turn: true,
            next_turn_ts_ms: Some(11_000_000),
            is_historical_page: false,
        };
        reconcile_bg_task(
            &mut daemon,
            &ctx,
            ChildArtifactEvidence::Quiet {
                last_modified_ms: Some(10_005_000),
                tokens: None,
            },
        );
        assert_eq!(daemon.state, SubagentState::Working);
        assert_eq!(daemon.settled_at, None);
    }

    #[test]
    fn respects_1s_kernel_tvsec_rounding_skew_margin() {
        // `pbi_start_tvsec * 1000` can sit up to ~1s ahead/behind sub-second JSONL stamp.
        let mut task = bg_entry("conv/task-1", BackgroundTaskKind::Command, Some(10_000_200));
        let ctx = ChildReconcileContext {
            now_ms: 10_005_000,
            epoch: SurfaceRunEpoch::LocalAgentAlive {
                pid: 9001,
                start_ms: 10_001_000, // Within EPOCH_SKEW_MARGIN_MS (2000ms)
                has_live_children: true,
            },
            session_working: true,
            has_later_turn: false,
            next_turn_ts_ms: None,
            is_historical_page: false,
        };
        reconcile_bg_task(&mut task, &ctx, ChildArtifactEvidence::Missing);
        assert_eq!(task.state, SubagentState::Working);
    }

    #[test]
    fn settles_unspawned_agy_placeholder_and_upgrades_completed_child_artifact() {
        let mut turns = vec![
            AgentTurn {
                id: "t1".into(),
                surface_id: "s1".into(),
                role: AgentRole::Assistant,
                timestamp: Some(5_000_000),
                events: vec![AgentEvent::Subagents {
                    group_id: "agy-subagents-t1".into(),
                    agents: vec![
                        SubagentEntry {
                            id: "research-2-0".into(), // Crashed before `GENERIC` UUID!
                            label: "Aborted Researcher".into(),
                            state: SubagentState::Working,
                            tokens: None,
                            started_at: Some(5_000_000),
                            settled_at: None,
                        },
                        SubagentEntry {
                            id: "11111111-2222-3333-4444-555555555555".into(),
                            label: "Finished Researcher".into(),
                            state: SubagentState::Working,
                            tokens: None,
                            started_at: Some(5_000_000),
                            settled_at: None,
                        },
                    ],
                }],
            },
            AgentTurn {
                id: "t2".into(),
                surface_id: "s1".into(),
                role: AgentRole::User,
                timestamp: Some(5_015_000),
                events: vec![AgentEvent::User {
                    text: "continue".into(),
                }],
            },
        ];

        reconcile_turns_with(
            &mut turns,
            5_020_000,
            SurfaceRunEpoch::LocalAgentAlive {
                pid: 100,
                start_ms: 4_000_000,
                has_live_children: false,
            },
            false,
            false,
            |_gid, agent| {
                if agent.id.len() == 36 {
                    ChildArtifactEvidence::Completed {
                        settled_at: Some(5_012_000),
                        tokens: Some(9_400),
                    }
                } else {
                    ChildArtifactEvidence::Missing
                }
            },
            |_| ChildArtifactEvidence::Missing,
        );

        let AgentEvent::Subagents { agents, .. } = &turns[0].events[0] else {
            panic!("expected subagents event");
        };
        assert_eq!(agents[0].state, SubagentState::Unverifiable);
        assert_eq!(agents[0].settled_at, Some(5_015_000));
        assert_eq!(agents[1].state, SubagentState::Completed);
        assert_eq!(agents[1].settled_at, Some(5_012_000));
        assert_eq!(agents[1].tokens, Some(9_400));
    }

    #[test]
    fn remote_unknown_epoch_preserves_fresh_work_and_bounds_32h_stale_idle() {
        let mut fresh = bg_entry("conv/task-fresh", BackgroundTaskKind::Command, Some(50_000_000));
        let fresh_ctx = ChildReconcileContext {
            now_ms: 50_010_000,
            epoch: SurfaceRunEpoch::RemoteOrUnknown,
            session_working: false,
            has_later_turn: false,
            next_turn_ts_ms: None,
            is_historical_page: false,
        };
        reconcile_bg_task(&mut fresh, &fresh_ctx, ChildArtifactEvidence::Missing);
        assert_eq!(fresh.state, SubagentState::Working);

        let mut stale = bg_entry("conv/task-stale", BackgroundTaskKind::Command, Some(1_000_000));
        let stale_ctx = ChildReconcileContext {
            now_ms: 120_000_000,
            epoch: SurfaceRunEpoch::RemoteOrUnknown,
            session_working: false,
            has_later_turn: true,
            next_turn_ts_ms: None,
            is_historical_page: false,
        };
        reconcile_bg_task(&mut stale, &stale_ctx, ChildArtifactEvidence::Missing);
        assert_eq!(stale.state, SubagentState::Unverifiable);
        assert_eq!(stale.settled_at, None);
    }
}
