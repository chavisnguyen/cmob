# cmux Socket & CLI API Specification

This document provides a verified, evidence-based technical reference for the `cmux` Unix domain socket and CLI interface, reverse-engineered and cited directly from `ref/cmux` and `ref/cmux-pocket`.

---

## 1. Socket Location & Transport

- **Socket Path Resolution Hierarchy:**
  * Explicit override: Configured via environment variable `CMUX_SOCKET_PATH` (passed to sidecars, `ref/cmux/agent-chat/README.md:19-20`).
  * Discovery resolver (`ref/cmux/CLI/CLISocketPathResolver.swift:134-142, 222-227, 401-405`):
    * Primary per-user socket: `/tmp/cmux-<uid>.sock` or `$TMPDIR/cmux-<uid>.sock`.
    * Legacy default: `/tmp/cmux.sock` (`legacyDefaultSocketPath`).
    * Channel-specific sockets: `/tmp/cmux-debug.sock` (`fallbackSocketPath`), `/tmp/cmux-nightly.sock`, `/tmp/cmux-rc.sock`, `/tmp/cmux-staging.sock`.
    * Liveness verification: Before returning any socket path, the resolver performs a non-blocking connection check (`socketAcceptsConnections(path)`). Stale or dangling socket files are rejected.
  * In `cmux-pocket`, `LiveCmuxBackend` defaults to invoking the `cmux` binary directly on PATH (`ref/cmux-pocket/crates/cmux-pocket-cmux/src/live.rs:66`), allowing `cmux`'s Swift CLI to run its native socket discovery automatically.
- **IPC Mechanism:** Unix Domain Socket (UDS) accepting framed JSON or line-delimited commands, alongside the native Swift CLI binary (`cmux`).

---

## 2. Core CLI & Socket Commands

### 2.1 Liveness & Workspace Introspection
* **`cmux ping`**
  * Verifies socket accessibility and daemon health.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:11-13`
* **`cmux tree --all --json`**
  * Dumps the full workspace and surface tree in JSON format.
  * Outputs workspaces, surface UUIDs, terminal titles, active focus, and split geometries.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:16-22`, `ref/cmux-pocket/crates/cmux-pocket-cmux/src/tree_parser.rs:1-120`
* **`cmux capabilities --json`**
  * Returns supported host and CLI capabilities (e.g., viewport resizing, clipboard paste flags, dialog guards).
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:209-211`

### 2.2 Workspace Lifecycle
* **`cmux new-workspace [--name <name>]`**
  * Spawns a new workspace tab.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:25-35`
* **`cmux rename-workspace --workspace <id|ref|index> <title>`**
  * Renames an existing workspace.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:38-45`
* **`cmux close-workspace --workspace <id|ref|index>`**
  * Closes and terminates a workspace.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:48-54`
* **`cmux select-workspace --workspace <id|ref|index>`**
  * Sets the active workspace on desktop.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:68-73`

### 2.3 Surface & Terminal Control
* **`cmux new-surface --workspace <id|ref|index> --type <type> --focus <true|false>`**
  * Creates a new surface (e.g. `type: "terminal"` or `type: "browser"`).
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:76-86`
* **`cmux rename-tab --surface <surface_id> <title>`**
  * Renames a surface tab.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:57-64`
* **`cmux close-surface --surface <surface_id> [--workspace <id>]`**
  * Terminates the specified surface.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:89-100`
* **`cmux read-screen --surface <surface_id>`**
  * Reads the current screen text buffer of a surface.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:244-250`

### 2.4 Notification & Attention Commands
* **`cmux list-notifications`**
  * Lists active notifications queued in the daemon.
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:253-255`, `ref/cmux/CLI/CMUXCLI+TaskHelp.swift:329`.
* **`cmux notify [--title <text>] [--subtitle <text>] [--body <text>] [--reply] [--desktop <true|false>] [--clear]`**
  * Dispatches an explicit user/agent notification.
  * *Evidence:* `ref/cmux/CLI/CMUXCLI+TaskHelp.swift:328`, `ref/cmux/CLI/Commands/NotificationCommands.swift:4-15`, `ref/cmux/CLI/cmux.swift:6920, 9446-9447`.
