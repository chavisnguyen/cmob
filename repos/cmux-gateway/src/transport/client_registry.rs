//! Authenticated WebSocket session registry & active surface-viewing tracking (`suppressWhileViewing`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// One authenticated, currently open WebSocket session.
#[derive(Clone, serde::Serialize)]
pub struct ClientInfo {
    pub session_id: String,
    pub device_id: Option<String>,
    pub label: String,
    pub user_agent: String,
    pub connected_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewing_surface: Option<String>,
    #[serde(default)]
    pub client_visible: bool,
}

/// Live sessions keyed by session id. Entries are removed automatically by `ClientGuard::drop`.
#[derive(Clone, Default)]
pub struct ClientRegistry {
    inner: Arc<std::sync::Mutex<HashMap<String, ClientInfo>>>,
}

impl ClientRegistry {
    pub(crate) fn register(&self, info: ClientInfo) -> ClientGuard {
        let id = info.session_id.clone();
        self.inner.lock().unwrap().insert(id.clone(), info);
        ClientGuard {
            registry: self.clone(),
            id,
        }
    }

    pub fn set_viewing(&self, session_id: &str, surface_id: Option<String>, visible: bool) {
        if let Some(info) = self.inner.lock().unwrap().get_mut(session_id) {
            info.viewing_surface = surface_id;
            info.client_visible = visible;
        }
    }

    pub fn is_session_viewing(&self, session_id: &str, surface_id: &str) -> bool {
        self.inner.lock().unwrap().get(session_id).is_some_and(|info| {
            info.client_visible && info.viewing_surface.as_deref() == Some(surface_id)
        })
    }

    pub fn devices_viewing_surface(&self, surface_id: &str) -> HashSet<String> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|info| {
                info.client_visible && info.viewing_surface.as_deref() == Some(surface_id)
            })
            .filter_map(|info| info.device_id.clone())
            .collect()
    }

    pub fn list(&self) -> Vec<ClientInfo> {
        let mut v: Vec<ClientInfo> = self.inner.lock().unwrap().values().cloned().collect();
        v.sort_by_key(|c| c.connected_at);
        v
    }
}

pub(crate) struct ClientGuard {
    registry: ClientRegistry,
    id: String,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.registry.inner.lock().unwrap().remove(&self.id);
    }
}
