//! Pure model / effort option catalogs and CLI/TUI command validation per coding agent.
//!
//! Modeled on Orca's per-agent option catalog, `ref/orca/src/shared/agent-session/options/
//! agent-session-option-catalog-claude-codex.ts`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Choice {
    pub value: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelOption {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'static str>,
    pub efforts: Vec<Choice>,
    /// `/fast` toggle available (Claude Opus only in Orca's catalog, :113-118).
    pub fast: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentOptions {
    pub agent_kind: &'static str,
    pub models: Vec<ModelOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<&'static str>,
    /// `command`: changes apply by typing a slash command. `picker`: the agent shows its own picker that must
    /// be answered in the terminal.
    pub mid_session: &'static str,
}

const fn c(value: &'static str, label: &'static str) -> Choice {
    Choice { value, label }
}

const CLAUDE_EFFORTS: [Choice; 5] = [
    c("low", "Low"),
    c("medium", "Medium"),
    c("high", "High"),
    c("xhigh", "Extra high"),
    c("max", "Max"),
];

const CODEX_EFFORTS: [Choice; 7] = [
    c("minimal", "Minimal"),
    c("low", "Low"),
    c("medium", "Medium"),
    c("high", "High"),
    c("xhigh", "Extra high"),
    c("max", "Max"),
    c("ultra", "Ultra"),
];

fn codex_efforts_up_to(ceiling: &str) -> Vec<Choice> {
    let idx = CODEX_EFFORTS
        .iter()
        .position(|e| e.value == ceiling)
        .unwrap_or(CODEX_EFFORTS.len() - 1);
    CODEX_EFFORTS[..=idx].to_vec()
}

pub fn is_antigravity(kind: &str) -> bool {
    crate::domain::agents::spec_for(kind).map(|s| s.kind) == Some("antigravity")
}

/// Parses `agy models` output: `<id>\t<label>` per model.
pub fn parse_agy_models(out: &str) -> Vec<serde_json::Value> {
    out.lines()
        .filter_map(|l| l.split_once('\t'))
        .filter(|(id, _)| valid_token(id.trim()))
        .map(|(id, label)| {
            serde_json::json!({ "id": id.trim(), "label": label.trim(), "efforts": [], "fast": false })
        })
        .collect()
}

fn canonical(kind: &str) -> Option<&'static str> {
    match crate::domain::agents::spec_for(kind)?.kind {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        _ => None,
    }
}

pub fn options_for(kind: &str) -> Option<AgentOptions> {
    match canonical(kind)? {
        "claude" => Some(AgentOptions {
            agent_kind: "claude",
            models: vec![
                ModelOption {
                    id: "fable",
                    label: "Fable",
                    description: Some("Most capable for the hardest, longest-running tasks"),
                    efforts: CLAUDE_EFFORTS.to_vec(),
                    fast: false,
                },
                ModelOption {
                    id: "opus",
                    label: "Opus",
                    description: Some("Best for everyday, complex tasks"),
                    efforts: CLAUDE_EFFORTS.to_vec(),
                    fast: true,
                },
                ModelOption {
                    id: "sonnet",
                    label: "Sonnet",
                    description: Some("Efficient for routine tasks"),
                    efforts: CLAUDE_EFFORTS.to_vec(),
                    fast: false,
                },
                ModelOption {
                    id: "haiku",
                    label: "Haiku",
                    description: Some("Fastest for quick answers"),
                    efforts: vec![],
                    fast: false,
                },
            ],
            default_model: Some("sonnet"),
            default_effort: Some("high"),
            mid_session: "command",
        }),
        "codex" => Some(AgentOptions {
            agent_kind: "codex",
            models: vec![
                ModelOption { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: None, efforts: codex_efforts_up_to("ultra"), fast: false },
                ModelOption { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: None, efforts: codex_efforts_up_to("ultra"), fast: false },
                ModelOption { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: None, efforts: codex_efforts_up_to("max"), fast: false },
                ModelOption { id: "gpt-5.5", label: "GPT-5.5", description: None, efforts: codex_efforts_up_to("xhigh"), fast: false },
                ModelOption { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: None, efforts: codex_efforts_up_to("xhigh"), fast: false },
            ],
            default_model: None,
            default_effort: Some("medium"),
            mid_session: "picker",
        }),
        _ => None,
    }
}

