use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

/// VAPID `sub` claim (RFC 8292 section 2.1). Overridable with `CMUX_VAPID_SUBJECT`.
const DEFAULT_VAPID_SUBJECT: &str = "mailto:cmux-mobile@example.com";

/// Persisted VAPID key pair (`~/.cmux/vapid.json`). Private key = raw 32-byte P-256 scalar, base64url (no pad).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VapidKeys {
    private_key: String,
    /// Uncompressed P-256 point (65 bytes), base64url no padding: the `applicationServerKey` for the browser.
    public_key: String,
}

impl VapidKeys {
    fn generate() -> Self {
        use jwt_simple::prelude::*;
        let pair = ES256KeyPair::generate();
        let b64 = |b: &[u8]| base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, b);
        Self {
            private_key: b64(&pair.to_bytes()),
            public_key: b64(&pair.public_key().public_key().to_bytes_uncompressed()),
        }
    }

    fn load_or_create(path: &std::path::Path) -> Self {
        if let Some(k) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Self>(&t).ok()) {
            return k;
        }
        let keys = Self::generate();
        write_private(path, &serde_json::to_string_pretty(&keys).unwrap_or_default());
        keys
    }
}

/// Write a file readable only by the owner (contains secrets / endpoints).
fn write_private(path: &std::path::Path, content: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Created 0600 from the start (a later chmod would leave a window where the VAPID key is world-readable).
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = opts.open(path).and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()));
    if written.is_err() {
        warn!("Failed to persist {}", path.display());
        return;
    }
    #[cfg(unix)]
    {
        // An existing file keeps its old mode on open; tighten it too.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Upper bound on stored subscriptions (one per browser/device is expected).
pub const MAX_SUBSCRIPTIONS: usize = 32;

/// Push services browsers actually use. A subscription pointing anywhere else would make the gateway
/// POST agent notification text to an arbitrary host (exfiltration / SSRF), so it is rejected.
/// Extra hosts can be added with `CMUX_PUSH_ALLOWED_HOSTS` (comma separated, suffix match).
const PUSH_HOST_SUFFIXES: &[&str] = &[
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
];

/// Validates a Web Push endpoint URL: https only, no userinfo, no IP literal, host on the allow list.
pub fn validate_push_endpoint(endpoint: &str) -> Result<(), String> {
    let rest = endpoint
        .strip_prefix("https://")
        .ok_or_else(|| "push endpoint must use https".to_string())?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Only plain DNS-name characters: WHATWG URL parsers treat `\` like `/` in https URLs, so
    // `https://evil.example\.fcm.googleapis.com/x` would otherwise pass the suffix check below yet resolve
    // to evil.example when requested.
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':');
    if authority.is_empty() || !authority.chars().all(plain) {
        return Err("push endpoint has an invalid authority".into());
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority).to_ascii_lowercase();
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return Err("push endpoint must be a DNS name, not an IP literal".into());
    }
    let extra = std::env::var("CMUX_PUSH_ALLOWED_HOSTS").unwrap_or_default();
    let allowed = PUSH_HOST_SUFFIXES
        .iter()
        .copied()
        .chain(extra.split(',').map(str::trim).filter(|x| !x.is_empty()))
        .any(|suffix| host == suffix || host.ends_with(&format!(".{suffix}")));
    if allowed {
        Ok(())
    } else {
        Err(format!("push host '{host}' is not an allowed push service"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
    /// Device that registered it. Set by the gateway from the authenticated session (a client-supplied
    /// value is overwritten), so revoking the device can remove its subscriptions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Notification categories this subscription opted out of (see `PUSH_CATEGORIES`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub muted_categories: Vec<String>,
}

/// Categories the gateway emits (`category` in the dispatch data, see server.rs dispatchers).
pub const PUSH_CATEGORIES: &[&str] = &["needs-permission", "turn-finished", "agent-error", "cmux-dialog"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchedNotification {
    pub timestamp_ms: u64,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub data: serde_json::Value,
    pub subscriptions_notified: usize,
}

#[derive(Clone, Default)]
pub struct PushService {
    /// `Some` => real Web Push delivery enabled (production). `None` => in-memory only (tests).
    vapid: Option<Arc<VapidKeys>>,
    client: Option<Arc<IsahcWebPushClient>>,
    subs_path: Option<PathBuf>,
    subscriptions: Arc<Mutex<Vec<PushSubscription>>>,
    persist_lock: Arc<Mutex<()>>,
    recent_dispatches: Arc<Mutex<Vec<DispatchedNotification>>>,
    cooldowns: Arc<Mutex<HashMap<String, Instant>>>,
}

impl PushService {
    /// Production constructor: persistent VAPID keys + subscriptions under `~/.cmux/` and real delivery.
    pub fn with_storage(dir: PathBuf) -> Self {
        let vapid = VapidKeys::load_or_create(&dir.join("vapid.json"));
        let subs_path = dir.join("push_subscriptions.json");
        let subs: Vec<PushSubscription> = std::fs::read_to_string(&subs_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut svc = Self::new();
        svc.vapid = Some(Arc::new(vapid));
        svc.client = IsahcWebPushClient::new().ok().map(Arc::new);
        svc.subs_path = Some(subs_path);
        *svc.subscriptions.lock().unwrap() = subs;
        svc
    }

    /// `~/.cmux` (same directory as `devices.json`).
    pub fn default_dir() -> Option<PathBuf> {
        std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".cmux"))
    }

    /// VAPID public key for `PushManager.subscribe({ applicationServerKey })`.
    pub fn vapid_public_key(&self) -> Option<String> {
        self.vapid.as_ref().map(|v| v.public_key.clone())
    }

    fn persist(&self) {
        if let Some(path) = &self.subs_path {
            // Serialize disk writes separately so `subscriptions` lock is never held across file I/O.
            let _persist_guard = self.persist_lock.lock().unwrap();
            let snapshot = self.subscriptions.lock().unwrap().clone();
            let json = serde_json::to_string_pretty(&snapshot).unwrap_or_default();
            write_private(path, &json);
        }
    }

    pub fn new() -> Self {
        Self {
            vapid: None,
            client: None,
            subs_path: None,
            subscriptions: Arc::new(Mutex::new(Vec::new())),
            persist_lock: Arc::new(Mutex::new(())),
            recent_dispatches: Arc::new(Mutex::new(Vec::new())),
            cooldowns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register(&self, sub: PushSubscription) {
        let mut guard = self.subscriptions.lock().unwrap();
        if let Some(existing) = guard.iter_mut().find(|s| s.endpoint == sub.endpoint) {
            // Same browser registering again: keep its preferences. The device link is only filled in when
            // empty; another device re-registering a known endpoint must not take the subscription over.
            if existing.device_id.is_none() && sub.device_id.is_some() {
                existing.device_id = sub.device_id;
                drop(guard);
                self.persist();
            }
        } else {
            info!("Registered new push subscription: {}", sub.endpoint);
            guard.push(sub);
            drop(guard);
            self.persist();
        }
    }

    /// Drops every subscription registered by `device_id` (called when the device is revoked).
    pub fn unregister_device(&self, device_id: &str) -> usize {
        let mut guard = self.subscriptions.lock().unwrap();
        let before = guard.len();
        guard.retain(|s| s.device_id.as_deref() != Some(device_id));
        let removed = before - guard.len();
        drop(guard);
        if removed > 0 {
            self.persist();
        }
        removed
    }

    /// Sets the muted categories of one subscription. Unknown category names are ignored.
    /// Returns false when the endpoint is not registered.
    pub fn set_muted(&self, endpoint: &str, muted: &[String]) -> bool {
        self.set_muted_for(endpoint, muted, None)
    }

    /// Like `set_muted`, but when `device_id` is given the subscription must belong to that device.
    pub fn set_muted_for(&self, endpoint: &str, muted: &[String], device_id: Option<&str>) -> bool {
        let mut guard = self.subscriptions.lock().unwrap();
        let Some(sub) = guard.iter_mut().find(|s| {
            s.endpoint == endpoint
                && match (device_id, s.device_id.as_deref()) {
                    (Some(want), Some(owner)) => want == owner,
                    _ => true,
                }
        }) else {
            return false;
        };
        let mut clean: Vec<String> = muted
            .iter()
            .filter(|m| PUSH_CATEGORIES.contains(&m.as_str()))
            .cloned()
            .collect();
        clean.sort();
        clean.dedup();
        sub.muted_categories = clean;
        drop(guard);
        self.persist();
        true
    }

    pub fn unregister(&self, endpoint: &str) {
        let mut guard = self.subscriptions.lock().unwrap();
        guard.retain(|s| s.endpoint != endpoint);
        drop(guard);
        self.persist();
    }

    pub fn count(&self) -> usize {
        self.subscriptions.lock().unwrap().len()
    }

    pub fn list(&self) -> Vec<PushSubscription> {
        self.subscriptions.lock().unwrap().clone()
    }

    /// Checks if a notification for (surface_id, category) can be dispatched according to
    /// the burst cooldown gate (matching Orca reserveNotificationCooldown standard).
    pub fn should_dispatch(&self, surface_id: &str, category: &str, cooldown_secs: u64) -> bool {
        let key = format!("{surface_id}:{category}");
        let mut guard = self.cooldowns.lock().unwrap();
        let now = Instant::now();
        if guard.len() > 256 {
            guard.retain(|_, at| now.duration_since(*at) < Duration::from_secs(3600));
        }
        if let Some(prev) = guard.get(&key) {
            if now.duration_since(*prev) < Duration::from_secs(cooldown_secs) {
                return false;
            }
        }
        guard.insert(key, now);
        true
    }

    /// Dispatches an alert to all registered push subscriptions and records to history.
    pub async fn dispatch(
        &self,
        title: &str,
        body: &str,
        tag: Option<&str>,
        data: serde_json::Value,
    ) -> usize {
        let none = std::collections::HashSet::new();
        self.dispatch_excluding_devices(title, body, tag, data, &none).await
    }

    /// Dispatches an alert to registered subscriptions, honouring category mutes and skipping any
    /// `device_id` currently viewing the target surface (`suppressWhileViewing`).
    pub async fn dispatch_excluding_devices(
        &self,
        title: &str,
        body: &str,
        tag: Option<&str>,
        data: serde_json::Value,
        excluded_devices: &std::collections::HashSet<String>,
    ) -> usize {
        // Honour per-subscription opt-outs for this notification's category.
        let category = data.get("category").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let subs: Vec<PushSubscription> = self
            .list()
            .into_iter()
            .filter(|s| !s.muted_categories.iter().any(|m| *m == category))
            .filter(|s| !s.device_id.as_ref().is_some_and(|id| excluded_devices.contains(id)))
            .collect();
        let count = subs.len();
        let tag_str = tag.unwrap_or("cmux-agent").to_string();

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let record = DispatchedNotification {
            timestamp_ms: now_ms,
            title: title.to_string(),
            body: body.to_string(),
            tag: tag_str.clone(),
            data: data.clone(),
            subscriptions_notified: count,
        };

        {
            let mut hist = self.recent_dispatches.lock().unwrap();
            hist.push(record);
            if hist.len() > 50 {
                hist.remove(0);
            }
        }

        info!(
            "PushService dispatched alert '{}' to {} active subscribers",
            title, count
        );

        // Real delivery (RFC 8030 + RFC 8291 + VAPID RFC 8292). Failures never block the caller.
        if let Some(vapid) = self.vapid.clone() {
            let payload = serde_json::json!({
                "title": title, "body": body, "tag": tag_str, "data": data,
            })
            .to_string();
            let urgent = matches!(data.get("category").and_then(|c| c.as_str()), Some("needs-permission" | "agent-error" | "cmux-dialog"));
            for sub in subs {
                let svc = self.clone();
                let vapid = vapid.clone();
                let client = self.client.clone();
                let payload = payload.clone();
                let tag = tag_str.clone();
                tokio::spawn(async move {
                    match deliver(client.as_deref(), &vapid, &sub, payload.as_bytes(), urgent, &tag).await {
                        Ok(()) => info!("Web Push delivered to {}", short(&sub.endpoint)),
                        Err(WebPushError::EndpointNotValid(_))
                        | Err(WebPushError::EndpointNotFound(_))
                        | Err(WebPushError::InvalidCryptoKeys) => {
                            info!("Pruning expired push subscription {}", short(&sub.endpoint));
                            svc.unregister(&sub.endpoint);
                        }
                        Err(e) => warn!("Web Push to {} failed: {e}", short(&sub.endpoint)),
                    }
                });
            }
        }

        count
    }

    /// Returns the most recent dispatched notifications (in-memory ring buffer).
    pub fn history(&self) -> Vec<DispatchedNotification> {
        self.recent_dispatches.lock().unwrap().clone()
    }
}

fn short(endpoint: &str) -> String {
    endpoint.chars().take(48).collect()
}

async fn deliver(
    client: Option<&IsahcWebPushClient>,
    vapid: &VapidKeys,
    sub: &PushSubscription,
    payload: &[u8],
    urgent: bool,
    topic: &str,
) -> Result<(), WebPushError> {
    let info = SubscriptionInfo::new(&sub.endpoint, &sub.keys.p256dh, &sub.keys.auth);
    let mut sig = VapidSignatureBuilder::from_base64(&vapid.private_key, &info)?;
    let subject = std::env::var("CMUX_VAPID_SUBJECT").unwrap_or_else(|_| DEFAULT_VAPID_SUBJECT.to_string());
    sig.add_claim("sub", subject);
    let mut msg = WebPushMessageBuilder::new(&info);
    msg.set_payload(ContentEncoding::Aes128Gcm, payload);
    msg.set_vapid_signature(sig.build()?);
    msg.set_ttl(if urgent { 3600 } else { 600 });
    msg.set_urgency(if urgent { Urgency::High } else { Urgency::Normal });
    // Topic must be <=32 base64url chars (RFC 8030 section 5.4); replaces a pending message of the same tag.
    let topic: String = topic.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
    if !topic.is_empty() {
        msg.set_topic(topic);
    }
    let built = msg.build()?;
    if let Some(shared) = client {
        shared.send(built).await
    } else {
        IsahcWebPushClient::new()?.send(built).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_service_registration() {
        let service = PushService::new();
        let sub = PushSubscription {
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "key-p256dh".to_string(),
                auth: "key-auth".to_string(),
            },
            device_id: None,
            muted_categories: vec![],
        };

        service.register(sub.clone());
        assert_eq!(service.count(), 1);

        // Deduplicate duplicate registration
        service.register(sub.clone());
        assert_eq!(service.count(), 1);

        service.unregister(&sub.endpoint);
        assert_eq!(service.count(), 0);
    }

    #[tokio::test]
    async fn test_push_service_cooldown_and_dispatch() {
        let service = PushService::new();
        assert!(service.should_dispatch("surf_1", "needs-permission", 5));
        // Immediate repeat must be rejected by cooldown
        assert!(!service.should_dispatch("surf_1", "needs-permission", 5));
        // Different category or surface passes
        assert!(service.should_dispatch("surf_1", "turn-finished", 5));
        assert!(service.should_dispatch("surf_2", "needs-permission", 5));

        service.dispatch(
            "Claude Needs Approval",
            "Agent requested approval for bash command",
            Some("cmux-agent"),
            serde_json::json!({ "surfaceId": "surf_1", "category": "needs-permission" }),
        ).await;

        let hist = service.history();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].title, "Claude Needs Approval");
        assert_eq!(hist[0].data["category"], "needs-permission");
    }

    #[test]
    fn test_vapid_keys_generate_and_persist() {
        let dir = std::env::temp_dir().join(format!("cmux-vapid-{}", uuid::Uuid::new_v4()));
        let a = PushService::with_storage(dir.clone());
        let key = a.vapid_public_key().unwrap();
        // Uncompressed P-256 point: 65 bytes starting with 0x04.
        let raw = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &key).unwrap();
        assert_eq!(raw.len(), 65);
        assert_eq!(raw[0], 0x04);

        a.register(PushSubscription {
            endpoint: "https://example.invalid/x".to_string(),
            keys: PushSubscriptionKeys { p256dh: "p".into(), auth: "a".into() },
            device_id: None,
            muted_categories: vec![],
        });
        // Restart: same key, same subscription
        let b = PushService::with_storage(dir.clone());
        assert_eq!(b.vapid_public_key().unwrap(), key);
        assert_eq!(b.count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn push_endpoint_validation() {
        assert!(validate_push_endpoint("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(validate_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x").is_ok());
        assert!(validate_push_endpoint("https://web.push.apple.com/abc").is_ok());
        assert!(validate_push_endpoint("http://fcm.googleapis.com/x").is_err());
        assert!(validate_push_endpoint("https://evil.example/x").is_err());
        assert!(validate_push_endpoint("https://127.0.0.1/x").is_err());
        assert!(validate_push_endpoint("https://[::1]/x").is_err());
        assert!(validate_push_endpoint("https://fcm.googleapis.com@evil.example/x").is_err());
        assert!(validate_push_endpoint("https://notfcm.googleapis.com.evil.example/x").is_err());
        // `\` is a path separator for WHATWG parsers: the real host would be evil.example.
        assert!(validate_push_endpoint("https://evil.example\\.fcm.googleapis.com/x").is_err());
        assert!(validate_push_endpoint("https://fcm.googleapis.com%2f@evil.example/x").is_err());
    }

    fn sub(endpoint: &str, device: Option<&str>) -> PushSubscription {
        PushSubscription {
            endpoint: endpoint.to_string(),
            keys: PushSubscriptionKeys { p256dh: "p".into(), auth: "a".into() },
            device_id: device.map(str::to_string),
            muted_categories: vec![],
        }
    }

    #[test]
    fn revoking_a_device_removes_only_its_subscriptions() {
        let svc = PushService::new();
        svc.register(sub("https://fcm.googleapis.com/a", Some("dev_1")));
        svc.register(sub("https://fcm.googleapis.com/b", Some("dev_2")));
        svc.register(sub("https://fcm.googleapis.com/c", None));
        assert_eq!(svc.unregister_device("dev_1"), 1);
        assert_eq!(svc.count(), 2);
        assert_eq!(svc.unregister_device("dev_1"), 0);
    }

    #[test]
    fn muted_categories_are_validated_and_survive_reregistration() {
        let svc = PushService::new();
        svc.register(sub("https://fcm.googleapis.com/a", Some("dev_1")));
        assert!(!svc.set_muted("https://fcm.googleapis.com/missing", &["turn-finished".into()]));
        assert!(svc.set_muted(
            "https://fcm.googleapis.com/a",
            &["turn-finished".into(), "bogus".into(), "turn-finished".into()]
        ));
        assert_eq!(svc.list()[0].muted_categories, vec!["turn-finished".to_string()]);
        svc.register(sub("https://fcm.googleapis.com/a", Some("dev_1")));
        assert_eq!(svc.list()[0].muted_categories, vec!["turn-finished".to_string()]);
    }

    #[tokio::test]
    async fn dispatch_skips_subscriptions_that_muted_the_category() {
        let svc = PushService::new();
        svc.register(sub("https://fcm.googleapis.com/a", None));
        svc.register(sub("https://fcm.googleapis.com/b", None));
        svc.set_muted("https://fcm.googleapis.com/b", &["turn-finished".into()]);
        let n = svc.dispatch("t", "b", None, serde_json::json!({ "category": "turn-finished" })).await;
        assert_eq!(n, 1);
        let n = svc.dispatch("t", "b", None, serde_json::json!({ "category": "needs-permission" })).await;
        assert_eq!(n, 2);
    }

    #[test]
    fn another_device_cannot_take_over_or_edit_a_subscription() {
        let svc = PushService::new();
        svc.register(sub("https://fcm.googleapis.com/a", Some("dev_1")));
        svc.register(sub("https://fcm.googleapis.com/a", Some("dev_2")));
        assert_eq!(svc.list()[0].device_id.as_deref(), Some("dev_1"), "no hijack by re-register");
        assert!(!svc.set_muted_for("https://fcm.googleapis.com/a", &["turn-finished".into()], Some("dev_2")));
        assert!(svc.set_muted_for("https://fcm.googleapis.com/a", &["turn-finished".into()], Some("dev_1")));
    }
}
