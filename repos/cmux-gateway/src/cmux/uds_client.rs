//! Pure persistent pooled Unix Domain Socket (`cmux.sock`) JSON-RPC client.
//!
//! Speaks `cmux`'s exact native v2 socket protocol over 4 reusable `tokio::net::UnixStream` slots
//! (~0.6–0.9ms per RPC, zero subprocess spawning, zero CLI fallback):
//! - Request line with `CMUX_SOCKET_CAPABILITY`:
//!   `_cmux_capability_v1 <CMUX_SOCKET_CAPABILITY> {"id":"...","method":"...","params":{...}}\n`
//! - Request line without `CMUX_SOCKET_CAPABILITY`:
//!   `{"id":"...","method":"...","params":{...}}\n`
//!
//! Surfaces all daemon and socket errors directly without masking or falling back to subprocesses.

use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

const POOL_SLOTS: usize = 4;
const CAPABILITY_PREFIX: &str = "_cmux_capability_v1 ";

#[derive(Debug)]
pub enum UdsCallError {
    /// Socket path missing or connection refused.
    Unavailable(String),
    /// Operation exceeded configured timeout.
    Timeout,
    /// Daemon returned an error (`ok: false` or `ERROR: ...` banner).
    RpcError(String),
    /// Malformed JSON response.
    ParseError(String),
}

struct PooledStream {
    path: PathBuf,
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

#[derive(Debug, Deserialize)]
struct RawSocketResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RawSocketError>,
}

#[derive(Debug, Deserialize)]
struct RawSocketError {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

pub struct CmuxUdsPool {
    explicit_path: Option<PathBuf>,
    capability_token: Option<String>,
    slots: [Mutex<Option<PooledStream>>; POOL_SLOTS],
    rr_cursor: AtomicUsize,
    req_seq: AtomicU64,
}

impl std::fmt::Debug for CmuxUdsPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CmuxUdsPool")
            .field("explicit_path", &self.explicit_path)
            .field("has_capability", &self.capability_token.is_some())
            .finish()
    }
}

impl Default for CmuxUdsPool {
    fn default() -> Self {
        Self::new()
    }
}

impl CmuxUdsPool {
    pub fn new() -> Self {
        let capability_token = std::env::var("CMUX_SOCKET_CAPABILITY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            explicit_path: None,
            capability_token,
            slots: std::array::from_fn(|_| Mutex::new(None)),
            rr_cursor: AtomicUsize::new(0),
            req_seq: AtomicU64::new(1),
        }
    }

    pub fn with_socket_path(path: impl Into<PathBuf>) -> Self {
        Self::with_socket_and_capability(path, None)
    }

    pub fn with_socket_and_capability(
        path: impl Into<PathBuf>,
        capability_token: Option<String>,
    ) -> Self {
        Self {
            explicit_path: Some(path.into()),
            capability_token: capability_token.filter(|s| !s.is_empty()),
            slots: std::array::from_fn(|_| Mutex::new(None)),
            rr_cursor: AtomicUsize::new(0),
            req_seq: AtomicU64::new(1),
        }
    }

    pub fn explicit_socket_path(&self) -> Option<&Path> {
        self.explicit_path.as_deref()
    }

    fn candidate_paths(&self) -> Vec<PathBuf> {
        if let Some(p) = &self.explicit_path {
            return vec![p.clone()];
        }
        let mut out = Vec::with_capacity(5);
        if let Ok(env_path) = std::env::var("CMUX_SOCKET_PATH") {
            let trimmed = env_path.trim();
            if !trimmed.is_empty() {
                out.push(PathBuf::from(trimmed));
            }
        }
        if let Ok(home) = std::env::var("HOME")
            && !home.is_empty()
        {
            out.push(PathBuf::from(home).join(".local/state/cmux/cmux.sock"));
        }
        #[cfg(unix)]
        {
            // SAFETY: `geteuid()` is thread-safe and takes no arguments.
            let uid = unsafe { libc::geteuid() };
            if let Ok(tmpdir) = std::env::var("TMPDIR")
                && !tmpdir.is_empty()
            {
                out.push(PathBuf::from(tmpdir).join(format!("cmux-{uid}.sock")));
            }
            out.push(PathBuf::from(format!("/tmp/cmux-{uid}.sock")));
        }
        out.push(PathBuf::from("/tmp/cmux.sock"));
        out
    }

