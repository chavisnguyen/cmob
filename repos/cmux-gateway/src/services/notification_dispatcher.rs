//! Background notification & startup-dialog dispatchers (WebPush, WS broadcast, macOS desktop).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::notifications::{
    build_dialog_notification_content, build_notification_content, make_push_tag, EngineEvent,
    NotificationContent, NotificationEngine,
};
use crate::protocol::event::AgentLifecycleState;
use crate::protocol::JsonRpcResponse;
use crate::scanner::hook_store::HookStoreIndex;
use crate::scanner::workspace_tree::WorkspaceTreeBuilder;
use crate::server::AppState;
use crate::services::notification_sources::{
    collect_notification_sessions, lookup_surface_context, surface_context_from_tree,
    workspace_dirs_map,
};

pub const EVENT_NOTIFICATION_ALERT: &str = "mobile.notification.alert";
pub const EVENT_NOTIFICATION_DISMISS: &str = "mobile.notification.dismiss";

/// Broadcast message fanned out to active WebSocket clients for live alerts/dismissals.
#[derive(Clone, Debug)]
pub enum NotificationBroadcast {
    Alert { surface_id: String, frame: String },
    Dismiss { surface_id: String, frame: String },
}

fn desktop_notifications_enabled() -> bool {
    !matches!(
        std::env::var("CMUX_DESKTOP_NOTIFY").as_deref(),
        Ok("0" | "false" | "FALSE")
    )
}

/// Emits a notification alert: ALWAYS fans out to live WebSocket clients and macOS desktop banner,
/// while gating ONLY external Web Push HTTP delivery behind the burst cooldown!
pub async fn emit_alert(
    state: &AppState,
    notification_id: &str,
    surface_id: &str,
    workspace_id: &str,
    content: &NotificationContent,
    cooldown_category: &str,
    cooldown_secs: u64,
) {
    if state
        .push_service
        .should_dispatch(surface_id, cooldown_category, cooldown_secs)
    {
        let data = serde_json::json!({
            "notificationId": notification_id,
            "surfaceId": surface_id,
            "workspaceId": workspace_id,
            "category": content.category,
            "agent": content.agent_kind,
            "agentDisplay": content.agent_display,
            "urgent": content.urgent,
            "tag": content.tag,
        });
        let excluded = state.clients.devices_viewing_surface(surface_id);
        state
            .push_service
            .dispatch_excluding_devices(
                &content.title,
                &content.body,
                Some(&content.tag),
                data,
                &excluded,
            )
            .await;
    }

    let ws_payload = serde_json::json!({
        "notification_id": notification_id,
        "surface_id": surface_id,
        "workspace_id": workspace_id,
        "category": content.category,
        "agent": content.agent_kind,
        "agent_display": content.agent_display,
        "title": content.title,
        "subtitle": content.subtitle,
        "body": content.body,
        "tag": content.tag,
        "urgent": content.urgent,
    });
    let frame = JsonRpcResponse::event_value(EVENT_NOTIFICATION_ALERT, ws_payload);
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = state.notif_tx.send(NotificationBroadcast::Alert {
            surface_id: surface_id.to_string(),
            frame: text,
        });
    }

    if desktop_notifications_enabled() {
        let _ = state
            .cmux_bridge
            .notify_desktop(
                surface_id,
                &content.title,
                content.subtitle.as_deref(),
                &content.body,
            )
            .await;
    }
}

pub async fn emit_dismiss(state: &AppState, surface_id: &str, tags: &[String]) {
    state.push_service.clear_surface_cooldowns(surface_id);
    let frame = JsonRpcResponse::event_value(
        EVENT_NOTIFICATION_DISMISS,
        serde_json::json!({ "surface_id": surface_id, "tags": tags }),
    );
    if let Ok(text) = serde_json::to_string(&frame) {
        let _ = state.notif_tx.send(NotificationBroadcast::Dismiss {
            surface_id: surface_id.to_string(),
            frame: text,
        });
    }
    if desktop_notifications_enabled() {
        let _ = state.cmux_bridge.clear_notifications(surface_id).await;
    }
}

/// Spawns the background monitor that scans ALL active top-level sessions (including OpenCode SQLite
/// and Kiro TTY sessions) and dispatches Orca-style alerts.
pub fn spawn_push_dispatcher(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        let mut engine = NotificationEngine::default();
        let mut baseline_done = false;
        let mut ticks: u64 = 0;
        loop {
            interval.tick().await;
            ticks += 1;
            if ticks % 1200 == 1 {
                let st = state.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    for id in st.devices.prune_expired() {
                        st.push_service.unregister_device(&id);
                    }
                })
                .await;
            }

            let Ok(sessions) = tokio::task::spawn_blocking(collect_notification_sessions).await else {
                continue;
            };
            let session_refs: Vec<_> = sessions.iter().collect();

            if !baseline_done {
                engine.seed(&session_refs);
                baseline_done = true;
                continue;
            }

            for ev in engine.step(&session_refs, Instant::now()) {
                match ev {
                    EngineEvent::Dismiss { surface_id, tags } => {
                        emit_dismiss(&state, &surface_id, &tags).await;
                    }
                    EngineEvent::Alert {
                        notification_id,
                        surface_id,
                        workspace_id,
                        lifecycle,
                        record,
                        ..
                    } => {
                        let ctx = lookup_surface_context(
                            &state.cmux_bridge,
                            &surface_id,
                            record.cwd.as_deref(),
                        )
                        .await;
                        let rec_clone = record.clone();
                        let Ok(content) = tokio::task::spawn_blocking(move || {
                            build_notification_content(&rec_clone, lifecycle, &ctx)
                        })
                        .await
                        else {
                            continue;
                        };
                        emit_alert(
                            &state,
                            &notification_id,
                            &surface_id,
                            &workspace_id,
                            &content,
                            content.category,
                            5,
                        )
                        .await;
                    }
                }
            }
        }
    })
}

