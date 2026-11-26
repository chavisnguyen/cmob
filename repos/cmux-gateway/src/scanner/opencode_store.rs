//! OpenCode SQLite (`opencode.db`) session & transcript store.
//!
//! Sources:
//! - `ref/orca/src/main/native-chat/transcript-opencode2-sqlite.ts`
//! - `ref/orca/src/main/opencode/accounts/opencode-data-directory.ts:3-33`

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::io::jsonl_window::TranscriptPage;
use crate::protocol::event::{AgentLifecycleState, AgentTurn};
use crate::providers::opencode::build_turns_with_seqs;

const SEPARATOR: char = '#';
const ROWS_PER_TURN: usize = 20;
const MAX_ROWS: usize = 2000;
const TURN_TTL: Duration = Duration::from_millis(1500);
const STATUS_TTL: Duration = Duration::from_millis(1500);
const IDS_TTL: Duration = Duration::from_secs(3);
const SQLITE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CACHE_ENTRIES: usize = 128;

/// A live OpenCode session's derived state.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeStatus {
    pub lifecycle: AgentLifecycleState,
    pub last_subtitle: Option<String>,
    pub turn_completed_at: Option<f64>,
}

#[derive(Clone)]
struct CachedTurnWindow {
    turns: Vec<AgentTurn>,
    seqs: Vec<u64>,
    total_turns: usize,
    db_has_older: bool,
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
    PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("opencode")
}

/// Candidate databases: `OPENCODE_DB` when set, otherwise `opencode*.db` in the data directory.
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
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(is_database_name)
        })
        .collect();
    paths.sort_by_key(|p| {
        let canonical = p.file_name().and_then(|n| n.to_str()) == Some("opencode.db");
        (!canonical, p.clone())
    });
    paths
}

fn is_database_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("opencode") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".db") else {
        return false;
    };
    stem.is_empty()
        || (stem.starts_with('-')
            && stem[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
}

pub fn is_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("ses_") else {
        return false;
    };
    !rest.is_empty() && rest.len() <= 64 && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

pub fn pseudo_path(db: &Path, session_id: &str) -> String {
    format!("{}{SEPARATOR}{session_id}", db.display())
}

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

static TURNS: LazyLock<Mutex<HashMap<String, Cached<Result<CachedTurnWindow, String>>>>> =
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
        guard.insert(
            key,
            Cached {
                at: Instant::now(),
                stamp,
                value,
            },
        );
    }
}

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

/// Paginated OpenCode SQLite reader supporting `before_offset` (`seq < cursor`), stable `turn-oc-{seq}` IDs,
/// `surface_id` stamping after cache lookup, and exact `max_turns` slicing.
pub fn read_turns_page(
    db: &Path,
    session_id: &str,
    surface_id: &str,
    max_turns: usize,
    before_offset: Option<u64>,
) -> Result<TranscriptPage, String> {
    if !is_session_id(session_id) || max_turns == 0 {
        return Ok(TranscriptPage {
            turns: Vec::new(),
            has_more: false,
            before_offset: None,
            total_turns: 0,
        });
    }

    let cursor_key = before_offset
        .map(|c| c.to_string())
        .unwrap_or_else(|| "tail".to_string());
    let key = format!("{}:{max_turns}:{cursor_key}", pseudo_path(db, session_id));
    let stamp = db_stamp(db);
    let win = match cached(&TURNS, &key, stamp, TURN_TTL) {
        Some(hit) => hit?,
        None => {
            let fetched = read_uncached(db, session_id, max_turns, before_offset);
            store(&TURNS, key, stamp, fetched.clone());
            fetched?
        }
    };

    let avail = win.turns.len();
    let start_idx = avail.saturating_sub(max_turns);
    let first_seq = win.seqs.get(start_idx).copied().unwrap_or(0);
    let mut turns: Vec<AgentTurn> = win.turns[start_idx..]
        .iter()
        .cloned()
        .map(|mut t| {
            t.surface_id = surface_id.to_string();
            t
        })
        .collect();
    if max_turns == 0 {
        turns.clear();
    }

    let has_more = (start_idx > 0 || win.db_has_older) && first_seq > 0;
    let total_turns = if before_offset.is_none() && !has_more {
        turns.len()
    } else {
        win.total_turns.max(turns.len() + usize::from(has_more))
    };

    Ok(TranscriptPage {
        turns,
        has_more,
        before_offset: has_more.then_some(first_seq),
        total_turns,
    })
}

