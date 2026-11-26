//! Shared turn construction, subagent/background-task folding, and detail truncation helpers.

use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, BackgroundTaskEntry, SubagentEntry,
};

/// Max characters of a tool `detail` sent to clients.
pub const MAX_DETAIL_CHARS: usize = 4000;

/// Truncate `detail` on a char boundary, marking the cut so the UI is not misled.
pub fn cap_detail(s: String) -> String {
    if s.chars().count() <= MAX_DETAIL_CHARS {
        return s;
    }
    let mut out: String = s.chars().take(MAX_DETAIL_CHARS).collect();
    out.push_str("… [truncated]");
    out
}

pub fn payload_text(v: &serde_json::Value) -> String {
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

pub fn start_user_turn_with_ts(
    text: String,
    ts_ms: Option<u64>,
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
    turn.timestamp = ts_ms;
    turn.events.push(AgentEvent::User { text });
    turns.push(turn);
}

pub fn assistant_turn<'a>(
    surface_id: &str,
    current_turn: &'a mut Option<AgentTurn>,
    turns: &[AgentTurn],
) -> &'a mut AgentTurn {
    current_turn.get_or_insert_with(|| {
        AgentTurn::new(
            format!("turn-{}", turns.len() + 1),
            surface_id,
            AgentRole::Assistant,
        )
    })
}

pub fn push_system_divider(
    label: &str,
    ts_ms: Option<u64>,
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
    turn.timestamp = ts_ms;
    turn.events.push(AgentEvent::Status {
        text: label.to_string(),
    });
    turns.push(turn);
}

/// Appends `"Interrupted"` status to the open assistant turn (closing it) or as a deduplicated System turn.
pub fn emit_interrupted_status(
    ts_ms: Option<u64>,
    surface_id: &str,
    current_turn: &mut Option<AgentTurn>,
    turns: &mut Vec<AgentTurn>,
) {
    if let Some(mut t) = current_turn.take() {
        let already = matches!(
            t.events.last(),
            Some(AgentEvent::Status { text }) if text == "Interrupted"
        );
        if !already {
            t.events.push(AgentEvent::Status {
                text: "Interrupted".to_string(),
            });
        }
        turns.push(t);
    } else {
        push_system_divider("Interrupted", ts_ms, surface_id, current_turn, turns);
    }
}

pub fn settle_open_thinking(
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

pub fn push_subagent_to_turn(turn: &mut AgentTurn, group_id: &str, entry: SubagentEntry) {
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

pub fn mutate_subagent_by_ids(
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

pub fn push_bg_task_to_turn(turn: &mut AgentTurn, entry: BackgroundTaskEntry) {
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

pub fn mutate_bg_task_by_ids(
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
