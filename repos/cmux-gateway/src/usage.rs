//! Real-time provider quota and rate-limit usage scanner for Antigravity (`agy`), Claude Code, and Codex.
//!
//! Sources (verified in `ref/orca`):
//! - Antigravity: `ref/orca/src/main/rate-limits/providers/antigravity/antigravity-usage-command.ts` &
//!   `antigravity-usage-response.ts` (`agy -p /usage --output-format json --print-timeout 20s`).
//! - Claude Code: `ref/orca/src/main/rate-limits/providers/claude/claude-oauth-credentials.ts` &
//!   `claude-oauth-usage-request.ts` (`https://api.anthropic.com/api/oauth/usage`).
//! - Codex: `ref/orca/src/main/rate-limits/providers/codex/codex-backend-auth.ts` &
//!   `codex-backend-usage-client.ts` (`https://chatgpt.com/backend-api/wham/usage`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

const CACHE_TTL_MS: u64 = 30_000;
const SESSION_WINDOW_MINUTES: u32 = 300;
const WEEKLY_WINDOW_MINUTES: u32 = 10_080;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageWindow {
    pub used_percent: u8,
    pub window_minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageBucket {
    pub id: String,
    pub name: String,
    pub group: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_name: Option<String>,
    pub used_percent: u8,
    pub window_minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderUsage {
    pub provider: String,
    pub display_name: String,
    /// `"ok"` | `"unavailable"` | `"error"`
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buckets: Vec<UsageBucket>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: u64,
}

impl ProviderUsage {
    pub fn has_data(&self) -> bool {
        self.session.is_some() || self.weekly.is_some() || !self.buckets.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageSnapshot {
    pub providers: Vec<ProviderUsage>,
    pub updated_at: u64,
}

#[derive(Default)]
struct UsageCache {
    snapshot: Option<UsageSnapshot>,
    fetched_at_ms: u64,
}

#[derive(Clone, Default)]
pub struct UsageService {
    cache: Arc<Mutex<UsageCache>>,
    refresh_lock: Arc<Mutex<()>>,
    agy_unsupported: Arc<AtomicBool>,
}

impl UsageService {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_snapshot(&self, force_refresh: bool) -> UsageSnapshot {
        let now = now_ms();
        if !force_refresh {
            let guard = self.cache.lock().await;
            if let Some(ref cached) = guard.snapshot {
                if now.saturating_sub(guard.fetched_at_ms) < CACHE_TTL_MS {
                    return cached.clone();
                }
            }
        }

        // Single-flight refresh lock so concurrent tabs/clients do not spawn duplicate CLI/API probes.
        let _refresh_guard = self.refresh_lock.lock().await;
        let now = now_ms();
        if !force_refresh {
            let guard = self.cache.lock().await;
            if let Some(ref cached) = guard.snapshot {
                if now.saturating_sub(guard.fetched_at_ms) < CACHE_TTL_MS {
                    return cached.clone();
                }
            }
        }

        let (agy, claude, codex) = tokio::join!(
            fetch_antigravity_usage(&self.agy_unsupported),
            fetch_claude_usage(),
            fetch_codex_usage(),
        );

        let providers: Vec<ProviderUsage> = [agy, claude, codex]
            .into_iter()
            .filter(|p| p.has_data() || p.status == "error")
            .collect();

        let snap = UsageSnapshot { providers, updated_at: now_ms() };
        let mut guard = self.cache.lock().await;
        guard.snapshot = Some(snap.clone());
        guard.fetched_at_ms = snap.updated_at;
        snap
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Timestamp parsing (ISO-8601 UTC/offset and epoch sec/ms)
// ---------------------------------------------------------------------------

/// Parses ISO-8601 (`2026-12-01T19:00:47Z` or `+07:00`) or numeric epoch seconds/ms into Unix ms.
pub fn parse_reset_timestamp(val: &Value) -> Option<u64> {
    if let Some(n) = val.as_u64() {
        return Some(if n > 10_000_000_000 { n } else { n.saturating_mul(1000) });
    }
    if let Some(f) = val.as_f64() {
        if f.is_finite() && f >= 0.0 {
            let ms = if f > 10_000_000_000.0 { f } else { f * 1000.0 };
            return Some(ms as u64);
        }
        return None;
    }
    let s = val.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<f64>() {
        if n.is_finite() && n >= 0.0 {
            let ms = if n > 10_000_000_000.0 { n } else { n * 1000.0 };
            return Some(ms as u64);
        }
    }
    crate::domain::noise_filter::parse_rfc3339_ms(s)
}

// ---------------------------------------------------------------------------
// Antigravity (`agy -p /usage --output-format json`)
// ---------------------------------------------------------------------------

fn find_agy_bin() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CMUX_AGY_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let cand = dir.join("agy");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    let mut fixed = vec![
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
    ];
    if let Some(home) = home_dir() {
        fixed.push(home.join(".local/bin/agy"));
    }
    fixed.into_iter().find(|p| p.is_file())
}

pub fn parse_agy_version_ok(stdout: &str) -> bool {
    // Require >= 1.1.11 so `/usage` never executes as a billed model turn (Orca antigravity-usage-command.ts:22).
    // Tolerates leading `v` and semver pre-release / build suffixes (`1.2.0-beta.1`, `v1.1.11+sha`).
    let trimmed = stdout.trim();
    let token = trimmed
        .split_whitespace()
        .map(|w| w.trim_start_matches(['v', 'V']))
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))
        .unwrap_or("");
    let nums: Vec<u32> = token
        .split('.')
        .take(3)
        .filter_map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
        })
        .collect();
    if nums.len() < 3 {
        return false;
    }
    (nums[0], nums[1], nums[2]) >= (1, 1, 11)
}

static AGY_BIN_CACHE: LazyLock<Mutex<Option<(std::time::Instant, PathBuf)>>> =
    LazyLock::new(|| Mutex::new(None));
const AGY_BIN_TTL: Duration = Duration::from_secs(300);

async fn resolve_verified_agy_bin(unsupported_latch: &AtomicBool) -> Option<PathBuf> {
    if unsupported_latch.load(Ordering::Relaxed) {
        return None;
    }
    if let Some((at, path)) = AGY_BIN_CACHE.lock().await.clone() {
        if at.elapsed() < AGY_BIN_TTL && path.is_file() {
            return Some(path);
        }
    }
    let agy_bin = find_agy_bin()?;
    let mut ver_cmd = Command::new(&agy_bin);
    ver_cmd
        .arg("--version")
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .kill_on_drop(true);
    let Ok(Ok(ver_out)) = tokio::time::timeout(Duration::from_secs(5), ver_cmd.output()).await else {
        return None;
    };
    if !ver_out.status.success() || !parse_agy_version_ok(&String::from_utf8_lossy(&ver_out.stdout)) {
        unsupported_latch.store(true, Ordering::Relaxed);
        return None;
    }
    *AGY_BIN_CACHE.lock().await = Some((std::time::Instant::now(), agy_bin.clone()));
    Some(agy_bin)
}

async fn fetch_antigravity_usage(unsupported_latch: &AtomicBool) -> ProviderUsage {
    let now = now_ms();
    let base = ProviderUsage {
        provider: "antigravity".into(),
        display_name: "Antigravity".into(),
        status: "unavailable".into(),
        plan_type: None,
        session: None,
        weekly: None,
        buckets: Vec::new(),
        error: None,
        updated_at: now,
    };

    if unsupported_latch.load(Ordering::Relaxed) {
        return ProviderUsage {
            status: "error".into(),
            error: Some("Installed agy version does not support /usage safely; update agy.".into()),
            ..base
        };
    }

    let Some(agy_bin) = resolve_verified_agy_bin(unsupported_latch).await else {
        if unsupported_latch.load(Ordering::Relaxed) {
            return ProviderUsage {
                status: "error".into(),
                error: Some("Update agy (>= 1.1.11) to read quota safely.".into()),
                ..base
            };
        }
        return base;
    };

    let mut cmd = Command::new(&agy_bin);
    cmd.args(["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"])
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true")
        .kill_on_drop(true);

    let out = match tokio::time::timeout(Duration::from_secs(25), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return ProviderUsage { status: "error".into(), error: Some(e.to_string()), ..base };
        }
        Err(_) => {
            return ProviderUsage {
                status: "error".into(),
                error: Some("Timed out reading Antigravity quota.".into()),
                ..base
            };
        }
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    if agy_stdout_shows_model_turn(&stdout) {
        unsupported_latch.store(true, Ordering::Relaxed);
        return ProviderUsage {
            status: "error".into(),
            error: Some("agy /usage executed as a model turn; polling disabled.".into()),
            ..base
        };
    }

    if let Some(parsed) = parse_agy_usage_stdout(&stdout, now) {
        return parsed;
    }

    if let Some(err_msg) = read_agy_error_envelope(&stdout) {
        let lower = err_msg.to_ascii_lowercase();
        let is_unauth = lower.contains("sign in") || lower.contains("not signed") || lower.contains("login");
        return ProviderUsage {
            status: if is_unauth { "unavailable" } else { "error" }.into(),
            error: Some(err_msg),
            ..base
        };
    }

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if stderr.to_ascii_lowercase().contains("sign in") {
            return base;
        }
        if !stderr.is_empty() {
            return ProviderUsage { status: "error".into(), error: Some(stderr), ..base };
        }
    }

    base
}

