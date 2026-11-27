//! Multi-Agent Transcript Reader Facade.
//!
//! Normalizes Claude Code, Antigravity (AGY), Codex, Kiro, and OpenCode transcripts into unified
//! `AgentTurn` structures, delegating pure filtering/normalization to `crate::domain`, window I/O
//! to `crate::io::jsonl_window`, and provider decoding to `crate::providers`.

use std::path::Path;

use crate::domain::noise_filter;
use crate::domain::receipt_normalizer;
use crate::io::jsonl_window::read_jsonl_turns_page;
use crate::protocol::event::AgentTurn;

pub use crate::io::jsonl_window::TranscriptPage;

pub struct TranscriptReader;

impl TranscriptReader {
    /// Read recent turns from a transcript file (JSONL or OpenCode `db#session`), returning at most `max_turns`.
    pub fn read_recent_turns(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
    ) -> Result<Vec<AgentTurn>, std::io::Error> {
        Self::read_recent_turns_page(transcript_path, surface_id, max_turns).map(|(turns, _)| turns)
    }

    /// Reads the latest page of turns and total turn count.
    pub fn read_recent_turns_page(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
    ) -> Result<(Vec<AgentTurn>, usize), std::io::Error> {
        let page = Self::read_turns_page(transcript_path, surface_id, max_turns, None)?;
        Ok((page.turns, page.total_turns))
    }

    /// Paginated transcript reader supporting both JSONL byte-offset cursors and OpenCode SQLite `seq` cursors.
    pub fn read_turns_page(
        transcript_path: &Path,
        surface_id: &str,
        max_turns: usize,
        before_offset: Option<u64>,
    ) -> Result<TranscriptPage, std::io::Error> {
        if let Some((db, session_id)) =
            crate::scanner::opencode_store::parse_pseudo_path(transcript_path)
        {
            return crate::scanner::opencode_store::read_turns_page(
                &db,
                &session_id,
                surface_id,
                max_turns,
                before_offset,
            )
            .map_err(std::io::Error::other);
        }
        read_jsonl_turns_page(transcript_path, surface_id, max_turns, before_offset)
    }

    /// Extracts user prompt text, stripping internal Antigravity & Claude XML envelopes.
    pub fn clean_user_prompt(text: &str) -> String {
        noise_filter::clean_user_prompt(text)
    }

    /// Alias matching Orca's exact function name: `extractAntigravityUserRequest`.
    pub fn extract_antigravity_user_request(text: &str) -> String {
        noise_filter::clean_user_prompt(text)
    }

    /// Strip leading `Created At: ...` / `Completed At: ...` lines from Antigravity `GENERIC` results.
    pub fn strip_agy_tool_headers(raw: &str) -> &str {
        receipt_normalizer::strip_agy_tool_headers(raw)
    }

