//! Structural `AgentTurn` digesting for live delta streaming and Antigravity argument normalization.

use crate::protocol::event::{
    AgentEvent, AgentRole, AgentTurn, AskQuestionItem, AwaitingInput, BackgroundTaskKind,
    SubagentState,
};

struct Fnv1a64(u64);

impl Fnv1a64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    fn new() -> Self {
        Self(Self::OFFSET_BASIS)
    }

    fn write_u8(&mut self, b: u8) {
        self.0 ^= u64::from(b);
        self.0 = self.0.wrapping_mul(Self::PRIME);
    }

    fn write_bool(&mut self, v: bool) {
        self.write_u8(u8::from(v));
    }

    fn write_u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.write_u8(b);
        }
    }

    fn write_usize(&mut self, v: usize) {
        self.write_u64(v as u64);
    }

    fn write_str(&mut self, s: &str) {
        self.write_usize(s.len());
        for &b in s.as_bytes() {
            self.write_u8(b);
        }
    }

    fn write_opt_str(&mut self, opt: Option<&str>) {
        match opt {
            Some(s) => {
                self.write_u8(1);
                self.write_str(s);
            }
            None => self.write_u8(0),
        }
    }

    fn write_opt_u64(&mut self, opt: Option<u64>) {
        match opt {
            Some(n) => {
                self.write_u8(1);
                self.write_u64(n);
            }
            None => self.write_u8(0),
        }
    }

    fn write_opt_bool(&mut self, opt: Option<bool>) {
        match opt {
            Some(b) => {
                self.write_u8(1);
                self.write_bool(b);
            }
            None => self.write_u8(0),
        }
    }

    fn finish(self) -> u64 {
        self.0
    }
}

fn role_tag(r: AgentRole) -> u8 {
    match r {
        AgentRole::User => 1,
        AgentRole::Assistant => 2,
        AgentRole::Tool => 3,
        AgentRole::Reasoning => 4,
        AgentRole::System => 5,
    }
}

fn subagent_state_tag(s: SubagentState) -> u8 {
    match s {
        SubagentState::Working => 1,
        SubagentState::Idle => 2,
        SubagentState::Completed => 3,
        SubagentState::Failed => 4,
        SubagentState::Stopped => 5,
        SubagentState::Unverifiable => 6,
    }
}

fn bg_kind_tag(k: BackgroundTaskKind) -> u8 {
    match k {
        BackgroundTaskKind::Agent => 1,
        BackgroundTaskKind::Command => 2,
        BackgroundTaskKind::Workflow => 3,
        BackgroundTaskKind::Monitor => 4,
        BackgroundTaskKind::Unknown => 5,
    }
}

