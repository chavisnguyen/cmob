//! Terminal `render_grid` subscription manager, session-namespaced viewport lifecycle, and stream watcher.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify, RwLock};
use tokio::task::JoinHandle;

use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, METHOD_TERMINAL_UNSUBSCRIBE};
use crate::server::AppState;
use crate::services::chat_stream::MAX_SUBSCRIPTIONS;

pub const EVENT_TERMINAL_UPDATE: &str = "mobile.terminal.update";

#[derive(Debug, Clone)]
pub struct TerminalStreamConfig {
    pub mode: String,
    pub columns: u16,
    pub rows: u16,
    pub client_id: String,
    pub max_scrollback_rows: usize,
    pub force_push: bool,
}

pub struct TerminalSubscriptionHandle {
    pub task: JoinHandle<()>,
    pub config: Arc<RwLock<TerminalStreamConfig>>,
    pub notify: Arc<Notify>,
    pub delayed_wakeup: Arc<AtomicBool>,
}

pub fn namespaced_client_id(ws_session_id: &str, raw_client_id: &str) -> String {
    let clean = raw_client_id.trim();
    let suffix = if clean.is_empty() { "pwa" } else { clean };
    format!("{ws_session_id}:{suffix}")
}

pub fn trigger_terminal_wakeup(notify: &Arc<Notify>, delayed_pending: &Arc<AtomicBool>) {
    notify.notify_one();
    if delayed_pending
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_ok()
    {
        let delayed_notify = notify.clone();
        let flag = delayed_pending.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(55)).await;
            flag.store(false, Ordering::Release);
            delayed_notify.notify_one();
        });
    }
}

pub fn terminal_replay_fingerprint(payload: &serde_json::Value, mode: &str) -> String {
    let rg = &payload["render_grid"];
    let size_state = &payload["size_state"];
    let epoch = rg.get("render_epoch").and_then(|val| val.as_str()).unwrap_or("");
    let rev = rg.get("render_revision").and_then(|val| val.as_u64()).unwrap_or(0);
    let row_rev = rg.get("row_space_revision").and_then(|val| val.as_u64()).unwrap_or(0);
    let state_seq = rg.get("state_seq").and_then(|val| val.as_u64()).unwrap_or(0);
    let cols = rg.get("columns").and_then(|val| val.as_u64()).unwrap_or(0);
    let rows = rg.get("rows").and_then(|val| val.as_u64()).unwrap_or(0);
    let screen = rg.get("active_screen").and_then(|val| val.as_str()).unwrap_or("");
    let sb_rows = rg.get("scrollback_rows").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_row = rg["cursor"].get("row").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_col = rg["cursor"].get("column").and_then(|val| val.as_u64()).unwrap_or(0);
    let cursor_vis = rg["cursor"].get("visible").and_then(|val| val.as_bool()).unwrap_or(true);
    let ss_cols = size_state.get("cols").and_then(|val| val.as_u64()).unwrap_or(0);
    let ss_rows = size_state.get("rows").and_then(|val| val.as_u64()).unwrap_or(0);
    format!("{mode}|{epoch}|{rev}|{row_rev}|{state_seq}|{cols}x{rows}|{screen}|{sb_rows}|{cursor_row},{cursor_col},{cursor_vis}|{ss_cols}x{ss_rows}")
}