pub fn valid_token(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(f) if f.is_ascii_alphanumeric())
        && s.len() <= 64
        && s.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn effort_allowed(opts: &AgentOptions, model: Option<&str>, effort: &str) -> bool {
    if !valid_token(effort) {
        return false;
    }
    let known = model.and_then(|m| opts.models.iter().find(|x| x.id == m));
    match known {
        Some(m) => m.efforts.iter().any(|e| e.value == effort),
        None => {
            let widest: &[Choice] = if opts.agent_kind == "codex" { &CODEX_EFFORTS } else { &CLAUDE_EFFORTS };
            widest.iter().any(|e| e.value == effort)
        }
    }
}

/// CLI arguments to append to the agent's launch command.
pub fn launch_flags(kind: &str, model: Option<&str>, effort: Option<&str>) -> Result<Vec<String>, String> {
    if is_antigravity(kind) {
        if effort.is_some_and(|e| !e.is_empty()) {
            return Err("Antigravity models carry their effort level in the model name".into());
        }
        return match model.filter(|m| !m.is_empty()) {
            Some(m) if valid_token(m) => Ok(vec!["--model".into(), m.into()]),
            Some(_) => Err("invalid model id".into()),
            None => Ok(vec![]),
        };
    }
    let opts = options_for(kind).ok_or("this agent has no model/effort options")?;
    let mut flags = Vec::new();
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        if !valid_token(m) {
            return Err("invalid model id".into());
        }
        match opts.agent_kind {
            "claude" => flags.extend(["--model".to_string(), m.to_string()]),
            _ => flags.extend(["-m".to_string(), m.to_string()]),
        }
    }
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        if !effort_allowed(&opts, model.filter(|m| !m.is_empty()), e) {
            return Err("effort level not supported by this model".into());
        }
        match opts.agent_kind {
            "claude" => flags.extend(["--effort".to_string(), e.to_string()]),
            _ => flags.extend(["-c".to_string(), format!("model_reasoning_effort={e}")]),
        }
    }
    Ok(flags)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MidSession {
    Command(String),
    TypedPicker(String),
}

