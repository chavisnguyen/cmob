//! OpenCode transcript + status reader.
//!
//! cmux writes `~/.cmuxterm/opencode-hook-sessions.json` (verified on this machine) whose
//! `sessionId` is OpenCode's own session id (`ses_...`) and whose `surfaceId` is the cmux surface.
//! The hook record carries no `transcriptPath`, so the conversation itself is read from OpenCode's
//! SQLite database:
//!   - `<XDG_DATA_HOME|~/.local/share>/opencode/opencode.db` (override: `OPENCODE_DB`)
//!   - tables `session_v2`, `session_message` (verified: opencode v2.3.2, `sqlite3 .schema`)
//!   - `session_message.data` is JSON: user `{text}`, assistant `{content:[...],tokens,model}` with
//!     part types `text` | `reasoning` | `tool` (`state.status`, `state.input`, `state.content`)
//! Schema discovery mirrors Orca: ref/orca/src/main/ai-vault/scanners/opencode2/
//! session-scanner-opencode2-sqlite.ts:36-37,95-117 and ...-message.ts:30-54.
//! Database path resolution mirrors ref/orca/src/main/opencode/accounts/opencode-data-directory.ts:3-33.
//!
//! Rust has no SQLite crate in this build (no vendored `rusqlite`), so reads shell out to the
//! `sqlite3` CLI in read-only + JSON mode. The gateway already shells out to `ps`/`cmux`/`agy`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::protocol::event::{
    AgentEvent, AgentLifecycleState, AgentRole, AgentTurn, AwaitingInput, SubagentEntry,
    SubagentState,
};

/// `dbPath#sessionId`, the same reference form Orca uses for SQLite-backed transcripts
/// (ref/orca/src/shared/opencode-sqlite-session-path.ts:3-22). It is a reference, not a file path.
const SEPARATOR: char = '#';
/// Same client-facing cap as the JSONL transcript reader (see `transcript::MAX_DETAIL_CHARS`).
const MAX_DETAIL_CHARS: usize = 4000;
/// Rows fetched per `max_turns` when only the tail is needed.
const ROWS_PER_TURN: usize = 20;
const MAX_ROWS: usize = 2000;
/// Turn snapshots and status are re-read when the DB/WAL changes or after TTL expires (must be >500ms watcher tick).
const TURN_TTL: Duration = Duration::from_millis(1500);
const STATUS_TTL: Duration = Duration::from_millis(1500);
/// Known session ids per database. A full id scan is cheap; a per-record probe is not.
const IDS_TTL: Duration = Duration::from_secs(3);
const SQLITE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CACHE_ENTRIES: usize = 128;

/// A live OpenCode session's derived state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeStatus {
    pub lifecycle: AgentLifecycleState,
    pub last_subtitle: Option<String>,
}

/// `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`.
pub fn data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("XDG_DATA_HOME") {
        let v = v.trim();
        if !v.is_empty() {
            return PathBuf::from(v).join("opencode");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".local").join("share").join("opencode")
}

/// Candidate databases: `OPENCODE_DB` when set, otherwise `opencode*.db` in the data directory.
/// Canonical `opencode.db` is tried first (Orca `compareOpenCodeClaimPriority`).
pub fn database_candidates() -> Vec<PathBuf> {
    if let Ok(sel) = std::env::var("OPENCODE_DB") {
        let sel = sel.trim();
        if sel == ":memory:" {
            return Vec::new();
        }
        if !sel.is_empty() {
            let p = PathBuf::from(sel);
            return vec![if p.is_absolute() { p } else { data_dir().join(p) }];
        }
    }
    let dir = data_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(is_database_name))
        .collect();
    paths.sort_by_key(|p| {
        let canonical = p.file_name().and_then(|n| n.to_str()) == Some("opencode.db");
        (!canonical, p.clone())
    });
    paths
}

