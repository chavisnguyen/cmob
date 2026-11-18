use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use crate::cmux::agent_profile::{profile_for, split_legacy_submit, ApproveInput};
use crate::cmux::startup_dialog;

pub const DEFAULT_RPC_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, thiserror::Error)]
pub enum CmuxBridgeError {
    /// The agent is showing a startup dialog that owns Enter; typing into it could accept it.
    #[error("The agent is waiting on a startup dialog ({0}). Open the Terminal tab and answer it first.")]
    StartupDialog(&'static str),
    #[error("cmux CLI execution failed: {0}")]
    CliExecutionFailed(String),

    #[error("cmux operation timed out after {0}s")]
    Timeout(u64),

    #[error("cmux returned error: {0}")]
    CmuxError(String),

    #[error("Failed to parse cmux output as JSON: {0}")]
    JsonParseError(String),
}

/// Dual-Transport Bridge for macOS cmux.
/// Primary Transport: Blessed CLI subprocess (`cmux rpc`, `cmux send-key`, `cmux ping`).
/// Solves SocketControlMode.cmuxOnly (ref/cmux/Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/SocketControlMode.swift:9-21)
#[derive(Debug, Clone)]
pub struct DualTransportCmuxBridge {
    cli_path: String,
    timeout_duration: Duration,
}

impl Default for DualTransportCmuxBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl DualTransportCmuxBridge {
    pub fn new() -> Self {
        let cli = std::env::var("CMUX_BUNDLED_CLI_PATH")
            .unwrap_or_else(|_| "cmux".to_string());
        Self {
            cli_path: cli,
            timeout_duration: Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECS),
        }
    }

