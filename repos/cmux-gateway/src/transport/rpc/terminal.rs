//! Terminal I/O, paste, scroll, and replay JSON-RPC handlers (`mobile.terminal.*`).

use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_TERMINAL_INPUT, METHOD_TERMINAL_PASTE,
    METHOD_TERMINAL_READ, METHOD_TERMINAL_REPLAY, METHOD_TERMINAL_SCROLL, METHOD_TERMINAL_SEND,
};
use crate::server::AppState;

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_TERMINAL_REPLAY => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    ));
                }
            };
            let max_scrollback = req
                .params
                .get("max_scrollback_rows")
                .and_then(|val| val.as_u64())
                .unwrap_or(500)
                .min(2000) as usize;
            let cols = req
                .params
                .get("columns")
                .or_else(|| req.params.get("cols"))
                .and_then(|val| val.as_u64())
                .map(|val| val as u16);
            let rows = req
                .params
                .get("rows")
                .and_then(|val| val.as_u64())
                .map(|val| val as u16);
            let viewport = match (cols, rows) {
                (Some(c), Some(r)) if c > 0 && r > 0 => Some((c, r)),
                _ => None,
            };

            match state
                .cmux_bridge
                .terminal_replay(surface, max_scrollback, viewport)
                .await
            {
                Ok(replay) => JsonRpcResponse::result_value(req.id.clone(), replay),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_INPUT => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    ));
                }
            };
            let text = req.params.get("text").and_then(|val| val.as_str());
            let key = req.params.get("key").and_then(|val| val.as_str());
            let res = if let Some(raw_text) = text {
                state
                    .cmux_bridge
                    .terminal_input(surface, raw_text)
                    .await
                    .map(|_| ())
            } else if let Some(key_name) = key {
                state.cmux_bridge.send_key(Some(surface), key_name).await
            } else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Either 'text' or 'key' must be provided"),
                ));
            };
            match res {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "status": "delivered", "surface_id": surface }),
                )
                .unwrap(),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_PASTE => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    ));
                }
            };
            let text = req.params.get("text").and_then(|val| val.as_str()).unwrap_or("");
            match state.cmux_bridge.terminal_paste(surface, text).await {
                Ok(res) => JsonRpcResponse::result_value(req.id.clone(), res),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_SCROLL => {
            let surface = match req.params.get("surface_id").and_then(|val| val.as_str()) {
                Some(surf) if !surf.is_empty() => surf,
                _ => {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params("Missing surface_id parameter"),
                    ));
                }
            };
            let delta_lines = req
                .params
                .get("delta_lines")
                .and_then(|val| val.as_i64())
                .unwrap_or(0) as i32;
            let col = req.params.get("col").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
            let row = req.params.get("row").and_then(|val| val.as_u64()).unwrap_or(0) as u16;
            match state
                .cmux_bridge
                .terminal_scroll(surface, delta_lines, col, row)
                .await
            {
                Ok(res) => JsonRpcResponse::result_value(req.id.clone(), res),
                Err(err) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(err.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_READ => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str());
            let lines = req
                .params
                .get("lines")
                .and_then(|v| v.as_u64())
                .unwrap_or(80)
                .min(5000) as usize;
            let scrollback = req
                .params
                .get("scrollback")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            match state.cmux_bridge.capture_pane(surface, lines, scrollback).await {
                Ok(text) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({
                        "surface_id": surface.unwrap_or_default(),
                        "text": text,
                        "screen": text,
                        "lines": lines,
                        "updated_at": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64
                    }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_TERMINAL_SEND => {
            let surface = req.params.get("surface_id").and_then(|v| v.as_str());
            let text = req.params.get("text").and_then(|v| v.as_str());
            let key = req.params.get("key").and_then(|v| v.as_str());

            let res = if let Some(k) = key {
                state.cmux_bridge.send_key(surface, k).await
            } else if let Some(t) = text {
                state.cmux_bridge.send_text(surface, t).await
            } else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Either 'text' or 'key' must be provided"),
                ));
            };

            match res {
                Ok(_) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({
                        "status": "delivered",
                        "surface_id": surface.unwrap_or_default()
                    }),
                )
                .unwrap(),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        _ => return None,
    };
    Some(resp)
}
