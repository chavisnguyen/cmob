//! Kiro CLI session discovery.
//!
//! cmux writes no `kiro-hook-sessions.json`, so Kiro sessions are located from Kiro's own
//! on-disk layout, verified against a real `~/.kiro` on this machine:
//!   - `<KIRO_HOME>/sessions/<workspace-hash>/sess_<uuid>/messages.jsonl` (transcript)
//!   - `<KIRO_HOME>/sessions/<workspace-hash>/sess_<uuid>/session.json`   (metadata)
//!   - `<KIRO_HOME>/session-leases/sess_<uuid>.lease` (JSON with `pid`, `parentPid`, `clientName`)
//! The lease's `parentPid` is the `kiro-cli` process attached to the terminal; its controlling
//! tty (`ps -o tty= -p <parentPid>`) equals the cmux surface `tty` reported by `cmux tree --json`.
//! `KIRO_HOME` replaces `~/.kiro` outright (ref/orca/src/shared/kiro-home.ts:5-8).

use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::protocol::event::AgentLifecycleState;

/// Bytes read from the end of `messages.jsonl` when deriving the live status.
const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct KiroSession {
    pub session_id: String,
    pub transcript_path: PathBuf,
    pub tty: Option<String>,
    pub lifecycle: AgentLifecycleState,
    pub last_subtitle: Option<String>,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KiroStatus {
    pub lifecycle: AgentLifecycleState,
    pub last_subtitle: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LeaseFile {
    #[serde(default, rename = "parentPid")]
    parent_pid: Option<u32>,
    #[serde(default)]
    pid: Option<u32>,
}

pub struct KiroSessionIndex;

impl KiroSessionIndex {
    pub fn default_home() -> PathBuf {
        if let Ok(v) = std::env::var("KIRO_HOME") {
            let p = PathBuf::from(&v);
            if p.is_absolute() {
                return p;
            }
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".kiro")
    }

    /// Controlling tty of a process via `ps`, e.g. `ttys019`. `None` for `??` or a dead pid.
    pub fn tty_for_pid(pid: u32) -> Option<String> {
        let out = std::process::Command::new("ps")
            .args(["-o", "tty=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() || s.chars().all(|c| c == '?') {
            None
        } else {
            Some(s)
        }
    }

    /// Scan live Kiro sessions and return the most recently modified one per tty.
    pub fn scan_by_tty(home: &Path, tty_for_pid: &dyn Fn(u32) -> Option<String>) -> HashMap<String, KiroSession> {
        let mut by_tty: HashMap<String, KiroSession> = HashMap::new();
        let leases = match fs::read_dir(home.join("session-leases")) {
            Ok(r) => r,
            Err(_) => return by_tty,
        };
        let mut tty_cache: HashMap<u32, Option<String>> = HashMap::new();

        for entry in leases.flatten() {
            let path = entry.path();
            let Some(session_id) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".lease"))
                .map(str::to_string)
            else {
                continue;
            };
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let Ok(lease) = serde_json::from_str::<LeaseFile>(&text) else { continue };
            let Some(pid) = lease.parent_pid.or(lease.pid) else { continue };
            let tty = tty_cache.entry(pid).or_insert_with(|| tty_for_pid(pid)).clone();
            let Some(tty) = tty else { continue };

            let Some(transcript_path) = Self::find_transcript(home, &session_id) else { continue };
            let modified = fs::metadata(&transcript_path).and_then(|m| m.modified()).ok();
            let status = Self::analyze_file(&transcript_path).unwrap_or(KiroStatus {
                lifecycle: AgentLifecycleState::Idle,
                last_subtitle: None,
            });
            let candidate = KiroSession {
                session_id,
                transcript_path,
                tty: Some(tty.clone()),
                lifecycle: status.lifecycle,
                last_subtitle: status.last_subtitle,
                modified,
            };
            match by_tty.get(&tty) {
                Some(existing) if existing.modified >= candidate.modified => {}
                _ => {
                    by_tty.insert(tty, candidate);
                }
            }
        }
        by_tty
    }

    pub fn scan_default_by_tty() -> HashMap<String, KiroSession> {
        Self::scan_by_tty(&Self::default_home(), &Self::tty_for_pid)
    }

    /// Locate `sessions/*/<session_id>/messages.jsonl`.
    pub fn find_transcript(home: &Path, session_id: &str) -> Option<PathBuf> {
        let sessions = fs::read_dir(home.join("sessions")).ok()?;
        for ws in sessions.flatten() {
            let candidate = ws.path().join(session_id).join("messages.jsonl");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// Derive live status from the tail of `messages.jsonl`.
    /// Record types are those observed in real transcripts: `turn_start`, `turn_end`
    /// (`stopReason`), `pending_interaction`/`interaction_resolved` (tool approval) and
    /// `assistant` (`operationType`: Reasoning | Say | Summary).
    pub fn analyze_file(path: &Path) -> Option<KiroStatus> {
        let mut f = File::open(path).ok()?;
        let len = f.metadata().ok()?.len();
        let start = len.saturating_sub(TAIL_BYTES);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        let mut lines = text.lines();
        if start > 0 {
            lines.next(); // first line is likely partial
        }
        Some(Self::analyze_lines(lines))
    }

    pub fn analyze_lines<'a>(lines: impl Iterator<Item = &'a str>) -> KiroStatus {
        let mut in_turn = false;
        let mut pending: Option<String> = None;
        let mut last_stop: Option<String> = None;
        // Live activity of the CURRENT turn only (Orca: "Journal rows are history, not the present, so
        // none of them ever becomes this line", ref/orca/src/shared/native-chat/transcript/
        // native-chat-turn-activity.ts:76-77). Assistant prose is already a chat row, so the line is
        // the tool still running (tool_call without its tool_result); otherwise the client says "Thinking…".
        let mut running_tools: Vec<(String, String)> = Vec::new();

        for line in lines {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some(p) = v.get("payload") else { continue };
            match p.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "turn_start" => {
                    in_turn = true;
                    last_stop = None;
                    running_tools.clear();
                }
                "turn_end" => {
                    in_turn = false;
                    running_tools.clear();
                    last_stop = p.get("stopReason").and_then(|s| s.as_str()).map(str::to_string);
                }
                "pending_interaction" => {
                    pending = Some(
                        p.get("toolCallId").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    );
                }
                "interaction_resolved" => pending = None,
                "tool_call" => {
                    let id = p.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = p
                        .get("toolName")
                        .or_else(|| p.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    if !running_tools.iter().any(|(i, _)| *i == id) {
                        running_tools.push((id, name));
                    }
                }
                "tool_result" => {
                    let id = p.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("");
                    running_tools.retain(|(i, _)| i != id);
                }
                _ => {}
            }
        }

        let lifecycle = if pending.is_some() {
            AgentLifecycleState::Waiting
        } else if in_turn {
            AgentLifecycleState::Working
        } else if last_stop.as_deref() == Some("error") {
            AgentLifecycleState::Error
        } else {
            AgentLifecycleState::Idle
        };
        let last_subtitle = match lifecycle {
            AgentLifecycleState::Working => running_tools.last().map(|(_, name)| format!("Running {name}")),
            _ => None,
        };
        KiroStatus { lifecycle, last_subtitle }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(t: &str, extra: &str) -> String {
        format!(r#"{{"id":"x","timestamp":"t","payload":{{"type":"{t}"{extra}}}}}"#)
    }

    #[test]
    fn lifecycle_from_records() {
        let working = [rec("turn_start", ""), rec("assistant", r#","operationType":"Say","content":"hi""#)];
        let s = KiroSessionIndex::analyze_lines(working.iter().map(String::as_str));
        assert_eq!(s.lifecycle, AgentLifecycleState::Working);
        // Prose is a chat row, never the activity line.
        assert_eq!(s.last_subtitle, None);

        // Previous turn's text/tools never leak into a new turn; only a running tool is shown.
        let next = [
            rec("turn_start", ""),
            rec("assistant", r#","operationType":"Say","content":"old answer""#),
            rec("tool_call", r#","toolCallId":"a","toolName":"fs_read""#),
            rec("turn_end", r#","stopReason":"end_turn""#),
            rec("turn_start", ""),
        ];
        let s = KiroSessionIndex::analyze_lines(next.iter().map(String::as_str));
        assert_eq!(s.last_subtitle, None);
        let tool = [
            rec("turn_start", ""),
            rec("tool_call", r#","toolCallId":"b","toolName":"execute_bash""#),
        ];
        let s = KiroSessionIndex::analyze_lines(tool.iter().map(String::as_str));
        assert_eq!(s.last_subtitle.as_deref(), Some("Running execute_bash"));
        let done_tool = [
            rec("turn_start", ""),
            rec("tool_call", r#","toolCallId":"b","toolName":"execute_bash""#),
            rec("tool_result", r#","toolCallId":"b""#),
        ];
        let s = KiroSessionIndex::analyze_lines(done_tool.iter().map(String::as_str));
        assert_eq!(s.last_subtitle, None);

        let waiting = [
            rec("turn_start", ""),
            rec("pending_interaction", r#","toolCallId":"c1""#),
        ];
        let s = KiroSessionIndex::analyze_lines(waiting.iter().map(String::as_str));
        assert_eq!(s.lifecycle, AgentLifecycleState::Waiting);

        let resolved = [
            rec("turn_start", ""),
            rec("pending_interaction", r#","toolCallId":"c1""#),
            rec("interaction_resolved", r#","toolCallId":"c1""#),
        ];
        let s = KiroSessionIndex::analyze_lines(resolved.iter().map(String::as_str));
        assert_eq!(s.lifecycle, AgentLifecycleState::Working);

        let done = [rec("turn_start", ""), rec("turn_end", r#","stopReason":"end_turn""#)];
        let s = KiroSessionIndex::analyze_lines(done.iter().map(String::as_str));
        assert_eq!(s.lifecycle, AgentLifecycleState::Idle);

        let err = [rec("turn_start", ""), rec("turn_end", r#","stopReason":"error""#)];
        let s = KiroSessionIndex::analyze_lines(err.iter().map(String::as_str));
        assert_eq!(s.lifecycle, AgentLifecycleState::Error);
    }

    #[test]
    fn scan_maps_lease_parent_tty_to_latest_session() {
        let root = std::env::temp_dir().join(format!("kiro-home-{}", uuid::Uuid::new_v4()));
        let ws = root.join("sessions").join("hash1");
        fs::create_dir_all(root.join("session-leases")).unwrap();
        for (id, body) in [("sess_old", rec("turn_end", r#","stopReason":"end_turn""#)), ("sess_new", rec("turn_start", ""))] {
            fs::create_dir_all(ws.join(id)).unwrap();
            fs::write(ws.join(id).join("messages.jsonl"), format!("{body}\n")).unwrap();
            fs::write(
                root.join("session-leases").join(format!("{id}.lease")),
                r#"{"pid":1,"parentPid":42,"clientName":"kiro-cli"}"#,
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let map = KiroSessionIndex::scan_by_tty(&root, &|pid| (pid == 42).then(|| "ttys019".to_string()));
        assert_eq!(map.len(), 1);
        let s = map.get("ttys019").unwrap();
        assert_eq!(s.session_id, "sess_new");
        assert_eq!(s.lifecycle, AgentLifecycleState::Working);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dead_pid_is_skipped() {
        let root = std::env::temp_dir().join(format!("kiro-home-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("session-leases")).unwrap();
        fs::create_dir_all(root.join("sessions/h/sess_a")).unwrap();
        fs::write(root.join("sessions/h/sess_a/messages.jsonl"), "").unwrap();
        fs::write(root.join("session-leases/sess_a.lease"), r#"{"pid":1,"parentPid":7}"#).unwrap();
        assert!(KiroSessionIndex::scan_by_tty(&root, &|_| None).is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