* **Management commands:** `dismiss-notification (--id <uuid> | --all-read)`, `mark-notification-read`, `open-notification`, `clear-notifications`.
  * *Evidence:* `ref/cmux/CLI/CMUXCLI+TaskHelp.swift:330-335`, `ref/cmux/CLI/Commands/NotificationCommands.swift:17-45`.
* **Attention V1 Socket Commands:**
  * Raise approval prompt: `notify_target_async <workspaceUUID> <surfaceUUID> <displayName>|<subtitle>|<body>|<meta>`
  * Dismiss approval prompt: `clear_notifications --tab=<workspaceUUID> --panel=<surfaceUUID>`
  * *Evidence:* `ref/cmux/CLI/FeedEventClassifier.swift:455-517`. Delimited fields sanitize `|` into broken pipe `¦` (`\u{00A6}`), and body names strictly the tool without inputs.

---

## 3. Terminal Input & Key Injection

* **Literal Input (`cmux send`):**
  * Usage: `cmux send --surface <surface_id> [--force] [--paste] -- <text>`
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:143-157`
  * Flags:
    * `--paste`: Submits text via bracketed paste (available since cmux >= 0.65.0).
    * `--force`: Bypasses agent draft and open modal dialogs (available since cmux >= 0.65.0).
    * `--`: Prevents text beginning with `-` from being parsed as CLI options.
* **Control Keys (`cmux send-key`):**
  * Usage: `cmux send-key --surface <surface_id> [--force] <key>`
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:113-141`
  * Key mapping table:
    * `\u{001b}` -> `escape`
    * `\t` -> `tab`
    * `\u{001b}[A` -> `up`
    * `\u{001b}[B` -> `down`
    * `\u{001b}[C` -> `right`
    * `\u{001b}[D` -> `left`
    * `\u{0003}` -> `ctrl-c`
    * `\u{0004}` -> `ctrl-d`
    * `\u{007f}` / `\u{0008}` -> `backspace`
    * `\n` / `\r` -> `enter`

---

## 4. Native Socket RPC Methods

cmux exposes an internal RPC dispatch subsystem via `cmux rpc <method> <json_payload>`:

### 4.1 Viewport & Terminal Replay
* **`terminal.replay`**
  * Replays terminal screen rows up to `max_scrollback_rows`.
  * Payload:
    ```json
    {
      "surface_id": "<uuid>",
      "anchor": "screen",
      "max_scrollback_rows": 100
    }
    ```
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:214-225`
* **`mobile.terminal.replay`**
  * Generates an authoritative viewport frame with attached non-sticky dimensions (TTL ~5 seconds).
  * Payload:
    ```json
    {
      "surface_id": "<uuid>",
      "anchor": "viewport",
      "max_scrollback_rows": 0,
      "client_id": "<client_uuid>",
      "viewport_columns": 80,
      "viewport_rows": 24,
      "viewport_generation": 1
    }
    ```
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:166-187`
* **`mobile.terminal.viewport`**
  * Clears client viewport overrides when phone disconnects.
  * Payload:
    ```json
    {
      "surface_id": "<uuid>",
      "client_id": "<client_uuid>",
      "clear": true,
      "viewport_generation": 1
    }
    ```
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:194-206`
* **`mobile.terminal.scroll`**
  * Scrolls the surface terminal buffer.
  * Payload:
    ```json
    {
      "surface_id": "<uuid>",
      "delta_lines": -3.0,
      "col": 0,
      "row": 0,
      "max_scrollback_rows": 1
    }
    ```
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:228-241`

### 4.2 Agent Chat RPC Controls
* **`mobile.chat.send`**
  * Injects bracketed-paste prompt into the agent running in the specified surface.
  * *Evidence:* `ref/cmux/agent-chat/README.md:19-20`
* **`mobile.chat.interrupt`**
  * Sends an interrupt signal (Stop / Esc) to the running agent.
  * *Evidence:* `ref/cmux/agent-chat/README.md:19-20`

---

## 5. Event Streaming

