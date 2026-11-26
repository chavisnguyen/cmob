//! One-time pairing tickets and per-device tokens.
//!
//! A pairing offer carries a short-lived single-use `ticket` instead of the long-lived gateway
//! token. The client redeems it once at `POST /api/pair/exchange` for a random per-device token,
//! which is persisted (mode 0600) so it survives gateway restarts. Modeled on Orca's one-time
//! ticket exchange (ref/orca/mobile/src/pairing/pairing-ticket-exchange.ts).
//!
//! Devices carry an id, a label and `created_at`/`last_seen`. A device that is not seen for
//! `DEVICE_TTL_SECS` expires, and any device can be revoked by id (`mobile.device.revoke`); live
//! WebSocket sessions re-check their token on every request, so revocation takes effect immediately.
//!
//! Limitation: this does not add transport encryption or device key pinning. Minting a ticket needs the
//! gateway token (`GET /api/pairing`), but anyone holding a ticket can redeem it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const TICKET_TTL: Duration = Duration::from_secs(600);
/// A device not seen for this long is treated as revoked (90 days).
pub const DEVICE_TTL_SECS: u64 = 90 * 24 * 3600;
/// `last_seen` is refreshed (and persisted) at most this often per device.
const TOUCH_INTERVAL_SECS: u64 = 3600;
const MAX_TICKETS: usize = 16;
const MAX_DEVICES: usize = 64;
const MAX_LABEL_CHARS: usize = 40;

#[derive(Clone, Serialize, Deserialize)]
struct DeviceRecord {
    id: String,
    token: String,
    label: String,
    created_at: u64,
    last_seen: u64,
}

/// Public view of a device. Never contains the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize)]
struct DevicesFile {
    version: u32,
    devices: Vec<DeviceRecord>,
}

#[derive(Default)]
struct Inner {
    tickets: HashMap<String, Instant>,
    devices: Vec<DeviceRecord>,
}

