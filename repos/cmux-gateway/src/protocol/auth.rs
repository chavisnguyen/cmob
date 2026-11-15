use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Protocol server version reported to mobile/web clients.
pub const PROTOCOL_SERVER_VERSION: &str = "2.0.0";

/// Standard WebSocket close code for authentication rejection.
pub const WS_CLOSE_AUTH_FAILED: u16 = 1008;

/// Reason for authentication failure when token is invalid.
pub const AUTH_REASON_INVALID_TOKEN: &str = "invalid_token";

/// Reason for authentication failure when client sent non-auth first frame.
pub const AUTH_REASON_UNAUTHENTICATED: &str = "unauthenticated";

// Capability identifiers supported by cmux-mobile Gateway
pub const CAP_RENDER_GRID: &str = "terminal.render_grid.v1";
pub const CAP_INPUT_ORDERED: &str = "terminal.input.ordered.v1";
pub const CAP_WORKSPACE_CHANGES: &str = "workspace.changes.v1";
pub const CAP_EVENTS: &str = "events.v1";
pub const CAP_CLIENT_FOCUS: &str = "client_focus.v1";
pub const CAP_MULTI_SURFACE: &str = "multi_surface.v1";
pub const CAP_HOST_WAKE: &str = "mobile.host.wake_cmux.v1";
pub const CAP_TERMINAL_VIEWPORT: &str = "terminal.viewport.v1";
pub const CAP_AGENT_CHAT: &str = "agent.chat.v1";
pub const CAP_PUSH_REGISTRATION: &str = "push.registration.v1";

pub const ALL_CAPABILITIES: &[&str] = &[
    CAP_RENDER_GRID,
    CAP_INPUT_ORDERED,
    CAP_WORKSPACE_CHANGES,
    CAP_EVENTS,
    CAP_CLIENT_FOCUS,
    CAP_MULTI_SURFACE,
    CAP_HOST_WAKE,
    CAP_TERMINAL_VIEWPORT,
    CAP_AGENT_CHAT,
    CAP_PUSH_REGISTRATION,
];

fn default_auth_type() -> String {
    "auth".to_string()
}

fn default_auth_ok_type() -> String {
    "auth_ok".to_string()
}

fn default_auth_error_type() -> String {
    "auth_error".to_string()
}

fn default_server_version() -> String {
    PROTOCOL_SERVER_VERSION.to_string()
}

pub fn default_capabilities() -> Vec<String> {
    ALL_CAPABILITIES.iter().map(|s| (*s).to_string()).collect()
}

/// First frame sent by client to authenticate with the Gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthRequest {
    #[serde(default = "default_auth_type")]
    pub r#type: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl AuthRequest {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            r#type: default_auth_type(),
            token: token.into(),
            client_id: Some("cmux-client".to_string()),
            extra: Map::new(),
        }
    }

    pub fn with_client_id(token: impl Into<String>, client_id: impl Into<String>) -> Self {
        Self {
            r#type: default_auth_type(),
            token: token.into(),
            client_id: Some(client_id.into()),
            extra: Map::new(),
        }
    }
}

/// Successful authentication response returned to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthOk {
    #[serde(default = "default_auth_ok_type")]
    pub r#type: String,
    pub session_id: String,
    #[serde(default = "default_server_version")]
    pub server_version: String,
    #[serde(default = "default_capabilities")]
    pub capabilities: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl AuthOk {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            r#type: default_auth_ok_type(),
            session_id: session_id.into(),
            server_version: default_server_version(),
            capabilities: default_capabilities(),
            extra: Map::new(),
        }
    }
}

/// Authentication error response returned when credentials fail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthError {
    #[serde(default = "default_auth_error_type")]
    pub r#type: String,
    pub reason: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl AuthError {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            r#type: default_auth_error_type(),
            reason: reason.into(),
            extra: Map::new(),
        }
    }

    pub fn invalid_token() -> Self {
        Self::new(AUTH_REASON_INVALID_TOKEN)
    }

    pub fn unauthenticated() -> Self {
        Self::new(AUTH_REASON_UNAUTHENTICATED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_request_serialization() {
        let req = AuthRequest::with_client_id("test_token_123", "mobile-pwa");
        let json = serde_json::to_string(&req).expect("serialize");
        assert!(json.contains("\"type\":\"auth\""));
        assert!(json.contains("\"token\":\"test_token_123\""));
        assert!(json.contains("\"client_id\":\"mobile-pwa\""));

        let deserialized: AuthRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, req);
    }

    #[test]
    fn test_auth_ok_serialization() {
        let ok = AuthOk::new("session-456");
        let json = serde_json::to_string(&ok).expect("serialize");
        assert!(json.contains("\"type\":\"auth_ok\""));
        assert!(json.contains("\"session_id\":\"session-456\""));
        assert!(json.contains("\"server_version\":\"2.0.0\""));
        assert!(json.contains("agent.chat.v1"));

        let deserialized: AuthOk = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, ok);
    }

    #[test]
    fn test_auth_error_serialization() {
        let err = AuthError::invalid_token();
        let json = serde_json::to_string(&err).expect("serialize");
        assert!(json.contains("\"type\":\"auth_error\""));
        assert!(json.contains("\"reason\":\"invalid_token\""));

        let deserialized: AuthError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, err);
    }
}