/// `^opencode(?:-[A-Za-z0-9_.-]+)?\.db$` (Orca `listOpenCodeDatabasesInDirectory`).
fn is_database_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("opencode") else { return false };
    let Some(stem) = rest.strip_suffix(".db") else { return false };
    stem.is_empty()
        || (stem.starts_with('-')
            && stem[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
}

/// OpenCode session ids look like `ses_<alnum>` (verified in both hook files and the database).
/// Anything else (e.g. the `opencode-test` fixtures cmux writes) is not a database key.
pub fn is_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("ses_") else { return false };
    !rest.is_empty() && rest.len() <= 64 && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn pseudo_path(db: &Path, session_id: &str) -> String {
    format!("{}{SEPARATOR}{session_id}", db.display())
}

/// Split a `dbPath#sessionId` reference. Returns None for real files.
pub fn parse_pseudo_path(path: &Path) -> Option<(PathBuf, String)> {
    let s = path.to_string_lossy();
    let idx = s.rfind(SEPARATOR)?;
    let (db, id) = (&s[..idx], &s[idx + 1..]);
    if !is_session_id(id) || !is_database_name(db.rsplit(['/', '\\']).next()?) {
        return None;
    }
    Some((PathBuf::from(db), id.to_string()))
}

struct Cached<T> {
    at: Instant,
    stamp: u128,
    value: T,
}

static TURNS: LazyLock<Mutex<HashMap<String, Cached<Result<(Vec<AgentTurn>, usize), String>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static STATUS: LazyLock<Mutex<HashMap<String, Cached<Option<OpenCodeStatus>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static IDS: LazyLock<Mutex<HashMap<String, Cached<HashSet<String>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn file_stamp(path: &Path) -> u128 {
    let Ok(m) = std::fs::metadata(path) else {
        return 0;
    };
    let ns = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    ns ^ ((m.len() as u128) << 64)
}

fn db_stamp(db: &Path) -> u128 {
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    file_stamp(db).wrapping_mul(31) ^ file_stamp(&wal)
}

fn cached<T: Clone>(
    map: &Mutex<HashMap<String, Cached<T>>>,
    key: &str,
    stamp: u128,
    ttl: Duration,
) -> Option<T> {
    let guard = map.lock().ok()?;
    let hit = guard.get(key)?;
    if stamp != 0 && hit.stamp != stamp {
        return None;
    }
    (hit.at.elapsed() < ttl).then(|| hit.value.clone())
}

fn store<T>(map: &Mutex<HashMap<String, Cached<T>>>, key: String, stamp: u128, value: T) {
    if let Ok(mut guard) = map.lock() {
        if guard.len() >= MAX_CACHE_ENTRIES {
            guard.retain(|_, v| v.at.elapsed() < Duration::from_secs(300));
            if guard.len() >= MAX_CACHE_ENTRIES {
                guard.clear();
            }
        }
        guard.insert(key, Cached { at: Instant::now(), stamp, value });
    }
}

/// Run a query with a bounded wait timeout and parse `sqlite3 -json` output.
fn query(db: &Path, sql: &str) -> Result<Vec<serde_json::Value>, String> {
    use std::io::Read;
    use std::process::Stdio;

    let mut child = Command::new("sqlite3")
        .args(["-readonly", "-json"])
        .arg(db)
        .arg(sql)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("sqlite3: {e}"))?;

    let deadline = Instant::now() + SQLITE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("sqlite3 timed out".into());
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("sqlite3: {e}"));
            }
        }
    };

    let mut stdout = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout);
    }
    if !status.success() {
        let mut stderr = Vec::new();
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_end(&mut stderr);
        }
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("sqlite3 json: {e}"))
}

fn session_ids(db: &Path) -> HashSet<String> {
    let stamp = db_stamp(db);
    if let Some(ids) = cached(&IDS, &db.to_string_lossy(), stamp, IDS_TTL) {
        return ids;
    }
    let ids: HashSet<String> = query(db, "SELECT id FROM session_v2")
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    store(&IDS, db.to_string_lossy().into_owned(), stamp, ids.clone());
    ids
}

/// Database reference for `session_id`, or None when no candidate database contains it.
pub fn resolve_transcript_path(session_id: &str) -> Option<String> {
    if !is_session_id(session_id) {
        return None;
    }
    database_candidates()
        .into_iter()
        .find(|db| session_ids(db).contains(session_id))
        .map(|db| pseudo_path(&db, session_id))
}

fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn cap(s: String) -> String {
    if s.chars().count() <= MAX_DETAIL_CHARS {
        return s;
    }
    let mut out: String = s.chars().take(MAX_DETAIL_CHARS).collect();
    out.push_str("… [truncated]");
    out
}

