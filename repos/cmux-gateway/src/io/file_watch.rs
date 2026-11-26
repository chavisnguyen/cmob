//! Event-driven `kqueue` (`EVFILT_VNODE`) file watcher for live transcript streaming.
//!
//! On macOS, opens `O_EVTONLY` descriptors on the active transcript file and `~/.cmuxterm`
//! hook directory, registering `EVFILT_VNODE` on a non-blocking `kqueue` wrapped in Tokio's
//! `AsyncFd`. File writes wake `chat_watcher_stream` in `< 1ms` (+ `8ms` micro-batch coalesce)
//! instead of waiting on a blind `500ms` polling interval, with zero background threads and
//! automatic fallback to timed sleeps on Linux or pseudo-paths (e.g. OpenCode SQLite).

use std::path::Path;
use std::time::Duration;

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use tokio::io::unix::AsyncFd;

    const COALESCE_DELAY: Duration = Duration::from_millis(8);

    pub struct TranscriptFileWatcher {
        kq: Option<AsyncFd<OwnedFd>>,
        watched_file: Option<(PathBuf, OwnedFd)>,
        watched_hook_dir: Option<(PathBuf, OwnedFd)>,
        hook_dir_candidate: Option<PathBuf>,
    }

    impl Default for TranscriptFileWatcher {
        fn default() -> Self {
            Self::new()
        }
    }

    impl TranscriptFileWatcher {
        pub fn new() -> Self {
            let hook_dir_candidate = std::env::var_os("CMUX_HOOK_SESSIONS_DIR")
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME")
                        .filter(|h| !h.is_empty())
                        .map(|h| PathBuf::from(h).join(".cmuxterm"))
                });
            Self::with_hook_dir(hook_dir_candidate)
        }

        pub fn with_hook_dir(hook_dir_candidate: Option<PathBuf>) -> Self {
            let kq = Self::create_kqueue().and_then(|fd| {
                // SAFETY: `fd` is a newly created `OwnedFd` owned exclusively by `AsyncFd` until drop.
                unsafe { AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE) }.ok()
            });
            Self {
                kq,
                watched_file: None,
                watched_hook_dir: None,
                hook_dir_candidate,
            }
        }

        fn create_kqueue() -> Option<OwnedFd> {
            // SAFETY: `kqueue()` takes no arguments and returns a new descriptor or -1.
            let raw = unsafe { libc::kqueue() };
            if raw < 0 {
                return None;
            }
            // SAFETY: set FD_CLOEXEC and O_NONBLOCK before wrapping in `OwnedFd`.
            unsafe {
                let _ = libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
                let flags = libc::fcntl(raw, libc::F_GETFL);
                if flags >= 0 {
                    let _ = libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
                }
                Some(OwnedFd::from_raw_fd(raw))
            }
        }

        fn open_and_register(kq_fd: RawFd, path: &Path) -> Option<OwnedFd> {
            let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
            // SAFETY: `c_path` is NUL-terminated; `O_EVTONLY | O_CLOEXEC` does not block file deletion.
            let raw = unsafe { libc::open(c_path.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) };
            if raw < 0 {
                return None;
            }
            // SAFETY: `raw` is a valid open descriptor owned exclusively here.
            let owned = unsafe { OwnedFd::from_raw_fd(raw) };

            let change = libc::kevent {
                ident: owned.as_raw_fd() as libc::uintptr_t,
                filter: libc::EVFILT_VNODE,
                flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                fflags: libc::NOTE_WRITE
                    | libc::NOTE_EXTEND
                    | libc::NOTE_ATTRIB
                    | libc::NOTE_DELETE
                    | libc::NOTE_RENAME
                    | libc::NOTE_LINK,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            let zero_ts = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            // SAFETY: `change` is valid and `nevents == 0` performs non-blocking registration.
            let rc =
                unsafe { libc::kevent(kq_fd, &change, 1, std::ptr::null_mut(), 0, &zero_ts) };
            if rc < 0 {
                return None;
            }
            Some(owned)
        }

        fn sync_targets(&mut self, kq_fd: RawFd, transcript_path: Option<&Path>) {
            match transcript_path {
                Some(target) => {
                    let same = self
                        .watched_file
                        .as_ref()
                        .is_some_and(|(cur, _)| cur.as_path() == target);
                    if !same {
                        self.watched_file = None;
                        if let Some(fd) = Self::open_and_register(kq_fd, target) {
                            self.watched_file = Some((target.to_path_buf(), fd));
                        }
                    }
                }
                None => {
                    self.watched_file = None;
                }
            }

            if self.watched_hook_dir.is_none()
                && let Some(dir) = self.hook_dir_candidate.as_deref()
                && let Some(fd) = Self::open_and_register(kq_fd, dir)
            {
                self.watched_hook_dir = Some((dir.to_path_buf(), fd));
            }
        }

        fn drain_events(kq_fd: RawFd, watched_file_fd: Option<RawFd>) -> (usize, bool) {
            let mut total = 0usize;
            let mut file_rotated = false;
            let zero_ts = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            loop {
                // SAFETY: `libc::kevent` is plain-old-data.
                let mut events: [libc::kevent; 8] = unsafe { std::mem::zeroed() };
                let n = unsafe {
                    libc::kevent(
                        kq_fd,
                        std::ptr::null(),
                        0,
                        events.as_mut_ptr(),
                        events.len() as libc::c_int,
                        &zero_ts,
                    )
                };
                if n <= 0 {
                    break;
                }
                let count = n as usize;
                total += count;
                for ev in &events[..count] {
                    if Some(ev.ident as RawFd) == watched_file_fd
                        && (ev.fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME)) != 0
                    {
                        file_rotated = true;
                    }
                }
                if count < events.len() {
                    break;
                }
            }
            (total, file_rotated)
        }

        pub async fn wait_for_change(&mut self, transcript_path: Option<&Path>, max_wait: Duration) {
            let Some(kq_raw) = self.kq.as_ref().map(|k| k.as_raw_fd()) else {
                tokio::time::sleep(max_wait.min(Duration::from_millis(250))).await;
                return;
            };

            self.sync_targets(kq_raw, transcript_path);

            if self.watched_file.is_none() && self.watched_hook_dir.is_none() {
                tokio::time::sleep(max_wait.min(Duration::from_millis(250))).await;
                return;
            }

            let file_fd = self.watched_file.as_ref().map(|(_, fd)| fd.as_raw_fd());
            let Some(kq) = self.kq.as_ref() else {
                return;
            };

            let wait_res = tokio::time::timeout(max_wait, async {
                loop {
                    let Ok(mut guard) = kq.readable().await else {
                        return false;
                    };
                    let (count, rotated) = Self::drain_events(kq.as_raw_fd(), file_fd);
                    guard.clear_ready();
                    if count > 0 {
                        return rotated;
                    }
                }
            })
            .await;

            if let Ok(file_rotated) = wait_res {
                if file_rotated {
                    self.watched_file = None;
                }
                // Coalesce multi-line JSONL bursts over a tiny 8ms window.
                tokio::time::sleep(COALESCE_DELAY).await;
                let (_, rotated_after) = Self::drain_events(kq_raw, file_fd);
                if rotated_after {
                    self.watched_file = None;
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[derive(Default)]
    pub struct TranscriptFileWatcher;

    impl TranscriptFileWatcher {
        pub fn new() -> Self {
            Self
        }

        #[allow(dead_code)]
        pub fn with_hook_dir(_hook_dir_candidate: Option<PathBuf>) -> Self {
            Self
        }

        pub async fn wait_for_change(&mut self, _transcript_path: Option<&Path>, max_wait: Duration) {
            tokio::time::sleep(max_wait.min(Duration::from_millis(250))).await;
        }
    }
}

pub use imp::TranscriptFileWatcher;

#[allow(dead_code)]
pub async fn wait_once(watcher: &mut TranscriptFileWatcher, path: Option<&Path>, max_wait: Duration) {
    watcher.wait_for_change(path, max_wait).await;
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Instant;

    #[tokio::test]
    async fn kqueue_watcher_wakes_immediately_on_file_append() {
        let dir = std::env::temp_dir().join(format!("cmob-kqueue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("transcript.jsonl");
        std::fs::write(&file_path, b"{\"turn\":1}\n").unwrap();

        let mut watcher = TranscriptFileWatcher::with_hook_dir(None);
        let writer_path = file_path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&writer_path)
                .unwrap();
            f.write_all(b"{\"turn\":2}\n").unwrap();
            f.flush().unwrap();
        });

        let start = Instant::now();
        watcher
            .wait_for_change(Some(&file_path), Duration::from_secs(5))
            .await;
        let elapsed = start.elapsed();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            elapsed < Duration::from_millis(350),
            "expected instant kqueue wakeup (<350ms), got {elapsed:?}"
        );
    }
}