fn terminal_surfaces(tree: &serde_json::Value) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for win in tree.get("windows").and_then(|w| w.as_array()).into_iter().flatten() {
        for ws in win.get("workspaces").and_then(|w| w.as_array()).into_iter().flatten() {
            let ws_id = ws.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            for pane in ws.get("panes").and_then(|p| p.as_array()).into_iter().flatten() {
                for s in pane.get("surfaces").and_then(|s| s.as_array()).into_iter().flatten() {
                    if s.get("type").and_then(|t| t.as_str()) != Some("terminal") {
                        continue;
                    }
                    if let (Some(id), Some(tty)) = (
                        s.get("id").and_then(|i| i.as_str()),
                        s.get("tty").and_then(|t| t.as_str()),
                    ) {
                        out.push((
                            id.to_string(),
                            ws_id.clone(),
                            tty.trim_start_matches("/dev/").to_string(),
                        ));
                    }
                }
            }
        }
    }
    out
}

/// Watches freshly started agents AND existing active dialogs for startup dialogs (trust, update...),
/// keeping active dialogs alive past 5 minutes until they genuinely clear from the terminal.
pub fn spawn_dialog_watcher(state: AppState) -> tokio::task::JoinHandle<()> {
    use crate::cmux::startup_dialog::registry;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3));
        let mut active_dialogs: HashMap<String, (String, String)> = HashMap::new();
        let mut seq: u64 = 0;
        loop {
            interval.tick().await;
            let recent =
                tokio::task::spawn_blocking(|| WorkspaceTreeBuilder::scan_recent_agent_ttys(300))
                    .await
                    .unwrap_or_default();
            if recent.is_empty() && active_dialogs.is_empty() {
                continue;
            }
            let Ok(raw) = state
                .cmux_bridge
                .run_command("tree", &["--json", "--id-format", "both"])
                .await
            else {
                continue;
            };
            let Ok(tree) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let hook_index =
                HookStoreIndex::scan_dir_async(HookStoreIndex::default_cmuxterm_dir()).await;
            let ws_dirs = workspace_dirs_map(&state.cmux_bridge).await;
            let mut seen_dialogs = HashSet::new();

            for (surface_id, workspace_id, tty) in terminal_surfaces(&tree) {
                let agent = recent
                    .iter()
                    .find(|(t, _)| *t == tty)
                    .map(|(_, a)| (*a).to_string())
                    .or_else(|| active_dialogs.get(&surface_id).map(|(a, _)| a.clone()));
                let Some(agent) = agent else { continue };

                if hook_index
                    .get_active_session_for_surface(&surface_id)
                    .is_some_and(|rec| rec.resolved_lifecycle() == AgentLifecycleState::Working)
                {
                    registry::set(&surface_id, None);
                    if active_dialogs.remove(&surface_id).is_some() {
                        emit_dismiss(&state, &surface_id, &[make_push_tag(&surface_id, "cmux-dialog")]).await;
                    }
                    continue;
                }

                match state.cmux_bridge.current_dialog(Some(&surface_id)).await {
                    Some(d) => {
                        registry::set(&surface_id, Some(&d.fingerprint));
                        seen_dialogs.insert(surface_id.clone());
                        let is_new_fp = active_dialogs
                            .get(&surface_id)
                            .is_none_or(|(_, prev_fp)| prev_fp != &d.fingerprint);
                        active_dialogs
                            .insert(surface_id.clone(), (agent.clone(), d.fingerprint.clone()));
                        if is_new_fp {
                            let cooldown_cat = format!("dialog:{}", d.fingerprint);
                            let ctx = surface_context_from_tree(&tree, &ws_dirs, &surface_id, None);
                            let content =
                                build_dialog_notification_content(&surface_id, &agent, &d.title, &ctx);
                            seq = seq.wrapping_add(1);
                            let notif_id = format!("dlg-{seq}");
                            emit_alert(
                                &state,
                                &notif_id,
                                &surface_id,
                                &workspace_id,
                                &content,
                                &cooldown_cat,
                                3600,
                            )
                            .await;
                        }
                    }
                    None => {
                        registry::set(&surface_id, None);
                        if active_dialogs.remove(&surface_id).is_some() {
                            emit_dismiss(&state, &surface_id, &[make_push_tag(&surface_id, "cmux-dialog")]).await;
                        }
                    }
                }
            }

            let gone: Vec<String> = active_dialogs
                .keys()
                .filter(|sid| !seen_dialogs.contains(*sid))
                .cloned()
                .collect();
            for sid in gone {
                registry::set(&sid, None);
                active_dialogs.remove(&sid);
                emit_dismiss(&state, &sid, &[make_push_tag(&sid, "cmux-dialog")]).await;
            }
        }
    })
}