    /// Normalize question tool answers into clean human-readable receipt text.
    pub fn clean_question_answer_text(raw: &str) -> String {
        receipt_normalizer::clean_question_answer_text(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::event::{AgentEvent, AgentRole, SubagentState};
    use std::fs::File;
    use std::io::Write;

    fn write_jsonl(name: &str, lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("{}-{}.jsonl", name, uuid::Uuid::new_v4()));
        let mut f = File::create(&p).expect("create");
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    #[test]
    fn test_parse_claude_jsonl() {
        let p = write_jsonl(
            "claude-basic",
            &[
                r#"{"type":"user","message":{"content":"npm run build"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Checking bundle"},{"type":"text","text":"Build completed successfully."}]}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-1", 10).expect("read turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, AgentRole::User);
        assert_eq!(turns[1].role, AgentRole::Assistant);
        assert_eq!(turns[1].events.len(), 2);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn claude_mixed_tool_result_and_system_reminder_never_splits_turn_or_emits_user_bubble() {
        let p = write_jsonl(
            "claude-mixed",
            &[
                r#"{"type":"user","message":{"role":"user","content":"run tests"}}"#,
                r#"{"type":"assistant","timestamp":"2026-11-25T10:00:01Z","message":{"content":[{"type":"thinking","thinking":"Running cargo test"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#,
                r#"{"type":"assistant","timestamp":"2026-11-25T10:00:08Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}]}}"#,
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false},{"type":"text","text":"<system-reminder>internal reminder</system-reminder>"}]}}"#,
                r#"{"type":"assistant","message":{"model":"<synthetic>","stop_reason":"stop_sequence","stop_sequence":"","content":[{"type":"text","text":"No response requested."}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All tests passed!"}]}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-c", 10).unwrap();
        assert_eq!(turns.len(), 2, "one user turn + one unbroken assistant turn");
        assert_eq!(turns[0].role, AgentRole::User);
        assert_eq!(turns[1].role, AgentRole::Assistant);
        assert!(matches!(
            turns[1].events[0],
            AgentEvent::Thinking { duration_secs: Some(7), .. }
        ));
        assert!(turns[1]
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { tool_id, ok: true, .. } if tool_id == "t1")));
        assert!(!turns[1].events.iter().any(|e| matches!(e, AgentEvent::Assistant { text } if text.contains("No response requested"))));
        let _ = std::fs::remove_file(p);

        let p2 = write_jsonl(
            "claude-unwrappers",
            &[
                r#"{"type":"user","message":{"role":"user","content":"<bash-input>git status -sb</bash-input>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"<pasted_content id=\"1\">error log line</pasted_content>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat</local-command-caveat><command-name>/review</command-name><command-args>PR #42</command-args>"}}"#,
            ],
        );
        let unwrapped = TranscriptReader::read_recent_turns(&p2, "surf-u", 10).unwrap();
        assert_eq!(unwrapped.len(), 3);
        assert_eq!(unwrapped[0].events, vec![AgentEvent::User { text: "!git status -sb".into() }]);
        assert_eq!(unwrapped[1].events, vec![AgentEvent::User { text: "error log line".into() }]);
        assert_eq!(unwrapped[2].events, vec![AgentEvent::User { text: "/review PR #42".into() }]);
        let _ = std::fs::remove_file(p2);
    }

    #[test]
    fn antigravity_fifo_parallel_tools_and_clean_args() {
        let p = write_jsonl(
            "agy-fifo",
            &[
                r#"{"type":"REQUEST","source":"USER_EXPLICIT","created_at":"2026-11-25T13:52:00Z","content":"<USER_REQUEST>inspect files"}"#,
                r#"{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T13:52:05Z","thinking":"Pure thinking step."}"#,
                r#"{"type":"PLANNER_RESPONSE","created_at":"2026-11-25T13:52:20Z","tool_calls":[{"name":"read_file","args":{"Path":"\"/tmp/first.rs\""}},{"name":"manage_subagents","args":{"Action":"\"list\""}},{"name":"read_file","args":{"Path":"\"/tmp/second.rs\""}},{"name":"run_command","args":{"CommandLine":"\"cargo test\"","toolSummary":"\"Run tests\""}}]}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:52:21Z","content":"Created At: t\nFIRST_CONTENT"}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:52:21Z","content":"Created At: t\nActive subagents: []"}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:52:21Z","content":"Created At: t\nSECOND_CONTENT"}"#,
                r#"{"type":"GENERIC","status":"RUNNING","created_at":"2026-11-25T13:52:22Z","content":"Tool is running as a background task with task id: conv/task-1\nTask Description: cargo test"}"#,
                r#"{"type":"GENERIC","created_at":"2026-11-25T13:52:23Z","content":"ORPHAN_GENERIC_MUST_NOT_BE_PROSE"}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-agy", 10).unwrap();
        assert_eq!(turns.len(), 2);
        let ast = &turns[1];

        // Pure thinking lasted 15s (13:52:05Z -> 13:52:20Z).
        assert!(matches!(
            ast.events[0],
            AgentEvent::Thinking { duration_secs: Some(15), .. }
        ));

        // Only the two `read_file` calls remain as ToolStarts (`manage_subagents` & backgrounded `run_command` suppressed!).
        let starts: Vec<(&str, &str)> = ast
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolStart { tool_id, detail, .. } => {
                    Some((tool_id.as_str(), detail.as_deref().unwrap_or("")))
                }
                _ => None,
            })
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0].1, r#"{"Path":"/tmp/first.rs"}"#);
        assert_eq!(starts[1].1, r#"{"Path":"/tmp/second.rs"}"#);

        // FIFO tool outputs match their exact corresponding ToolStart IDs!
        let ends: Vec<(&str, &str)> = ast
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolEnd { tool_id, detail, .. } => {
                    Some((tool_id.as_str(), detail.as_deref().unwrap_or("")))
                }
                _ => None,
            })
            .collect();
        assert_eq!(ends.len(), 2);
        assert_eq!(ends[0], (starts[0].0, "FIRST_CONTENT"));
        assert_eq!(ends[1], (starts[1].0, "SECOND_CONTENT"));