fn text_of_parts(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_event(part: &serde_json::Value, turn: &mut AgentTurn) {
    let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
    let tool_id = part
        .get("id")
        .and_then(|i| i.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("tool-{}", turn.events.len()));
    let state = part.get("state");
    let status = state
        .and_then(|s| s.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("completed");
    // A running `question` is OpenCode's blocking prompt (verified shape:
    // `{questions:[{question, options:[{label, description}]}]}`).
    if name == "question" && status == "running" {
        if let Some(q) = state
            .and_then(|s| s.get("input"))
            .and_then(|i| i.get("questions"))
            .and_then(|q| q.as_array())
            .and_then(|q| q.first())
        {
            let prompt = q.get("question").and_then(|v| v.as_str()).unwrap_or("Question").to_string();
            let options = q
                .get("options")
                .and_then(|o| o.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.get("label").and_then(|l| l.as_str()).map(str::to_string))
                        .collect()
                });
            turn.events.push(AgentEvent::AwaitingInput(AwaitingInput {
                input_kind: "question".into(),
                prompt,
                options,
                default_choice: None,
                multi_select: None,
                questions: None,
                answered: None,
            }));
            return;
        }
    }
    if matches!(name.as_str(), "task" | "subagent") {
        let inp = state.and_then(|s| s.get("input"));
        let label = inp
            .and_then(|i| i.get("description").or_else(|| i.get("subagent_type")))
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Subagent")
            .to_string();
        let sub_state = match status {
            "running" | "pending" => SubagentState::Working,
            "error" => SubagentState::Failed,
            _ => SubagentState::Completed,
        };
        let entry = SubagentEntry {
            id: tool_id,
            label,
            state: sub_state,
            tokens: None,
            started_at: None,
            settled_at: None,
        };
        let gid = format!("opencode-subagents-{}", turn.id);
        if let Some(agents) = turn.events.iter_mut().find_map(|e| match e {
            AgentEvent::Subagents { group_id, agents } if *group_id == gid => Some(agents),
            _ => None,
        }) {
            agents.push(entry);
        } else {
            turn.events.push(AgentEvent::Subagents {
                group_id: gid,
                agents: vec![entry],
            });
        }
        return;
    }

    let detail = state
        .and_then(|s| s.get("input"))
        .map(|i| cap(i.to_string()));
    turn.events.push(AgentEvent::ToolStart { tool_id: tool_id.clone(), name: name.clone(), detail });
    if status != "running" && status != "pending" {
        let detail = state
            .and_then(|s| s.get("content"))
            .map(|c| cap(text_of_parts(Some(c))))
            .filter(|s| !s.trim().is_empty());
        turn.events.push(AgentEvent::ToolEnd { tool_id, name: Some(name), detail, ok: status != "error" });
    }
}

fn assistant_events(data: &serde_json::Value, turn: &mut AgentTurn) {
    for part in data.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        match part.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "reasoning" => {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()).filter(|t| !t.trim().is_empty()) {
                    turn.events.push(AgentEvent::Thinking {
                        text: text.to_string(),
                        duration_secs: None,
                    });
                }
            }
            "text" => {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()).filter(|t| !t.trim().is_empty()) {
                    turn.events.push(AgentEvent::Assistant { text: text.to_string() });
                }
            }
            "tool" => tool_event(part, turn),
            _ => {}
        }
    }
    if let Some(tokens) = data.get("tokens") {
        let n = |k: &str| tokens.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        turn.events.push(AgentEvent::Usage {
            model: data
                .pointer("/model/id")
                .and_then(|m| m.as_str())
                .map(str::to_string),
            input_tokens: n("input"),
            output_tokens: n("output"),
            cache_read_tokens: tokens.pointer("/cache/read").and_then(|v| v.as_u64()).unwrap_or(0),
            cache_creation_tokens: tokens.pointer("/cache/write").and_then(|v| v.as_u64()).unwrap_or(0),
        });
    }
}

