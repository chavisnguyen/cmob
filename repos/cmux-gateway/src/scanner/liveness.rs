//! Instance-scoped workspace topology, surface identity latching, TTY liveness, and startup-dialog runtime store.
//!
//! Replaces process-global mutable `static LazyLock` caches with `WorkspaceRuntimeStore`, owned by
//! `AppState` so every gateway instance and parallel test owns isolated state with zero cross-test pollution.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::domain::child_work_fsm::SurfaceRunEpoch;
use crate::domain::workspace_model::{SurfaceAgentInfo, WorkspaceNode};
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;

pub type ProcScan = Option<HashMap<String, HashSet<&'static str>>>;
pub type EpochMap = HashMap<String, SurfaceRunEpoch>;

const PROC_TTL: Duration = Duration::from_secs(2);
const DIALOG_FRESH_TTL: Duration = Duration::from_secs(10);

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

#[derive(Default)]
struct WorkspaceRuntimeStoreInner {
    /// Durable identity latching cache (`surface_id -> SurfaceAgentInfo`).
    remembered_surfaces: RwLock<HashMap<String, SurfaceAgentInfo>>,
    /// Short-lived cache of the last built workspace tree.
    last_tree_snapshot: RwLock<Option<(Vec<WorkspaceNode>, Instant)>>,
    /// Canonical surface UUIDs known to have unread cmux notifications in the latest scan.
    unread_surfaces: RwLock<HashSet<String>>,
    /// Surface topology (`tty`, `surface:N -> UUID`, `workspace_id`, `cwd`).
    surface_meta: RwLock<SurfaceMetaMaps>,
    /// Short-lived process table cache so 500ms watchers do not re-scan processes on every sample.
    proc_cache: Mutex<Option<(Instant, ProcScan)>>,
    /// Short-lived TTY run-epoch cache (`PROC_TTL = 2s`) backing child-work FSM reconciliation.
    epoch_cache: Mutex<Option<(Instant, Option<EpochMap>)>>,
    /// Surfaces currently displaying a startup dialog (`surface_id -> (fingerprint, seen_at)`).
    waiting_dialogs: RwLock<HashMap<String, (String, Instant)>>,
}

#[derive(Clone, Default)]
pub struct WorkspaceRuntimeStore {
    inner: Arc<WorkspaceRuntimeStoreInner>,
}