/// Deterministic structural 64-bit hash of an `AgentTurn` and all its nested `AgentEvent` fields.
/// Ensures `chat_watcher_stream` detects every in-place mutation (subagent completion, token count,
/// background task summary, `AwaitingInput.answered`, `Thinking.duration_secs`, `ToolEnd.ok`, etc.).
pub fn turn_digest(turn: &AgentTurn) -> u64 {
    let mut h = Fnv1a64::new();
    h.write_str(&turn.id);
    h.write_u8(role_tag(turn.role));
    h.write_opt_u64(turn.timestamp);
    h.write_usize(turn.events.len());

    for ev in &turn.events {
        match ev {
            AgentEvent::User { text } => {
                h.write_u8(1);
                h.write_str(text);
            }
            AgentEvent::Thinking { text, duration_secs } => {
                h.write_u8(2);
                h.write_str(text);
                h.write_opt_u64(*duration_secs);
            }
            AgentEvent::ToolStart { tool_id, name, detail } => {
                h.write_u8(3);
                h.write_str(tool_id);
                h.write_str(name);
                h.write_opt_str(detail.as_deref());
            }
            AgentEvent::ToolEnd { tool_id, name, detail, ok } => {
                h.write_u8(4);
                h.write_str(tool_id);
                h.write_opt_str(name.as_deref());
                h.write_opt_str(detail.as_deref());
                h.write_bool(*ok);
            }
            AgentEvent::Assistant { text } => {
                h.write_u8(5);
                h.write_str(text);
            }
            AgentEvent::Delta { text } => {
                h.write_u8(6);
                h.write_str(text);
            }
            AgentEvent::Subagents { group_id, agents } => {
                h.write_u8(7);
                h.write_str(group_id);
                h.write_usize(agents.len());
                for a in agents {
                    h.write_str(&a.id);
                    h.write_str(&a.label);
                    h.write_u8(subagent_state_tag(a.state));
                    h.write_opt_u64(a.tokens);
                    h.write_opt_u64(a.started_at);
                    h.write_opt_u64(a.settled_at);
                }
            }
            AgentEvent::BackgroundTasks { tasks } => {
                h.write_u8(8);
                h.write_usize(tasks.len());
                for t in tasks {
                    h.write_str(&t.id);
                    h.write_u8(bg_kind_tag(t.kind));
                    h.write_str(&t.label);
                    h.write_u8(subagent_state_tag(t.state));
                    h.write_opt_str(t.summary.as_deref());
                    h.write_opt_u64(t.tokens);
                    h.write_opt_u64(t.started_at);
                    h.write_opt_u64(t.settled_at);
                }
            }
            AgentEvent::AwaitingInput(ai) => {
                h.write_u8(9);
                h.write_opt_str(ai.tool_id.as_deref());
                h.write_str(&ai.input_kind);
                h.write_str(&ai.prompt);
                match &ai.options {
                    Some(opts) => {
                        h.write_u8(1);
                        h.write_usize(opts.len());
                        for o in opts {
                            h.write_str(o);
                        }
                    }
                    None => h.write_u8(0),
                }
                h.write_opt_str(ai.default_choice.as_deref());
                h.write_opt_bool(ai.multi_select);
                match &ai.questions {
                    Some(qs) => {
                        h.write_u8(1);
                        h.write_usize(qs.len());
                        for q in qs {
                            h.write_str(&q.question);
                            h.write_usize(q.options.len());
                            for o in &q.options {
                                h.write_str(o);
                            }
                            h.write_opt_bool(q.multi_select);
                        }
                    }
                    None => h.write_u8(0),
                }
                h.write_opt_str(ai.answered.as_deref());
            }
            AgentEvent::Status { text } => {
                h.write_u8(10);
                h.write_str(text);
            }
            AgentEvent::Done { stats } => {
                h.write_u8(11);
                h.write_opt_str(stats.as_deref());
            }
            AgentEvent::Usage {
                model,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            } => {
                h.write_u8(12);
                h.write_opt_str(model.as_deref());
                h.write_u64(*input_tokens);
                h.write_u64(*output_tokens);
                h.write_u64(*cache_read_tokens);
                h.write_u64(*cache_creation_tokens);
            }
            AgentEvent::Error { message } => {
                h.write_u8(13);
                h.write_str(message);
            }
        }
    }

    h.finish()
}

/// Unquote JSON-stringified argument strings that Antigravity writes in `tool_calls[].args`
/// (e.g. `"\"Client lint, test, and build\""` -> `"Client lint, test, and build"`).
pub fn clean_agy_arg_str(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"')
        && trimmed.ends_with('"')
        && let Ok(unquoted) = serde_json::from_str::<String>(trimmed)
    {
        return unquoted;
    }
    trimmed.to_string()
}

/// Recursively unquotes double-encoded string fields (e.g. `{"Path":"\"/tmp/a.rs\""}` -> `{"Path":"/tmp/a.rs"}`)
/// and parses stringified JSON arrays/objects in Antigravity `tool_calls[].args`.
pub fn clean_agy_args_json(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let mut cleaned = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                cleaned.insert(k.clone(), clean_agy_args_json(v));
            }
            serde_json::Value::Object(cleaned)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(clean_agy_args_json).collect())
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.starts_with('"')
                && trimmed.ends_with('"')
                && let Ok(unquoted) = serde_json::from_str::<String>(trimmed)
            {
                return serde_json::Value::String(unquoted);
            }
            if ((trimmed.starts_with('[') && trimmed.ends_with(']'))
                || (trimmed.starts_with('{') && trimmed.ends_with('}')))
                && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed)
            {
                return clean_agy_args_json(&parsed);
            }
            serde_json::Value::String(s.clone())
        }
        other => other.clone(),
    }
}

