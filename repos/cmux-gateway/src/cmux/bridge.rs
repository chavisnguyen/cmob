//! Pure Unix Domain Socket (`cmux.sock`) bridge for macOS `cmux`.
//!
//! All IPC runs directly over `CmuxUdsPool` using `cmux`'s native v2 JSON-RPC protocol and
//! `_cmux_capability_v1 <CMUX_SOCKET_CAPABILITY>` authentication (~0.6–0.9ms per call, zero
//! subprocess spawning, zero silent CLI fallback).

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::cmux::agent_profile::{profile_for, split_legacy_submit};
use crate::cmux::startup_dialog;
use crate::cmux::uds_client::{CmuxUdsPool, UdsCallError};
use crate::domain::dialog::{
    plan_approval_steps, plan_batch_question_steps_for_selector, plan_interrupt_keys,
    plan_question_answer_steps_checked, ApprovalPlanError, QuestionAnswerPlan,
    QuestionAnswerSelection, QuestionStep,
};

pub const DEFAULT_RPC_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, thiserror::Error)]
pub enum CmuxBridgeError {
    /// The agent is showing a startup dialog that owns Enter; typing into it could accept it.
    #[error("The agent is waiting on a startup dialog ({0}). Open the Terminal tab and answer it first.")]
    StartupDialog(&'static str),

    #[error("cmux socket unavailable: {0}")]
    SocketUnavailable(String),

    #[error("cmux operation timed out after {0}s")]
    Timeout(u64),

    #[error("cmux returned error: {0}")]
    CmuxError(String),

    #[error("Failed to parse cmux output as JSON: {0}")]
    JsonParseError(String),
}

#[derive(Debug, Clone)]
pub struct DualTransportCmuxBridge {
    timeout_duration: Duration,
    uds_pool: Arc<CmuxUdsPool>,
}

impl Default for DualTransportCmuxBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl DualTransportCmuxBridge {
    pub fn new() -> Self {
        Self {
            timeout_duration: Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECS),
            uds_pool: Arc::new(CmuxUdsPool::new()),
        }
    }

