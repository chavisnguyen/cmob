//! Process-based liveness and surface-topology cache (`tty`, `surface:N` ref -> UUID, owning `workspace_id`).

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::scanner::workspace_tree::WorkspaceTreeBuilder;

type ProcScan = Option<HashMap<String, HashSet<&'static str>>>;

#[derive(Default)]
struct SurfaceMetaMaps {
    /// surface UUID -> controlling tty (without `/dev/`)
    surface_tty: HashMap<String, String>,
    /// `surface:N` ref -> canonical surface UUID
    ref_to_id: HashMap<String, String>,
    /// canonical surface UUID -> owning workspace UUID
    surface_workspace: HashMap<String, String>,
    /// canonical surface UUID -> workspace cwd
    surface_cwd: HashMap<String, String>,
}

static SURFACE_META: LazyLock<RwLock<SurfaceMetaMaps>> =
    LazyLock::new(|| RwLock::new(SurfaceMetaMaps::default()));
/// Short-lived cache so 500ms watchers do not fork `ps` on every sample.
static PROC_CACHE: LazyLock<Mutex<Option<(Instant, ProcScan)>>> = LazyLock::new(|| Mutex::new(None));
const PROC_TTL: Duration = Duration::from_secs(2);

pub fn record_surface_tty(surface_id: &str, tty: &str) {
    if let Ok(mut meta) = SURFACE_META.write() {
        meta.surface_tty
            .insert(surface_id.to_string(), tty.trim_start_matches("/dev/").to_string());
    }
}

pub fn record_surface_meta(
    surface_id: &str,
    surface_ref: &str,
    workspace_id: &str,
    cwd: Option<&str>,
) {
    if let Ok(mut meta) = SURFACE_META.write() {
        if !surface_ref.is_empty() && surface_ref != surface_id {
            meta.ref_to_id
                .insert(surface_ref.to_string(), surface_id.to_string());
        }
        if !workspace_id.is_empty() {
            meta.surface_workspace
                .insert(surface_id.to_string(), workspace_id.to_string());
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty() && *d != "~") {
            meta.surface_cwd
                .insert(surface_id.to_string(), dir.to_string());
        }
    }
}

pub fn resolve_cached_surface_ref(raw_id_or_ref: &str) -> Option<String> {
    let meta = SURFACE_META.read().ok()?;
    meta.ref_to_id.get(raw_id_or_ref).cloned()
}

pub fn workspace_for_surface(surface_id: &str) -> Option<String> {
    let meta = SURFACE_META.read().ok()?;
    let canonical = meta
        .ref_to_id
        .get(surface_id)
        .map(String::as_str)
        .unwrap_or(surface_id);
    meta.surface_workspace.get(canonical).cloned()
}

pub fn surface_for_tty(tty: &str) -> Option<(String, String, Option<String>)> {
    let clean = tty.trim_start_matches("/dev/");
    let meta = SURFACE_META.read().ok()?;
    let (surf_id, _) = meta.surface_tty.iter().find(|(_, t)| t.as_str() == clean)?;
    let ws_id = meta.surface_workspace.get(surf_id).cloned().unwrap_or_default();
    let cwd = meta.surface_cwd.get(surf_id).cloned();
    Some((surf_id.clone(), ws_id, cwd))
}

/// Drop closed surfaces so `SURFACE_META` stays bounded over long daemon lifetimes.
pub fn prune_surfaces(live_ids: &HashSet<String>) {
    if let Ok(mut meta) = SURFACE_META.write() {
        meta.surface_tty.retain(|k, _| live_ids.contains(k));
        meta.surface_workspace.retain(|k, _| live_ids.contains(k));
        meta.surface_cwd.retain(|k, _| live_ids.contains(k));
        meta.ref_to_id.retain(|_, id| live_ids.contains(id));
    }
}

/// Immediately forget a single closed surface (id or ref).
pub fn forget_surface(surface_id: &str) {
    if let Ok(mut meta) = SURFACE_META.write() {
        let canonical = meta
            .ref_to_id
            .get(surface_id)
            .cloned()
            .unwrap_or_else(|| surface_id.to_string());
        meta.surface_tty.remove(&canonical);
        meta.surface_workspace.remove(&canonical);
        meta.surface_cwd.remove(&canonical);
        meta.ref_to_id.retain(|r, id| r != surface_id && id != &canonical);
    }
}

/// Seed the cache with a scan the tree builder already made.
pub fn store_proc_scan(scan: &ProcScan) {
    if let Ok(mut c) = PROC_CACHE.lock() {
        *c = Some((Instant::now(), scan.clone()));
    }
}

fn proc_scan() -> ProcScan {
    if let Ok(c) = PROC_CACHE.lock()
        && let Some((at, scan)) = c.as_ref()
        && at.elapsed() < PROC_TTL
    {
        return scan.clone();
    }
    let scan = WorkspaceTreeBuilder::scan_agent_processes_by_tty();
    store_proc_scan(&scan);
    scan
}

/// Live canonical agent kinds running on `surface_id`'s tty (`None` when tty is unknown or `ps` failed).
/// Blocking (may run `ps`): call from `spawn_blocking`.
pub fn surface_live_agent_kinds(surface_id: &str) -> Option<HashSet<&'static str>> {
    let tty = {
        let meta = SURFACE_META.read().ok()?;
        let canonical = meta
            .ref_to_id
            .get(surface_id)
            .map(String::as_str)
            .unwrap_or(surface_id);
        meta.surface_tty.get(canonical).cloned()?
    };
    let scan = proc_scan()?;
    Some(scan.get(&tty).cloned().unwrap_or_default())
}

/// `Some(true/false)` when the surface tty is known and `ps` succeeded; `None` = cannot tell.
/// Blocking (may run `ps`): call from `spawn_blocking`.
pub fn surface_has_agent_process(surface_id: &str) -> Option<bool> {
    surface_live_agent_kinds(surface_id).map(|kinds| !kinds.is_empty())
}
