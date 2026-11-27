//! Host status, usage probe, image upload, and workspace git JSON-RPC handlers.

use crate::protocol::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_GIT_DIFF, METHOD_GIT_STATUS,
    METHOD_FILE_READ, METHOD_HOST_STATUS, METHOD_UPLOAD_IMAGE, METHOD_USAGE_GET, METHOD_USAGE_SPEND,
};
use crate::server::AppState;
use crate::transport::rpc::workspace::workspace_dir;

pub async fn try_dispatch(req: &JsonRpcRequest, state: &AppState) -> Option<JsonRpcResponse> {
    let resp = match req.method.as_str() {
        METHOD_HOST_STATUS => {
            let cmux_alive = state.cmux_bridge.ping().await;
            JsonRpcResponse::result(
                req.id.clone(),
                serde_json::json!({
                    "cmux_alive": cmux_alive,
                    "host": state.host,
                    "port": state.port,
                    "gateway_version": env!("CARGO_PKG_VERSION")
                }),
            )
            .unwrap()
        }
        METHOD_USAGE_GET => {
            let refresh = req
                .params
                .get("refresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let snap = state.usage_service.get_snapshot(refresh).await;
            JsonRpcResponse::result_value(req.id.clone(), serde_json::to_value(snap).unwrap())
        }
        METHOD_FILE_READ => {
            let Some(path) = req
                .params
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
            else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing path parameter"),
                ));
            };
            let since = req.params.get("since_mtime_ms").and_then(|v| v.as_u64());
            let dir = match workspace_dir(state, &req.params).await {
                Ok(d) => d,
                Err(e) => return Some(JsonRpcResponse::error(Some(req.id.clone()), e)),
            };
            let path = path.to_string();
            let read = tokio::task::spawn_blocking(move || {
                crate::services::file_read::read_workspace_file(&dir, &path, since)
            })
            .await;
            match read {
                Ok(Ok(file)) => {
                    JsonRpcResponse::result_value(req.id.clone(), serde_json::to_value(file).unwrap())
                }
                Ok(Err(e)) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params(e.message()),
                ),
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_USAGE_SPEND => {
            let period = req.params.get("period").and_then(|v| v.as_str()).unwrap_or("month");
            let refresh = req.params.get("refresh").and_then(|v| v.as_bool()).unwrap_or(false);
            let Some(snap) = state.spend_service.get_spend(period, refresh).await else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("period must be one of: today, week, 30days, month"),
                ));
            };
            JsonRpcResponse::result_value(req.id.clone(), serde_json::to_value(snap).unwrap())
        }
        METHOD_UPLOAD_IMAGE => {
            use base64::Engine;
            let Some(b64) = req.params.get("content_base64").and_then(|v| v.as_str()) else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing content_base64 parameter"),
                ));
            };
            if b64.len() > crate::uploads::MAX_IMAGE_BYTES / 3 * 4 + 8 {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Image too large"),
                ));
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("content_base64 is not valid base64"),
                ));
            };
            let Some(dir) = crate::uploads::default_dir() else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error("No upload directory available"),
                ));
            };
            let saved =
                tokio::task::spawn_blocking(move || crate::uploads::save_image(&dir, &bytes)).await;
            match saved {
                Ok(Ok(path)) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "path": path.to_string_lossy() }),
                )
                .unwrap(),
                Ok(Err(msg)) => {
                    JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(msg))
                }
                Err(e) => JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::internal_error(e.to_string()),
                ),
            }
        }
        METHOD_GIT_STATUS => {
            let dir = match workspace_dir(state, &req.params).await {
                Ok(d) => d,
                Err(e) => return Some(JsonRpcResponse::error(Some(req.id.clone()), e)),
            };
            match crate::git_view::status(&dir).await {
                Ok(st) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({ "directory": dir.to_string_lossy(), "status": st }),
                )
                .unwrap(),
                Err(e) => {
                    JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(e))
                }
            }
        }
        METHOD_GIT_DIFF => {
            let Some(path) = req
                .params
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
            else {
                return Some(JsonRpcResponse::error(
                    Some(req.id.clone()),
                    JsonRpcError::invalid_params("Missing path parameter"),
                ));
            };
            let staged = req
                .params
                .get("staged")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let dir = match workspace_dir(state, &req.params).await {
                Ok(d) => d,
                Err(e) => return Some(JsonRpcResponse::error(Some(req.id.clone()), e)),
            };
            let st = match crate::git_view::status(&dir).await {
                Ok(st) => st,
                Err(e) => {
                    return Some(JsonRpcResponse::error(
                        Some(req.id.clone()),
                        JsonRpcError::invalid_params(e),
                    ))
                }
            };
            match crate::git_view::diff(&dir, &st, path, staged).await {
                Ok((diff, truncated)) => JsonRpcResponse::result(
                    req.id.clone(),
                    serde_json::json!({
                        "path": path,
                        "staged": staged,
                        "diff": diff,
                        "truncated": truncated
                    }),
                )
                .unwrap(),
                Err(e) => {
                    JsonRpcResponse::error(Some(req.id.clone()), JsonRpcError::invalid_params(e))
                }
            }
        }
        _ => return None,
    };
    Some(resp)
}
