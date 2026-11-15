//! Detects an agent's startup dialog ("Trust this folder?", update prompts, MCP / API-key menus) on a
//! terminal screen, so the gateway never types a chat message and an Enter into one.
//!
//! Why this matters (verified live on Codex 0.169.0, 2026-11-14): with the trust dialog open,
//! `cmux send --paste hi` and `cmux send-key enter` both return OK even without `--force` (cmux's own
//! guard only covers agents it already has hooks for), and the Enter selected the default
//! "Trust and continue", i.e. it silently granted the folder trust.
//!
//! Detection follows Orca (ref/orca/src/main/runtime/terminal/output/startup-dialog-screen.ts:12-70,
//! ref/orca/src/main/runtime/agent-state-rules/blocked-text-layer.ts:9-85,
//! ref/orca/src/main/runtime/terminal/wait/startup-dialog-blocked-signals.ts): a live dialog ENDS on a
//! key footer, so a reply that merely quotes dialog text is not matched; the dialog kind comes from
//! sentinel phrases on the same screen.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    /// "Do you trust this folder?" (Codex, Claude, Antigravity...).
    FolderTrust,
    /// "Update available" / "just got an upgrade".
    UpdatePrompt,
    /// Other first-run menus: hooks review, MCP servers, custom API key, bypass permissions, cwd chooser.
    StartupMenu,
}

impl DialogKind {
    pub fn label(&self) -> &'static str {
        match self {
            DialogKind::FolderTrust => "folder trust",
            DialogKind::UpdatePrompt => "update",
            DialogKind::StartupMenu => "startup menu",
        }
    }
}

/// How many bottom lines of the screen are inspected (Orca `LIVE_PROMPT_TAIL_LINES` = 12; dialogs here
/// are 7-10 lines, a little more room for wrapped headings).
const TAIL_LINES: usize = 16;

fn is_key_footer(line: &str) -> bool {
    let has_dot = line.contains('\u{b7}');
    // `enter continue · esc back` (Codex 0.169.0, observed), `enter to confirm · esc to cancel` and
    // `space to select · esc to reject all` (Claude), `enter/esc continue · esc quit` (Codex notices).
    let enter_footer = line.contains("enter")
        && (line.contains("continue") || line.contains("confirm"))
        && (line.contains("esc") || line.contains("ctrl+c"));
    let select_footer = line.contains("space to select") && line.contains("esc");
    // Pre-0.157 Codex wording: "press enter to continue".
    let legacy_footer = line.contains("press enter to")
        && (line.contains("continue") || line.contains("confirm") || line.contains("view") || line.contains("insert"));
    legacy_footer || ((enter_footer || select_footer) && has_dot)
}

/// One selectable row of a dialog and the `cmux send-key` names that select it (arrow keys from the
/// highlighted row, then Enter), like Orca's `menuKeys` (startup-dialog-screen.ts:100-103).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogChoice {
    pub label: String,
    pub keys: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogInfo {
    pub kind: DialogKind,
    /// First question on the screen, e.g. "Trust this folder?".
    pub title: String,
    /// The dialog text the user must read before answering.
    pub description: String,
    /// Empty when the layout is not the known numbered list: only the terminal can answer it.
    pub choices: Vec<DialogChoice>,
    /// Identity of the dialog content. The highlight position is excluded, so moving the cursor in the
    /// terminal does not change it; answers are refused when it no longer matches (Orca
    /// `requireStartupDialog`, terminal-send-method.ts:177-186).
    pub fingerprint: String,
}

const CURSOR_MARKERS: [char; 3] = ['\u{203a}', '\u{276f}', '>'];
const MAX_DESCRIPTION_CHARS: usize = 1500;