/// Manages `mobile.terminal.subscribe` / `mobile.terminal.unsubscribe` without blocking the WS `select!` loop.
pub async fn handle_terminal_subscription(
    ws_session_id: &str,
    req: &JsonRpcRequest,
    state: &AppState,
    out_tx: &mpsc::Sender<String>,
    term_subs: &mut HashMap<String, TerminalSubscriptionHandle>,
) -> JsonRpcResponse {
    let Some(surface_id) = req
        .params
        .get("surface_id")
        .and_then(|val| val.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Missing surface_id parameter"),
        );
    };

    let prev_cfg = if let Some(old) = term_subs.remove(&surface_id) {
        old.task.abort();
        Some(old.config.read().await.clone())
    } else {
        None
    };

    if req.method == METHOD_TERMINAL_UNSUBSCRIBE {
        if let Some(cfg) = prev_cfg
            && cfg.mode == "mobile"
            && !cfg.client_id.is_empty()
        {
            let bridge = state.cmux_bridge.clone();
            let sid = surface_id.clone();
            tokio::spawn(async move {
                let _ = bridge.terminal_clear_viewport(&sid, &cfg.client_id).await;
            });
        }
        return JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "unsubscribed": true, "surface_id": surface_id }),
        )
        .unwrap();
    }

    if term_subs.len() >= MAX_SUBSCRIPTIONS {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params(format!(
                "Too many terminal subscriptions (max {MAX_SUBSCRIPTIONS} per connection)"
            )),
        );
    }

    let mode = req.params.get("mode").and_then(|v| v.as_str()).unwrap_or("desktop").to_string();
    let columns = req
        .params
        .get("columns")
        .or_else(|| req.params.get("cols"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u16;
    let rows = req.params.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    let raw_client_id = req.params.get("client_id").and_then(|v| v.as_str()).unwrap_or("pwa");
    let client_id = namespaced_client_id(ws_session_id, raw_client_id);
    let max_scrollback_rows = req
        .params
        .get("max_scrollback_rows")
        .and_then(|v| v.as_u64())
        .unwrap_or(500)
        .min(2000) as usize;

    let prev_to_clear = prev_cfg.and_then(|old_cfg| {
        (old_cfg.mode == "mobile"
            && !old_cfg.client_id.is_empty()
            && (mode != "mobile" || old_cfg.client_id != client_id))
            .then_some(old_cfg.client_id)
    });

    {
        let bridge = state.cmux_bridge.clone();
        let sid = surface_id.clone();
        let cid = client_id.clone();
        let mode_cl = mode.clone();
        tokio::spawn(async move {
            if let Some(old_cid) = prev_to_clear {
                let _ = bridge.terminal_clear_viewport(&sid, &old_cid).await;
            }
            if mode_cl == "mobile" && columns > 0 && rows > 0 {
                let _ = bridge.terminal_set_viewport(&sid, &cid, columns, rows).await;
            } else if mode_cl == "desktop" && !cid.is_empty() {
                let _ = bridge.terminal_clear_viewport(&sid, &cid).await;
            }
        });
    }

    let config = Arc::new(RwLock::new(TerminalStreamConfig {
        mode: mode.clone(),
        columns,
        rows,
        client_id,
        max_scrollback_rows,
        force_push: true,
    }));
    let notify = Arc::new(Notify::new());
    let task = tokio::spawn(terminal_watcher(
        state.clone(),
        out_tx.clone(),
        surface_id.clone(),
        config.clone(),
        notify.clone(),
    ));

    term_subs.insert(
        surface_id.clone(),
        TerminalSubscriptionHandle {
            task,
            config,
            notify,
            delayed_wakeup: Arc::new(AtomicBool::new(false)),
        },
    );

    JsonRpcResponse::result(
        req.id.clone(),
        serde_json::json!({
            "subscribed": true,
            "surface_id": surface_id,
            "mode": mode,
            "event": EVENT_TERMINAL_UPDATE,
        }),
    )
    .unwrap()
}

/// Applies `mobile.terminal.viewport` on a spawned worker task so `handle_socket` never blocks.
pub async fn apply_terminal_viewport(
    ws_session_id: &str,
    req: &JsonRpcRequest,
    state: &AppState,
    sub_ctx: Option<(Arc<RwLock<TerminalStreamConfig>>, Arc<Notify>)>,
) -> JsonRpcResponse {
    let Some(surface_id) = req
        .params
        .get("surface_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    else {
        return JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::invalid_params("Missing surface_id parameter"),
        );
    };
    let raw_client_id = req.params.get("client_id").and_then(|v| v.as_str()).unwrap_or("pwa");
    let client_id = namespaced_client_id(ws_session_id, raw_client_id);
    let clear = req.params.get("clear").and_then(|v| v.as_bool()).unwrap_or(false);
    let mode = req
        .params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or(if clear { "desktop" } else { "mobile" });
    let columns = req
        .params
        .get("columns")
        .or_else(|| req.params.get("cols"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u16;
    let rows = req.params.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;

    let rpc_res = if clear || mode == "desktop" {
        let mut prev_cid = None;
        if let Some((cfg_lock, _)) = &sub_ctx {
            let mut cfg = cfg_lock.write().await;
            if cfg.mode == "mobile" && !cfg.client_id.is_empty() && cfg.client_id != client_id {
                prev_cid = Some(cfg.client_id.clone());
            }
            cfg.mode = "desktop".to_string();
            cfg.force_push = true;
        }
        if let Some(old_cid) = prev_cid {
            let _ = state.cmux_bridge.terminal_clear_viewport(surface_id, &old_cid).await;
        }
        state.cmux_bridge.terminal_clear_viewport(surface_id, &client_id).await
    } else {
        if columns == 0 || rows == 0 {
            return JsonRpcResponse::error(
                Some(req.id.clone()),
                JsonRpcError::invalid_params("columns and rows must be > 0 for mobile mode"),
            );
        }
        let mut prev_cid = None;
        if let Some((cfg_lock, _)) = &sub_ctx {
            let mut cfg = cfg_lock.write().await;
            if cfg.mode == "mobile" && !cfg.client_id.is_empty() && cfg.client_id != client_id {
                prev_cid = Some(cfg.client_id.clone());
            }
            cfg.mode = "mobile".to_string();
            cfg.columns = columns;
            cfg.rows = rows;
            cfg.client_id = client_id.clone();
            cfg.force_push = true;
        }
        if let Some(old_cid) = prev_cid {
            let _ = state.cmux_bridge.terminal_clear_viewport(surface_id, &old_cid).await;
        }
        state.cmux_bridge.terminal_set_viewport(surface_id, &client_id, columns, rows).await
    };

    if let Some((_, notify)) = sub_ctx {
        notify.notify_one();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(160)).await;
            notify.notify_one();
        });
    }

    match rpc_res {
        Ok(result) => JsonRpcResponse::result(
            req.id.clone(),
            serde_json::json!({ "surface_id": surface_id, "mode": mode, "result": result }),
        )
        .unwrap(),
        Err(err) => JsonRpcResponse::error(
            Some(req.id.clone()),
            JsonRpcError::internal_error(err.to_string()),
        ),
    }
}