    pub fn with_cli_path(cli_path: impl Into<String>) -> Self {
        Self {
            cli_path: cli_path.into(),
            timeout_duration: Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECS),
        }
    }

    /// Pings cmux to verify daemon health.
    pub async fn ping(&self) -> bool {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg("ping")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        match timeout(self.timeout_duration, cmd.output()).await {
            Ok(Ok(output)) => output.status.success(),
            _ => false,
        }
    }

    /// Runs an arbitrary cmux CLI subcommand with arguments, returning stdout.
    pub async fn run_command(&self, subcmd: &str, args: &[&str]) -> Result<String, CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg(subcmd);
        cmd.args(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            let msg = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("cmux {subcmd} failed with exit code {:?}", output.status.code())
            };
            return Err(CmuxBridgeError::CmuxError(msg));
        }

        Ok(stdout)
    }

    /// Dispatches a raw JSON-RPC call returning the raw string response.
    pub async fn rpc_call(&self, method: &str, params: Option<Value>) -> Result<String, CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.args(["rpc", method]);
        if let Some(p) = params {
            let p_str = serde_json::to_string(&p)
                .map_err(|e| CmuxBridgeError::JsonParseError(e.to_string()))?;
            cmd.arg(p_str);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            let msg = if !stderr.is_empty() { stderr } else { stdout };
            return Err(CmuxBridgeError::CmuxError(msg));
        }

        Ok(stdout)
    }

    /// Dispatches a JSON-RPC method call through `cmux rpc <method> '<params_json>'`.
    /// Modeled after ref/cmux/agent-chat/cmux-rpc.ts:9-38.
    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value, CmuxBridgeError> {
        let params_str = serde_json::to_string(&params)
            .map_err(|e| CmuxBridgeError::JsonParseError(e.to_string()))?;

        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.args(["rpc", method, &params_str])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            let msg = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("cmux rpc failed with exit code {:?}", output.status.code())
            };
            return Err(CmuxBridgeError::CmuxError(msg));
        }

        if stdout.is_empty() {
            return Ok(Value::Null);
        }

        serde_json::from_str(&stdout).or(Ok(Value::String(stdout)))
    }

    /// Sends a keystroke or control key to a surface tab via `cmux send-key [--surface=<id>] [--force] <key>`.
    pub async fn send_key(&self, surface_id: Option<&str>, key: &str) -> Result<(), CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg("send-key");

        if let Some(surf) = surface_id {
            cmd.arg(format!("--surface={surf}"));
        }
        cmd.arg("--force");
        cmd.arg(key);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(CmuxBridgeError::CmuxError(stderr));
        }

        Ok(())
    }

    /// Sends text input to a surface tab via `cmux send [--surface=<id>] [--force] -- <text>`.
    pub async fn send_text(&self, surface_id: Option<&str>, text: &str) -> Result<(), CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg("send");

        if let Some(surf) = surface_id {
            cmd.arg(format!("--surface={surf}"));
        }
        cmd.arg("--force");
        cmd.arg("--");
        cmd.arg(text);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(CmuxBridgeError::CmuxError(stderr));
        }

        Ok(())
    }

    /// Captures terminal screen buffer via `cmux capture-pane [--surface=<id>] [--scrollback] [--lines <n>]`.
    pub async fn capture_pane(
        &self,
        surface_id: Option<&str>,
        lines: usize,
        scrollback: bool,
    ) -> Result<String, CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg("capture-pane");

        if let Some(surf) = surface_id {
            cmd.arg(format!("--surface={surf}"));
        }
        if scrollback {
            cmd.arg("--scrollback");
        }
        cmd.arg("--lines");
        cmd.arg(lines.to_string());
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            let msg = if !stderr.is_empty() { stderr } else { stdout };
            return Err(CmuxBridgeError::CmuxError(msg));
        }

        Ok(stdout)
    }

    /// Interrupts active agent execution via SIGINT (Ctrl+C).
    /// Source: architecture.md:109-113.
    pub async fn interrupt(&self, surface_id: &str) -> Result<(), CmuxBridgeError> {
        self.send_key(Some(surface_id), "ctrl+c").await
    }

    /// Sends one-tap approval to a pending permission request, as defined by the agent's profile
    /// (`agent_profile::profile_for`; Claude/Codex "1", others Enter. Source: architecture.md:101-108).
    pub async fn approve(&self, surface_id: &str, agent_kind: &str) -> Result<(), CmuxBridgeError> {
        // An approval keystroke on a startup dialog (e.g. folder trust) would silently grant trust.
        // Unlike prompt submission, fail closed here: if the screen cannot be read, do not press anything.
        let screen = self.capture_pane(Some(surface_id), 40, false).await?;
        if let Some(kind) = startup_dialog::detect(&screen) {
            return Err(CmuxBridgeError::StartupDialog(kind.label()));
        }
        match profile_for(agent_kind).approve {
            ApproveInput::Text(t) => self.send_text(Some(surface_id), t).await,
            ApproveInput::Key(k) => self.send_key(Some(surface_id), k).await,
        }
    }

    /// Pastes `text` into the surface, waits for the agent TUI to ingest it, then presses Enter as a
    /// separate key. Multi-line text is pasted (typing it would press Enter on every newline).
    /// A trailing `\r`/`\n` from older clients means "submit". See `agent_profile` for why.
    pub async fn submit_prompt(
        &self,
        surface_id: Option<&str>,
        text: &str,
        agent_kind: &str,
        enter: bool,
    ) -> Result<(), CmuxBridgeError> {
        let (body, legacy_submit) = split_legacy_submit(text);
        let profile = profile_for(agent_kind);
        // Never type or press Enter into a startup dialog (see startup_dialog.rs).
        self.ensure_no_startup_dialog(surface_id).await?;
        if !body.is_empty() {
            self.paste_text(surface_id, body).await?;
        }
        if enter || legacy_submit {
            if !body.is_empty() {
                tokio::time::sleep(profile.submit_delay(body)).await;
            }
            // A dialog can also appear while the paste settles.
            self.ensure_no_startup_dialog(surface_id).await?;
            self.send_key(surface_id, "enter").await?;
        }
        Ok(())
    }

    /// The startup dialog on the surface screen, if any (see `startup_dialog`).
    pub async fn current_dialog(&self, surface_id: Option<&str>) -> Option<startup_dialog::DialogInfo> {
        let screen = self.capture_pane(surface_id, 40, false).await.ok()?;
        startup_dialog::analyze(&screen)
    }

    /// Answers the dialog on screen with its `choice`-th option. The screen is re-read right before the
    /// keys go out and the answer is refused unless it is still the dialog the user saw (`fingerprint`),
    /// since the keys are aimed from that screen (Orca `requireStartupDialog`).
    pub async fn answer_dialog(
        &self,
        surface_id: &str,
        fingerprint: &str,
        choice: usize,
    ) -> Result<String, CmuxBridgeError> {
        let dialog = self
            .current_dialog(Some(surface_id))
            .await
            .ok_or_else(|| CmuxBridgeError::CmuxError("There is no startup dialog on this terminal any more.".into()))?;
        if dialog.fingerprint != fingerprint {
            return Err(CmuxBridgeError::CmuxError("The dialog changed. Review it again before answering.".into()));
        }
        let picked = dialog
            .choices
            .get(choice)
            .ok_or_else(|| CmuxBridgeError::CmuxError("This dialog can only be answered in the Terminal tab.".into()))?;
        for key in &picked.keys {
            self.send_key(Some(surface_id), key).await?;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Ok(picked.label.clone())
    }

    /// Refuses when the surface screen shows an agent startup dialog. If the screen cannot be read the
    /// send proceeds (cmux itself is the source of truth for everything else).
    pub async fn ensure_no_startup_dialog(&self, surface_id: Option<&str>) -> Result<(), CmuxBridgeError> {
        match self.capture_pane(surface_id, 40, false).await {
            Ok(screen) => match startup_dialog::detect(&screen) {
                Some(kind) => Err(CmuxBridgeError::StartupDialog(kind.label())),
                None => Ok(()),
            },
            Err(_) => Ok(()),
        }
    }

    /// `cmux send --paste --force -- <text>`: goes through the paste path (bracketed paste, newlines kept).
    pub async fn paste_text(&self, surface_id: Option<&str>, text: &str) -> Result<(), CmuxBridgeError> {
        let mut cmd = Command::new(&self.cli_path);
        cmd.kill_on_drop(true);
        cmd.arg("send").arg("--paste");
        if let Some(surf) = surface_id {
            cmd.arg(format!("--surface={surf}"));
        }
        cmd.arg("--force").arg("--").arg(text);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let output = timeout(self.timeout_duration, cmd.output())
            .await
            .map_err(|_| CmuxBridgeError::Timeout(DEFAULT_RPC_TIMEOUT_SECS))?
            .map_err(|e| CmuxBridgeError::CliExecutionFailed(e.to_string()))?;
        if !output.status.success() {
            return Err(CmuxBridgeError::CmuxError(String::from_utf8_lossy(&output.stderr).trim().to_string()));
        }
        Ok(())
    }

    /// Creates a new terminal tab surface in the given workspace.
    pub async fn new_surface(
        &self,
        workspace_id: Option<&str>,
        command: Option<&str>,
    ) -> Result<String, CmuxBridgeError> {
        self.new_surface_with_cwd(workspace_id, command, None).await
    }

    /// Like `new_surface`, starting in `cwd` (`cmux new-surface --working-directory`, from `cmux new-surface --help`).
    pub async fn new_surface_with_cwd(
        &self,
        workspace_id: Option<&str>,
        command: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<String, CmuxBridgeError> {
        let mut args: Vec<&str> = vec!["new-surface", "--type", "terminal", "--focus", "true"];
        if let Some(dir) = cwd {
            args.push("--working-directory");
            args.push(dir);
        }
        if let Some(ws) = workspace_id {
            args.push("--workspace");
            args.push(ws);
        }
        if let Some(cmd) = command {
            args.push("--command");
            args.push(cmd);
        }
        self.run_command(args[0], &args[1..]).await
    }

    /// Renames an existing surface tab.
    pub async fn rename_tab(
        &self,
        surface_id: &str,
        title: &str,
    ) -> Result<String, CmuxBridgeError> {
        self.run_command("rename-tab", &["--surface", surface_id, "--title", title])
            .await
    }

    /// Closes a surface.
    pub async fn close_surface(
        &self,
        surface_id: &str,
        workspace_id: Option<&str>,
        force: bool,
    ) -> Result<String, CmuxBridgeError> {
        // cmux refuses an explicit --surface without --workspace or --window.
        let mut args: Vec<&str> = vec!["close-surface", "--surface", surface_id];
        if let Some(ws) = workspace_id {
            args.push("--workspace");
            args.push(ws);
        }
        if force {
            args.push("--force");
        }
        self.run_command(args[0], &args[1..]).await
    }

    /// Fetches the structured terminal render_grid snapshot via `mobile.terminal.replay`.
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

    /// Posts a native macOS desktop banner and cmux panel entry bound to `surface_id`.
    pub async fn notify_desktop(
        &self,
        surface_id: &str,
        title: &str,
        subtitle: Option<&str>,
        body: &str,
    ) -> Result<String, CmuxBridgeError> {
        let mut args: Vec<&str> = vec![
            "notify",
            "--surface",
            surface_id,
            "--title",
            title,
            "--body",
            body,
            "--desktop",
            "true",
        ];
        if let Some(sub) = subtitle.filter(|s| !s.trim().is_empty()) {
            args.push("--subtitle");
            args.push(sub);
        }
        self.run_command(args[0], &args[1..]).await
    }

    /// Clears cmux notifications for `surface_id` once the user or agent moves on.
    pub async fn clear_notifications(&self, surface_id: &str) -> Result<String, CmuxBridgeError> {
        self.run_command("notify", &["--surface", surface_id, "--clear"]).await
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
            Err(CmuxBridgeError::CmuxError(msg)) if msg.contains("viewport_transition") => Ok(vp_res),
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
    pub async fn terminal_input(&self, surface_id: &str, text: &str) -> Result<Value, CmuxBridgeError> {
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
    pub async fn terminal_paste(&self, surface_id: &str, text: &str) -> Result<Value, CmuxBridgeError> {
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

    #[test]
    fn test_bridge_creation() {
        let bridge = DualTransportCmuxBridge::with_cli_path("/custom/path/cmux");
        assert_eq!(bridge.cli_path, "/custom/path/cmux");
    }

    #[tokio::test]
    async fn test_bridge_timeout_handling() {
        // Points to /usr/bin/false or nonexistent command
        let bridge = DualTransportCmuxBridge::with_cli_path("nonexistent_cmux_binary_test");
        assert!(!bridge.ping().await);
    }
}
