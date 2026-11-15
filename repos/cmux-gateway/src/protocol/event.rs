use serde::{Deserialize, Serialize};

/// Role in the conversation timeline.
/// Source: ref/orca/src/shared/native-chat/native-chat-types.ts:31-32
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    User,
    Assistant,
    Tool,
    Reasoning,
    System,
}

/// Normalized Agent Runtime Lifecycle State matching Orca
/// Source: ref/orca/src/shared/agent-status/contracts/agent-status-types.ts:29-35
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentLifecycleState {
    Idle,
    Working,
    Waiting,
    Done,
    Error,
}

/// Lifecycle states of a subagent in a hierarchy or fan-out roster.
/// Source: ref/orca/src/shared/native-chat/native-chat-types.ts:114-122
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentState {
    Working,
    Idle,
    Completed,
    Failed,
    Stopped,
    Unverifiable,
}

/// Entry representing a single child agent in a subagent group.
/// Source: ref/orca/src/shared/native-chat/native-chat-types.ts:125-137
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentEntry {
    pub id: String,
    pub label: String,
    pub state: SubagentState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<u64>,
}

/// Awaiting user feedback or permission for a tool execution.
/// Source: ref/orca/src/shared/native-chat/native-chat-types.ts & ref/cmux/agent-chat/types.ts
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AwaitingInput {
    pub input_kind: String, // e.g. "permission", "question", "options"
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_choice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
}

/// Unified Agent Event enum.
/// Normalized from Claude, Antigravity (AGY), Codex, and Kiro transcripts.
/// Sources: ref/cmux/agent-chat/types.ts:1-35, ref/orca/src/shared/native-chat/native-chat-types.ts:34-175
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentEvent {
    User {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolStart {
        tool_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    ToolEnd {
        tool_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default = "default_true")]
        ok: bool,
    },
    Assistant {
        text: String,
    },
    Delta {
        text: String,
    },
    Subagents {
        group_id: String,
        agents: Vec<SubagentEntry>,
    },
    AwaitingInput(AwaitingInput),
    Status {
        text: String,
    },
    Done {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stats: Option<String>,
    },
    /// Token usage reported with an assistant message (Claude: `message.usage`). The context size of the
    /// conversation is `input + cache_read + cache_creation` of the latest one.
    Usage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
        #[serde(default)]
        cache_read_tokens: u64,
        #[serde(default)]
        cache_creation_tokens: u64,
    },
    Error {
        message: String,
    },
}

fn default_true() -> bool {
    true
}

/// A structured turn in the conversational history of an agent session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentTurn {
    pub id: String,
    pub surface_id: String,
    pub role: AgentRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    pub events: Vec<AgentEvent>,
}

impl AgentTurn {
    pub fn new(id: impl Into<String>, surface_id: impl Into<String>, role: AgentRole) -> Self {
        Self {
            id: id.into(),
            surface_id: surface_id.into(),
            role,
            timestamp: None,
            events: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_agent_event_serialization() {
        let events = vec![
            AgentEvent::User {
                text: "fix the flaky test".to_string(),
            },
            AgentEvent::Thinking {
                text: "look at the test first".to_string(),
            },
            AgentEvent::ToolStart {
                tool_id: "t1".to_string(),
                name: "Bash".to_string(),
                detail: Some("bun test flaky".to_string()),
            },
            AgentEvent::ToolEnd {
                tool_id: "t1".to_string(),
                name: Some("Bash".to_string()),
                detail: Some("1 fail".to_string()),
                ok: false,
            },
            AgentEvent::Assistant {
                text: "Fixed the race in setup.".to_string(),
            },
            AgentEvent::Done {
                stats: Some("4.2s".to_string()),
            },
        ];

        let json = serde_json::to_string(&events).expect("serialize");
        assert!(json.contains("\"kind\":\"user\""));
        assert!(json.contains("\"kind\":\"thinking\""));
        assert!(json.contains("\"kind\":\"tool-start\""));
        assert!(json.contains("\"kind\":\"tool-end\""));
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("\"kind\":\"assistant\""));
        assert!(json.contains("\"kind\":\"done\""));

        let deserialized: Vec<AgentEvent> = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, events);
    }

    #[test]
    fn test_subagent_states() {
        let entry = SubagentEntry {
            id: "sub-1".to_string(),
            label: "Explore Codebase".to_string(),
            state: SubagentState::Working,
            tokens: Some(12500),
            started_at: Some(1700000000000),
            settled_at: None,
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        assert!(json.contains("\"state\":\"working\""));

        let deserialized: SubagentEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, entry);
    }

    #[test]
    fn test_golden_transcript_fixture_tier1_gate() {
        // Real fixture events from ref/cmux/agent-chat/test/transcript.test.ts:50-64
        let golden_json = r#"[
            {"kind":"user","text":"fix the flaky test"},
            {"kind":"thinking","text":"look at the test first"},
            {"kind":"tool-start","tool_id":"t1","name":"Bash","detail":"bun test flaky"},
            {"kind":"tool-end","tool_id":"t1","ok":false,"detail":"1 fail"},
            {"kind":"assistant","text":"Fixed the race in setup."},
            {"kind":"done","stats":"4.2s"},
            {"kind":"user","text":"/model opus"},
            {"kind":"status","text":"Set model to opus"},
            {"kind":"status","text":"Background task: Build finished"},
            {"kind":"status","text":"Interrupted"},
            {"kind":"done"},
            {"kind":"error","message":"API Error: overloaded"},
            {"kind":"status","text":"Conversation compacted"}
        ]"#;

        let events: Vec<AgentEvent> = serde_json::from_str(golden_json).expect("deserialize golden fixture");
        assert_eq!(events.len(), 13);
        assert_eq!(events[0], AgentEvent::User { text: "fix the flaky test".to_string() });
        assert_eq!(events[1], AgentEvent::Thinking { text: "look at the test first".to_string() });
        assert_eq!(events[3], AgentEvent::ToolEnd {
            tool_id: "t1".to_string(),
            name: None,
            detail: Some("1 fail".to_string()),
            ok: false,
        });
    }
}