pub fn agy_stdout_shows_model_turn(stdout: &str) -> bool {
    stdout.lines().any(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            return false;
        };
        let turns = v.get("num_turns").and_then(|n| n.as_u64()).unwrap_or(0);
        let conv = v.get("conversation_id").and_then(|c| c.as_str()).unwrap_or("");
        turns > 0 || !conv.is_empty()
    })
}

pub fn read_agy_error_envelope(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if v.get("status").and_then(|s| s.as_str()) == Some("ERROR") {
            if let Some(err) = v.get("error").and_then(|e| e.as_str()).filter(|e| !e.is_empty()) {
                return Some(err.to_string());
            }
        }
    }
    None
}

pub fn parse_agy_usage_stdout(stdout: &str, now: u64) -> Option<ProviderUsage> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if val.get("status").and_then(|s| s.as_str()) != Some("SUCCESS") {
            continue;
        }
        let cmd = val.get("command")?;
        if cmd.get("name").and_then(|n| n.as_str()) != Some("usage") {
            continue;
        }
        let groups = cmd.get("data")?.get("groups")?.as_array()?;
        let mut buckets = Vec::new();
        for group in groups {
            let Some(group_name) = group.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) else {
                continue;
            };
            let group_desc = group
                .get("description")
                .and_then(|d| d.as_str())
                .map(|s| s.trim_start_matches("Models within this group:").trim().to_string())
                .filter(|s| !s.is_empty());
            let Some(raw_buckets) = group.get("buckets").and_then(|b| b.as_array()) else {
                continue;
            };
            let enabled: Vec<&Value> = raw_buckets
                .iter()
                .filter(|b| b.get("disabled").and_then(|d| d.as_bool()) != Some(true))
                .collect();
            let siblings = enabled.len();
            for b in enabled {
                let Some(id) = b.get("id").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let Some(fraction) = b.get("remaining_fraction").and_then(|f| f.as_f64()) else {
                    continue;
                };
                if !fraction.is_finite() {
                    continue;
                }
                let used_percent = ((1.0 - fraction) * 100.0).round().clamp(0.0, 100.0) as u8;
                let window_name = b.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty());
                let name = match (siblings > 1, window_name) {
                    (true, Some(wn)) => format!("{group_name} · {wn}"),
                    _ => group_name.to_string(),
                };
                let window_minutes = match b.get("window").and_then(|w| w.as_str()) {
                    Some("5h") => SESSION_WINDOW_MINUTES,
                    Some("weekly") => WEEKLY_WINDOW_MINUTES,
                    _ => 0,
                };
                let resets_at = b.get("reset_time").and_then(parse_reset_timestamp);
                buckets.push(UsageBucket {
                    id: id.to_string(),
                    name,
                    group: group_name.to_string(),
                    group_description: group_desc.clone(),
                    window_name: window_name.map(str::to_string),
                    used_percent,
                    window_minutes,
                    resets_at,
                });
            }
        }
        if !groups.is_empty() && buckets.is_empty() {
            return None;
        }
        let session = most_constrained_window(&buckets, SESSION_WINDOW_MINUTES);
        let weekly = most_constrained_window(&buckets, WEEKLY_WINDOW_MINUTES);
        return Some(ProviderUsage {
            provider: "antigravity".into(),
            display_name: "Antigravity".into(),
            status: "ok".into(),
            plan_type: None,
            session,
            weekly,
            buckets,
            error: None,
            updated_at: now,
        });
    }
    None
}