    async fn connect_fresh(&self) -> Result<PooledStream, UdsCallError> {
        let candidates = self.candidate_paths();
        let mut last_err = None;
        for candidate in &candidates {
            if !Path::new(candidate).exists() {
                continue;
            }
            match timeout(Duration::from_millis(500), UnixStream::connect(candidate)).await {
                Ok(Ok(stream)) => {
                    let (read_half, write_half) = stream.into_split();
                    return Ok(PooledStream {
                        path: candidate.clone(),
                        reader: BufReader::new(read_half),
                        writer: write_half,
                    });
                }
                Ok(Err(e)) => {
                    last_err = Some(format!("{}: {e}", candidate.display()));
                }
                Err(_) => {
                    last_err = Some(format!("{}: connect timeout", candidate.display()));
                }
            }
        }
        Err(UdsCallError::Unavailable(last_err.unwrap_or_else(|| {
            format!(
                "no live cmux socket found (checked {:?})",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
            )
        })))
    }

    async fn send_once(
        conn: &mut PooledStream,
        payload_line: &[u8],
    ) -> Result<String, std::io::Error> {
        conn.writer.write_all(payload_line).await?;
        conn.writer.flush().await?;
        let mut resp_line = String::new();
        let n = conn.reader.read_line(&mut resp_line).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "cmux socket EOF",
            ));
        }
        Ok(resp_line)
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        op_timeout: Duration,
    ) -> Result<Value, UdsCallError> {
        let req_id = format!("u{}", self.req_seq.fetch_add(1, Ordering::Relaxed));
        let params_obj = if params.is_object() {
            params
        } else {
            serde_json::json!({})
        };

        let mut line = Vec::with_capacity(256);
        if let Some(cap) = self.capability_token.as_deref() {
            line.extend_from_slice(CAPABILITY_PREFIX.as_bytes());
            line.extend_from_slice(cap.as_bytes());
            line.push(b' ');
        }
        serde_json::to_writer(
            &mut line,
            &serde_json::json!({
                "id": req_id,
                "method": method,
                "params": params_obj,
            }),
        )
        .map_err(|e| UdsCallError::ParseError(e.to_string()))?;
        line.push(b'\n');

        let start_idx = self.rr_cursor.fetch_add(1, Ordering::Relaxed) % POOL_SLOTS;
        let mut guard = None;
        for offset in 0..POOL_SLOTS {
            let slot = &self.slots[(start_idx + offset) % POOL_SLOTS];
            if let Ok(g) = slot.try_lock() {
                guard = Some(g);
                break;
            }
        }
        let mut slot_guard = match guard {
            Some(g) => g,
            None => self.slots[start_idx].lock().await,
        };

        let raw_line = timeout(op_timeout, async {
            if let Some(existing) = slot_guard.as_mut() {
                if existing.path.exists()
                    && let Ok(resp) = Self::send_once(existing, &line).await
                {
                    return Ok(resp);
                }
                *slot_guard = None;
            }

            let mut fresh = self.connect_fresh().await?;
            match Self::send_once(&mut fresh, &line).await {
                Ok(resp) => {
                    *slot_guard = Some(fresh);
                    Ok(resp)
                }
                Err(e) => Err(UdsCallError::Unavailable(e.to_string())),
            }
        })
        .await
        .map_err(|_| UdsCallError::Timeout)??;

        let trimmed = raw_line.trim();
        if let Some(err_msg) = trimmed.strip_prefix("ERROR:") {
            *slot_guard = None;
            return Err(UdsCallError::RpcError(err_msg.trim().to_string()));
        }

        let parsed: RawSocketResponse = serde_json::from_str(trimmed).map_err(|e| {
            *slot_guard = None;
            UdsCallError::ParseError(e.to_string())
        })?;

        if parsed.ok {
            return Ok(parsed.result.unwrap_or(Value::Null));
        }

        let (code, message) = match parsed.error {
            Some(err) => (
                err.code.unwrap_or_default(),
                err.message.unwrap_or_else(|| "cmux socket error".to_string()),
            ),
            None => (String::new(), "cmux socket error".to_string()),
        };

        if code.is_empty() {
            Err(UdsCallError::RpcError(message))
        } else {
            Err(UdsCallError::RpcError(format!("{code}: {message}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    struct TempDirGuard(PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn uds_pool_sends_capability_prefix_reuses_stream_and_reconnects_after_eof() {
        let short_id = &uuid::Uuid::new_v4().simple().to_string()[..10];
        let dir_path = PathBuf::from(format!("/tmp/cmob-u-{short_id}"));
        std::fs::create_dir_all(&dir_path).unwrap();
        let _cleanup = TempDirGuard(dir_path.clone());
        let sock_path = dir_path.join("s.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (stream1, _) = listener.accept().await.unwrap();
            let (r1, mut w1) = stream1.into_split();
            let mut reader1 = BufReader::new(r1);
            for expected_n in 1..=2 {
                let mut line = String::new();
                reader1.read_line(&mut line).await.unwrap();
                let json_part = line
                    .strip_prefix("_cmux_capability_v1 cap-tok-123 ")
                    .expect("capability prefix present");
                let req: Value = serde_json::from_str(json_part).unwrap();
                let resp = serde_json::json!({
                    "id": req["id"],
                    "ok": true,
                    "result": { "conn": 1, "call": expected_n }
                });
                w1.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
            }
            drop(w1);
            drop(reader1);

            let (stream2, _) = listener.accept().await.unwrap();
            let (r2, mut w2) = stream2.into_split();
            let mut reader2 = BufReader::new(r2);
            let mut line = String::new();
            reader2.read_line(&mut line).await.unwrap();
            let json_part = line
                .strip_prefix("_cmux_capability_v1 cap-tok-123 ")
                .expect("capability prefix on reconnect");
            let req: Value = serde_json::from_str(json_part).unwrap();
            let resp = serde_json::json!({
                "id": req["id"],
                "ok": true,
                "result": { "conn": 2, "call": 3 }
            });
            w2.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
        });

        let pool =
            CmuxUdsPool::with_socket_and_capability(sock_path, Some("cap-tok-123".to_string()));
        let _g1 = pool.slots[1].lock().await;
        let _g2 = pool.slots[2].lock().await;
        let _g3 = pool.slots[3].lock().await;

        let res1 = pool
            .call("system.ping", serde_json::json!({}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(res1["conn"], 1);
        assert_eq!(res1["call"], 1);

        let res2 = pool
            .call("system.ping", serde_json::json!({}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(res2["conn"], 1);
        assert_eq!(res2["call"], 2);

        let res3 = pool
            .call("system.ping", serde_json::json!({}), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(res3["conn"], 2);
        assert_eq!(res3["call"], 3);

        server.await.unwrap();
    }

    #[tokio::test]
    async fn uds_pool_surfaces_plaintext_error_directly_without_hiding() {
        let short_id = &uuid::Uuid::new_v4().simple().to_string()[..10];
        let dir_path = PathBuf::from(format!("/tmp/cmob-e-{short_id}"));
        std::fs::create_dir_all(&dir_path).unwrap();
        let _cleanup = TempDirGuard(dir_path.clone());
        let sock_path = dir_path.join("s.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (r, mut w) = stream.into_split();
            let mut reader = BufReader::new(r);
            let mut line = String::new();
            let _ = reader.read_line(&mut line).await;
            w.write_all(b"ERROR: Access denied - only processes started inside cmux can connect\n")
                .await
                .unwrap();
        });

        let pool = CmuxUdsPool::with_socket_path(sock_path);
        let err = pool
            .call("system.tree", serde_json::json!({}), Duration::from_secs(2))
            .await
            .unwrap_err();
        match err {
            UdsCallError::RpcError(msg) => {
                assert!(msg.contains("Access denied"));
            }
            other => panic!("expected RpcError, got {other:?}"),
        }

        server.await.unwrap();
    }
}
