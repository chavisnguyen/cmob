//! Day/month token-cost ("spend") data sourced from the `codeburn` CLI (npm `codeburn`).
//!
//! Verified by running `codeburn@0.9.28` locally (see `.context/codeburn_integration.md`):
//! `codeburn status --format menubar-json --period <today|week|30days|month|all> --no-optimize --no-timeline`
//! prints one JSON document whose relevant keys are `current` (period totals, `topModels`,
//! `providerDetails`, `topProjects`), `history.daily` and `periodTotals.{today,week,month}`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::Mutex;

const CACHE_TTL_MS: u64 = 60_000;
const CODEBURN_TIMEOUT: Duration = Duration::from_secs(40);
/// Pinned so the `bunx` fallback never silently runs a newer, unreviewed release.
const CODEBURN_PINNED_VERSION: &str = "0.9.28";
const MAX_DAILY: usize = 31;
const MAX_ROWS: usize = 8;

/// Periods forwarded to `--period` (whitelist: the value reaches a subprocess argv).
pub const ALLOWED_PERIODS: [&str; 4] = ["today", "week", "30days", "month"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SpendTokens {
    pub cost: f64,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendDay {
    pub date: String,
    #[serde(flatten)]
    pub totals: SpendTokens,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendModel {
    pub name: String,
    pub cost: f64,
    pub calls: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendProvider {
    pub id: String,
    pub label: String,
    pub cost: f64,
    pub calls: u64,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendProject {
    pub name: String,
    pub cost: f64,
    pub sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendCurrency {
    pub code: String,
    pub symbol: String,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendData {
    pub period: String,
    pub label: String,
    pub currency: SpendCurrency,
    pub sessions: u64,
    pub cache_hit_percent: f64,
    #[serde(flatten)]
    pub totals: SpendTokens,
    pub today: SpendTokens,
    pub week: SpendTokens,
    pub month: SpendTokens,
    pub daily: Vec<SpendDay>,
    pub models: Vec<SpendModel>,
    pub providers: Vec<SpendProvider>,
    pub projects: Vec<SpendProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpendSnapshot {
    /// `"ok"` | `"unavailable"` (codeburn not runnable) | `"error"`
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<SpendData>,
    pub updated_at: u64,
}

#[derive(Default)]
struct PeriodSlot {
    snapshot: Option<SpendSnapshot>,
    fetched_at_ms: u64,
}

#[derive(Clone, Default)]
pub struct SpendService {
    cache: Arc<Mutex<HashMap<String, Arc<Mutex<PeriodSlot>>>>>,
}

impl SpendService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `None` for a period outside [`ALLOWED_PERIODS`].
    pub async fn get_spend(&self, period: &str, force_refresh: bool) -> Option<SpendSnapshot> {
        let period = ALLOWED_PERIODS.iter().find(|p| **p == period)?;
        let slot = {
            let mut map = self.cache.lock().await;
            map.entry((*period).to_string()).or_default().clone()
        };
        // Holding the per-period lock across the fetch gives single-flight refresh.
        let mut guard = slot.lock().await;
        let now = now_ms();
        if !force_refresh
            && let Some(ref cached) = guard.snapshot
            && now.saturating_sub(guard.fetched_at_ms) < CACHE_TTL_MS
        {
            return Some(cached.clone());
        }
        let snap = fetch_spend(period).await;
        // Do not let a transient failure evict a good cached result.
        if snap.status != "ok"
            && let Some(ref cached) = guard.snapshot
            && cached.status == "ok"
        {
            return Some(cached.clone());
        }
        guard.fetched_at_ms = snap.updated_at;
        guard.snapshot = Some(snap.clone());
        Some(snap)
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

enum Runner {
    Binary(PathBuf),
    Bunx(PathBuf),
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).map(|d| d.join(name)).find(|p| p.is_file())
}

fn find_runner() -> Option<Runner> {
    if let Ok(explicit) = std::env::var("CMUX_CODEBURN_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(Runner::Binary(p));
        }
    }
    if let Some(p) = find_in_path("codeburn") {
        return Some(Runner::Binary(p));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut fixed = vec![
        PathBuf::from("/opt/homebrew/bin/codeburn"),
        PathBuf::from("/usr/local/bin/codeburn"),
    ];
    if let Some(h) = &home {
        fixed.push(h.join(".bun/bin/codeburn"));
    }
    if let Some(p) = fixed.into_iter().find(|p| p.is_file()) {
        return Some(Runner::Binary(p));
    }
    let mut bunx = vec![
        PathBuf::from("/opt/homebrew/bin/bunx"),
        PathBuf::from("/usr/local/bin/bunx"),
    ];
    if let Some(h) = &home {
        bunx.push(h.join(".bun/bin/bunx"));
    }
    find_in_path("bunx")
        .or_else(|| bunx.into_iter().find(|p| p.is_file()))
        .map(Runner::Bunx)
}

async fn fetch_spend(period: &str) -> SpendSnapshot {
    let now = now_ms();
    let fail = |status: &str, msg: String| SpendSnapshot {
        status: status.into(),
        error: Some(msg),
        data: None,
        updated_at: now,
    };

    let Some(runner) = find_runner() else {
        return fail("unavailable", "codeburn is not installed (npm i -g codeburn).".into());
    };
    let mut cmd = match &runner {
        Runner::Binary(p) => Command::new(p),
        Runner::Bunx(p) => {
            let mut c = Command::new(p);
            c.arg(format!("codeburn@{CODEBURN_PINNED_VERSION}"));
            c
        }
    };
    cmd.args(["status", "--format", "menubar-json", "--period", period, "--no-optimize", "--no-timeline"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let out = match tokio::time::timeout(CODEBURN_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return fail("error", format!("Failed to run codeburn: {e}")),
        Err(_) => return fail("error", "Timed out reading codeburn usage.".into()),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = stderr.trim().lines().last().unwrap_or("codeburn exited with an error.");
        return fail("error", msg.to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    match parse_codeburn_status(&stdout, period) {
        Some(data) => SpendSnapshot { status: "ok".into(), error: None, data: Some(data), updated_at: now },
        None => fail("error", "Unexpected codeburn output.".into()),
    }
}

fn u(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))).unwrap_or(0)
}

fn f(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|n| n.as_f64()).filter(|n| n.is_finite()).unwrap_or(0.0)
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|n| n.as_str()).unwrap_or("").to_string()
}

fn tokens(v: &Value) -> SpendTokens {
    SpendTokens {
        cost: f(v, "cost"),
        calls: u(v, "calls"),
        input_tokens: u(v, "inputTokens"),
        output_tokens: u(v, "outputTokens"),
        cache_read_tokens: u(v, "cacheReadTokens"),
        cache_write_tokens: u(v, "cacheWriteTokens"),
    }
}

/// Parses `codeburn status --format menubar-json` output into the trimmed mobile payload.
pub fn parse_codeburn_status(stdout: &str, period: &str) -> Option<SpendData> {
    let root: Value = serde_json::from_str(stdout.trim()).ok()?;
    let cur = root.get("current")?;
    cur.get("cost")?.as_f64()?;

    let currency = root
        .get("currency")
        .map(|c| SpendCurrency {
            code: s(c, "code"),
            symbol: s(c, "symbol"),
            rate: c.get("rate").and_then(|r| r.as_f64()).unwrap_or(1.0),
        })
        .unwrap_or(SpendCurrency { code: "USD".into(), symbol: "$".into(), rate: 1.0 });

    let period_totals = root.get("periodTotals");
    let pt = |k: &str| period_totals.and_then(|p| p.get(k)).map(tokens).unwrap_or_default();

    let mut daily: Vec<SpendDay> = root
        .pointer("/history/daily")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    let date = d.get("date")?.as_str()?.to_string();
                    Some(SpendDay { date, totals: tokens(d) })
                })
                .collect()
        })
        .unwrap_or_default();
    daily.sort_by(|a, b| a.date.cmp(&b.date));
    if daily.len() > MAX_DAILY {
        daily.drain(..daily.len() - MAX_DAILY);
    }

    let mut models: Vec<SpendModel> = cur
        .get("topModels")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .map(|m| SpendModel {
                    name: s(m, "name"),
                    cost: f(m, "cost"),
                    calls: u(m, "calls"),
                    input_tokens: u(m, "inputTokens"),
                    output_tokens: u(m, "outputTokens"),
                })
                .collect()
        })
        .unwrap_or_default();
    models.truncate(MAX_ROWS);

    let providers: Vec<SpendProvider> = cur
        .get("providerDetails")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .map(|p| SpendProvider {
                    id: s(p, "id"),
                    label: s(p, "label"),
                    cost: f(p, "cost"),
                    calls: u(p, "calls"),
                    sessions: u(p, "sessions"),
                })
                .filter(|p| p.cost > 0.0 || p.calls > 0)
                .collect()
        })
        .unwrap_or_default();

    let mut projects: Vec<SpendProject> = cur
        .get("topProjects")
        .and_then(|m| m.as_array())
        .map(|a| {
            a.iter()
                .map(|p| SpendProject { name: s(p, "name"), cost: f(p, "cost"), sessions: u(p, "sessions") })
                .collect()
        })
        .unwrap_or_default();
    projects.truncate(MAX_ROWS);

    Some(SpendData {
        period: period.to_string(),
        label: s(cur, "label"),
        currency,
        sessions: u(cur, "sessions"),
        cache_hit_percent: f(cur, "cacheHitPercent"),
        totals: tokens(cur),
        today: pt("today"),
        week: pt("week"),
        month: pt("month"),
        daily,
        models,
        providers,
        projects,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape copied from a live `codeburn@0.9.28 status --format menubar-json --period month` run
    // (values and names replaced).
    const SAMPLE: &str = r#"{
      "generated":"2026-11-27T09:19:37.329Z",
      "current":{"label":"November 2026","cost":12.5,"calls":10,"sessions":3,"cacheHitPercent":90.5,
        "inputTokens":100,"outputTokens":50,"cacheReadTokens":900,"cacheWriteTokens":7,
        "topModels":[{"name":"Model A","cost":10.0,"calls":6,"inputTokens":80,"outputTokens":30},
                     {"name":"Model B","cost":2.5,"calls":4,"inputTokens":20,"outputTokens":20}],
        "providerDetails":[{"id":"claude","label":"Claude","cost":12.5,"calls":10,"sessions":3},
                           {"id":"copilot","label":"Copilot","cost":0,"calls":0,"sessions":0}],
        "topProjects":[{"id":"p1","name":"proj-1","cost":12.5,"sessions":3}]},
      "history":{"daily":[
        {"date":"2026-11-26","cost":2.0,"calls":4,"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4},
        {"date":"2026-11-25","cost":1.0,"calls":2,"inputTokens":1,"outputTokens":1,"cacheReadTokens":1,"cacheWriteTokens":1}]},
      "currency":{"code":"USD","symbol":"$","rate":1},
      "periodTotals":{"today":{"cost":2.0,"calls":4,"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4},
        "week":{"cost":3.0,"calls":6},"month":{"cost":12.5,"calls":10}}
    }"#;

    #[test]
    fn parses_menubar_json_into_trimmed_payload() {
        let d = parse_codeburn_status(SAMPLE, "month").expect("parse");
        assert_eq!(d.label, "November 2026");
        assert_eq!(d.totals.cost, 12.5);
        assert_eq!(d.totals.cache_read_tokens, 900);
        assert_eq!(d.sessions, 3);
        assert_eq!(d.today.cost, 2.0);
        assert_eq!(d.week.calls, 6);
        assert_eq!(d.models.len(), 2);
        assert_eq!(d.providers.len(), 1, "zero-spend providers are dropped");
        assert_eq!(d.daily[0].date, "2026-11-25", "daily sorted ascending");
        assert_eq!(d.daily[1].totals.cost, 2.0);
        assert_eq!(d.currency.symbol, "$");
    }

    #[test]
    fn rejects_garbage_and_missing_current() {
        assert!(parse_codeburn_status("not json", "month").is_none());
        assert!(parse_codeburn_status(r#"{"history":{}}"#, "month").is_none());
    }

    #[test]
    fn caps_daily_history() {
        let days: Vec<String> = (1..=60)
            .map(|i| format!(r#"{{"date":"2026-10-{i:02}","cost":1.0}}"#))
            .collect();
        let json = format!(r#"{{"current":{{"cost":1.0}},"history":{{"daily":[{}]}}}}"#, days.join(","));
        let d = parse_codeburn_status(&json, "month").unwrap();
        assert_eq!(d.daily.len(), MAX_DAILY);
        assert_eq!(d.daily.last().unwrap().date, "2026-10-60");
    }

    /// Optional live check: `CODEBURN_SAMPLE=/path/to/menubar.json cargo test live_codeburn_sample`.
    #[test]
    fn live_codeburn_sample() {
        let Ok(path) = std::env::var("CODEBURN_SAMPLE") else { return };
        let raw = std::fs::read_to_string(path).expect("read sample");
        let d = parse_codeburn_status(&raw, "month").expect("parse live codeburn output");
        assert!(d.totals.cost > 0.0 && !d.daily.is_empty() && !d.models.is_empty());
        eprintln!("live: {} cost={} daily={} models={} providers={} projects={}",
            d.label, d.totals.cost, d.daily.len(), d.models.len(), d.providers.len(), d.projects.len());
    }

    /// Optional live run of the real runner: `CODEBURN_LIVE=1 cargo test live_codeburn_run -- --nocapture`.
    #[tokio::test]
    async fn live_codeburn_run() {
        if std::env::var("CODEBURN_LIVE").is_err() {
            return;
        }
        let svc = SpendService::new();
        let snap = svc.get_spend("today", true).await.expect("period allowed");
        eprintln!("live status={} err={:?} cost={:?}", snap.status, snap.error, snap.data.as_ref().map(|d| d.totals.cost));
        assert_eq!(snap.status, "ok");
        let again = svc.get_spend("today", false).await.unwrap();
        assert_eq!(again.updated_at, snap.updated_at, "second call served from cache");
    }

    #[tokio::test]
    async fn rejects_unknown_period() {
        assert!(SpendService::new().get_spend("--help", false).await.is_none());
    }
}