pub fn read_recent_turns_page(
    db: &Path,
    session_id: &str,
    surface_id: &str,
    max_turns: usize,
) -> Result<(Vec<AgentTurn>, usize), String> {
    let page = read_turns_page(db, session_id, surface_id, max_turns, None)?;
    Ok((page.turns, page.total_turns))
}

fn read_uncached(
    db: &Path,
    session_id: &str,
    max_turns: usize,
    before_offset: Option<u64>,
) -> Result<CachedTurnWindow, String> {
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
    let seq_clause = match before_offset {
        Some(cursor) => format!("AND seq < {cursor} "),
        None => String::new(),
    };
    let mut rows = query(
        db,
        &format!(
            "SELECT seq, id, type, time_created, time_updated, data FROM session_message \
             WHERE session_id={id} AND type IN ('user','assistant','idle') {seq_clause}\
             ORDER BY seq DESC, time_created DESC LIMIT {}",
            limit + 1
        ),
    )?;
    let db_has_older = rows.len() > limit;
    if db_has_older {
        rows.truncate(limit);
    }
    rows.reverse();

    let (turns, seqs) = build_turns_with_seqs(&rows, "");
    Ok(CachedTurnWindow {
        turns,
        seqs,
        total_turns,
        db_has_older,
    })
}

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
    Some(format!(
        "{}|{}|{}|{}",
        v("time_updated"),
        v("time_busy"),
        v("time_idle"),
        v("messages")
    ))
}

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

fn to_unix_secs(raw: i64) -> Option<f64> {
    if raw <= 0 {
        return None;
    }
    if raw > 10_000_000_000 {
        Some(raw as f64 / 1000.0)
    } else {
        Some(raw as f64)
    }
}

