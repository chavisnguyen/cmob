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

    /// Answers an active interactive TUI question menu (`ask_question` / `AskUserQuestion`) on screen.
    ///
    /// Navigates from the currently highlighted `>`/`›`/`❯` numbered row to the selected option (or the
    /// trailing `Write-in...` / `Type something` row for free-text `other` replies) using real terminal
    /// keys, falling back to `submit_prompt` when no numbered picker is visible on screen.
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
        let steps = plan_question_answer_steps(
            screen.as_deref(),
            agent_kind,
            indices,
            other,
            option_count,
            multi_select,
        );
        match steps {
            QuestionAnswerPlan::TuiSteps(actions) => {
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
            QuestionAnswerPlan::PromptFallback(text) => {
                self.submit_prompt(Some(surface_id), &text, agent_kind, true)
                    .await
            }
        }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QuestionStep {
    Key(&'static str),
    Text(String),
    Paste(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QuestionAnswerPlan {
    TuiSteps(Vec<QuestionStep>),
    PromptFallback(String),
}

struct ParsedMenu {
    row_count: usize,
    cursor_index: usize,
    write_in_index: Option<usize>,
}

/// Detect numbered question menu rows (`> 1. Option A`, `  2. Option B`, `  4. Write-in...`)
/// near the bottom of a terminal screen capture.
fn detect_numbered_question_menu(screen: &str) -> Option<ParsedMenu> {
    let lines: Vec<&str> = screen.lines().collect();
    let start = lines.len().saturating_sub(36);
    let tail = &lines[start..];

    // Anchor after the last horizontal rule or `Question` header if present so earlier prose
    // numbered lists (`1. **brew services**...`) are never mistaken for the picker!
    let anchor = tail
        .iter()
        .rposition(|l| {
            let t = l.trim();
            t.starts_with("Question ")
                || (t.chars().count() >= 12 && t.chars().all(|c| matches!(c, '─' | '━' | '-')))
        })
        .unwrap_or(0);

    let mut rows: Vec<(usize, bool, String)> = Vec::new();
    for line in &tail[anchor..] {
        let t = line.trim();
        let (has_cursor, rest) = match t.chars().next() {
            Some('>' | '\u{203a}' | '\u{276f}') => {
                let c = t.chars().next().unwrap();
                (true, t[c.len_utf8()..].trim_start())
            }
            _ => (false, t),
        };
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || digits > 2 {
            continue;
        }
        let Ok(num) = rest[..digits].parse::<usize>() else {
            continue;
        };
        let Some(label) = rest[digits..].strip_prefix('.').map(str::trim) else {
            continue;
        };
        if label.is_empty() || num == 0 {
            continue;
        }
        // Sequential 1-based menu items
        if num == rows.len() + 1 {
            rows.push((num - 1, has_cursor, label.to_lowercase()));
        } else if num == 1 {
            // Restart if a fresh `1.` block began lower down
            rows.clear();
            rows.push((0, has_cursor, label.to_lowercase()));
        }
    }

    if rows.len() < 2 {
        return None;
    }

    let cursor_index = rows.iter().find(|r| r.1).map(|r| r.0).unwrap_or(0);
    let write_in_index = rows
        .iter()
        .find(|r| {
            r.2.starts_with("write-in")
                || r.2.starts_with("type something")
                || r.2.starts_with("other")
        })
        .map(|r| r.0);

    Some(ParsedMenu {
        row_count: rows.len(),
        cursor_index,
        write_in_index,
    })
}

fn push_cursor_moves(steps: &mut Vec<QuestionStep>, from: usize, to: usize) {
    if to > from {
        for _ in 0..(to - from) {
            steps.push(QuestionStep::Key("down"));
        }
    } else if from > to {
        for _ in 0..(from - to) {
            steps.push(QuestionStep::Key("up"));
        }
    }
}

pub(crate) fn plan_question_answer_steps(
    screen: Option<&str>,
    agent_kind: &str,
    indices: &[usize],
    other: Option<&str>,
    option_count: usize,
    multi_select: bool,
) -> QuestionAnswerPlan {
    let other_clean = other.map(str::trim).filter(|s| !s.is_empty());
    let kind = crate::cmux::agents::spec_for(agent_kind)
        .map(|s| s.kind)
        .unwrap_or(agent_kind);

    if let Some(menu) = screen.and_then(detect_numbered_question_menu) {
        let mut steps = Vec::new();
        let mut cur = menu.cursor_index;

        if multi_select {
            if kind == "claude" {
                for &idx in indices {
                    steps.push(QuestionStep::Text((idx + 1).to_string()));
                }
                if let Some(text) = other_clean {
                    let write_row = menu.write_in_index.unwrap_or(option_count) + 1;
                    steps.push(QuestionStep::Text(write_row.to_string()));
                    steps.push(QuestionStep::Paste(text.to_string()));
                    steps.push(QuestionStep::Key("enter"));
                }
                steps.push(QuestionStep::Key("right"));
                steps.push(QuestionStep::Key("enter"));
                return QuestionAnswerPlan::TuiSteps(steps);
            }
            for &idx in indices {
                if idx < menu.row_count {
                    push_cursor_moves(&mut steps, cur, idx);
                    cur = idx;
                    steps.push(QuestionStep::Key("space"));
                }
            }
            if let Some(text) = other_clean {
                let target = menu
                    .write_in_index
                    .unwrap_or_else(|| option_count.min(menu.row_count.saturating_sub(1)));
                push_cursor_moves(&mut steps, cur, target);
                steps.push(QuestionStep::Key("enter"));
                steps.push(QuestionStep::Paste(text.to_string()));
                steps.push(QuestionStep::Key("enter"));
                return QuestionAnswerPlan::TuiSteps(steps);
            }
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }

        // Single-select with custom `other` / `Write-in...` text
        if let Some(text) = other_clean {
            let target = menu
                .write_in_index
                .unwrap_or_else(|| option_count.min(menu.row_count.saturating_sub(1)));
            push_cursor_moves(&mut steps, cur, target);
            if kind == "codex" {
                steps.push(QuestionStep::Key("tab"));
            } else {
                steps.push(QuestionStep::Key("enter"));
            }
            steps.push(QuestionStep::Paste(text.to_string()));
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }

        // Single-select option pick
        if let Some(&target) = indices.first()
            && target < menu.row_count
        {
            push_cursor_moves(&mut steps, cur, target);
            steps.push(QuestionStep::Key("enter"));
            return QuestionAnswerPlan::TuiSteps(steps);
        }
    }

    // Fallback when no TUI menu is active on screen (e.g. non-TUI question or free-text prompt)
    let fallback = if let Some(text) = other_clean {
        text.to_string()
    } else if let Some(&idx) = indices.first() {
        (idx + 1).to_string()
    } else {
        String::new()
    };
    QuestionAnswerPlan::PromptFallback(fallback)
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

        // Picking option 0 (already highlighted at `> 1.`) presses Enter immediately.
        assert_eq!(
            plan_question_answer_steps(Some(screen), "agy", &[0], None, 3, false),
            QuestionAnswerPlan::TuiSteps(vec![QuestionStep::Key("enter")])
        );

        // Picking option 2 (`3. Giữ tất cả...`) moves down twice and presses Enter.
        assert_eq!(
            plan_question_answer_steps(Some(screen), "agy", &[2], None, 3, false),
            QuestionAnswerPlan::TuiSteps(vec![
                QuestionStep::Key("down"),
                QuestionStep::Key("down"),
                QuestionStep::Key("enter"),
            ])
        );

        // Submitting custom `Write-in...` text moves down 3 rows to `4. Write-in...`, opens it, pastes, and confirms.
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