fn user_text(data: &serde_json::Value) -> String {
    if let Some(t) = data.get("text").and_then(|t| t.as_str()) {
        return t.to_string();
    }
    data.get("content")
        .and_then(|c| c.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn build_turns(rows: &[serde_json::Value], surface_id: &str) -> Vec<AgentTurn> {
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;
    for row in rows {
        let kind = row.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let Ok(data) = serde_json::from_str::<serde_json::Value>(
            row.get("data").and_then(|d| d.as_str()).unwrap_or("{}"),
        ) else {
            continue;
        };
        match kind {
            "user" => {
                if let Some(t) = current.take() {
                    turns.push(t);
                }
                let text = user_text(&data);
                if text.trim().is_empty() {
                    continue;
                }
                let mut turn =
                    AgentTurn::new(format!("turn-{}", turns.len() + 1), surface_id, AgentRole::User);
                turn.events.push(AgentEvent::User { text });
                turns.push(turn);
            }
            "assistant" => {
                let turn = current.get_or_insert_with(|| {
                    AgentTurn::new(format!("turn-{}", turns.len() + 1), surface_id, AgentRole::Assistant)
                });
                assistant_events(&data, turn);
            }
            _ => {}
        }
    }
    if let Some(t) = current {
        turns.push(t);
    }
    turns
}

/// Read the conversation stored for `session_id`, newest `max_turns` turns.
pub fn read_recent_turns_page(
    db: &Path,
    session_id: &str,
    surface_id: &str,
    max_turns: usize,
) -> Result<(Vec<AgentTurn>, usize), String> {
    if !is_session_id(session_id) {
        return Ok((Vec::new(), 0));
    }
    let key = format!("{}:{max_turns}", pseudo_path(db, session_id));
    let stamp = db_stamp(db);
    if let Some(hit) = cached(&TURNS, &key, stamp, TURN_TTL) {
        return hit;
    }
    let result = read_uncached(db, session_id, surface_id, max_turns);
    store(&TURNS, key, stamp, result.clone());
    result
}

fn read_uncached(
    db: &Path,
    session_id: &str,
    surface_id: &str,
    max_turns: usize,
) -> Result<(Vec<AgentTurn>, usize), String> {
    let id = sql_str(session_id);
    let counts = query(
        db,
        &format!(
            "SELECT (SELECT COUNT(*) FROM session_message WHERE session_id={id} AND type='user') AS users, \
                    (SELECT COUNT(*) FROM session_message WHERE session_id={id} AND type='assistant') AS assistants"
        ),
    )?;
    let total_turns = counts.first().map_or(0, |r| {
        let n = |k: &str| r.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        n("users") + n("assistants")
    });
    let limit = (max_turns.max(1) * ROWS_PER_TURN).clamp(ROWS_PER_TURN, MAX_ROWS);
    let mut rows = query(
        db,
        &format!(
            "SELECT type, data FROM session_message WHERE session_id={id} \
             AND type IN ('user','assistant') ORDER BY time_created DESC, seq DESC LIMIT {limit}"
        ),
    )?;
    rows.reverse();
    Ok((build_turns(&rows, surface_id), total_turns))
}

/// Change token for the chat watcher (`server::fingerprint`): the row reference has no file mtime.
pub fn change_token(db: &Path, session_id: &str) -> Option<String> {
    if !is_session_id(session_id) {
        return None;
    }
    let id = sql_str(session_id);
    let rows = query(
        db,
        &format!(
            "SELECT time_updated, time_busy, time_idle, \
                    (SELECT COUNT(*) FROM session_message WHERE session_id={id}) AS messages \
             FROM session_v2 WHERE id={id} LIMIT 1"
        ),
    )
    .ok()?;
    let r = rows.first()?;
    let v = |k: &str| r.get(k).map(|x| x.to_string()).unwrap_or_default();
    Some(format!("{}|{}|{}|{}", v("time_updated"), v("time_busy"), v("time_idle"), v("messages")))
}

/// Live status derived from the session row and its newest assistant message.
pub fn status(db: &Path, session_id: &str) -> Option<OpenCodeStatus> {
    if !is_session_id(session_id) {
        return None;
    }
    let key = pseudo_path(db, session_id);
    let stamp = db_stamp(db);
    if let Some(hit) = cached(&STATUS, &key, stamp, STATUS_TTL) {
        return hit;
    }
    let value = status_uncached(db, session_id);
    store(&STATUS, key, stamp, value.clone());
    value
}

fn status_uncached(db: &Path, session_id: &str) -> Option<OpenCodeStatus> {
    let id = sql_str(session_id);
    let rows = query(
        db,
        &format!(
            "SELECT time_busy, time_idle, idle_outcome FROM session_v2 WHERE id={id} LIMIT 1"
        ),
    )
    .ok()?;
    let row = rows.first()?;
    let num = |k: &str| row.get(k).and_then(|v| v.as_i64());
    let last = query(
        db,
        &format!(
            "SELECT data FROM session_message WHERE session_id={id} AND type='assistant' \
             ORDER BY time_created DESC, seq DESC LIMIT 1"
        ),
    )
    .unwrap_or_default();

    let mut running_tool: Option<String> = None;
    let mut question = false;
    if let Some(data) = last.first().and_then(|r| r.get("data")).and_then(|d| d.as_str()) {
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(data) {
            for part in data.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
                let is_tool = part.get("type").and_then(|t| t.as_str()) == Some("tool");
                let status = part.pointer("/state/status").and_then(|s| s.as_str());
                if is_tool && status == Some("running") {
                    let name = part.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    if name == "question" {
                        question = true;
                    }
                    running_tool = Some(name.to_string());
                }
            }
        }
    }

    let lifecycle = if question {
        AgentLifecycleState::Waiting
    } else if running_tool.is_some() {
        AgentLifecycleState::Working
    } else if row.get("idle_outcome").and_then(|v| v.as_str()) == Some("failed") {
        AgentLifecycleState::Error
    } else {
        match (num("time_busy"), num("time_idle")) {
            (Some(busy), Some(idle)) if busy > idle => AgentLifecycleState::Working,
            _ => AgentLifecycleState::Idle,
        }
    };
    let last_subtitle = match (&lifecycle, running_tool) {
        (AgentLifecycleState::Working, Some(name)) => Some(format!("Running {name}")),
        _ => None,
    };
    Some(OpenCodeStatus { lifecycle, last_subtitle })
}

/// Status for a `dbPath#sessionId` reference.
pub fn status_for_path(path: &Path) -> Option<OpenCodeStatus> {
    let (db, id) = parse_pseudo_path(path)?;
    status(&db, &id)
}

pub fn change_token_for_path(path: &Path) -> Option<String> {
    let (db, id) = parse_pseudo_path(path)?;
    change_token(&db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: &str, data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "type": kind, "data": data.to_string() })
    }

    #[test]
    fn parses_assistant_parts_like_the_real_database() {
        // Shapes copied from opencode 2.3.2 `session_message.data` on this machine.
        let rows = vec![
            row("user", serde_json::json!({ "text": "cmux mobile chưa có agent opencode đúng không?" })),
            row(
                "assistant",
                serde_json::json!({
                    "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode" },
                    "content": [
                        { "type": "reasoning", "text": "look at the code first" },
                        { "type": "tool", "id": "call_1", "name": "grep",
                          "state": { "status": "completed", "input": { "pattern": "opencode" },
                                     "content": [{ "type": "text", "text": "Found 18 matches" }] } },
                        { "type": "text", "text": "Đúng một phần." }
                    ],
                    "tokens": { "input": 17888, "output": 115, "reasoning": 40, "cache": { "read": 512, "write": 0 } }
                }),
            ),
        ];
        let turns = build_turns(&rows, "surf-1");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, AgentRole::User);
        assert_eq!(turns[1].role, AgentRole::Assistant);
        let ev = &turns[1].events;
        assert!(matches!(ev[0], AgentEvent::Thinking { .. }));
        assert!(matches!(ev[1], AgentEvent::ToolStart { .. }));
        assert!(matches!(ev[2], AgentEvent::ToolEnd { ok: true, .. }));
        assert!(matches!(ev[3], AgentEvent::Assistant { .. }));
        match &ev[4] {
            AgentEvent::Usage { model, input_tokens, output_tokens, cache_read_tokens, .. } => {
                assert_eq!(model.as_deref(), Some("deepseek-v4.1-flash-free"));
                assert_eq!((*input_tokens, *output_tokens, *cache_read_tokens), (17888, 115, 512));
            }
            other => panic!("expected usage, got {other:?}"),
        }
    }

    #[test]
    fn running_question_is_awaiting_input_not_a_tool_row() {
        let rows = vec![row(
            "assistant",
            serde_json::json!({
                "content": [{
                    "type": "tool", "id": "call_q", "name": "question",
                    "state": { "status": "running", "input": { "questions": [{
                        "question": "Bạn muốn dừng ở mức nào?",
                        "options": [{ "label": "L0 → L1 → L2" }, { "label": "Chỉ L0" }]
                    }] } }
                }]
            }),
        )];
        let turns = build_turns(&rows, "s");
        match &turns[0].events[0] {
            AgentEvent::AwaitingInput(ai) => {
                assert_eq!(ai.prompt, "Bạn muốn dừng ở mức nào?");
                assert_eq!(ai.options.as_ref().map(Vec::len), Some(2));
            }
            other => panic!("expected awaiting input, got {other:?}"),
        }
    }

    #[test]
    fn non_ses_ids_are_not_database_keys() {
        // cmux writes fixture ids such as `opencode-test` / `test` into the hook file.
        assert!(!is_session_id("opencode-test"));
        assert!(!is_session_id("test"));
        assert!(is_session_id("ses_e0b26e1b8ffeAttLF01b9Ckpqu"));
        assert!(resolve_transcript_path("opencode-test").is_none());
    }

    #[test]
    fn pseudo_path_round_trip_and_name_filter() {
        let db = PathBuf::from("/Users/x/.local/share/opencode/opencode.db");
        let p = pseudo_path(&db, "ses_abc123");
        assert_eq!(parse_pseudo_path(Path::new(&p)), Some((db, "ses_abc123".to_string())));
        assert!(parse_pseudo_path(Path::new("/tmp/notes.txt#ses_abc123")).is_none());
        assert!(is_database_name("opencode.db"));
        assert!(is_database_name("opencode-next.db"));
        assert!(!is_database_name("opencode.db-wal"));
        assert!(!is_database_name("other.db"));
    }

    fn fake_db(dir: &Path, rows: &str) -> PathBuf {
        let db = dir.join("opencode.db");
        let schema = "CREATE TABLE session_v2 (id text PRIMARY KEY, time_busy integer, time_idle integer, idle_outcome text, time_updated integer);\
                      CREATE TABLE session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);";
        let setup = Command::new("sqlite3").arg(&db).arg(schema).arg(rows).output().unwrap();
        assert!(setup.status.success(), "{}", String::from_utf8_lossy(&setup.stderr));
        db
    }

    #[test]
    fn reads_turns_and_counts_from_sqlite() {
        let dir = std::env::temp_dir().join(format!("ocdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = fake_db(
            &dir,
            "INSERT INTO session_v2 VALUES ('ses_abc123', 0, 0, 'succeeded', 5);\
             INSERT INTO session_message VALUES ('m1','ses_abc123','user',1,1,1,'{\"text\":\"hi\"}');\
             INSERT INTO session_message VALUES ('m2','ses_abc123','assistant',2,2,2,'{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}');\
             INSERT INTO session_message VALUES ('m3','ses_abc123','synthetic',3,3,3,'{\"text\":\"ignored\"}');",
        );
        let (turns, total) = read_recent_turns_page(&db, "ses_abc123", "surf", 10).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(total, 2);
        assert!(matches!(turns[1].events[0], AgentEvent::Assistant { .. }));
        assert!(change_token(&db, "ses_abc123").is_some());
        assert_eq!(status(&db, "ses_abc123").unwrap().lifecycle, AgentLifecycleState::Idle);
        assert!(read_recent_turns_page(&db, "ses_missing", "s", 10).unwrap().0.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn running_tool_makes_the_session_work() {
        let dir = std::env::temp_dir().join(format!("ocdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = fake_db(
            &dir,
            "INSERT INTO session_v2 VALUES ('ses_run123', 10, 5, NULL, 10);\
             INSERT INTO session_message VALUES ('m1','ses_run123','assistant',1,2,2,'{\"content\":[{\"type\":\"tool\",\"id\":\"c1\",\"name\":\"shell\",\"state\":{\"status\":\"running\",\"input\":{\"command\":\"ls\"}}}]}');",
        );
        let s = status(&db, "ses_run123").unwrap();
        assert_eq!(s.lifecycle, AgentLifecycleState::Working);
        assert_eq!(s.last_subtitle.as_deref(), Some("Running shell"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
