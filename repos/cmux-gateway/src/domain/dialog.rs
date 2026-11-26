//! Shared TUI box-border stripping, approval context extraction, and interactive question/approval key planners.

use serde::Deserialize;

use crate::cmux::agent_profile::{profile_for, ApproveInput};
use crate::cmux::startup_dialog;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionStep {
    Key(&'static str),
    Text(String),
    Paste(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionAnswerPlan {
    TuiSteps(Vec<QuestionStep>),
    PromptFallback(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct QuestionAnswerSelection {
    #[serde(default)]
    pub indices: Vec<usize>,
    #[serde(default)]
    pub other: Option<String>,
    #[serde(default)]
    pub option_count: usize,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMenu {
    pub row_count: usize,
    pub cursor_index: usize,
    pub write_in_index: Option<usize>,
}

/// Strips leading/trailing Unicode/ASCII vertical box borders (`│`, `┃`, `║`) and surrounding spaces.
pub fn clean_box_line(raw: &str) -> String {
    raw.trim()
        .trim_matches(['│', '┃', '║'])
        .trim()
        .to_string()
}

/// True when a line is purely a horizontal/corner TUI box border (`╭──╮`, `╰──╯`, `────`, etc.).
pub fn is_box_border_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let first = t.chars().next().unwrap_or(' ');
    if matches!(first, '╭' | '┌' | '╰' | '└' | '├' | '╟' | '╠')
        && t.chars().all(|c| {
            matches!(
                c,
                '╭' | '╮'
                    | '┌'
                    | '┐'
                    | '╰'
                    | '╯'
                    | '└'
                    | '┘'
                    | '├'
                    | '┤'
                    | '┬'
                    | '┴'
                    | '┼'
                    | '╟'
                    | '╢'
                    | '╠'
                    | '╣'
                    | '─'
                    | '━'
                    | '═'
                    | '-'
                    | ' '
            )
        })
    {
        return true;
    }
    t.chars().count() >= 4
        && t.chars()
            .all(|c| matches!(c, '─' | '━' | '═' | '-' | ' '))
}

/// Normalizes a terminal capture into non-empty content lines with box borders removed.
pub fn strip_screen_box_lines(screen: &str) -> Vec<String> {
    screen
        .lines()
        .filter(|raw| !is_box_border_line(raw))
        .map(clean_box_line)
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn is_numbered_choice_line(line: &str, prefix: &str) -> bool {
    let t = line.trim_start_matches(['›', '❯', '>', ' ']);
    t.starts_with(prefix)
}

/// Extracts the approval question/command shown above numbered choices (`1. ...`) on the terminal screen.
pub fn extract_approval_screen_context(screen: &str) -> Option<String> {
    let lines: Vec<String> = screen
        .lines()
        .map(|raw| {
            if is_box_border_line(raw) {
                "────".to_string()
            } else {
                clean_box_line(raw)
            }
        })
        .collect();
    let first_opt_idx = lines.iter().rposition(|l| is_numbered_choice_line(l, "1."))?;
    let lookahead_end = (first_opt_idx + 10).min(lines.len());
    let has_dialog_tail = lines[first_opt_idx + 1..lookahead_end].iter().any(|l| {
        let lower = l.to_ascii_lowercase();
        is_numbered_choice_line(l, "2.")
            || is_numbered_choice_line(l, "3.")
            || ((lower.contains("confirm") || lower.contains("cancel") || lower.contains("select"))
                && (lower.contains("esc") || lower.contains("enter")))
    });
    if !has_dialog_tail {
        return None;
    }

    let mut collected = Vec::new();
    let mut blank_streak = 0usize;
    for line in lines[..first_opt_idx].iter().rev() {
        if is_box_border_line(line) {
            if !collected.is_empty() {
                break;
            }
            continue;
        }
        if line.is_empty() {
            blank_streak += 1;
            if blank_streak >= 2 && !collected.is_empty() {
                break;
            }
            continue;
        }
        blank_streak = 0;
        if matches!(line.as_str(), "›" | "❯") {
            break;
        }
        collected.push(line.clone());
        if collected.len() >= 8 {
            break;
        }
    }
    if collected.is_empty() {
        return None;
    }
    collected.reverse();
    let joined = collected.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= 360 {
        Some(trimmed.to_string())
    } else {
        let mut out: String = trimmed.chars().take(359).collect();
        out.push('…');
        Some(out)
    }
}

/// Detect numbered question/approval menu rows (`> 1. Option A`, `  2. Option B`, `  4. Write-in...`)
/// near the bottom of a terminal screen capture (supporting boxed TUI layouts).
pub fn detect_numbered_question_menu(screen: &str) -> Option<ParsedMenu> {
    let raw_lines: Vec<&str> = screen.lines().collect();
    let start = raw_lines.len().saturating_sub(36);
    let tail = &raw_lines[start..];

    // Anchor after the last horizontal rule / box top border or `Question` header if present so earlier
    // prose numbered lists (`1. **brew services**...`) are never mistaken for the picker!
    let anchor = tail
        .iter()
        .enumerate()
        .rposition(|(idx, l)| {
            let cleaned = clean_box_line(l);
            if cleaned.starts_with("Question ") {
                return true;
            }
            // Only treat a box border as the *top* anchor if numbered items appear after it!
            is_box_border_line(l)
                && tail[idx + 1..]
                    .iter()
                    .any(|after| is_numbered_choice_line(&clean_box_line(after), "1."))
        })
        .unwrap_or(0);

    let mut rows: Vec<(usize, bool, String)> = Vec::new();
    for line in &tail[anchor..] {
        if is_box_border_line(line) {
            continue;
        }
        let cleaned = clean_box_line(line);
        let t = cleaned.as_str();
        let (has_cursor, rest) = match t.chars().next() {
            Some('>' | '\u{203a}' | '\u{276f}') => {
                let c = t.chars().next().unwrap();
                (true, t[c.len_utf8()..].trim_start())
            }
            _ => (false, t),
        };
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || digits > 2 {
            continue;
        }
        let Ok(num) = rest[..digits].parse::<usize>() else {
            continue;
        };
        let Some(label) = rest[digits..].strip_prefix('.').map(str::trim) else {
            continue;
        };
        if label.is_empty() || num == 0 {
            continue;
        }
        if num == rows.len() + 1 {
            rows.push((num - 1, has_cursor, label.to_lowercase()));
        } else if num == 1 {
            rows.clear();
            rows.push((0, has_cursor, label.to_lowercase()));
        }
    }

    if rows.len() < 2 {
        return None;
    }

    let cursor_index = rows.iter().find(|r| r.1).map(|r| r.0).unwrap_or(0);
    let write_in_index = rows
        .iter()
        .find(|r| {
            r.2.starts_with("write-in")
                || r.2.starts_with("type something")
                || r.2.starts_with("other")
        })
        .map(|r| r.0);

    Some(ParsedMenu {
        row_count: rows.len(),
        cursor_index,
        write_in_index,
    })
}

pub fn push_cursor_moves(steps: &mut Vec<QuestionStep>, from: usize, to: usize) {
    if to > from {
        for _ in 0..(to - from) {
            steps.push(QuestionStep::Key("down"));
        }
    } else if from > to {
        for _ in 0..(from - to) {
            steps.push(QuestionStep::Key("up"));
        }
    }
}

/// Plans terminal steps to answer a single question menu, returning `Err(dialog_label)` if a
/// startup dialog owns the terminal screen.
pub fn plan_question_answer_steps_checked(
    screen: Option<&str>,
    agent_kind: &str,
    indices: &[usize],
    other: Option<&str>,
    option_count: usize,
    multi_select: bool,
) -> Result<QuestionAnswerPlan, &'static str> {
    if let Some(kind) = screen.and_then(startup_dialog::detect) {
        return Err(kind.label());
    }
    Ok(plan_question_answer_steps(
        screen,
        agent_kind,
        indices,
        other,
        option_count,
        multi_select,
    ))
}

pub fn plan_question_answer_steps(
    screen: Option<&str>,
    agent_kind: &str,
    indices: &[usize],
    other: Option<&str>,
    option_count: usize,
    multi_select: bool,
) -> QuestionAnswerPlan {
    let other_clean = other.map(str::trim).filter(|s| !s.is_empty());
    let kind = crate::cmux::agents::spec_for(agent_kind)
        .map(|s| s.kind)
        .unwrap_or(agent_kind);

    if let Some(menu) = screen.and_then(detect_numbered_question_menu) {
        let mut steps = Vec::new();
        let mut cur = menu.cursor_index;

        if multi_select {
            if kind == "claude" {
                for &idx in indices {
                    steps.push(QuestionStep::Text((idx + 1).to_string()));
                }
                if let Some(text) = other_clean {
                    let write_row = menu.write_in_index.unwrap_or(option_count) + 1;
                    steps.push(QuestionStep::Text(write_row.to_string()));
                    steps.push(QuestionStep::Paste(text.to_string()));
                    steps.push(QuestionStep::Key("enter"));
                }
                steps.push(QuestionStep::Key("right"));
                steps.push(QuestionStep::Key("enter"));
                return QuestionAnswerPlan::TuiSteps(steps);
            }
            for &idx in indices {
                if idx < menu.row_count {
                    push_cursor_moves(&mut steps, cur, idx);
                    cur = idx;
                    steps.push(QuestionStep::Key("space"));
                }
            }
            if let Some(text) = other_clean {
                let target = menu
                    .write_in_index
                    .unwrap_or_else(|| option_count.min(menu.row_count.saturating_sub(1)));
                push_cursor_moves(&mut steps, cur, target);
                steps.push(QuestionStep::Key("enter"));
                steps.push(QuestionStep::Paste(text.to_string()));
                steps.push(QuestionStep::Key("enter"));
                return QuestionAnswerPlan::TuiSteps(steps);
            }
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }

        // Single-select with custom `other` / `Write-in...` / Codex note
        if let Some(text) = other_clean {
            let target = if kind == "codex" {
                // Codex attaches notes (`Tab`) to the selected option row if one was picked,
                // or to the trailing option_count row otherwise (`buildCodexAskAnswerKeys`).
                indices
                    .first()
                    .copied()
                    .unwrap_or_else(|| menu.write_in_index.unwrap_or(option_count))
                    .min(menu.row_count.saturating_sub(1))
            } else {
                menu.write_in_index
                    .unwrap_or_else(|| option_count.min(menu.row_count.saturating_sub(1)))
            };
            push_cursor_moves(&mut steps, cur, target);
            if kind == "codex" {
                steps.push(QuestionStep::Key("tab"));
            } else {
                steps.push(QuestionStep::Key("enter"));
            }
            steps.push(QuestionStep::Paste(text.to_string()));
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }

        // Single-select option pick
        if let Some(&target) = indices.first()
            && target < menu.row_count
        {
            push_cursor_moves(&mut steps, cur, target);
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }
    }

    let fallback = if let Some(text) = other_clean {
        text.to_string()
    } else if let Some(&idx) = indices.first() {
        (idx + 1).to_string()
    } else {
        String::new()
    };
    QuestionAnswerPlan::PromptFallback(fallback)
}

/// Plans batch multi-question key steps for Claude & Codex selector wizards
/// (`ref/orca/src/shared/native-chat/input/native-chat-ask-answer.ts:114-219`).
pub fn plan_batch_question_steps_for_selector(
    agent_kind: &str,
    selections: &[QuestionAnswerSelection],
) -> Option<Vec<QuestionStep>> {
    let kind = crate::cmux::agents::spec_for(agent_kind)
        .map(|s| s.kind)
        .unwrap_or(agent_kind);
    let multi_question = selections.len() > 1;
    let mut steps = Vec::new();

    if kind == "claude" {
        for sel in selections {
            let other = sel.other.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let type_something = (sel.option_count + 1).to_string();
            if sel.multi_select {
                for &idx in &sel.indices {
                    steps.push(QuestionStep::Text((idx + 1).to_string()));
                }
                if let Some(text) = other {
                    steps.push(QuestionStep::Text(type_something));
                    steps.push(QuestionStep::Paste(text.to_string()));
                    steps.push(QuestionStep::Key("enter"));
                }
                steps.push(QuestionStep::Key("right"));
            } else if let Some(text) = other {
                steps.push(QuestionStep::Text(type_something));
                steps.push(QuestionStep::Paste(text.to_string()));
                steps.push(QuestionStep::Key("enter"));
            } else if let Some(&idx) = sel.indices.first() {
                steps.push(QuestionStep::Text((idx + 1).to_string()));
            } else if multi_question {
                steps.push(QuestionStep::Key("right"));
            }
        }
        let ends_on_submit =
            multi_question || (selections.len() == 1 && selections[0].multi_select);
        if ends_on_submit && !steps.is_empty() {
            steps.push(QuestionStep::Key("enter"));
        }
        return Some(steps);
    }

    if kind == "codex" {
        let mut has_unanswered = false;
        for (qi, sel) in selections.iter().enumerate() {
            let other = sel.other.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let selected = sel.indices.first().copied();
            if let Some(note) = other {
                let target = selected.unwrap_or(sel.option_count);
                for _ in 0..target {
                    steps.push(QuestionStep::Key("down"));
                }
                steps.push(QuestionStep::Key("tab"));
                steps.push(QuestionStep::Paste(note.to_string()));
                steps.push(QuestionStep::Key("enter"));
            } else if let Some(idx) = selected {
                steps.push(QuestionStep::Text((idx + 1).to_string()));
            } else {
                has_unanswered = true;
                steps.push(QuestionStep::Key("backspace"));
                if qi + 1 < selections.len() {
                    steps.push(QuestionStep::Key("right"));
                } else {
                    steps.push(QuestionStep::Key("enter"));
                }
            }
        }
        if has_unanswered {
            steps.push(QuestionStep::Key("enter"));
        }
        return Some(steps);
    }

    None
}

fn screen_has_unnumbered_approval_cue(screen: &str) -> bool {
    let lines = strip_screen_box_lines(screen);
    let from = lines.len().saturating_sub(24);
    let tail_lower = lines[from..].join("\n").to_lowercase();
    [
        "allow",
        "approve",
        "permission",
        "confirm",
        "[y/n]",
        "(y/n)",
        "yes/no",
        "proceed",
        "would you like to run",
        "do you want to",
        "accept",
        "grant",
        "press enter",
    ]
    .iter()
    .any(|kw| tail_lower.contains(kw))
}

/// Plans safe approval keystrokes from the live screen:
/// - Rejects startup dialogs (`Err(StartupDialog)`)
/// - Rejects idle prompts with no approval/menu context (`Err(NoApprovalContext)`)
/// - Moves cursor up to option 1 (`index 0`) when a numbered menu has `cursor_index > 0` on `ApproveInput::Key("enter")` agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalPlanError {
    StartupDialog(&'static str),
    NoApprovalContext,
}

pub fn plan_approval_steps(
    screen: &str,
    agent_kind: &str,
) -> Result<Vec<QuestionStep>, ApprovalPlanError> {
    if let Some(kind) = startup_dialog::detect(screen) {
        return Err(ApprovalPlanError::StartupDialog(kind.label()));
    }

    let menu = detect_numbered_question_menu(screen);
    let has_context = menu.is_some()
        || extract_approval_screen_context(screen).is_some()
        || screen_has_unnumbered_approval_cue(screen);

    if !has_context {
        return Err(ApprovalPlanError::NoApprovalContext);
    }

    let mut steps = Vec::new();
    match profile_for(agent_kind).approve {
        ApproveInput::Text(t) => {
            steps.push(QuestionStep::Text(t.to_string()));
        }
        ApproveInput::Key(k) => {
            if let Some(m) = menu
                && m.cursor_index > 0
            {
                push_cursor_moves(&mut steps, m.cursor_index, 0);
            }
            steps.push(QuestionStep::Key(k));
        }
    }
    Ok(steps)
}

/// Plans interrupt keystrokes per agent (`escape`, or two `escape`s 60ms apart for OpenCode).
/// Source: `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:45-48`
pub fn plan_interrupt_keys(agent_kind: Option<&str>) -> (&'static [&'static str], u64) {
    let canonical = agent_kind
        .and_then(crate::cmux::agents::spec_for)
        .map(|s| s.kind)
        .or_else(|| {
            agent_kind
                .map(str::trim)
                .filter(|k| k.eq_ignore_ascii_case("zcode"))
                .map(|_| "opencode")
        });
    if canonical == Some("opencode") {
        (&["escape", "escape"], 60)
    } else {
        (&["escape"], 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_boxed_question_menu_and_approval_context() {
        let boxed_screen = "\
╭────────────────────────────────────────────────────────╮
│ Would you like to run the following command?           │
│   $ rm -rf dist                                        │
│ › 1. Yes, allow once                                   │
│   2. Always allow                                      │
│   3. Deny (esc)                                        │
╰────────────────────────────────────────────────────────╯";
        assert_eq!(
            extract_approval_screen_context(boxed_screen).as_deref(),
            Some("Would you like to run the following command?\n$ rm -rf dist")
        );
        let menu = detect_numbered_question_menu(boxed_screen).expect("boxed menu");
        assert_eq!(menu.row_count, 3);
        assert_eq!(menu.cursor_index, 0);
    }

    #[test]
    fn guards_question_and_approval_against_startup_dialog_and_idle_composer() {
        let trust = "\
╭──────────────────────────────────────────────╮
│ Trust this folder?                           │
│ › 1. Trust and continue                      │
│   2. Quit                                    │
│   enter continue · esc back                  │
╰──────────────────────────────────────────────╯";
        assert_eq!(
            plan_question_answer_steps_checked(Some(trust), "codex", &[0], None, 2, false),
            Err("folder trust")
        );
        assert_eq!(
            plan_approval_steps(trust, "codex"),
            Err(ApprovalPlanError::StartupDialog("folder trust"))
        );

        let idle = "› Ask Codex to do anything\n  gpt-5.6 · ~/project\n";
        assert_eq!(
            plan_approval_steps(idle, "codex"),
            Err(ApprovalPlanError::NoApprovalContext)
        );

        let cursor_on_two = "\
  Allow Bash tool?
    1. Allow once
  › 2. Deny
  enter to confirm · esc to cancel";
        assert_eq!(
            plan_approval_steps(cursor_on_two, "kiro"),
            Ok(vec![QuestionStep::Key("up"), QuestionStep::Key("enter")])
        );
    }

    #[test]
    fn codex_other_attaches_note_to_selected_index_when_provided() {
        let screen = "\
Question 1/1: Pick target
› 1. Production
  2. Staging
  3. Other
";
        assert_eq!(
            plan_question_answer_steps(Some(screen), "codex", &[1], Some("after freeze"), 2, false),
            QuestionAnswerPlan::TuiSteps(vec![
                QuestionStep::Key("down"),
                QuestionStep::Key("tab"),
                QuestionStep::Paste("after freeze".into()),
                QuestionStep::Key("enter"),
            ])
        );
    }

    #[test]
    fn interrupt_uses_escape_and_double_escape_for_opencode() {
        assert_eq!(plan_interrupt_keys(Some("claude")), (&["escape"][..], 0));
        assert_eq!(plan_interrupt_keys(Some("codex")), (&["escape"][..], 0));
        assert_eq!(plan_interrupt_keys(Some("agy")), (&["escape"][..], 0));
        assert_eq!(plan_interrupt_keys(Some("opencode")), (&["escape", "escape"][..], 60));
        assert_eq!(plan_interrupt_keys(Some("opencode2")), (&["escape", "escape"][..], 60));
    }
}