fn most_constrained_window(buckets: &[UsageBucket], minutes: u32) -> Option<UsageWindow> {
    buckets
        .iter()
        .filter(|b| b.window_minutes == minutes)
        .max_by(|a, b| {
            a.used_percent.cmp(&b.used_percent).then_with(|| {
                let ra = a.resets_at.unwrap_or(u64::MAX);
                let rb = b.resets_at.unwrap_or(u64::MAX);
                rb.cmp(&ra)
            })
        })
        .map(|b| UsageWindow {
            used_percent: b.used_percent,
            window_minutes: minutes,
            resets_at: b.resets_at,
        })
}

// ---------------------------------------------------------------------------
// Claude Code (`https://api.anthropic.com/api/oauth/usage`)
// ---------------------------------------------------------------------------

async fn read_claude_oauth_token() -> Option<String> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")));
    if let Some(dir) = config_dir {
        let creds_path = dir.join(".credentials.json");
        if let Ok(raw) = tokio::fs::read_to_string(creds_path).await
            && let Some(tok) = extract_claude_oauth_token(&raw)
        {
            return Some(tok);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("/usr/bin/security");
        cmd.args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .kill_on_drop(true);
        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await
            && out.status.success()
        {
            let raw = String::from_utf8_lossy(&out.stdout);
            if let Some(tok) = extract_claude_oauth_token(raw.trim()) {
                return Some(tok);
            }
        }
    }

    None
}

