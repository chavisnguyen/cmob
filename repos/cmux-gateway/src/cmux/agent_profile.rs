//! Per-agent terminal input behaviour. The per-agent values live in the registry
//! (`cmux/agents.rs`); supporting a new agent means adding a row there.
//!
//! Why prompts are not sent as `text + "\r"`: agent TUIs treat one burst of bytes as pasted prose, so an
//! Enter inside the burst is swallowed or becomes a newline. Verified on Codex 0.169.0 through
//! `cmux send`: `testA one line\r` left the draft unsent in the composer, while a separate `enter` key
//! submitted it. Orca does the same: write the text, wait for the TUI to ingest it, then write Enter on
//! its own (ref/orca/src/main/runtime/terminal/input/runtime-terminal-writer.ts:72-117, delay in
//! ref/orca/src/shared/agent-launch/startup/agent-prompt-injection.ts:15-30,140-170).

use std::time::Duration;

/// How an approval prompt is accepted.
/// Source of the existing mapping: architecture.md:101-108.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproveInput {
    /// Type this text (e.g. option "1").
    Text(&'static str),
    /// Press this key (e.g. "enter").
    Key(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentProfile {
    pub kind: &'static str,
    /// Minimum wait between the pasted text and Enter. Orca `AGENT_PROMPT_SUBMIT_SETTLE_MS` = 500.
    pub submit_settle_ms: u64,
    /// Extra wait per line of the prompt. Orca `submitLineSettleMsPerLine` (Antigravity: 45, "agy 1.2.x
    /// expands collapsed multiline pastes over seconds", tui-agent-config.ts:171-173).
    pub submit_line_settle_ms: u64,
    pub approve: ApproveInput,
}

const DEFAULT_SETTLE_MS: u64 = 500;
/// Orca `DEFAULT_PASTE_INGEST_BYTES_PER_MS` for non-Windows hosts (4096 B/ms).
const INGEST_BYTES_PER_MS: u64 = 4096;
/// Never hold the RPC for longer than this (phone request timeout).
const MAX_SUBMIT_DELAY_MS: u64 = 8_000;

const DEFAULT: AgentProfile = AgentProfile {
    kind: "default",
    submit_settle_ms: DEFAULT_SETTLE_MS,
    submit_line_settle_ms: 0,
    approve: ApproveInput::Key("enter"),
};

/// Profile for a gateway `agent_kind` (hook-file prefix or process name). Unknown agents get the
/// conservative default: paste, settle, then a separate Enter.
pub fn profile_for(agent_kind: &str) -> AgentProfile {
    match crate::cmux::agents::spec_for(agent_kind) {
        Some(spec) => AgentProfile {
            kind: spec.kind,
            approve: spec.approve,
            submit_line_settle_ms: spec.submit_line_settle_ms,
            ..DEFAULT
        },
        None => DEFAULT,
    }
}

impl AgentProfile {
    /// Delay between the pasted text and Enter: settle + host ingest + per-line settle
    /// (`getAgentPromptSubmitDelayMs`, agent-prompt-injection.ts:140-153).
    pub fn submit_delay(&self, text: &str) -> Duration {
        let lines = text.split('\n').count().max(1) as u64;
        let ingest = (text.len() as u64).div_ceil(INGEST_BYTES_PER_MS);
        let ms = self.submit_settle_ms + ingest + lines * self.submit_line_settle_ms;
        Duration::from_millis(ms.min(MAX_SUBMIT_DELAY_MS))
    }
}

/// Older clients appended `\r` to the message to mean "submit". Returns the text without trailing
/// line terminators and whether one was present.
pub fn split_legacy_submit(text: &str) -> (&str, bool) {
    let trimmed = text.trim_end_matches(['\r', '\n']);
    (trimmed, trimmed.len() != text.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_map_known_agents_and_default_for_unknown() {
        assert_eq!(profile_for("codex").approve, ApproveInput::Text("1"));
        assert_eq!(profile_for("Claude").approve, ApproveInput::Text("1"));
        assert_eq!(profile_for("kiro").approve, ApproveInput::Key("enter"));
        assert_eq!(profile_for("agy").submit_line_settle_ms, 45);
        assert_eq!(profile_for("some-new-agent"), DEFAULT);
    }

    #[test]
    fn submit_delay_scales_with_lines_for_antigravity_only() {
        let text = "a\nb\nc";
        assert_eq!(profile_for("codex").submit_delay(text), Duration::from_millis(501));
        assert_eq!(profile_for("agy").submit_delay(text), Duration::from_millis(501 + 3 * 45));
        // Capped
        let huge = "x".repeat(100_000_000);
        assert_eq!(profile_for("codex").submit_delay(&huge), Duration::from_millis(MAX_SUBMIT_DELAY_MS));
    }

    #[test]
    fn legacy_trailing_newline_means_submit() {
        assert_eq!(split_legacy_submit("hi\r"), ("hi", true));
        assert_eq!(split_legacy_submit("hi\n"), ("hi", true));
        assert_eq!(split_legacy_submit("hi"), ("hi", false));
        assert_eq!(split_legacy_submit("a\nb"), ("a\nb", false));
    }
}