        // Orphan GENERIC never leaks into Assistant prose.
        assert!(!ast.events.iter().any(|e| matches!(e, AgentEvent::Assistant { .. })));
        // Background command recorded once.
        assert!(ast.events.iter().any(|e| matches!(e, AgentEvent::BackgroundTasks { tasks } if tasks.len() == 1 && tasks[0].label == "Run tests")));

        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn antigravity_send_message_resumes_subagent_and_schedule_classifies_as_monitor() {
        let child_uuid = "cc7f9ac4-7f59-416d-8867-e491d1b9b009";
        let p = write_jsonl(
            "agy-resume-cron",
            &[
                r#"{"type":"REQUEST","source":"USER_EXPLICIT","created_at":"2026-11-26T13:14:00Z","content":"<USER_REQUEST>run team"}"#,
                r#"{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T13:14:37Z","tool_calls":[{"name":"invoke_subagent","args":{"TypeName":"\"teamwork\"","Role":"\"Team Coord\""}},{"name":"schedule","args":{"CronExpression":"\"*/8 * * * *\"","Prompt":"\"Monitor\""}}]}"#,
                &format!(r#"{{"type":"GENERIC","created_at":"2026-11-26T13:15:09Z","content":"Created the following subagent: {{\"conversationId\": \"{child_uuid}\"}}"}}"#),
                r#"{"type":"GENERIC","status":"RUNNING","created_at":"2026-11-26T13:15:10Z","content":"Tool is running as a background task with task id: conv/task-cron\nTask Description: Cron"}"#,
                &format!(r#"{{"type":"SYSTEM_MESSAGE","created_at":"2026-11-26T13:16:22Z","content":"[Message] sender={child_uuid} content=Started"}}"#),
                &format!(r#"{{"type":"PLANNER_RESPONSE","created_at":"2026-11-26T17:52:15Z","tool_calls":[{{"name":"send_message","args":{{"Recipient":"\"{child_uuid}\"","Message":"\"Resume\""}}}}]}}"#),
                r#"{"type":"GENERIC","created_at":"2026-11-26T17:52:20Z","content":"Message sent"}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-agy-res", 10).unwrap();
        let ast = &turns[1];
        let sub = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents[0].clone()),
                _ => None,
            })
            .expect("subagent present");
        assert_eq!(sub.state, SubagentState::Working);
        assert_eq!(sub.settled_at, None);

        let cron = ast
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::BackgroundTasks { tasks } => Some(tasks[0].clone()),
                _ => None,
            })
            .expect("cron task present");
        assert_eq!(cron.kind, crate::protocol::event::BackgroundTaskKind::Monitor);

        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn codex_paginated_keeps_apply_patch_and_reasoning_and_exit_status() {
        let p = write_jsonl(
            "codex-pg-tools",
            &[
                r#"{"type":"session_meta","payload":{"id":"s","history_mode":"paginated"}}"#,
                r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"input_text","text":"<skill>hidden</skill>"},{"type":"input_text","text":"patch file"}]}}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","summary_text":["Inspecting target"]}}}"#,
                r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"cp-1","input":"*** Begin Patch"}}"#,
                r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"cp-1","output":"Success."}}"#,
                r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"id":"cmd-1","type":"CommandExecution","command":["cargo","check"],"aggregated_output":"error[E0425]","exit_code":1}}}"#,
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":80}}}}"#,
                r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-x", 10).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].events, vec![AgentEvent::User { text: "patch file".into() }]);
        let evs = &turns[1].events;
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Thinking { text, .. } if text == "Inspecting target")));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolStart { name, .. } if name == "apply_patch")));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolEnd { tool_id, ok: false, .. } if tool_id == "cmd-1")));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Usage { input_tokens: 1000, cache_read_tokens: 200, output_tokens: 80, .. })));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Status { text } if text == "Interrupted")));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn kiro_preserves_resolved_awaiting_input_and_groups_subagents() {
        let p = write_jsonl(
            "kiro-receipt",
            &[
                r#"{"id":"1","timestamp":"2026-11-25T10:00:00Z","payload":{"type":"user","content":"deploy"}}"#,
                r#"{"id":"2","timestamp":"2026-11-25T10:00:01Z","payload":{"type":"pending_interaction","toolCallId":"c1","question":"Allow deploy?","options":[{"optionId":"o1","name":"Allow once"}]}}"#,
                r#"{"id":"3","timestamp":"2026-11-25T10:00:02Z","payload":{"type":"interaction_resolved","toolCallId":"c1","outcome":"selected"}}"#,
                r#"{"id":"4","timestamp":"2026-11-25T10:00:03Z","payload":{"type":"sub_agent_start","subSessionId":"sub-a","subAgentName":"Tester"}}"#,
                r#"{"id":"5","timestamp":"2026-11-25T10:00:04Z","payload":{"type":"sub_agent_start","subSessionId":"sub-b","subAgentName":"Linter"}}"#,
                r#"{"id":"6","timestamp":"2026-11-25T10:00:05Z","payload":{"type":"user","content":"status?"}}"#,
                r#"{"id":"7","timestamp":"2026-11-25T10:00:06Z","payload":{"type":"sub_agent_complete","subSessionId":"sub-a","status":"completed"}}"#,
            ],
        );
        let turns = TranscriptReader::read_recent_turns(&p, "surf-k", 10).unwrap();
        let ask = turns[1]
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::AwaitingInput(a) => Some(a),
                _ => None,
            })
            .expect("preserved AwaitingInput");
        assert_eq!(ask.answered.as_deref(), Some("Allow once"));

        let sub_cards: Vec<_> = turns[1]
            .events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::Subagents { agents, .. } => Some(agents),
                _ => None,
            })
            .collect();
        assert_eq!(sub_cards.len(), 1, "grouped into a single Subagents card");
        assert_eq!(sub_cards[0].len(), 2);
        assert_eq!(sub_cards[0][0].state, SubagentState::Completed, "cross-turn completion");
        assert_eq!(sub_cards[0][1].state, SubagentState::Working);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn large_transcript_tail_window_pagination_and_rewrite_detection() {
        let path = std::env::temp_dir().join(format!("cmux-tail-win-{}.jsonl", uuid::Uuid::new_v4()));
        let mut f = File::create(&path).unwrap();
        let padding = "x".repeat(4500);
        for idx in 0..40 {
            writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"prompt-{idx} {padding}"}}}}"#).unwrap();
            writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"reply-{idx} {padding}"}}]}}}}"#).unwrap();
        }
        drop(f);

        let tail_page = TranscriptReader::read_turns_page(&path, "surf-tail", 10, None).unwrap();
        assert_eq!(tail_page.turns.len(), 10);
        assert!(tail_page.has_more);
        assert!(tail_page.turns[0].id.starts_with("turn-@"));

        let mut all_turns = tail_page.turns.clone();
        let mut cursor = tail_page.before_offset;
        while let Some(off) = cursor {
            let older = TranscriptReader::read_turns_page(&path, "surf-tail", 14, Some(off)).unwrap();
            assert!(older.turns[0].id.starts_with("turn-@"), "oldest page keeps turn-@off IDs");
            let mut combined = older.turns;
            combined.extend(all_turns);
            all_turns = combined;
            cursor = if older.has_more { older.before_offset } else { None };
        }
        assert_eq!(all_turns.len(), 80);

        // Rewrite file with LARGER size (`new_len > old_offset`): 64-byte boundary digest detects replacement!
        let bigger = "y".repeat(10_000);
        let mut f = File::create(&path).unwrap();
        for idx in 0..25 {
            writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":"replaced-{idx} {bigger}"}}}}"#).unwrap();
            writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"fresh-{idx} {bigger}"}}]}}}}"#).unwrap();
        }
        // Append an incomplete trailing line without `\n`: live reader must NOT consume it yet!
        write!(f, r#"{{"type":"user","message":{{"role":"user","content":"half-written"#).unwrap();
        drop(f);

        let after_rewrite = TranscriptReader::read_turns_page(&path, "surf-tail", 10, None).unwrap();
        assert!(matches!(
            &after_rewrite.turns.last().unwrap().events[0],
            AgentEvent::Assistant { text } if text.starts_with("fresh-24 ")
        ));

        let _ = std::fs::remove_file(&path);
    }
}