* **Command:** `cmux events --category agent --category notification --reconnect --no-heartbeat`
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:258-268`, `ref/cmux-pocket/crates/cmux-pocket-cmux/src/events.rs:33-57`
* Streams newline-delimited JSON objects over stdout.
* Categories:
  * `agent`: Hook events, state transitions, subagent completions.
  * `notification`: Unread badge changes, notification requests.

---

## 6. Verified Gateway Bridge (`repos/cmux-gateway/src/cmux/bridge.rs`)

* **Tab Management (No Split):**
  * `new_surface` (`bridge.rs:267-283`): invokes `cmux new-surface --type terminal --focus true [--workspace <ws>]` and optionally injects initial `command` via `send_text`.
  * `rename_tab` (`bridge.rs:285-306`): invokes `cmux rename-tab --surface <surface_id> --title <title>`.
  * `close_surface`: invokes `cmux close-surface --surface <surface_id> [--force]`.
* **Live Terminal Grid & PTY Viewport (`bridge.rs:308-423`):**
  * `terminal_replay` (`bridge.rs:308-326`): invokes `cmux rpc mobile.terminal.replay` returning `cmux.render-grid.v1` (`columns`, `rows`, `size_state`, `render_grid`), optionally passing `viewport: { columns, rows }`.
  * `terminal_set_viewport` (`bridge.rs:328-366`): invokes `cmux rpc mobile.terminal.viewport` with `columns`, `rows`, `counts: true`, then settles/primes `mobile.terminal.replay` with `viewport_columns`/`viewport_rows`.
  * `terminal_clear_viewport` (`bridge.rs:368-383`): invokes `cmux rpc mobile.terminal.viewport` with `clear: true` to restore Mac desktop pane dimensions.
  * `terminal_input` (`bridge.rs:385-396`): invokes `cmux rpc mobile.terminal.input` with raw VT bytes (`text`).
  * `terminal_paste` (`bridge.rs:398-408`): invokes `cmux rpc mobile.terminal.paste` with clipboard `text`.
  * `terminal_scroll` (`bridge.rs:410-423`): invokes `cmux rpc mobile.terminal.scroll` with `delta_lines`, `col`, `row`.

### Antigravity subagent sessions in the hook store (verified 2026-11-14)
`~/.cmuxterm/antigravity-hook-sessions.json` stores subagent conversations as separate sessions on the **same surfaceId** (and same live pid) as their parent, usually with a newer `updatedAt`. Distinguishing signal, read from the first line of `transcriptPath`:
- top-level conversation: `{"source":"USER_EXPLICIT","type":"USER_INPUT",...}`
- subagent: `{"source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"...sender=<parent-uuid> priority=..."}`
Live sample: 62/95 sessions were subagents; 55 had their parent in the store. Example: surface "Pull All Source Code" -> sub `f4838892…` (1 turn, no user input) vs parent `56296f97…` (92 turns).
Gateway (`scanner/hook_store.rs` `parse_subagent_parent`, `get_active_session_for_surface`) now walks subagent -> parent for chat/tree, and the push dispatcher skips subagent sessions.

### Codex subagent rollouts in the hook store (verified 2026-11-14)
`~/.cmuxterm/codex-hook-sessions.json`: a record keeps `sessionId` = the user's conversation (e.g. `01a1d910-...`) but `transcriptPath` is overwritten by whichever thread fired the latest hook, including subagents (e.g. `rollout-...-01a1d922-7cdb-...jsonl`, nickname "Cicero"). The subagent rollout's first line is `session_meta` with `payload.thread_source = "subagent"`, `payload.parent_thread_id` (also `payload.source.subagent.thread_spawn.parent_thread_id`); the top-level rollout has `source: "cli"`. Rollouts live in `~/.codex/sessions/<Y>/<M>/<D>/rollout-<timestamp>-<thread id>.jsonl`.
Gateway (`scanner/hook_store.rs` `resolve_codex_top_level_rollout`, applied in `load_file` for codex): follows `parent_thread_id` (max 4 hops) to the top-level rollout. Result on the live store: Project C and project-b Codex surfaces show the user's prompt as first turn instead of the subagent task.