#[derive(Clone)]
pub struct DeviceRegistry {
    inner: Arc<Mutex<Inner>>,
    persist_lock: Arc<Mutex<()>>,
    path: Option<PathBuf>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_secret(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Constant-time string comparison (length is not secret here).
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn clean_label(raw: &str) -> String {
    let t: String = raw.chars().filter(|c| !c.is_control()).take(MAX_LABEL_CHARS).collect();
    let t = t.trim();
    if t.is_empty() { "Device".to_string() } else { t.to_string() }
}

impl DeviceRegistry {
    /// `CMUX_DEVICES_FILE`, else `~/.cmux/devices.json`.
    pub fn default_path() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("CMUX_DEVICES_FILE") {
            return Some(PathBuf::from(p));
        }
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".cmux").join("devices.json"))
    }

    /// Loads v2 (`{"version":2,"devices":[..]}`) or the legacy flat token list. A file that exists but
    /// cannot be parsed is moved aside to `<file>.corrupt` instead of being overwritten by the next write.
    pub fn new(path: Option<PathBuf>) -> Self {
        let now = now_secs();
        let mut devices: Vec<DeviceRecord> = Vec::new();
        if let Some(p) = path.as_ref() {
            if let Ok(raw) = std::fs::read_to_string(p) {
                if let Ok(f) = serde_json::from_str::<DevicesFile>(&raw) {
                    devices = f.devices;
                } else if let Ok(tokens) = serde_json::from_str::<Vec<String>>(&raw) {
                    devices = tokens
                        .into_iter()
                        .map(|token| DeviceRecord {
                            id: format!("dev_{}", uuid::Uuid::new_v4().simple()),
                            token,
                            label: "Legacy device".into(),
                            created_at: now,
                            last_seen: now,
                        })
                        .collect();
                } else {
                    let mut aside = p.clone().into_os_string();
                    aside.push(".corrupt");
                    let _ = std::fs::rename(p, aside);
                }
            }
        }
        Self {
            inner: Arc::new(Mutex::new(Inner { tickets: HashMap::new(), devices })),
            persist_lock: Arc::new(Mutex::new(())),
            path,
        }
    }

    pub fn issue_ticket(&self) -> String {
        let ticket = random_secret("cmux_tkt_");
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.tickets.retain(|_, exp| *exp > now);
        while g.tickets.len() >= MAX_TICKETS {
            if let Some(oldest) = g.tickets.iter().min_by_key(|(_, e)| **e).map(|(k, _)| k.clone()) {
                g.tickets.remove(&oldest);
            }
        }
        g.tickets.insert(ticket.clone(), now + TICKET_TTL);
        ticket
    }

    /// Consume a ticket (single use) and return a fresh device token.
    pub fn redeem(&self, ticket: &str) -> Option<String> {
        self.redeem_labeled(ticket, "Device")
    }

    pub fn redeem_labeled(&self, ticket: &str, label: &str) -> Option<String> {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        let wall = now_secs();
        g.devices.retain(|d| wall.saturating_sub(d.last_seen) <= DEVICE_TTL_SECS);
        let key = g.tickets.keys().find(|k| ct_eq(k, ticket)).cloned()?;
        // A full registry must not burn the ticket: check before consuming it.
        if g.devices.len() >= MAX_DEVICES {
            return None;
        }
        let expiry = g.tickets.remove(&key)?;
        if expiry <= now {
            return None;
        }
        let token = random_secret("cmux_dev_");
        g.devices.push(DeviceRecord {
            id: format!("dev_{}", uuid::Uuid::new_v4().simple()),
            token: token.clone(),
            label: clean_label(label),
            created_at: wall,
            last_seen: wall,
        });
        drop(g);
        self.persist_latest();
        Some(token)
    }

    /// True for a known, unexpired device token. Refreshes `last_seen` (at most hourly).
    pub fn is_device_token(&self, token: &str) -> bool {
        self.is_device_token_at(token, now_secs())
    }

    fn is_device_token_at(&self, token: &str, now: u64) -> bool {
        let mut g = self.inner.lock().unwrap();
        let Some(idx) = g.devices.iter().position(|d| ct_eq(&d.token, token)) else {
            return false;
        };
        if now.saturating_sub(g.devices[idx].last_seen) > DEVICE_TTL_SECS {
            return false;
        }
        let touched = now.saturating_sub(g.devices[idx].last_seen) >= TOUCH_INTERVAL_SECS;
        if touched {
            g.devices[idx].last_seen = now;
        }
        drop(g);
        if touched {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let reg = self.clone();
                handle.spawn_blocking(move || reg.persist_latest());
            } else {
                self.persist_latest();
            }
        }
        true
    }

    /// Id of the device owning `token` (None for the gateway token or an unknown token).
    pub fn device_id_for_token(&self, token: &str) -> Option<String> {
        let g = self.inner.lock().unwrap();
        g.devices.iter().find(|d| ct_eq(&d.token, token)).map(|d| d.id.clone())
    }

    /// Removes devices idle past the TTL and returns their ids (so callers can drop their push
    /// subscriptions too).
    pub fn prune_expired(&self) -> Vec<String> {
        let wall = now_secs();
        let mut g = self.inner.lock().unwrap();
        let (keep, gone): (Vec<_>, Vec<_>) = g
            .devices
            .drain(..)
            .partition(|d| wall.saturating_sub(d.last_seen) <= DEVICE_TTL_SECS);
        g.devices = keep;
        let ids: Vec<String> = gone.into_iter().map(|d| d.id).collect();
        drop(g);
        if !ids.is_empty() {
            self.persist_latest();
        }
        ids
    }

    pub fn list(&self) -> Vec<DeviceInfo> {
        let wall = now_secs();
        let g = self.inner.lock().unwrap();
        g.devices
            .iter()
            .filter(|d| wall.saturating_sub(d.last_seen) <= DEVICE_TTL_SECS)
            .map(|d| DeviceInfo {
                id: d.id.clone(),
                label: d.label.clone(),
                created_at: d.created_at,
                last_seen: d.last_seen,
            })
            .collect()
    }

    /// Removes a device by id. Returns whether it existed.
    pub fn revoke(&self, id: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        let before = g.devices.len();
        g.devices.retain(|d| d.id != id);
        let removed = g.devices.len() != before;
        drop(g);
        if removed {
            self.persist_latest();
        }
        removed
    }

    pub fn device_count(&self) -> usize {
        self.inner.lock().unwrap().devices.len()
    }

    /// Serializes disk persistence without holding `inner` across file I/O or `fsync`.
    fn persist_latest(&self) {
        let _persist_guard = self.persist_lock.lock().unwrap();
        let snapshot = self.inner.lock().unwrap().devices.clone();
        self.persist(&snapshot);
    }

    fn persist(&self, devices: &[DeviceRecord]) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = DevicesFile { version: 2, devices: devices.to_vec() };
        let Ok(json) = serde_json::to_string(&file) else { return };
        // Write a temp file next to the target and rename it into place: a crash mid-write must never
        // leave a truncated devices.json (which would log every paired device out).
        let mut tmp = path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let written = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
                .and_then(|mut f| {
                    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
                    f.write_all(json.as_bytes())?;
                    f.sync_all()
                });
            if written.is_ok() {
                let _ = std::fs::rename(&tmp, path);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        #[cfg(not(unix))]
        {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_is_single_use_and_yields_persistent_device_token() {
        let path = std::env::temp_dir().join(format!("devices-{}.json", uuid::Uuid::new_v4()));
        let reg = DeviceRegistry::new(Some(path.clone()));
        let t = reg.issue_ticket();
        assert!(reg.redeem("wrong").is_none());
        let dev = reg.redeem(&t).expect("first redeem");
        assert!(reg.redeem(&t).is_none(), "ticket must be single-use");
        assert!(reg.is_device_token(&dev));
        assert!(!reg.is_device_token("nope"));

        // survives restart
        let reloaded = DeviceRegistry::new(Some(path.clone()));
        assert!(reloaded.is_device_token(&dev));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ticket_count_is_bounded() {
        let reg = DeviceRegistry::new(None);
        let first = reg.issue_ticket();
        for _ in 0..MAX_TICKETS + 2 {
            reg.issue_ticket();
        }
        assert!(reg.redeem(&first).is_none(), "oldest ticket evicted");
    }

    #[test]
    fn ct_eq_basics() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "ab"));
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("devices-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn revoke_removes_device_and_persists() {
        let path = temp_path();
        let reg = DeviceRegistry::new(Some(path.clone()));
        let t = reg.issue_ticket();
        let tok = reg.redeem_labeled(&t, "My iPhone").unwrap();
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "My iPhone");
        assert!(!serde_json::to_string(&list).unwrap().contains(&tok), "token must never be listed");
        assert!(!reg.revoke("dev_missing"));
        assert!(reg.revoke(&list[0].id));
        assert!(!reg.is_device_token(&tok));
        assert!(!DeviceRegistry::new(Some(path.clone())).is_device_token(&tok), "revocation persisted");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn idle_device_expires_but_active_one_is_refreshed() {
        let reg = DeviceRegistry::new(None);
        let t = reg.issue_ticket();
        let tok = reg.redeem(&t).unwrap();
        let now = now_secs();
        assert!(reg.is_device_token_at(&tok, now + DEVICE_TTL_SECS - 10));
        // that call refreshed last_seen, so it is valid again long after the original creation
        assert!(reg.is_device_token_at(&tok, now + DEVICE_TTL_SECS + 3600));
        assert!(!reg.is_device_token_at(&tok, now + 3 * DEVICE_TTL_SECS));
    }

    #[test]
    fn legacy_flat_token_file_is_migrated() {
        let path = temp_path();
        std::fs::write(&path, r#"["cmux_dev_old1","cmux_dev_old2"]"#).unwrap();
        let reg = DeviceRegistry::new(Some(path.clone()));
        assert!(reg.is_device_token("cmux_dev_old1"));
        assert_eq!(reg.device_count(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let path = temp_path();
        std::fs::write(&path, "{not json").unwrap();
        let reg = DeviceRegistry::new(Some(path.clone()));
        assert_eq!(reg.device_count(), 0);
        let mut aside = path.clone().into_os_string();
        aside.push(".corrupt");
        let aside = PathBuf::from(aside);
        assert_eq!(std::fs::read_to_string(&aside).unwrap(), "{not json");
        let _ = std::fs::remove_file(aside);
    }
}