fn status_uncached(db: &Path, session_id: &str) -> Option<OpenCodeStatus> {
    let id = sql_str(session_id);
    let rows = query(
        db,
        &format!("SELECT time_busy, time_idle, idle_outcome FROM session_v2 WHERE id={id} LIMIT 1"),
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
    if let Some(data) = last.first().and_then(|r| r.get("data")).and_then(|d| d.as_str())
        && let Ok(data) = serde_json::from_str::<serde_json::Value>(data)
    {
        for part in data.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
            let is_tool = part.get("type").and_then(|t| t.as_str()) == Some("tool");
            let status = part.pointer("/state/status").and_then(|s| s.as_str());
            if is_tool && status == Some("running") {
                let name = part
                    .get("name")
                    .or_else(|| part.get("tool"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool");
                if name == "question" {
                    question = true;
                }
                running_tool = Some(name.to_string());
            }
        }
    }

    let idle_val = num("time_idle");
    let busy_val = num("time_busy");
    let idle_outcome = row.get("idle_outcome").and_then(|v| v.as_str());

    let lifecycle = if question {
        AgentLifecycleState::Waiting
    } else if running_tool.is_some() {
        AgentLifecycleState::Working
    } else if idle_outcome == Some("failed") {
        AgentLifecycleState::Error
    } else {
        match (busy_val, idle_val) {
            (Some(busy), Some(idle)) if busy > idle => AgentLifecycleState::Working,
            (_, Some(idle)) if idle > 0 && idle_outcome == Some("succeeded") => {
                AgentLifecycleState::Done
            }
            _ => AgentLifecycleState::Idle,
        }
    };
    let last_subtitle = match (&lifecycle, running_tool) {
        (AgentLifecycleState::Working, Some(name)) => Some(format!("Running {name}")),
        _ => None,
    };
    let turn_completed_at = if lifecycle == AgentLifecycleState::Done {
        idle_val.and_then(to_unix_secs)
    } else {
        None
    };
    Some(OpenCodeStatus {
        lifecycle,
        last_subtitle,
        turn_completed_at,
    })
}

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
    use crate::protocol::event::{AgentEvent, AgentRole};
    use crate::providers::opencode::build_turns;

    fn row(seq: u64, kind: &str, data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "seq": seq, "id": format!("m{seq}"), "type": kind, "data": data.to_string() })
    }

    #[test]
    fn parses_assistant_parts_and_filters_synthetic_and_zero_usage() {
        let rows = vec![
            row(1, "user", serde_json::json!({ "text": "cmux mobile chưa có agent opencode đúng không?" })),
            row(
                2,
                "assistant",
                serde_json::json!({
                    "model": { "id": "deepseek-v4.1-flash-free", "providerID": "opencode" },
                    "content": [
                        { "type": "reasoning", "text": "look at the code first" },
                        { "type": "text", "synthetic": true, "text": "SYNTHETIC_NOISE" },
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
        assert_eq!(turns[0].id, "turn-oc-1");
        assert_eq!(turns[1].id, "turn-oc-2");
        assert_eq!(turns[0].role, AgentRole::User);
        assert_eq!(turns[1].role, AgentRole::Assistant);
        let ev = &turns[1].events;
        assert!(!ev.iter().any(|e| matches!(e, AgentEvent::Assistant { text } if text.contains("SYNTHETIC_NOISE"))));
        assert!(matches!(ev[0], AgentEvent::Thinking { .. }));
        assert!(matches!(ev[1], AgentEvent::ToolStart { .. }));
        assert!(matches!(ev[2], AgentEvent::ToolEnd { ok: true, .. }));
        assert!(matches!(ev[3], AgentEvent::Assistant { .. }));
        assert!(matches!(ev[4], AgentEvent::Usage { input_tokens: 17888, output_tokens: 115, cache_read_tokens: 512, .. }));
    }

    #[test]
    fn running_and_completed_question_are_awaiting_input_with_receipt() {
        let rows = vec![
            row(
                10,
                "assistant",
                serde_json::json!({
                    "content": [{
                        "type": "tool", "id": "call_q", "name": "question",
                        "state": {
                            "status": "completed",
                            "input": { "questions": [{
                                "question": "Bạn muốn dừng ở mức nào?",
                                "options": [{ "label": "L0 → L1 → L2" }, { "label": "Chỉ L0" }]
                            }] },
                            "metadata": { "answers": [["L0 → L1 → L2"]] }
                        }
                    }]
                }),
            ),
            row(11, "idle", serde_json::json!({ "outcome": "interrupted" })),
        ];
        let turns = build_turns(&rows, "s");
        assert_eq!(turns[0].id, "turn-oc-10");
        match &turns[0].events[0] {
            AgentEvent::AwaitingInput(ai) => {
                assert_eq!(ai.prompt, "Bạn muốn dừng ở mức nào?");
                assert_eq!(ai.answered.as_deref(), Some("L0 → L1 → L2"));
            }
            other => panic!("expected awaiting input, got {other:?}"),
        }
        assert!(turns[0]
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::Status { text } if text == "Interrupted")));
    }

    #[test]
    fn non_ses_ids_and_pseudo_paths() {
        assert!(!is_session_id("opencode-test"));
        assert!(is_session_id("ses_e0b26e1b8ffeAttLF01b9Ckpqu"));
        let db = PathBuf::from("/Users/x/.local/share/opencode/opencode.db");
        let p = pseudo_path(&db, "ses_abc123");
        assert_eq!(parse_pseudo_path(Path::new(&p)), Some((db, "ses_abc123".to_string())));
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
    fn reads_paginated_turns_stamps_surface_id_and_tracks_status() {
        let dir = std::env::temp_dir().join(format!("ocdb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = fake_db(
            &dir,
            "INSERT INTO session_v2 VALUES ('ses_abc123', 0, 0, 'succeeded', 5);\
             INSERT INTO session_message VALUES ('m1','ses_abc123','user',1,1,1,'{\"text\":\"hi\"}');\
             INSERT INTO session_message VALUES ('m2','ses_abc123','assistant',2,2,2,'{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}');\
             INSERT INTO session_message VALUES ('m3','ses_abc123','user',3,3,3,'{\"text\":\"second\"}');\
             INSERT INTO session_message VALUES ('m4','ses_abc123','assistant',4,4,4,'{\"content\":[{\"type\":\"text\",\"text\":\"reply 2\"}]}');",
        );

        let page1 = read_turns_page(&db, "ses_abc123", "surf-a", 2, None).unwrap();
        assert_eq!(page1.turns.len(), 2);
        assert_eq!(page1.turns[0].id, "turn-oc-3");
        assert_eq!(page1.turns[0].surface_id, "surf-a");
        assert!(page1.has_more);
        assert_eq!(page1.before_offset, Some(3));

        // Cache hit with a DIFFERENT surface_id stamps the caller's surface_id cleanly!
        let page1_b = read_turns_page(&db, "ses_abc123", "surf-b", 2, None).unwrap();
        assert_eq!(page1_b.turns[0].surface_id, "surf-b");

        // Older page via `before_offset` (`seq < 3`).
        let older = read_turns_page(&db, "ses_abc123", "surf-a", 2, page1.before_offset).unwrap();
        assert_eq!(older.turns.len(), 2);
        assert_eq!(older.turns[0].id, "turn-oc-1");
        assert!(!older.has_more);

        assert_eq!(status(&db, "ses_abc123").unwrap().lifecycle, AgentLifecycleState::Idle);
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
