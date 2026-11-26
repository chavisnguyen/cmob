pub mod chat;
pub mod chat_options;
pub mod host_tools;
pub mod push_device;
pub mod terminal;
pub mod workspace;

use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::server::AppState;

/// Top-level JSON-RPC dispatcher delegating to cohesive domain handler modules.
pub async fn dispatch_rpc(req: &JsonRpcRequest, state: &AppState) -> JsonRpcResponse {
    if let Some(resp) = chat::try_dispatch(req, state).await {
        return resp;
    }
    if let Some(resp) = chat_options::try_dispatch(req, state).await {
        return resp;
    }
    if let Some(resp) = workspace::try_dispatch(req, state).await {
        return resp;
    }
    if let Some(resp) = terminal::try_dispatch(req, state).await {
        return resp;
    }
    if let Some(resp) = push_device::try_dispatch(req, state).await {
        return resp;
    }
    if let Some(resp) = host_tools::try_dispatch(req, state).await {
        return resp;
    }
    JsonRpcResponse::error(
        Some(req.id.clone()),
        JsonRpcError::method_not_found(&req.method),
    )
}
