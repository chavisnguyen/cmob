//! Process-based liveness for surfaces: "is any agent process running on this surface's tty?"
//!
//! The pid stored in hook records is not reliable (an Antigravity session keeps being updated after
//! `agy` resumes it under a new pid), so liveness comes from the surface tty instead, using the same
//! `ps` scan as the workspace tree (`WorkspaceTreeBuilder::scan_agent_processes_by_tty`).

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::scanner::workspace_tree::WorkspaceTreeBuilder;

type ProcScan = Option<HashMap<String, HashSet<&'static str>>>;

/// surface id (UUID) -> controlling tty, refreshed on every workspace tree build.
static SURFACE_TTY: LazyLock<RwLock<HashMap<String, String>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
/// Short-lived cache so the 500ms chat watchers do not fork `ps` on every sample.
static PROC_CACHE: LazyLock<Mutex<Option<(Instant, ProcScan)>>> = LazyLock::new(|| Mutex::new(None));
const PROC_TTL: Duration = Duration::from_secs(2);

pub fn record_surface_tty(surface_id: &str, tty: &str) {
    if let Ok(mut map) = SURFACE_TTY.write() {
        map.insert(surface_id.to_string(), tty.trim_start_matches("/dev/").to_string());
    }
}

/// Drop closed surfaces so `SURFACE_TTY` stays bounded over long daemon lifetimes.
pub fn prune_surfaces(live_ids: &HashSet<String>) {
    if let Ok(mut map) = SURFACE_TTY.write() {
        map.retain(|k, _| live_ids.contains(k));
    }
}

/// Seed the cache with a scan the tree builder already made.
pub fn store_proc_scan(scan: &ProcScan) {
    if let Ok(mut c) = PROC_CACHE.lock() {
        *c = Some((Instant::now(), scan.clone()));
    }
}

fn proc_scan() -> ProcScan {
    if let Ok(c) = PROC_CACHE.lock() {
        if let Some((at, scan)) = c.as_ref() {
            if at.elapsed() < PROC_TTL {
                return scan.clone();
            }
        }
    }
    let scan = WorkspaceTreeBuilder::scan_agent_processes_by_tty();
    store_proc_scan(&scan);
    scan
}

/// `Some(true/false)` when the surface tty is known and `ps` succeeded; `None` = cannot tell.
/// Blocking (may run `ps`): call from `spawn_blocking`.
pub fn surface_has_agent_process(surface_id: &str) -> Option<bool> {
    let tty = SURFACE_TTY.read().ok()?.get(surface_id).cloned()?;
    let scan = proc_scan()?;
    Some(scan.get(&tty).is_some_and(|k| !k.is_empty()))
}
