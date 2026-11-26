//! Persistent pooled Unix Domain Socket (`cmux.sock`) JSON-RPC client.
//!
//! Speaks `cmux`'s newline-delimited v2 socket protocol (`{"id":"...","method":"...","params":{...}}\n`)
//! over reusable `tokio::net::UnixStream` slots (~0.9–1.2ms per RPC vs ~35–40ms spawning `cmux` CLI).
//! Automatically reconnects once on broken/idle pipe and signals `Unavailable` or `AccessDenied`
//! so `DualTransportCmuxBridge` falls back seamlessly to the `cmux` CLI binary when needed.

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

#[derive(Debug)]
pub enum UdsCallError {
    /// Socket path missing or connection refused — caller should fall back to `cmux` CLI.
    Unavailable,
    /// `SocketControlMode.cmuxOnly` rejected direct socket caller — caller should fall back to `cmux` CLI.
    AccessDenied,
    /// Operation exceeded configured timeout.
    Timeout,
    /// Daemon returned a valid JSON-RPC error (`ok: false`).
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
    slots: [Mutex<Option<PooledStream>>; POOL_SLOTS],
    rr_cursor: AtomicUsize,
    req_seq: AtomicU64,
}

impl std::fmt::Debug for CmuxUdsPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CmuxUdsPool")
            .field("explicit_path", &self.explicit_path)
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
        Self {
            explicit_path: None,
            slots: std::array::from_fn(|_| Mutex::new(None)),
            rr_cursor: AtomicUsize::new(0),
            req_seq: AtomicU64::new(1),
        }
    }

    pub fn with_socket_path(path: impl Into<PathBuf>) -> Self {
        Self {
            explicit_path: Some(path.into()),
            slots: std::array::from_fn(|_| Mutex::new(None)),
            rr_cursor: AtomicUsize::new(0),
            req_seq: AtomicU64::new(1),
        }
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
        for candidate in self.candidate_paths() {
            if !Path::new(&candidate).exists() {
                continue;
            }
            if let Ok(Ok(stream)) =
                timeout(Duration::from_millis(500), UnixStream::connect(&candidate)).await
            {
                let (read_half, write_half) = stream.into_split();
                return Ok(PooledStream {
                    path: candidate,
                    reader: BufReader::new(read_half),
                    writer: write_half,
                });
            }
        }
        Err(UdsCallError::Unavailable)
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
        let mut line = serde_json::to_vec(&serde_json::json!({
            "id": req_id,
            "method": method,
            "params": params_obj,
        }))
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
                Err(_) => Err(UdsCallError::Unavailable),
            }
        })
        .await
        .map_err(|_| UdsCallError::Timeout)??;

        let parsed: RawSocketResponse =
            serde_json::from_str(raw_line.trim()).map_err(|e| UdsCallError::ParseError(e.to_string()))?;

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

        if matches!(
            code.as_str(),
            "access_denied" | "unauthorized" | "forbidden" | "permission_denied"
        ) || message.to_ascii_lowercase().contains("cmuxonly")
        {
            return Err(UdsCallError::AccessDenied);
        }

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
    async fn uds_pool_reuses_persistent_connection_and_reconnects_after_eof() {
        let short_id = &uuid::Uuid::new_v4().simple().to_string()[..10];
        let dir_path = PathBuf::from(format!("/tmp/cmob-u-{short_id}"));
        std::fs::create_dir_all(&dir_path).unwrap();
        let _cleanup = TempDirGuard(dir_path.clone());
        let sock_path = dir_path.join("s.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        let server = tokio::spawn(async move {
            // Connection #1: serves 2 sequential RPCs on the SAME stream, then closes.
            let (stream1, _) = listener.accept().await.unwrap();
            let (r1, mut w1) = stream1.into_split();
            let mut reader1 = BufReader::new(r1);
            for expected_n in 1..=2 {
                let mut line = String::new();
                reader1.read_line(&mut line).await.unwrap();
                let req: Value = serde_json::from_str(&line).unwrap();
                let resp = serde_json::json!({
                    "id": req["id"],
                    "ok": true,
                    "result": { "conn": 1, "call": expected_n }
                });
                w1.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
            }
            drop(w1);
            drop(reader1);

            // Connection #2: verifies automatic 1-retry reconnect after EOF.
            let (stream2, _) = listener.accept().await.unwrap();
            let (r2, mut w2) = stream2.into_split();
            let mut reader2 = BufReader::new(r2);
            let mut line = String::new();
            reader2.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(&line).unwrap();
            let resp = serde_json::json!({
                "id": req["id"],
                "ok": true,
                "result": { "conn": 2, "call": 3 }
            });
            w2.write_all(format!("{resp}\n").as_bytes()).await.unwrap();
        });

        let pool = CmuxUdsPool {
            explicit_path: Some(sock_path),
            slots: std::array::from_fn(|_| Mutex::new(None)),
            rr_cursor: AtomicUsize::new(0),
            req_seq: AtomicU64::new(1),
        };
        // Force single-slot reuse by locking slots 1..POOL_SLOTS during the reuse test.
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
}
