//! Single registry of the coding agents the gateway knows about.
//!
//! Evidence for detection names: Orca `detectCmd` per agent in
//! `ref/orca/src/shared/agent-launch/catalog/tui-agent-config.ts` (gemini :160-161, aider :175-176,
//! goose :179-180, amp :183-184, cline :207-208, cursor-agent :231-232, droid :237-238, qwen :258-259,
//! copilot :280-281, grok :288-289, kiro-cli :191-193). Approve keys: Orca `nativeChatApprovalAcceptKey`
//! (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`) is "1" for everything except
//! OpenCode ("\r").

use crate::domain::agent_profile::ApproveInput;

#[derive(Debug, Clone, Copy)]
pub struct AgentSpec {
    /// Canonical kind reported to clients (`SurfaceAgentInfo.agent_kind`).
    pub kind: &'static str,
    pub display_name: &'static str,
    /// Executable-name prefixes that identify the agent process.
    pub bin_prefixes: &'static [&'static str],
    /// Executable-name substrings that identify the agent process.
    pub bin_contains: &'static [&'static str],
    /// Exact executable names (use for short names where a prefix would over-match).
    pub bin_exact: &'static [&'static str],
    /// Other spellings of `kind` accepted from hook files / clients.
    pub aliases: &'static [&'static str],
    pub approve: ApproveInput,
    /// Extra settle time per prompt line before Enter (see `AgentProfile::submit_line_settle_ms`).
    pub submit_line_settle_ms: u64,
    /// Command template that opens a copy of a conversation (`{id}` is the session id). Only agents whose
    /// fork command and session-id mapping are verified are listed.
    pub fork: Option<&'static [&'static str]>,
    /// Why this row has the values it has / what is unverified.
    pub note: &'static str,
}

const ENTER: ApproveInput = ApproveInput::Key("enter");
const ONE: ApproveInput = ApproveInput::Text("1");

const fn spec(kind: &'static str, display_name: &'static str) -> AgentSpec {
    AgentSpec {
        kind,
        display_name,
        bin_prefixes: &[],
        bin_contains: &[],
        bin_exact: &[],
        aliases: &[],
        approve: ENTER,
        submit_line_settle_ms: 0,
        fork: None,
        note: "",
    }
}

/// Order matters for detection: first match wins (antigravity's `agy` prefix is checked before others).
pub const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        bin_prefixes: &["agy"],
        bin_contains: &["antigravity"],
        aliases: &["agy", "agys", "antigravity"],
        submit_line_settle_ms: 45,
        note: "agy 1.2.x expands collapsed multiline pastes over seconds (Orca tui-agent-config.ts:171-173)",
        ..spec("antigravity", "Antigravity")
    },
    AgentSpec {
        bin_prefixes: &["claude"],
        bin_contains: &["openclaude"],
        aliases: &["claude", "openclaude"],
        approve: ONE,
        fork: Some(&["claude", "--resume", "{id}", "--fork-session"]),
        ..spec("claude", "Claude")
    },
    AgentSpec {
        bin_prefixes: &["codex"],
        aliases: &["codex"],
        approve: ONE,
        ..spec("codex", "Codex")
    },
    AgentSpec {
        bin_prefixes: &["kiro"],
        aliases: &["kiro", "kiro-cli"],
        ..spec("kiro", "Kiro")
    },
    AgentSpec {
        bin_prefixes: &["opencode"],
        aliases: &["opencode", "opencode2"],
        note: "Orca approve key is \\r (native-chat-agent-support.ts:66-68)",
        ..spec("opencode", "OpenCode")
    },
    AgentSpec {
        bin_prefixes: &["grok"],
        aliases: &["grok"],
        note: "approve key not verified; default Enter",
        ..spec("grok", "Grok")
    },
    AgentSpec { bin_exact: &["gemini"], aliases: &["gemini"], note: "detect-only; approve key unverified", ..spec("gemini", "Gemini") },
    AgentSpec { bin_exact: &["aider"], aliases: &["aider"], note: "detect-only; approve key unverified", ..spec("aider", "Aider") },
    AgentSpec { bin_exact: &["cursor-agent"], aliases: &["cursor", "cursor-agent"], note: "detect-only; approve key unverified", ..spec("cursor", "Cursor") },
    AgentSpec { bin_exact: &["copilot"], aliases: &["copilot"], note: "detect-only; approve key unverified", ..spec("copilot", "Copilot") },
    AgentSpec { bin_exact: &["goose"], aliases: &["goose"], note: "detect-only; approve key unverified", ..spec("goose", "Goose") },
    AgentSpec { bin_exact: &["amp"], aliases: &["amp"], note: "detect-only; approve key unverified", ..spec("amp", "Amp") },
    AgentSpec { bin_exact: &["cline"], aliases: &["cline"], note: "detect-only; approve key unverified", ..spec("cline", "Cline") },
    AgentSpec { bin_exact: &["droid"], aliases: &["droid"], note: "detect-only; approve key unverified", ..spec("droid", "Droid") },
    AgentSpec { bin_exact: &["qwen"], aliases: &["qwen"], note: "detect-only; approve key unverified", ..spec("qwen", "Qwen") },
];