fn fnv1a(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// `› 1. Trust and continue` -> (has_cursor, "Trust and continue")
fn parse_choice_row(line: &str) -> Option<(bool, String)> {
    let t = line.trim();
    let (cursor, rest) = match t.chars().next() {
        Some(c) if CURSOR_MARKERS.contains(&c) => (true, t[c.len_utf8()..].trim_start()),
        _ => (false, t),
    };
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 2 {
        return None;
    }
    let label = rest[digits..].strip_prefix('.')?.trim();
    (!label.is_empty()).then(|| (cursor, label.to_string()))
}

pub fn analyze(screen: &str) -> Option<DialogInfo> {
    let original: Vec<&str> = screen.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let lowered: Vec<String> = original.iter().map(|l| l.to_lowercase()).collect();
    let last = lowered.last()?;
    if !is_key_footer(last) {
        return None;
    }
    let from = lowered.len().saturating_sub(TAIL_LINES);
    let tail = lowered[from..].join("\n");

    let kind = {
        let trust_at = ["do you trust", "trust this", "trusted workspace"]
            .iter()
            .filter_map(|k| tail.rfind(k))
            .max();
        let trust = trust_at.is_some_and(|i| {
            let seg = &tail[i..];
            ["workspace", "folder", "directory", "repo"].iter().any(|w| seg.contains(w))
        });
        if trust {
            DialogKind::FolderTrust
        } else if tail.contains("update available") || tail.contains("just got an upgrade") {
            DialogKind::UpdatePrompt
        } else if [
            "hooks need review",
            "new mcp server",
            "custom api key",
            "bypass permissions mode",
            "external claude.md",
            "choose working directory to",
        ]
        .iter()
        .any(|m| tail.contains(m))
            // Codex model-upgrade notice, observed live on Codex 0.169.0 (2026-11-15): "Meet GPT-6 Sol ...
            // 1. Try new model / 2. Use existing model". Answering it writes ~/.codex/config.toml, and a
            // gateway that typed into it switched the model and ran a prompt (see audit_report.md section M).
            || (tail.contains("try new model") && tail.contains("use existing model"))
        {
            DialogKind::StartupMenu
        } else {
            return None;
        }
    };

    // Rows of the visible dialog, without the key footer.
    let rows = &original[from..original.len() - 1];
    let mut choice_rows: Vec<(bool, String)> = Vec::new();
    let mut text_rows: Vec<&str> = Vec::new();
    for row in rows {
        match parse_choice_row(row) {
            Some(c) => choice_rows.push(c),
            None => text_rows.push(row),
        }
    }
    let cursors = choice_rows.iter().filter(|(c, _)| *c).count();
    let cursor = choice_rows.iter().position(|(c, _)| *c);
    let choices = match (cursor, cursors) {
        (Some(cur), 1) if choice_rows.len() >= 2 => choice_rows
            .iter()
            .enumerate()
            .map(|(i, (_, label))| {
                let mut keys: Vec<&'static str> = Vec::new();
                for _ in 0..i.abs_diff(cur) {
                    keys.push(if i > cur { "down" } else { "up" });
                }
                keys.push("enter");
                DialogChoice { label: label.clone(), keys }
            })
            .collect(),
        _ => Vec::new(),
    };

    let description: String = text_rows.join("\n").chars().take(MAX_DESCRIPTION_CHARS).collect();
    let title = text_rows
        .iter()
        .find_map(|r| r.find('?').map(|i| r[..=i].to_string()))
        .unwrap_or_else(|| kind.label().to_string());
    let identity = format!(
        "{}\n{}",
        text_rows.iter().map(|r| r.to_lowercase()).collect::<Vec<_>>().join("\n"),
        choice_rows.iter().map(|(_, l)| l.to_lowercase()).collect::<Vec<_>>().join("\n"),
    );
    Some(DialogInfo { kind, title, description, choices, fingerprint: fnv1a(&identity) })
}

pub fn detect(screen: &str) -> Option<DialogKind> {
    analyze(screen).map(|d| d.kind)
}

/// Surfaces whose screen currently shows a startup dialog (filled by the dialog watcher and the chat
/// watchers), so the tree can report them as waiting. surface id -> (fingerprint, seen at).
pub mod registry {
    use std::collections::HashMap;
    use std::sync::{LazyLock, RwLock};
    use std::time::{Duration, Instant};

    static SEEN: LazyLock<RwLock<HashMap<String, (String, Instant)>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
    const FRESH: Duration = Duration::from_secs(10);

    pub fn set(surface_id: &str, fingerprint: Option<&str>) {
        if let Ok(mut m) = SEEN.write() {
            match fingerprint {
                Some(fp) => {
                    m.insert(surface_id.to_string(), (fp.to_string(), Instant::now()));
                }
                None => {
                    m.remove(surface_id);
                }
            }
        }
    }

    pub fn is_waiting(surface_id: &str) -> bool {
        SEEN.read()
            .ok()
            .and_then(|m| m.get(surface_id).map(|(_, at)| at.elapsed() < FRESH))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real Codex 0.169.0 session (cmux read-screen), folder never trusted before.
    const CODEX_TRUST: &str = "  Folder access
  /Users/dev/projects/tool-x

  Trust this folder? Codex can read, edit, and run files here, subject to your permission
  settings. Folder settings can run code automatically, even without a model request.
  Continue only if you trust these files. Your trust decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back
";
    // Captured: Codex ready composer.
    const CODEX_READY: &str = "› Ask Codex to do anything
  gemini-4-hydrogen default · ~/projects/project-c
  ← for agents · ? for shortcuts                                   ⚠ 2 warnings · f2 to view
";

    #[test]
    fn detects_real_codex_folder_trust_dialog() {
        assert_eq!(detect(CODEX_TRUST), Some(DialogKind::FolderTrust));
    }

    #[test]
    fn ready_composer_is_not_a_dialog() {
        assert_eq!(detect(CODEX_READY), None);
    }

    #[test]
    fn quoted_dialog_text_in_a_reply_is_not_a_dialog() {
        // The agent quotes the dialog, but the screen ends on the composer, not a key footer.
        let screen = "• You'll see: Trust this folder? ... Trust and continue\n› Ask Codex to do anything\n  ← for agents · ? for shortcuts\n";
        assert_eq!(detect(screen), None);
    }

    #[test]
    fn detects_other_startup_dialogs() {
        let update = "  Update available! 0.168 -> 0.169\n  1. Update now\n  2. Skip\n  enter continue · esc skip\n";
        assert_eq!(detect(update), Some(DialogKind::UpdatePrompt));
        let claude = "  New MCP server found in .mcp.json: foo\n  1. Use this server\n  2. Skip\n  Enter to confirm · Esc to cancel\n";
        assert_eq!(detect(claude), Some(DialogKind::StartupMenu));
        let legacy = "  Do you trust the files in this folder?\n  Press enter to continue\n";
        assert_eq!(detect(legacy), Some(DialogKind::FolderTrust));
    }

    #[test]
    fn mid_session_picker_without_sentinel_is_not_blocked() {
        let picker = "  Select model\n  1. a\n  2. b\n  enter confirm · esc back\n";
        assert_eq!(detect(picker), None);
        assert_eq!(detect(""), None);
    }

    #[test]
    fn analyze_extracts_choices_and_aimed_keys() {
        let d = analyze(CODEX_TRUST).expect("dialog");
        assert_eq!(d.kind, DialogKind::FolderTrust);
        assert_eq!(d.title, "Trust this folder?");
        assert!(d.description.contains("Folder access"));
        assert!(d.description.contains("tool-x"));
        assert!(!d.description.contains("enter continue"));
        let labels: Vec<&str> = d.choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["Trust and continue", "Back to Agent Command Center"]);
        // Highlight is on row 1: choosing row 1 is Enter, choosing row 2 is Down then Enter.
        assert_eq!(d.choices[0].keys, ["enter"]);
        assert_eq!(d.choices[1].keys, ["down", "enter"]);
    }

    #[test]
    fn fingerprint_ignores_highlight_but_keys_follow_it() {
        let moved = CODEX_TRUST
            .replace("› 1. Trust and continue", "  1. Trust and continue")
            .replace("  2. Back to Agent Command Center", "› 2. Back to Agent Command Center");
        let a = analyze(CODEX_TRUST).unwrap();
        let b = analyze(&moved).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(b.choices[0].keys, ["up", "enter"]);
        assert_eq!(b.choices[1].keys, ["enter"]);
        // A different dialog has a different identity.
        let other = CODEX_TRUST.replace("tool-x", "other-folder");
        assert_ne!(a.fingerprint, analyze(&other).unwrap().fingerprint);
    }

    #[test]
    fn unnumbered_dialog_has_no_aimed_choices() {
        let legacy = "  Do you trust the files in this folder?\n  Press enter to continue\n";
        let d = analyze(legacy).unwrap();
        assert!(d.choices.is_empty());
        assert_eq!(d.title, "Do you trust the files in this folder?");
    }

    /// Real screen captured from Codex 0.169.0 (a model-upgrade notice). The gateway did not recognise it,
    /// so `mobile.chat.setOption`, `chat.send` and `chat.approve` all typed into it.
    #[test]
    fn codex_model_upgrade_notice_is_a_startup_dialog() {
        let screen = "  Meet GPT-6 Sol\n\
            \x20 Our latest Sol is more intelligent and more efficient so your usage limits go further. This model is a great daily driver for complex tasks, especially\n\
            \x20 coding.\n\
            › 1. Try new model\n\
            \x20 2. Use existing model\n\
            \x20 enter/esc confirm · ⌃c quit\n";
        let d = analyze(screen).expect("must be detected");
        assert_eq!(d.kind, DialogKind::StartupMenu);
        assert_eq!(d.choices.len(), 2);
        assert_eq!(d.choices[0].label, "Try new model");
        assert_eq!(detect(screen), Some(DialogKind::StartupMenu));
        // The same words in a normal reply (no key footer) must not match.
        assert!(detect("I suggest we try new model settings or use existing model defaults.\n› _").is_none());
    }
}