/// Shared structured question tool parser (`ask_question`, `AskUserQuestion`, `question`, etc.).
pub fn parse_ask_event(
    tool_id: Option<String>,
    name: &str,
    args: Option<&serde_json::Value>,
) -> Option<AgentEvent> {
    if !matches!(
        name,
        "ask_question"
            | "ask_permission"
            | "AskUserQuestion"
            | "ask_user_question"
            | "askUserQuestion"
            | "question"
    ) {
        return None;
    }
    let args = args?;
    let owned_questions: Option<Vec<serde_json::Value>> = match args.get("questions") {
        Some(serde_json::Value::Array(arr)) => Some(arr.clone()),
        Some(serde_json::Value::String(raw)) => {
            serde_json::from_str::<Vec<serde_json::Value>>(raw).ok()
        }
        _ => None,
    };

    let extract_opts = |q: &serde_json::Value| -> Vec<String> {
        q.get("options")
            .and_then(|opts| opts.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| {
                        if let Some(s) = o.as_str() {
                            Some(clean_agy_arg_str(s))
                        } else {
                            o.get("label")
                                .or_else(|| o.get("name"))
                                .and_then(|l| l.as_str())
                                .map(clean_agy_arg_str)
                        }
                    })
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };

    if let Some(questions) = owned_questions {
        let parsed_items: Vec<AskQuestionItem> = questions
            .iter()
            .filter_map(|q| {
                let q_text = q
                    .get("question")
                    .and_then(|v| v.as_str())
                    .map(clean_agy_arg_str)
                    .unwrap_or_default();
                if q_text.is_empty() {
                    return None;
                }
                let multi = q
                    .get("is_multi_select")
                    .and_then(|m| m.as_bool())
                    .or_else(|| q.get("multiSelect").and_then(|m| m.as_bool()))
                    .or_else(|| q.get("multiple").and_then(|m| m.as_bool()));
                Some(AskQuestionItem {
                    question: q_text,
                    options: extract_opts(q),
                    multi_select: multi,
                })
            })
            .collect();

        if let Some(first_item) = parsed_items.first().cloned() {
            return Some(AgentEvent::AwaitingInput(AwaitingInput {
                tool_id,
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
        .map(clean_agy_arg_str)
        .filter(|s| !s.is_empty())
    {
        let opts = extract_opts(args);
        return Some(AgentEvent::AwaitingInput(AwaitingInput {
            tool_id,
            input_kind: "question".into(),
            prompt: question,
            options: (!opts.is_empty()).then_some(opts),
            default_choice: None,
            multi_select: args
                .get("is_multi_select")
                .or_else(|| args.get("multiSelect"))
                .and_then(|m| m.as_bool()),
            questions: None,
            answered: None,
        }));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::event::SubagentEntry;

    #[test]
    fn turn_digest_detects_every_in_place_mutation() {
        let mut turn = AgentTurn::new("turn-1", "surf-1", AgentRole::Assistant);
        turn.events.push(AgentEvent::Subagents {
            group_id: "g".into(),
            agents: vec![SubagentEntry {
                id: "sub-1".into(),
                label: "Auditor".into(),
                state: SubagentState::Working,
                tokens: None,
                started_at: Some(100),
                settled_at: None,
            }],
        });
        let d0 = turn_digest(&turn);

        if let AgentEvent::Subagents { agents, .. } = &mut turn.events[0] {
            agents[0].state = SubagentState::Completed;
        }
        let d1 = turn_digest(&turn);
        assert_ne!(d0, d1, "subagent state change must change digest");

        if let AgentEvent::Subagents { agents, .. } = &mut turn.events[0] {
            agents[0].tokens = Some(4200);
        }
        let d2 = turn_digest(&turn);
        assert_ne!(d1, d2, "subagent token update must change digest");
    }

    #[test]
    fn cleans_agy_double_quoted_and_stringified_args() {
        let raw = serde_json::json!({
            "Path": "\"/tmp/a.rs\"",
            "ConversationIds": "[\"id-1\", \"id-2\"]",
            "WaitMsBeforeAsync": 5000
        });
        let cleaned = clean_agy_args_json(&raw);
        assert_eq!(cleaned["Path"], "/tmp/a.rs");
        assert_eq!(cleaned["ConversationIds"], serde_json::json!(["id-1", "id-2"]));
        assert_eq!(cleaned["WaitMsBeforeAsync"], 5000);
    }
}
