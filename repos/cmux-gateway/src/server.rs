//! Shared Gateway `AppState` and Clean Architecture public facade re-exports.

use std::sync::Arc;

use crate::cmux::DualTransportCmuxBridge;
use crate::pairing_store::{ct_eq, DeviceRegistry};
use crate::protocol::PairingOffer;
use crate::push::PushService;
use crate::transport::ws_session::MAX_WS_CONNECTIONS;

pub use crate::services::chat_stream::EVENT_CHAT_UPDATE;
pub use crate::services::notification_dispatcher::{
    spawn_dialog_watcher, spawn_push_dispatcher, NotificationBroadcast, EVENT_NOTIFICATION_ALERT,
    EVENT_NOTIFICATION_DISMISS,
};
pub use crate::services::terminal_stream::EVENT_TERMINAL_UPDATE;
pub use crate::transport::client_registry::{ClientInfo, ClientRegistry};
pub use crate::transport::http_guard::{host_allowed, origin_allowed};
pub use crate::transport::http_routes::create_router;

/// Shared application state for all Axum routes and WS connections.
#[derive(Clone)]
pub struct AppState {
    pub auth_token: String,
    pub host: String,
    pub port: u16,
    pub cmux_bridge: DualTransportCmuxBridge,
    pub push_service: PushService,
    pub devices: DeviceRegistry,
    pub conn_limit: Arc<tokio::sync::Semaphore>,
    pub clients: ClientRegistry,
    pub notif_tx: tokio::sync::broadcast::Sender<NotificationBroadcast>,
    pub usage_service: crate::usage::UsageService,
}

impl AppState {
    pub fn new(host: String, port: u16, auth_token: String) -> Self {
        Self {
            auth_token,
            host,
            port,
            cmux_bridge: DualTransportCmuxBridge::new(),
            push_service: PushService::default_dir()
                .map(PushService::with_storage)
                .unwrap_or_else(PushService::new),
            devices: DeviceRegistry::new(DeviceRegistry::default_path()),
            conn_limit: Arc::new(tokio::sync::Semaphore::new(MAX_WS_CONNECTIONS)),
            clients: ClientRegistry::default(),
            notif_tx: tokio::sync::broadcast::channel(128).0,
            usage_service: crate::usage::UsageService::new(),
        }
    }

    pub fn token_valid(&self, candidate: &str) -> bool {
        ct_eq(candidate, &self.auth_token) || self.devices.is_device_token(candidate)
    }

    pub fn pairing_offer(&self) -> PairingOffer {
        let endpoint = format!("ws://{}:{}/ws", self.host, self.port);
        PairingOffer::new(endpoint, &self.auth_token)
    }

    pub fn pairing_offer_with_ticket(&self) -> PairingOffer {
        PairingOffer::with_ticket(self.pairing_offer().endpoint, self.devices.issue_ticket())
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