/// Canonical spec for a kind or any of its aliases (case-insensitive).
pub fn spec_for(name: &str) -> Option<&'static AgentSpec> {
    let n = name.trim().to_ascii_lowercase();
    AGENTS
        .iter()
        .find(|a| a.kind == n || a.aliases.iter().any(|al| *al == n))
}

/// Shell command that opens a forked copy of conversation `session_id`, or None when the agent has no
/// verified fork command or the id is not a plain token.
pub fn fork_command(kind: &str, session_id: &str) -> Option<String> {
    if !kind.trim().eq_ignore_ascii_case("claude") {
        return None;
    }
    let template = spec_for(kind)?.fork?;
    let ok_len = (8..=80).contains(&session_id.len());
    let first_ok = session_id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !ok_len
        || !first_ok
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(template.iter().map(|p| p.replace("{id}", session_id)).collect::<Vec<_>>().join(" "))
}

/// Maps an executable name to a canonical agent kind.
pub fn kind_from_bin(bin_name: &str) -> Option<&'static str> {
    AGENTS
        .iter()
        .find(|a| {
            a.bin_exact.contains(&bin_name)
                || a.bin_prefixes.iter().any(|p| bin_name.starts_with(p))
                || a.bin_contains.iter().any(|c| bin_name.contains(c))
        })
        .map(|a| a.kind)
}

/// Human name for push titles; unknown kinds are capitalised.
pub fn display_name(kind: &str) -> String {
    if let Some(a) = spec_for(kind) {
        return a.display_name.to_string();
    }
    let mut c = kind.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_matches_previous_behaviour() {
        assert_eq!(kind_from_bin("agy"), Some("antigravity"));
        assert_eq!(kind_from_bin("agys"), Some("antigravity"));
        assert_eq!(kind_from_bin("claude"), Some("claude"));
        assert_eq!(kind_from_bin("openclaude"), Some("claude"));
        assert_eq!(kind_from_bin("codex"), Some("codex"));
        assert_eq!(kind_from_bin("kiro-cli"), Some("kiro"));
        assert_eq!(kind_from_bin("opencode2"), Some("opencode"));
        assert_eq!(kind_from_bin("grok"), Some("grok"));
    }

    #[test]
    fn new_agents_detected_without_over_matching() {
        assert_eq!(kind_from_bin("gemini"), Some("gemini"));
        assert_eq!(kind_from_bin("aider"), Some("aider"));
        assert_eq!(kind_from_bin("cursor-agent"), Some("cursor"));
        assert_eq!(kind_from_bin("ampersand"), None, "exact match must not behave like a prefix");
        assert_eq!(kind_from_bin("geminid"), None);
        assert_eq!(kind_from_bin("zsh"), None);
    }

    #[test]
    fn kinds_and_aliases_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for a in AGENTS {
            assert!(seen.insert(a.kind), "duplicate kind {}", a.kind);
            for al in a.aliases {
                assert!(seen.insert(al) || *al == a.kind, "alias {al} reused");
            }
        }
    }

    #[test]
    fn display_names() {
        assert_eq!(display_name("antigravity"), "Antigravity");
        assert_eq!(display_name("agy"), "Antigravity");
        assert_eq!(display_name("some-new"), "Some-new");
    }

    #[test]
    fn fork_command_only_for_verified_agents_and_safe_ids() {
        let id = "f6c4368e-faef-4b60-9432-e1ca1a198168";
        assert_eq!(
            fork_command("claude", id).as_deref(),
            Some("claude --resume f6c4368e-faef-4b60-9432-e1ca1a198168 --fork-session")
        );
        assert!(fork_command("openclaude", id).is_none(), "openclaude has no verified fork command");
        assert!(fork_command("claude", "--dangerously-skip-permissions").is_none(), "leading '-' is a flag");
        assert!(fork_command("claude", "-aaaaaaaaaaaa").is_none());
        assert!(fork_command("codex", id).is_none(), "unverified agents are not enabled");
        assert!(fork_command("claude", "x; rm -rf ~").is_none());
        assert!(fork_command("claude", "$(id)aaaaaaaa").is_none());
        assert!(fork_command("claude", "short").is_none());
        assert!(fork_command("claude", &"a".repeat(81)).is_none());
    }
}