pub fn mid_session(kind: &str, option: &str, value: Option<&str>) -> Result<MidSession, String> {
    if is_antigravity(kind) {
        return match option {
            "model" | "effort" => Ok(MidSession::TypedPicker("/model".into())),
            _ => Err("unknown option".into()),
        };
    }
    let opts = options_for(kind).ok_or("this agent has no model/effort options")?;
    if opts.agent_kind == "codex" {
        return match option {
            "model" | "effort" => Ok(MidSession::TypedPicker("/model".into())),
            _ => Err("unknown option".into()),
        };
    }
    match option {
        "model" => {
            let v = value.filter(|v| valid_token(v)).ok_or("a valid model id is required")?;
            Ok(MidSession::Command(format!("/model {v}")))
        }
        "effort" => {
            let v = value.ok_or("an effort level is required")?;
            if !effort_allowed(&opts, None, v) {
                return Err("unknown effort level".into());
            }
            Ok(MidSession::Command(format!("/effort {v}")))
        }
        "fast" => Ok(MidSession::Command("/fast".into())),
        _ => Err("unknown option".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_orca_seed() {
        let claude = options_for("claude").unwrap();
        assert_eq!(claude.models.iter().map(|m| m.id).collect::<Vec<_>>(), ["fable", "opus", "sonnet", "haiku"]);
        assert!(claude.models.iter().find(|m| m.id == "opus").unwrap().fast);
        assert!(claude.models.iter().find(|m| m.id == "haiku").unwrap().efforts.is_empty());
        let codex = options_for("codex").unwrap();
        let luna = codex.models.iter().find(|m| m.id == "gpt-5.6-luna").unwrap();
        assert_eq!(luna.efforts.last().unwrap().value, "max");
        assert_eq!(codex.mid_session, "picker");
        assert!(options_for("kiro").is_none());
        assert!(options_for("openclaude").is_some(), "alias resolves to claude");
    }

    #[test]
    fn antigravity_models_parse_and_launch_with_model_flag() {
        let out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        let m = parse_agy_models(out);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["id"], "gemini-3.8-flash-high");
        assert_eq!(m[1]["label"], "Claude Sonnet 4.6 (Thinking)");
        assert_eq!(launch_flags("agy", Some("claude-sonnet-4-6"), None).unwrap(), ["--model", "claude-sonnet-4-6"]);
        assert!(launch_flags("antigravity", None, Some("high")).is_err());
        assert!(launch_flags("agy", Some("--sandbox"), None).is_err());
    }

    #[test]
    fn launch_flags_follow_orca_cli_forms() {
        assert_eq!(
            launch_flags("claude", Some("sonnet"), Some("high")).unwrap(),
            ["--model", "sonnet", "--effort", "high"]
        );
        assert_eq!(
            launch_flags("codex", Some("gpt-5.5"), Some("xhigh")).unwrap(),
            ["-m", "gpt-5.5", "-c", "model_reasoning_effort=xhigh"]
        );
        assert!(launch_flags("claude", None, None).unwrap().is_empty());
    }

    #[test]
    fn launch_flags_reject_unsafe_or_unsupported_values() {
        assert!(launch_flags("claude", Some("--dangerously-skip-permissions"), None).is_err());
        assert!(launch_flags("claude", Some("opus; rm -rf ~"), None).is_err());
        assert!(launch_flags("claude", Some("haiku"), Some("high")).is_err(), "haiku has no effort levels");
        assert!(launch_flags("codex", Some("gpt-5.5"), Some("ultra")).is_err(), "above the model's ceiling");
        assert!(launch_flags("claude", Some("sonnet"), Some("bogus")).is_err());
        assert!(launch_flags("kiro", Some("x"), None).is_err());
        assert_eq!(launch_flags("claude", Some("claude-sonnet-5-5"), None).unwrap(), ["--model", "claude-sonnet-5-5"]);
    }

    #[test]
    fn mid_session_commands() {
        assert_eq!(mid_session("claude", "model", Some("opus")).unwrap(), MidSession::Command("/model opus".into()));
        assert_eq!(mid_session("claude", "effort", Some("low")).unwrap(), MidSession::Command("/effort low".into()));
        assert_eq!(mid_session("claude", "fast", None).unwrap(), MidSession::Command("/fast".into()));
        assert_eq!(mid_session("codex", "model", None).unwrap(), MidSession::TypedPicker("/model".into()));
        assert_eq!(mid_session("codex", "effort", Some("high")).unwrap(), MidSession::TypedPicker("/model".into()));
        assert!(mid_session("claude", "model", Some("opus\n/exit")).is_err(), "no newline injection");
        assert!(mid_session("claude", "model", Some("-x")).is_err());
        assert!(mid_session("claude", "effort", Some("ultra")).is_err(), "ultra is a Codex level");
        assert!(mid_session("claude", "model", None).is_err());
        assert!(mid_session("claude", "temperature", Some("1")).is_err());
    }

    #[test]
    fn tokens() {
        assert!(valid_token("gpt-5.6-sol"));
        assert!(valid_token("claude-sonnet-5-5"));
        assert!(!valid_token(""));
        assert!(!valid_token("-x"));
        assert!(!valid_token("a b"));
        assert!(!valid_token(&"a".repeat(65)));
    }
}