impl WorkspaceRuntimeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invalidate_tree_cache(&self) {
        if let Ok(mut snap) = self.inner.last_tree_snapshot.write() {
            *snap = None;
        }
    }

    pub fn cached_tree(&self, max_age: Duration) -> Option<Vec<WorkspaceNode>> {
        let guard = self.inner.last_tree_snapshot.read().ok()?;
        let (cached, built_at) = guard.as_ref()?;
        (built_at.elapsed() < max_age).then(|| cached.clone())
    }

    pub fn store_tree_snapshot(&self, tree: Vec<WorkspaceNode>) {
        if let Ok(mut snap) = self.inner.last_tree_snapshot.write() {
            *snap = Some((tree, Instant::now()));
        }
    }

    pub fn note_surface_unread(&self, surface_id: &str) {
        if !surface_id.is_empty()
            && let Ok(mut set) = self.inner.unread_surfaces.write()
        {
            set.insert(surface_id.to_string());
        }
        self.invalidate_tree_cache();
    }

    pub fn replace_unread_surfaces(&self, unread_ids: HashSet<String>) {
        if let Ok(mut set) = self.inner.unread_surfaces.write() {
            *set = unread_ids;
        }
    }

    /// Atomically checks and clears the unread flag for `surface_id`. Returns `true` if it was unread.
    pub fn clear_surface_unread(&self, surface_id: &str) -> bool {
        if surface_id.is_empty() {
            return false;
        }
        self.inner
            .unread_surfaces
            .write()
            .ok()
            .is_some_and(|mut set| set.remove(surface_id))
    }

    pub fn remember_surface_agent(&self, surface_id: &str, info: SurfaceAgentInfo) {
        if let Ok(mut cache) = self.inner.remembered_surfaces.write() {
            cache.insert(surface_id.to_string(), info);
        }
    }

    pub fn forget_remembered_agent(&self, surface_id: &str) {
        if let Ok(mut cache) = self.inner.remembered_surfaces.write() {
            cache.remove(surface_id);
        }
    }

    pub fn remembered_surface_agent(&self, surface_id: &str) -> Option<SurfaceAgentInfo> {
        self.inner
            .remembered_surfaces
            .read()
            .ok()
            .and_then(|cache| cache.get(surface_id).cloned())
    }

    pub fn prune_remembered_surfaces(&self, live_ids: &HashSet<String>) {
        if let Ok(mut cache) = self.inner.remembered_surfaces.write() {
            cache.retain(|k, _| live_ids.contains(k));
        }
    }

    pub fn record_surface_tty(&self, surface_id: &str, tty: &str) {
        if let Ok(mut meta) = self.inner.surface_meta.write() {
            meta.surface_tty.insert(
                surface_id.to_string(),
                tty.trim_start_matches("/dev/").to_string(),
            );
        }
    }

    pub fn record_surface_meta(
        &self,
        surface_id: &str,
        surface_ref: &str,
        workspace_id: &str,
        cwd: Option<&str>,
    ) {
        if let Ok(mut meta) = self.inner.surface_meta.write() {
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

    pub fn resolve_cached_surface_ref(&self, raw_id_or_ref: &str) -> Option<String> {
        let meta = self.inner.surface_meta.read().ok()?;
        meta.ref_to_id.get(raw_id_or_ref).cloned()
    }

    pub fn workspace_for_surface(&self, surface_id: &str) -> Option<String> {
        let meta = self.inner.surface_meta.read().ok()?;
        let canonical = meta
            .ref_to_id
            .get(surface_id)
            .map(String::as_str)
            .unwrap_or(surface_id);
        meta.surface_workspace.get(canonical).cloned()
    }

    pub fn surface_for_tty(&self, tty: &str) -> Option<(String, String, Option<String>)> {
        let clean = tty.trim_start_matches("/dev/");
        let meta = self.inner.surface_meta.read().ok()?;
        let (surf_id, _) = meta.surface_tty.iter().find(|(_, t)| t.as_str() == clean)?;
        let ws_id = meta.surface_workspace.get(surf_id).cloned().unwrap_or_default();
        let cwd = meta.surface_cwd.get(surf_id).cloned();
        Some((surf_id.clone(), ws_id, cwd))
    }

    pub fn prune_surfaces(&self, live_ids: &HashSet<String>) {
        if let Ok(mut meta) = self.inner.surface_meta.write() {
            meta.surface_tty.retain(|k, _| live_ids.contains(k));
            meta.surface_workspace.retain(|k, _| live_ids.contains(k));
            meta.surface_cwd.retain(|k, _| live_ids.contains(k));
            meta.ref_to_id.retain(|_, id| live_ids.contains(id));
        }
    }

    /// Immediately purges a closed surface (UUID or `surface:N` ref) across all runtime caches.
    pub fn forget_surface(&self, surface_id: &str) {
        let canonical = if let Ok(mut meta) = self.inner.surface_meta.write() {
            let canonical = meta
                .ref_to_id
                .get(surface_id)
                .cloned()
                .unwrap_or_else(|| surface_id.to_string());
            meta.surface_tty.remove(&canonical);
            meta.surface_workspace.remove(&canonical);
            meta.surface_cwd.remove(&canonical);
            meta.ref_to_id
                .retain(|r, id| r != surface_id && id != &canonical);
            canonical
        } else {
            surface_id.to_string()
        };
        if let Ok(mut cache) = self.inner.remembered_surfaces.write() {
            cache.remove(&canonical);
            cache.remove(surface_id);
        }
        if let Ok(mut unread) = self.inner.unread_surfaces.write() {
            unread.remove(&canonical);
            unread.remove(surface_id);
        }
        if let Ok(mut dialogs) = self.inner.waiting_dialogs.write() {
            dialogs.remove(&canonical);
            dialogs.remove(surface_id);
        }
        self.invalidate_tree_cache();
    }

    pub fn store_proc_scan(&self, scan: &ProcScan) {
        if let Ok(mut c) = self.inner.proc_cache.lock() {
            *c = Some((Instant::now(), scan.clone()));
        }
    }

    fn proc_scan(&self) -> ProcScan {
        if let Ok(c) = self.inner.proc_cache.lock()
            && let Some((at, scan)) = c.as_ref()
            && at.elapsed() < PROC_TTL
        {
            return scan.clone();
        }
        let scan = WorkspaceTreeBuilder::scan_agent_processes_by_tty();
        self.store_proc_scan(&scan);
        scan
    }

    pub fn surface_live_agent_kinds(&self, surface_id: &str) -> Option<HashSet<&'static str>> {
        let tty = {
            let meta = self.inner.surface_meta.read().ok()?;
            let canonical = meta
                .ref_to_id
                .get(surface_id)
                .map(String::as_str)
                .unwrap_or(surface_id);
            meta.surface_tty.get(canonical).cloned()?
        };
        let scan = self.proc_scan()?;
        Some(scan.get(&tty).cloned().unwrap_or_default())
    }

    pub fn surface_has_agent_process(&self, surface_id: &str) -> Option<bool> {
        self.surface_live_agent_kinds(surface_id)
            .map(|kinds| !kinds.is_empty())
    }

    fn epoch_scan(&self) -> Option<EpochMap> {
        if let Ok(c) = self.inner.epoch_cache.lock()
            && let Some((at, map)) = c.as_ref()
            && at.elapsed() < PROC_TTL
        {
            return map.clone();
        }
        #[cfg(target_os = "macos")]
        let map = crate::scanner::macos_proc::scan_agent_epochs_by_tty();
        #[cfg(not(target_os = "macos"))]
        let map: Option<EpochMap> = self.proc_scan().map(|scan| {
            scan.into_iter()
                .map(|(tty, kinds)| {
                    let ep = if kinds.is_empty() {
                        SurfaceRunEpoch::LocalNoAgent
                    } else {
                        SurfaceRunEpoch::RemoteOrUnknown
                    };
                    (tty, ep)
                })
                .collect()
        });
        if let Ok(mut c) = self.inner.epoch_cache.lock() {
            *c = Some((Instant::now(), map.clone()));
        }
        map
    }

    /// Resolves the OS process run-epoch for `surface_id`'s controlling TTY, returning
    /// `SurfaceRunEpoch::RemoteOrUnknown` when the TTY is unknown, SSH-backed, or uninspectable.
    pub fn surface_run_epoch(&self, surface_id: &str) -> SurfaceRunEpoch {
        if surface_id.is_empty() {
            return SurfaceRunEpoch::RemoteOrUnknown;
        }
        let tty = {
            let Ok(meta) = self.inner.surface_meta.read() else {
                return SurfaceRunEpoch::RemoteOrUnknown;
            };
            let canonical = meta
                .ref_to_id
                .get(surface_id)
                .map(String::as_str)
                .unwrap_or(surface_id);
            let Some(t) = meta.surface_tty.get(canonical).cloned() else {
                return SurfaceRunEpoch::RemoteOrUnknown;
            };
            t
        };
        let Some(epochs) = self.epoch_scan() else {
            return SurfaceRunEpoch::RemoteOrUnknown;
        };
        epochs
            .get(&tty)
            .copied()
            .unwrap_or(SurfaceRunEpoch::LocalNoAgent)
    }

    #[cfg(test)]
    pub fn set_tty_epochs_for_test(&self, map: EpochMap) {
        if let Ok(mut c) = self.inner.epoch_cache.lock() {
            *c = Some((Instant::now(), Some(map)));
        }
    }

    pub fn set_dialog_waiting(&self, surface_id: &str, fingerprint: Option<&str>) {
        if let Ok(mut m) = self.inner.waiting_dialogs.write() {
            match fingerprint {
                Some(fp) => {
                    m.insert(surface_id.to_string(), (fp.to_string(), Instant::now()));
                }
                None => {
                    m.remove(surface_id);
                }
            }
        }
    }

    pub fn is_dialog_waiting(&self, surface_id: &str) -> bool {
        self.inner
            .waiting_dialogs
            .read()
            .ok()
            .and_then(|m| m.get(surface_id).map(|(_, at)| at.elapsed() < DIALOG_FRESH_TTL))
            .unwrap_or(false)
    }
}
