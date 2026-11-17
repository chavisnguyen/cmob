use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::fmt;

/// Standard JSON-RPC 2.0 and Gateway error codes
/// Source: ref/cmux-pocket/crates/cmux-pocket-protocol/src/rpc.rs:7-13
pub const CODE_PARSE_ERROR: i32 = -32700;
pub const CODE_INVALID_REQUEST: i32 = -32600;
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
pub const CODE_INVALID_PARAMS: i32 = -32602;
pub const CODE_INTERNAL_ERROR: i32 = -32603;
pub const CODE_BACKEND_UNAVAILABLE: i32 = -32000;

/// Standard RPC Method Names
pub const METHOD_CHAT_SESSIONS: &str = "mobile.chat.sessions";
pub const METHOD_CHAT_READ_SESSION: &str = "mobile.chat.readSession";
pub const METHOD_CHAT_ANSWER_DIALOG: &str = "mobile.chat.answerDialog";
pub const METHOD_CHAT_SUBSCRIBE: &str = "mobile.chat.subscribe";
pub const METHOD_CHAT_UNSUBSCRIBE: &str = "mobile.chat.unsubscribe";
pub const METHOD_CHAT_SEND: &str = "mobile.chat.send";
pub const METHOD_CHAT_APPROVE: &str = "mobile.chat.approve";
pub const METHOD_CHAT_INTERRUPT: &str = "mobile.chat.interrupt";
pub const METHOD_HOST_STATUS: &str = "mobile.host.status";
pub const METHOD_WORKSPACE_LIST: &str = "mobile.workspace.list";
pub const METHOD_WORKSPACE_TREE: &str = "mobile.workspace.tree";
pub const METHOD_SURFACE_GET: &str = "mobile.surface.get";
pub const METHOD_TERMINAL_READ: &str = "mobile.terminal.read";
pub const METHOD_TERMINAL_SEND: &str = "mobile.terminal.send";
pub const METHOD_PUSH_REGISTER: &str = "mobile.push.register";
pub const METHOD_PUSH_TEST: &str = "mobile.push.test";
pub const METHOD_PUSH_PREFERENCES: &str = "mobile.push.preferences";
pub const METHOD_AGENT_OPTIONS: &str = "mobile.agent.options";
pub const METHOD_CHAT_SET_OPTION: &str = "mobile.chat.setOption";
pub const METHOD_CHAT_FORK: &str = "mobile.chat.fork";
pub const METHOD_UPLOAD_IMAGE: &str = "mobile.upload.image";
pub const METHOD_GIT_STATUS: &str = "mobile.git.status";
pub const METHOD_GIT_DIFF: &str = "mobile.git.diff";
pub const METHOD_DEVICE_LIST: &str = "mobile.device.list";
pub const METHOD_DEVICE_REVOKE: &str = "mobile.device.revoke";
pub const METHOD_PUSH_VAPID_KEY: &str = "mobile.push.vapidKey";
pub const METHOD_PUSH_HISTORY: &str = "mobile.push.history";
pub const METHOD_SURFACE_NEW: &str = "mobile.surface.new";
pub const METHOD_SURFACE_CLOSE: &str = "mobile.surface.close";
pub const METHOD_SURFACE_RENAME: &str = "mobile.surface.rename";
pub const METHOD_TERMINAL_REPLAY: &str = "mobile.terminal.replay";
pub const METHOD_TERMINAL_VIEWPORT: &str = "mobile.terminal.viewport";
pub const METHOD_TERMINAL_INPUT: &str = "mobile.terminal.input";
pub const METHOD_TERMINAL_PASTE: &str = "mobile.terminal.paste";
pub const METHOD_TERMINAL_SCROLL: &str = "mobile.terminal.scroll";
pub const METHOD_TERMINAL_SUBSCRIBE: &str = "mobile.terminal.subscribe";
pub const METHOD_TERMINAL_UNSUBSCRIBE: &str = "mobile.terminal.unsubscribe";
pub const METHOD_CLIENT_VIEWING: &str = "mobile.client.viewing";

/// Identifier for JSON-RPC requests and responses, accommodating both strings and numbers.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

impl RequestId {
    pub fn as_str(&self) -> Cow<'_, str> {
        match self {
            Self::String(s) => Cow::Borrowed(s.as_str()),
            Self::Number(n) => Cow::Owned(n.to_string()),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(s) => write!(f, "{s}"),
            Self::Number(n) => write!(f, "{n}"),
        }
    }
}