fn extract_claude_oauth_token(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    v.pointer("/claudeAiOauth/accessToken")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

async fn fetch_claude_usage() -> ProviderUsage {
    let now = now_ms();
    let base = ProviderUsage {
        provider: "claude".into(),
        display_name: "Claude Code".into(),
        status: "unavailable".into(),
        plan_type: None,
        session: None,
        weekly: None,
        buckets: Vec::new(),
        error: None,
        updated_at: now,
    };

    let Some(token) = read_claude_oauth_token().await else {
        return base;
    };

    let headers = [
        format!("Authorization: Bearer {token}"),
        "anthropic-beta: oauth-2025-04-20".to_string(),
        "User-Agent: claude-code/2.1.0".to_string(),
    ];
    match curl_get_json("https://api.anthropic.com/api/oauth/usage", &headers).await {
        Ok((200, body)) => parse_claude_usage_body(&body, now).unwrap_or(ProviderUsage {
            status: "error".into(),
            error: Some("Invalid Claude usage response.".into()),
            ..base
        }),
        Ok((401 | 403, _)) => base,
        Ok((429, _)) => ProviderUsage {
            status: "error".into(),
            error: Some("Claude usage endpoint is rate-limited.".into()),
            ..base
        },
        Ok((code, _)) => ProviderUsage {
            status: "error".into(),
            error: Some(format!("Claude usage API returned HTTP {code}.")),
            ..base
        },
        Err(e) => ProviderUsage { status: "error".into(), error: Some(e), ..base },
    }
}

pub fn parse_claude_usage_body(body: &str, now: u64) -> Option<ProviderUsage> {
    let v: Value = serde_json::from_str(body).ok()?;
    let session = map_claude_window(v.get("five_hour"), SESSION_WINDOW_MINUTES);
    let weekly = map_claude_window(v.get("seven_day"), WEEKLY_WINDOW_MINUTES);
    if session.is_none() && weekly.is_none() {
        return None;
    }
    Some(ProviderUsage {
        provider: "claude".into(),
        display_name: "Claude Code".into(),
        status: "ok".into(),
        plan_type: None,
        session,
        weekly,
        buckets: Vec::new(),
        error: None,
        updated_at: now,
    })
}

fn map_claude_window(raw: Option<&Value>, window_minutes: u32) -> Option<UsageWindow> {
    let raw = raw?;
    let pct = raw
        .get("utilization")
        .or_else(|| raw.get("used_percentage"))
        .and_then(|n| n.as_f64())?;
    if !pct.is_finite() {
        return None;
    }
    Some(UsageWindow {
        used_percent: pct.round().clamp(0.0, 100.0) as u8,
        window_minutes,
        resets_at: raw.get("resets_at").and_then(parse_reset_timestamp),
    })
}

// ---------------------------------------------------------------------------
// Codex (`https://chatgpt.com/backend-api/wham/usage`)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CodexAuthJson {
    tokens: Option<CodexAuthTokens>,
}

#[derive(Deserialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