async fn terminal_watcher(
    state: AppState,
    out_tx: mpsc::Sender<String>,
    surface_id: String,
    config: Arc<RwLock<TerminalStreamConfig>>,
    notify: Arc<Notify>,
) {
    const POLL_MS: u64 = 150;
    let mut last_fp: Option<String> = None;
    let mut viewport_sync_pending = false;

    loop {
        let cfg = config.read().await.clone();
        let viewport = (cfg.mode == "mobile" && cfg.columns > 0 && cfg.rows > 0)
            .then_some((cfg.columns, cfg.rows));

        match state
            .cmux_bridge
            .terminal_replay(&surface_id, cfg.max_scrollback_rows, viewport)
            .await
        {
            Ok(mut replay) => {
                if let Some((target_cols, target_rows)) = viewport {
                    let actual_cols = replay.get("columns").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                    let actual_rows = replay.get("rows").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                    let has_mobile_owner = replay["size_state"]
                        .get("participants")
                        .and_then(|v| v.as_array())
                        .is_some_and(|arr| {
                            arr.iter().any(|p| {
                                p.get("id")
                                    .and_then(|id| id.as_str())
                                    .is_some_and(|id| id == format!("mobile:{}", cfg.client_id))
                            })
                        });

                    if !has_mobile_owner && !viewport_sync_pending {
                        viewport_sync_pending = true;
                        if state
                            .cmux_bridge
                            .terminal_set_viewport(&surface_id, &cfg.client_id, target_cols, target_rows)
                            .await
                            .is_err()
                        {
                            viewport_sync_pending = false;
                        }
                    } else if has_mobile_owner && (actual_cols == target_cols || actual_rows == target_rows) {
                        viewport_sync_pending = false;
                    }
                } else {
                    viewport_sync_pending = false;
                }

                let fp = terminal_replay_fingerprint(&replay, &cfg.mode);
                if cfg.force_push || last_fp.as_deref() != Some(fp.as_str()) {
                    if cfg.force_push {
                        config.write().await.force_push = false;
                    }
                    last_fp = Some(fp);
                    if let Some(obj) = replay.as_object_mut() {
                        obj.insert("mode".to_string(), serde_json::Value::String(cfg.mode.clone()));
                    }
                    let frame = JsonRpcResponse::event_value(EVENT_TERMINAL_UPDATE, replay);
                    if let Ok(text) = serde_json::to_string(&frame)
                        && out_tx.send(text).await.is_err()
                    {
                        return;
                    }
                }
            }
            Err(_) => {
                viewport_sync_pending = false;
            }
        }

        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(POLL_MS)) => {}
        }
    }
}