impl From<String> for RequestId {
    fn from(s: String) -> Self {
        Self::String(s)
    }
}

impl From<&str> for RequestId {
    fn from(s: &str) -> Self {
        Self::String(s.to_string())
    }
}

impl From<i64> for RequestId {
    fn from(n: i64) -> Self {
        Self::Number(n)
    }
}

impl From<i32> for RequestId {
    fn from(n: i32) -> Self {
        Self::Number(n as i64)
    }
}

fn default_params() -> Value {
    Value::Object(Map::new())
}

/// JSON-RPC request frame received from client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub id: RequestId,
    pub method: String,
    #[serde(default = "default_params")]
    pub params: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl JsonRpcRequest {
    pub fn new(id: impl Into<RequestId>, method: impl Into<String>, params: Value) -> Self {
        Self {
            id: id.into(),
            method: method.into(),
            params,
            extra: Map::new(),
        }
    }

    pub fn without_params(id: impl Into<RequestId>, method: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            method: method.into(),
            params: default_params(),
            extra: Map::new(),
        }
    }
}

/// JSON-RPC response or gateway server push event frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl JsonRpcResponse {
    pub fn result(
        id: impl Into<RequestId>,
        result: impl Serialize,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            id: Some(id.into()),
            result: Some(serde_json::to_value(result)?),
            error: None,
            event: None,
            data: None,
            extra: Map::new(),
        })
    }

    pub fn result_value(id: impl Into<RequestId>, result: Value) -> Self {
        Self {
            id: Some(id.into()),
            result: Some(result),
            error: None,
            event: None,
            data: None,
            extra: Map::new(),
        }
    }

    pub fn error(id: Option<RequestId>, error: JsonRpcError) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
            event: None,
            data: None,
            extra: Map::new(),
        }
    }

    pub fn event(
        event: impl Into<String>,
        data: impl Serialize,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            id: None,
            result: None,
            error: None,
            event: Some(event.into()),
            data: Some(serde_json::to_value(data)?),
            extra: Map::new(),
        })
    }

    pub fn event_value(event: impl Into<String>, data: Value) -> Self {
        Self {
            id: None,
            result: None,
            error: None,
            event: Some(event.into()),
            data: Some(data),
            extra: Map::new(),
        }
    }
}

/// JSON-RPC error payload object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl JsonRpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
            extra: Map::new(),
        }
    }

    pub fn parse_error() -> Self {
        Self::new(CODE_PARSE_ERROR, "Parse error")
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_REQUEST, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(CODE_METHOD_NOT_FOUND, format!("Method not found: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_PARAMS, message)
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new(CODE_INTERNAL_ERROR, message)
    }

    pub fn backend_unavailable(message: impl Into<String>) -> Self {
        Self::new(CODE_BACKEND_UNAVAILABLE, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rpc_request_serialization() {
        let req = JsonRpcRequest::new(
            "req-1",
            METHOD_CHAT_SEND,
            serde_json::json!({
                "surface_id": "surf-101",
                "text": "npm test"
            }),
        );
        let json = serde_json::to_string(&req).expect("serialize");
        assert!(json.contains("\"id\":\"req-1\""));
        assert!(json.contains("\"method\":\"mobile.chat.send\""));
        assert!(json.contains("\"surface_id\":\"surf-101\""));

        let deserialized: JsonRpcRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, req);
    }

    #[test]
    fn test_rpc_response_result_serialization() {
        let resp = JsonRpcResponse::result("req-1", serde_json::json!({ "status": "delivered" }))
            .expect("result");
        let json = serde_json::to_string(&resp).expect("serialize");
        assert!(json.contains("\"id\":\"req-1\""));
        assert!(json.contains("\"result\":{\"status\":\"delivered\"}"));
    }

    #[test]
    fn test_rpc_response_event_serialization() {
        let resp = JsonRpcResponse::event(
            "agent.chat.turn",
            serde_json::json!({ "turn_id": "turn-1", "role": "assistant" }),
        )
        .expect("event");
        let json = serde_json::to_string(&resp).expect("serialize");
        assert!(json.contains("\"event\":\"agent.chat.turn\""));
        assert!(!json.contains("\"id\""));
    }

    #[test]
    fn test_rpc_error_serialization() {
        let err = JsonRpcError::method_not_found("unknown.method");
        let resp = JsonRpcResponse::error(Some("req-2".into()), err);
        let json = serde_json::to_string(&resp).expect("serialize");
        assert!(json.contains("\"code\":-32601"));
        assert!(json.contains("Method not found: unknown.method"));
    }
}