    pub fn with_socket_path(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            timeout_duration: Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECS),
            uds_pool: Arc::new(CmuxUdsPool::with_socket_path(socket_path)),
        }
    }

    fn map_uds_err(&self, err: UdsCallError) -> CmuxBridgeError {
        match err {
            UdsCallError::Unavailable(msg) => CmuxBridgeError::SocketUnavailable(msg),
            UdsCallError::Timeout => {
                CmuxBridgeError::Timeout(self.timeout_duration.as_secs().max(1))
            }
            UdsCallError::RpcError(msg) => CmuxBridgeError::CmuxError(msg),
            UdsCallError::ParseError(msg) => CmuxBridgeError::JsonParseError(msg),
        }
    }

    /// Pings `cmux` over `cmux.sock` (`system.ping`) to verify daemon health and capability validity.
    pub async fn ping(&self) -> bool {
        self.rpc("system.ping", serde_json::json!({})).await.is_ok()
    }

    /// Fetches the full workspace/pane/surface JSON tree across all windows (`system.tree`).
    pub async fn tree_json(&self) -> Result<String, CmuxBridgeError> {
        self.rpc_call("system.tree", Some(serde_json::json!({ "all_windows": true })))
            .await
    }

    async fn resolve_workspace_for_surface(&self, surface_id: &str) -> Option<String> {
        let tree = self
            .rpc("system.tree", serde_json::json!({ "all_windows": true }))
            .await
            .ok()?;
        for win in tree.get("windows")?.as_array()? {
            for ws in win.get("workspaces")?.as_array()? {
                let ws_id = ws.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if ws_id.is_empty() {
                    continue;
                }
                let Some(panes) = ws.get("panes").and_then(|v| v.as_array()) else {
                    continue;
                };
                for pane in panes {
                    let Some(surfaces) = pane.get("surfaces").and_then(|v| v.as_array()) else {
                        continue;
                    };
                    for surf in surfaces {
                        let sid = surf.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let sref = surf.get("ref").and_then(|v| v.as_str()).unwrap_or("");
                        if sid == surface_id || sref == surface_id {
                            return Some(ws_id.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// Dispatches a JSON-RPC call returning the serialized JSON result string.
    pub async fn rpc_call(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<String, CmuxBridgeError> {
        let val = self
            .rpc(method, params.unwrap_or_else(|| serde_json::json!({})))
            .await?;
        serde_json::to_string(&val).map_err(|e| CmuxBridgeError::JsonParseError(e.to_string()))
    }

    /// Dispatches a JSON-RPC method call directly over the persistent `cmux.sock` pool.
    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value, CmuxBridgeError> {
        self.uds_pool
            .call(method, params, self.timeout_duration)
            .await
            .map_err(|e| self.map_uds_err(e))
    }

    /// Sends a keystroke or control key to a surface tab via `surface.send_key`.
    pub async fn send_key(
        &self,
        surface_id: Option<&str>,
        key: &str,
    ) -> Result<(), CmuxBridgeError> {
        let mut params = serde_json::json!({ "key": key });
        if let Some(surf) = surface_id {
            params["surface_id"] = serde_json::json!(surf);
        }
        self.rpc("surface.send_key", params).await.map(|_| ())
    }

    /// Sends literal text input to a surface tab via `surface.send_text`.
    pub async fn send_text(
        &self,
        surface_id: Option<&str>,
        text: &str,
    ) -> Result<(), CmuxBridgeError> {
        let mut params = serde_json::json!({ "text": text });
        if let Some(surf) = surface_id {
            params["surface_id"] = serde_json::json!(surf);
        }
        self.rpc("surface.send_text", params).await.map(|_| ())
    }

    /// Pastes text via bracketed paste (`terminal.paste` with `submit_key: "none"`).
    pub async fn paste_text(
        &self,
        surface_id: Option<&str>,
        text: &str,
    ) -> Result<(), CmuxBridgeError> {
        let mut params = serde_json::json!({
            "text": text,
            "submit_key": "none",
        });
        if let Some(surf) = surface_id {
            params["surface_id"] = serde_json::json!(surf);
        }
        self.rpc("terminal.paste", params).await.map(|_| ())
    }

    /// Captures terminal screen buffer via `surface.read_text`.
    pub async fn capture_pane(
        &self,
        surface_id: Option<&str>,
        lines: usize,
        scrollback: bool,
    ) -> Result<String, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "lines": lines,
            "scrollback": scrollback,
        });
        if let Some(surf) = surface_id {
            params["surface_id"] = serde_json::json!(surf);
        }
        let val = self.rpc("surface.read_text", params).await?;
        val.get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                CmuxBridgeError::JsonParseError("surface.read_text missing 'text' field".into())
            })
    }

    /// Interrupts active agent execution via Escape (matching Orca TUI interrupt semantics).
    pub async fn interrupt(&self, surface_id: &str) -> Result<(), CmuxBridgeError> {
        self.interrupt_agent(surface_id, None).await
    }

    /// Interrupts active agent execution via `escape` (or two `escape` keys 60ms apart for OpenCode).
    /// Source: `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:45-48`.
    pub async fn interrupt_agent(
        &self,
        surface_id: &str,
        agent_kind: Option<&str>,
    ) -> Result<(), CmuxBridgeError> {
        let (keys, delay_ms) = plan_interrupt_keys(agent_kind);
        for (idx, key) in keys.iter().enumerate() {
            if idx > 0 && delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            self.send_key(Some(surface_id), key).await?;
        }
        Ok(())
    }

    async fn execute_question_steps(
        &self,
        surface_id: &str,
        agent_kind: &str,
        actions: Vec<QuestionStep>,
    ) -> Result<(), CmuxBridgeError> {
        for action in actions {
            match action {
                QuestionStep::Key(k) => {
                    self.send_key(Some(surface_id), k).await?;
                    tokio::time::sleep(Duration::from_millis(45)).await;
                }
                QuestionStep::Text(t) => {
                    self.send_text(Some(surface_id), &t).await?;
                    tokio::time::sleep(Duration::from_millis(45)).await;
                }
                QuestionStep::Paste(t) => {
                    self.paste_text(Some(surface_id), &t).await?;
                    tokio::time::sleep(profile_for(agent_kind).submit_delay(&t)).await;
                }
            }
        }
        Ok(())
    }

    /// Sends one-tap approval to a pending permission request, failing closed on startup dialogs and
    /// idle screens with no approval context, and moving the cursor back to option 1 when needed.
    pub async fn approve(&self, surface_id: &str, agent_kind: &str) -> Result<(), CmuxBridgeError> {
        let screen = self.capture_pane(Some(surface_id), 40, false).await?;
        let steps = match plan_approval_steps(&screen, agent_kind) {
            Ok(s) => s,
            Err(ApprovalPlanError::StartupDialog(lbl)) => {
                return Err(CmuxBridgeError::StartupDialog(lbl));
            }
            Err(ApprovalPlanError::NoApprovalContext) => {
                return Err(CmuxBridgeError::CmuxError(
                    "No active approval prompt found on this terminal.".into(),
                ));
            }
        };
        self.execute_question_steps(surface_id, agent_kind, steps)
            .await
    }

    /// Pastes `text` into the surface, waits for the agent TUI to ingest it, then presses Enter as a
    /// separate key.
    pub async fn submit_prompt(
        &self,
        surface_id: Option<&str>,
        text: &str,
        agent_kind: &str,
        enter: bool,
    ) -> Result<(), CmuxBridgeError> {
        let (body, legacy_submit) = split_legacy_submit(text);
        let profile = profile_for(agent_kind);
        self.ensure_no_startup_dialog(surface_id).await?;
        if !body.is_empty() {
            self.paste_text(surface_id, body).await?;
        }
        if enter || legacy_submit {
            if !body.is_empty() {
                tokio::time::sleep(profile.submit_delay(body)).await;
            }
            self.ensure_no_startup_dialog(surface_id).await?;
            self.send_key(surface_id, "enter").await?;
        }
        Ok(())
    }

    /// The startup dialog on the surface screen, if any (see `startup_dialog`).
    pub async fn current_dialog(
        &self,
        surface_id: Option<&str>,
    ) -> Option<startup_dialog::DialogInfo> {
        let screen = self.capture_pane(surface_id, 40, false).await.ok()?;
        startup_dialog::analyze(&screen)
    }

    /// Answers the dialog on screen with its `choice`-th option.
    pub async fn answer_dialog(
        &self,
        surface_id: &str,
        fingerprint: &str,
        choice: usize,
    ) -> Result<String, CmuxBridgeError> {
        let dialog = self.current_dialog(Some(surface_id)).await.ok_or_else(|| {
            CmuxBridgeError::CmuxError(
                "There is no startup dialog on this terminal any more.".into(),
            )
        })?;
        if dialog.fingerprint != fingerprint {
            return Err(CmuxBridgeError::CmuxError(
                "The dialog changed. Review it again before answering.".into(),
            ));
        }
        let picked = dialog.choices.get(choice).ok_or_else(|| {
            CmuxBridgeError::CmuxError(
                "This dialog can only be answered in the Terminal tab.".into(),
            )
        })?;
        for key in &picked.keys {
            self.send_key(Some(surface_id), key).await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Ok(picked.label.clone())
    }

    /// Answers an active interactive TUI question menu (`ask_question` / `AskUserQuestion`) on screen.
    pub async fn answer_question(
        &self,
        surface_id: &str,
        agent_kind: &str,
        indices: &[usize],
        other: Option<&str>,
        option_count: usize,
        multi_select: bool,
    ) -> Result<(), CmuxBridgeError> {
        let screen = self.capture_pane(Some(surface_id), 45, false).await.ok();
        let plan = plan_question_answer_steps_checked(
            screen.as_deref(),
            agent_kind,
            indices,
            other,
            option_count,
            multi_select,
        )
        .map_err(CmuxBridgeError::StartupDialog)?;

        match plan {
            QuestionAnswerPlan::TuiSteps(actions) => {
                self.execute_question_steps(surface_id, agent_kind, actions)
                    .await
            }
            QuestionAnswerPlan::PromptFallback(text) => {
                self.submit_prompt(Some(surface_id), &text, agent_kind, true)
                    .await
            }
        }
    }

    /// Answers a multi-question wizard batch (`answers: Vec<QuestionAnswerSelection>`).
    pub async fn answer_questions_batch(
        &self,
        surface_id: &str,
        agent_kind: &str,
        selections: &[QuestionAnswerSelection],
    ) -> Result<(), CmuxBridgeError> {
        if selections.is_empty() {
            return Ok(());
        }
        if selections.len() == 1 {
            let s = &selections[0];
            return self
                .answer_question(
                    surface_id,
                    agent_kind,
                    &s.indices,
                    s.other.as_deref(),
                    s.option_count,
                    s.multi_select,
                )
                .await;
        }

        let initial_screen = self.capture_pane(Some(surface_id), 45, false).await.ok();
        if let Some(kind) = initial_screen.as_deref().and_then(startup_dialog::detect) {
            return Err(CmuxBridgeError::StartupDialog(kind.label()));
        }

        if let Some(selector_steps) = plan_batch_question_steps_for_selector(agent_kind, selections)
        {
            return self
                .execute_question_steps(surface_id, agent_kind, selector_steps)
                .await;
        }

        for (idx, sel) in selections.iter().enumerate() {
            if idx > 0 {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            self.answer_question(
                surface_id,
                agent_kind,
                &sel.indices,
                sel.other.as_deref(),
                sel.option_count,
                sel.multi_select,
            )
            .await?;
        }
        Ok(())
    }

    /// Refuses when the surface screen shows an agent startup dialog.
    pub async fn ensure_no_startup_dialog(
        &self,
        surface_id: Option<&str>,
    ) -> Result<(), CmuxBridgeError> {
        match self.capture_pane(surface_id, 40, false).await {
            Ok(screen) => match startup_dialog::detect(&screen) {
                Some(kind) => Err(CmuxBridgeError::StartupDialog(kind.label())),
                None => Ok(()),
            },
            Err(_) => Ok(()),
        }
    }

    /// Creates a new terminal tab surface in the given workspace via `surface.create`.
    pub async fn new_surface(
        &self,
        workspace_id: Option<&str>,
        command: Option<&str>,
    ) -> Result<String, CmuxBridgeError> {
        self.new_surface_with_cwd(workspace_id, command, None).await
    }

    /// Like `new_surface`, starting in `cwd`.
    pub async fn new_surface_with_cwd(
        &self,
        workspace_id: Option<&str>,
        command: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<String, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "type": "terminal",
            "focus": true,
        });
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            params["working_directory"] = serde_json::json!(dir);
        }
        if let Some(ws) = workspace_id.filter(|w| !w.is_empty()) {
            params["workspace_id"] = serde_json::json!(ws);
        }
        if let Some(cmd) = command.filter(|c| !c.is_empty()) {
            params["initial_input"] = serde_json::json!(format!("{cmd}\r"));
        }
        self.rpc_call("surface.create", Some(params)).await
    }

    /// Renames an existing surface tab via `tab.action` (`action: "rename"`).
    pub async fn rename_tab(
        &self,
        surface_id: &str,
        title: &str,
    ) -> Result<String, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "surface_id": surface_id,
            "action": "rename",
            "title": title,
            "force": false,
            "focus": false,
        });
        if let Some(ws_id) = self.resolve_workspace_for_surface(surface_id).await {
            params["workspace_id"] = serde_json::json!(ws_id);
        }
        self.rpc_call("tab.action", Some(params)).await
    }

    /// Closes a surface via `surface.close`.
    pub async fn close_surface(
        &self,
        surface_id: &str,
        workspace_id: Option<&str>,
        force: bool,
    ) -> Result<String, CmuxBridgeError> {
        let resolved_ws = match workspace_id.filter(|w| !w.is_empty()) {
            Some(ws) => Some(ws.to_string()),
            None => self.resolve_workspace_for_surface(surface_id).await,
        };
        let mut params = serde_json::json!({
            "surface_id": surface_id,
            "force": force,
        });
        if let Some(ws) = resolved_ws.filter(|w| !w.is_empty()) {
            params["workspace_id"] = serde_json::json!(ws);
        }
        self.rpc_call("surface.close", Some(params)).await
    }

    /// Fetches the structured terminal `render_grid` snapshot via `mobile.terminal.replay`.
    pub async fn terminal_replay(
        &self,
        surface_id: &str,
        max_scrollback_rows: usize,
        viewport: Option<(u16, u16)>,
    ) -> Result<Value, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "surface_id": surface_id,
            "max_scrollback_rows": max_scrollback_rows,
        });
        if let Some((columns, rows)) = viewport {
            params["viewport"] = serde_json::json!({
                "columns": columns,
                "rows": rows,
            });
        }
        self.rpc("mobile.terminal.replay", params).await
    }

    /// Posts a native macOS desktop banner and cmux panel entry bound to `surface_id` via `notification.create`.
    pub async fn notify_desktop(
        &self,
        workspace_id: Option<&str>,
        surface_id: &str,
        title: &str,
        subtitle: Option<&str>,
        body: &str,
    ) -> Result<String, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "surface_id": surface_id,
            "title": title,
            "body": body,
            "effects": { "desktop": true },
        });
        if let Some(ws_id) = workspace_id.filter(|w| !w.is_empty()) {
            params["workspace_id"] = serde_json::json!(ws_id);
        }
        if let Some(sub) = subtitle.filter(|s| !s.trim().is_empty()) {
            params["subtitle"] = serde_json::json!(sub);
        }
        self.rpc_call("notification.create", Some(params)).await
    }

    /// Clears cmux notifications for `surface_id` via `notification.clear`.
    pub async fn clear_notifications(
        &self,
        workspace_id: Option<&str>,
        surface_id: &str,
    ) -> Result<String, CmuxBridgeError> {
        let mut params = serde_json::json!({
            "surface_id": surface_id,
        });
        let ws = match workspace_id.filter(|w| !w.is_empty()) {
            Some(w) => Some(w.to_string()),
            None => self.resolve_workspace_for_surface(surface_id).await,
        };
        if let Some(ws_id) = ws {
            params["workspace_id"] = serde_json::json!(ws_id);
        }
        self.rpc_call("notification.clear", Some(params)).await
    }

    /// Marks notifications read on `(workspace_id, surface_id)` via `notification.mark_read`.
    pub async fn mark_notifications_read(
        &self,
        workspace_id: &str,
        surface_id: &str,
    ) -> Result<Value, CmuxBridgeError> {
        self.rpc(
            "notification.mark_read",
            serde_json::json!({
                "tab_id": workspace_id,
                "surface_id": surface_id,
            }),
        )
        .await
    }

    /// Registers or updates the mobile participant viewport so cmux resizes the PTY.
    pub async fn terminal_set_viewport(
        &self,
        surface_id: &str,
        client_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<Value, CmuxBridgeError> {
        let vp_res = self
            .rpc(
                "mobile.terminal.viewport",
                serde_json::json!({
                    "surface_id": surface_id,
                    "client_id": client_id,
                    "columns": columns,
                    "rows": rows,
                    "counts": true,
                }),
            )
            .await?;

        let replay_res = self
            .rpc(
                "mobile.terminal.replay",
                serde_json::json!({
                    "surface_id": surface_id,
                    "viewport_columns": columns,
                    "viewport_rows": rows,
                    "client_id": client_id,
                }),
            )
            .await;

        match replay_res {
            Ok(val) => Ok(val),
            Err(CmuxBridgeError::CmuxError(msg)) if msg.contains("viewport_transition") => {
                Ok(vp_res)
            }
            Err(err) => Err(err),
        }
    }

    /// Clears the mobile participant viewport so cmux restores desktop dimensions.
    pub async fn terminal_clear_viewport(
        &self,
        surface_id: &str,
        client_id: &str,
    ) -> Result<Value, CmuxBridgeError> {
        self.rpc(
            "mobile.terminal.viewport",
            serde_json::json!({
                "surface_id": surface_id,
                "client_id": client_id,
                "clear": true,
            }),
        )
        .await
    }

    /// Sends raw VT/text input bytes directly to the terminal PTY.
    pub async fn terminal_input(
        &self,
        surface_id: &str,
        text: &str,
    ) -> Result<Value, CmuxBridgeError> {
        self.rpc(
            "mobile.terminal.input",
            serde_json::json!({
                "surface_id": surface_id,
                "text": text,
                "kind": "text",
            }),
        )
        .await
    }

    /// Pastes text into the terminal surface respecting bracketed paste on host.
    pub async fn terminal_paste(
        &self,
        surface_id: &str,
        text: &str,
    ) -> Result<Value, CmuxBridgeError> {
        self.rpc(
            "mobile.terminal.paste",
            serde_json::json!({
                "surface_id": surface_id,
                "text": text,
            }),
        )
        .await
    }

    /// Sends a mouse/scroll delta to the terminal surface.
    pub async fn terminal_scroll(
        &self,
        surface_id: &str,
        delta_lines: i32,
        col: u16,
        row: u16,
    ) -> Result<Value, CmuxBridgeError> {
        self.rpc(
            "mobile.terminal.scroll",
            serde_json::json!({
                "surface_id": surface_id,
                "delta_lines": delta_lines,
                "col": col,
                "row": row,
            }),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::dialog::plan_question_answer_steps;
    use std::path::Path;

    #[test]
    fn test_bridge_creation() {
        let bridge = DualTransportCmuxBridge::with_socket_path("/tmp/custom-cmux.sock");
        assert_eq!(
            bridge.uds_pool.explicit_socket_path(),
            Some(Path::new("/tmp/custom-cmux.sock"))
        );
    }

    #[tokio::test]
    async fn test_bridge_nonexistent_socket_reports_false_ping() {
        let bridge = DualTransportCmuxBridge::with_socket_path("/tmp/nonexistent-cmux-test.sock");
        assert!(!bridge.ping().await);
    }

    #[test]
    fn plan_question_answer_steps_navigates_antigravity_tui_menu() {
        let screen = "\
1. Không lo bị trói chết khi cần khoá cứng version 3rd-party
2. Giữ gọn repo

? Quyết định 8 — Xử lý nhóm tool mỏng / wrapper:

Question
──────────────────────────────────────────────────────────────────────

Question 1/1: Quyết định 8 — Xử lý nhóm tool mỏng / wrapper:

> 1. (Recommended) Gom luôn vào gear-config
  2. Gom slack-mcp và aistudioproxy, tách riêng md2pdf
  3. Giữ tất cả làm các repo Git riêng biệt hết
  4. Write-in...

  ↑/↓ Navigate · enter Select · esc Skip · ctrl+r Review
esc to cancel
";

        assert_eq!(
            plan_question_answer_steps(Some(screen), "agy", &[0], None, 3, false),
            QuestionAnswerPlan::TuiSteps(vec![QuestionStep::Key("enter")])
        );

        assert_eq!(
            plan_question_answer_steps(Some(screen), "agy", &[2], None, 3, false),
            QuestionAnswerPlan::TuiSteps(vec![
                QuestionStep::Key("down"),
                QuestionStep::Key("down"),
                QuestionStep::Key("enter"),
            ])
        );

        assert_eq!(
            plan_question_answer_steps(
                Some(screen),
                "antigravity",
                &[],
                Some("Tách riêng slack-mcp"),
                3,
                false,
            ),
            QuestionAnswerPlan::TuiSteps(vec![
                QuestionStep::Key("down"),
                QuestionStep::Key("down"),
                QuestionStep::Key("down"),
                QuestionStep::Key("enter"),
                QuestionStep::Paste("Tách riêng slack-mcp".to_string()),
                QuestionStep::Key("enter"),
            ])
        );
    }
}