async fn fetch_codex_usage() -> ProviderUsage {
    let now = now_ms();
    let base = ProviderUsage {
        provider: "codex".into(),
        display_name: "Codex".into(),
        status: "unavailable".into(),
        plan_type: None,
        session: None,
        weekly: None,
        buckets: Vec::new(),
        error: None,
        updated_at: now,
    };

    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")));
    let Some(auth_path) = codex_home.map(|d| d.join("auth.json")) else {
        return base;
    };
    let Ok(raw) = tokio::fs::read_to_string(auth_path).await else {
        return base;
    };
    let Ok(parsed) = serde_json::from_str::<CodexAuthJson>(&raw) else {
        return base;
    };
    let Some(tokens) = parsed.tokens else {
        return base;
    };
    let Some(access_token) = tokens.access_token.filter(|t| !t.trim().is_empty()) else {
        return base;
    };

    let mut headers = vec![
        format!("Authorization: Bearer {access_token}"),
        "User-Agent: codex-cli".to_string(),
        "OpenAI-Beta: codex-1".to_string(),
        "originator: Codex Desktop".to_string(),
    ];
    if let Some(acc) = tokens.account_id.filter(|a| !a.trim().is_empty()) {
        headers.push(format!("ChatGPT-Account-Id: {acc}"));
    }

    match curl_get_json("https://chatgpt.com/backend-api/wham/usage", &headers).await {
        Ok((200, body)) => parse_codex_usage_body(&body, now).unwrap_or(ProviderUsage {
            status: "error".into(),
            error: Some("Invalid Codex usage response.".into()),
            ..base
        }),
        Ok((401 | 403, _)) => base,
        Ok((code, _)) => ProviderUsage {
            status: "error".into(),
            error: Some(format!("Codex usage API returned HTTP {code}.")),
            ..base
        },
        Err(e) => ProviderUsage { status: "error".into(), error: Some(e), ..base },
    }
}

pub fn parse_codex_usage_body(body: &str, now: u64) -> Option<ProviderUsage> {
    let v: Value = serde_json::from_str(body).ok()?;
    let plan_type = v.get("plan_type").and_then(|p| p.as_str()).map(str::to_string);
    let rl = v.get("rate_limit")?;
    let primary = map_codex_raw_window(rl.get("primary_window"));
    let secondary = map_codex_raw_window(rl.get("secondary_window"));

    let mut session: Option<UsageWindow> = None;
    let mut weekly: Option<UsageWindow> = None;
    for w in [&primary, &secondary].into_iter().flatten() {
        if w.window_minutes.abs_diff(SESSION_WINDOW_MINUTES) <= 1 && session.is_none() {
            session = Some(w.clone());
        } else if w.window_minutes.abs_diff(WEEKLY_WINDOW_MINUTES) <= 1 && weekly.is_none() {
            weekly = Some(w.clone());
        }
    }
    if session.is_none()
        && let Some(p) = primary
        && p.window_minutes.abs_diff(WEEKLY_WINDOW_MINUTES) > 1
    {
        session = Some(p);
    }
    if weekly.is_none()
        && let Some(s) = secondary
        && s.window_minutes.abs_diff(SESSION_WINDOW_MINUTES) > 1
    {
        weekly = Some(s);
    }

    if session.is_none() && weekly.is_none() {
        return None;
    }

    Some(ProviderUsage {
        provider: "codex".into(),
        display_name: "Codex".into(),
        status: "ok".into(),
        plan_type,
        session,
        weekly,
        buckets: Vec::new(),
        error: None,
        updated_at: now,
    })
}

fn map_codex_raw_window(raw: Option<&Value>) -> Option<UsageWindow> {
    let raw = raw?;
    let pct = raw.get("used_percent").and_then(|n| n.as_f64())?;
    if !pct.is_finite() {
        return None;
    }
    let secs = raw.get("limit_window_seconds").and_then(|s| s.as_f64()).unwrap_or(0.0);
    let window_minutes = if secs > 0.0 { (secs / 60.0).ceil() as u32 } else { 0 };
    Some(UsageWindow {
        used_percent: pct.round().clamp(0.0, 100.0) as u8,
        window_minutes,
        resets_at: raw.get("reset_at").and_then(parse_reset_timestamp),
    })
}

// ---------------------------------------------------------------------------
// Secure HTTP helper via curl `-K -` (headers never appear in argv/ps)
// ---------------------------------------------------------------------------

async fn curl_get_json(url: &str, headers: &[String]) -> Result<(u16, String), String> {
    let mut cfg = format!("url = \"{}\"\n", escape_curl_cfg(url));
    for h in headers {
        cfg.push_str(&format!("header = \"{}\"\n", escape_curl_cfg(h)));
    }

    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-sS", "--max-time", "10", "-w", "\n%{http_code}", "-K", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(cfg.as_bytes()).await;
    }

    let output = tokio::time::timeout(Duration::from_secs(12), child.wait_with_output())
        .await
        .map_err(|_| "Usage HTTP request timed out.".to_string())?
        .map_err(|e| format!("curl error: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "HTTP request failed".into() } else { stderr });
    }

    let full = String::from_utf8_lossy(&output.stdout);
    let (body, code_str) = full.rsplit_once('\n').ok_or_else(|| "Malformed HTTP output".to_string())?;
    let code = code_str.trim().parse::<u16>().map_err(|_| "Invalid HTTP status code".to_string())?;
    Ok((code, body.to_string()))
}

pub fn escape_curl_cfg(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\0'))
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso8601_and_numeric_resets() {
        assert_eq!(parse_reset_timestamp(&serde_json::json!(1_700_000_000)), Some(1_700_000_000_000));
        assert_eq!(parse_reset_timestamp(&serde_json::json!(1_700_000_000_123u64)), Some(1_700_000_000_123));
        assert_eq!(
            parse_reset_timestamp(&serde_json::json!("1970-01-01T00:01:00Z")),
            Some(60_000)
        );
        assert_eq!(
            parse_reset_timestamp(&serde_json::json!("2026-12-01T19:00:47Z")),
            Some(1_796_151_647_000)
        );
        assert_eq!(
            parse_reset_timestamp(&serde_json::json!("2026-12-02T02:00:47+07:00")),
            Some(1_796_151_647_000)
        );
    }

    #[test]
    fn parses_live_antigravity_usage_envelope() {
        let stdout = r#"{"conversation_id":"","status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","description":"Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.94,"reset_time":"2026-12-01T19:00:47Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.79,"reset_time":"2026-11-25T00:00:47Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-25T00:07:22Z"},{"id":"disabled-pool","name":"Hidden","window":"5h","remaining_fraction":0,"disabled":true}]}]}}}"#;
        assert!(!agy_stdout_shows_model_turn(stdout));
        let parsed = parse_agy_usage_stdout(stdout, 12345).expect("parse agy");
        assert_eq!(parsed.status, "ok");
        assert_eq!(parsed.buckets.len(), 3);
        assert_eq!(parsed.buckets[0].name, "Gemini Models · Weekly Limit Remaining");
        assert_eq!(parsed.buckets[0].used_percent, 6);
        assert_eq!(parsed.buckets[0].group_description.as_deref(), Some("Gemini 4 Hydrogen, Gemini 3.8 Flash"));
        assert_eq!(parsed.buckets[1].used_percent, 21);
        assert_eq!(parsed.buckets[2].name, "Claude and GPT models");
        assert_eq!(parsed.session.as_ref().unwrap().used_percent, 21);
        assert_eq!(parsed.weekly.as_ref().unwrap().used_percent, 6);
    }

    #[test]
    fn detects_agy_model_turn_guard() {
        let bad = r#"{"conversation_id":"conv-1","num_turns":1,"status":"SUCCESS"}"#;
        assert!(agy_stdout_shows_model_turn(bad));
    }

    #[test]
    fn parses_claude_and_codex_responses() {
        let claude = r#"{"five_hour":{"utilization":34.6,"resets_at":"2026-11-25T04:00:00Z"},"seven_day":{"used_percentage":18,"resets_at":1796151647}}"#;
        let cu = parse_claude_usage_body(claude, 999).expect("claude");
        assert_eq!(cu.session.as_ref().unwrap().used_percent, 35);
        assert_eq!(cu.weekly.as_ref().unwrap().used_percent, 18);
        assert_eq!(cu.weekly.as_ref().unwrap().resets_at, Some(1_796_151_647_000));

        let codex = r#"{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":42,"limit_window_seconds":18000,"reset_at":1796000000},"secondary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_at":1796500000}}}"#;
        let xu = parse_codex_usage_body(codex, 999).expect("codex");
        assert_eq!(xu.plan_type.as_deref(), Some("plus"));
        assert_eq!(xu.session.as_ref().unwrap().used_percent, 42);
        assert_eq!(xu.weekly.as_ref().unwrap().used_percent, 12);
    }

    #[test]
    fn parses_prerelease_agy_semver_and_strips_curl_cfg_newlines() {
        assert!(parse_agy_version_ok("agy 1.2.0-beta.1"));
        assert!(parse_agy_version_ok("v1.1.11-rc.2+build9"));
        assert!(!parse_agy_version_ok("agy 1.1.10-beta.5"));
        assert_eq!(
            escape_curl_cfg("Authorization: Bearer tok\r\nurl = \"https://evil.test\"\0"),
            "Authorization: Bearer tokurl = \\\"https://evil.test\\\""
        );
    }
}
