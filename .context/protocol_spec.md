# WebSocket & RPC Protocol Specification

This document defines the wire protocol for **cmux-mobile**, combining the battle-tested differential grid streaming of `cmux-pocket` with Orca-inspired structured agent chat methods.

---

## 1. Connection & Authentication Handshake

* **Transport:** WebSocket (`wss://` for remote/Tailscale connections, `ws://127.0.0.1` for local loopback).
* **Port:** `8088` (bound to `127.0.0.1` and Tailscale interface `100.x.y.z`, `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:95-120`).

### 1.1 Why Auth Token is Mandatory (Even with Tailscale)
While Tailscale provides secure network-layer routing and node identity, an **Application-Layer Auth Token** is strictly required:
1. **Host-Local Process Isolation:** Without auth, any non-sandboxed process or script on the local Mac could connect to `ws://127.0.0.1:8088` and execute arbitrary terminal commands / keystrokes inside cmux sessions.
2. **Tailnet Peer Isolation:** Tailscale grants network reachability to other devices in the user's tailnet (family devices, shared nodes, CI/CD runners). Application tokens ensure only the paired mobile device can control cmux.
3. **Future Tunnel Neutrality:** If connecting via Cloudflare Tunnel or direct LAN in the future, the token prevents open internet takeover.

### 1.2 Pairing Schemes & Payload Formats

#### Reference Implementations:
* **cmux-pocket Scheme (`ref/cmux-pocket/crates/cmux-pocket-cli/src/uri.rs:112-143`):**
  `cmux-pocket://import?v=1&host=<host>&port=<port>&tls=<true|false>&token=<token>&name=<name>`
* **Orca Scheme (`ref/orca/src/shared/remote-runtime/pairing/pairing.ts:12-25`, `ref/orca/src/renderer/src/web/web-pairing.ts:28-40`):**
  `orca://pair?code=<base64url(JSON)>` where payload is `WebPairingOffer`:
  `{ "v": 2, "endpoint": "ws://...", "deviceToken": "...", "publicKeyB64": "..." }`

#### cmux-mobile Phase 1 Pairing Implementation:
* **Terminal QR Code Output:**
  Upon gateway startup or running `cmob qr`, the CLI prints a QR code containing the web pairing URL with a single-use ticket:
  - Format: `https://<tailscale-magicdns>/#code=<base64url(PairingOffer)>`
  - Ticket Offer Payload (`v: 1`):
    ```json
    {
      "v": 1,
      "endpoint": "wss://<tailscale-magicdns>/ws",
      "token": "",
      "ticket": "cmux_tkt_..."
    }
    ```
* **Single-Use Ticket Redemption Flow:**
  1. The pairing QR code never carries the permanent master token; it provides a short-lived ticket (TTL: 10 min).
  2. The mobile client calls `POST /api/pair/exchange` with `{ "ticket": "cmux_tkt_...", "label": "iPhone" }`.
  3. The gateway redeems the ticket, creates a scoped device token (`cmux_dev_...`), registers the device in `DeviceRegistry`, and returns `{ "token": "cmux_dev_..." }`.
  4. The client uses this device token for all subsequent WebSocket authentication frames (`{ "type": "auth", "token": "cmux_dev_..." }`).
* **Cross-Origin & CORS Support (GitHub Pages):**
  - When hosted on GitHub Pages (`https://chavisnguyen.github.io/cmob/`), requests to the gateway are cross-origin.
  - The gateway middleware (`host_and_origin_guard` and `CorsLayer`) explicitly permits `Origin: https://chavisnguyen.github.io` and sets `Access-Control-Allow-Credentials: true`.
  - If ticket redemption fails (e.g. 403, 401, or unreachable), the client displays inline error banners rather than erroneously prompting for manual token entry.
* **Address Bar Secret Sanitization (Orca Pattern, `ref/orca/src/renderer/src/web/web-pairing.ts:107-116`):**
  Upon reading the pairing token from the URL fragment (`#token=...`) into `localStorage`, the web client immediately calls:
  ```typescript
  window.history.replaceState(null, document.title, window.location.pathname);
  ```
  This guarantees that refreshing, sharing links, or inspecting browser history never leaks the gateway authentication token.

### 1.3 Handshake Authentication Flow
* **Option A (HTTP Upgrade Header):** `Authorization: Bearer <token>` during the HTTP WebSocket upgrade (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:108-112`).
* **Option B (First Message Wire Frame):** Immediately after connection, client sends an `auth` frame:
  ```json
  {
    "type": "auth",
    "token": "secret-bearer-token-generated-at-setup",
    "client_id": "cmux-mobile-client"
  }
  ```
  *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs:61-91`, `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:310-316`.
  * **Successful Response (`AuthOk`):**
    ```json
    {
      "type": "auth_ok",
      "session_id": "session-uuid-1234",
      "server_version": "2.0.0",
      "capabilities": [
        "terminal.render_grid.v1",
        "terminal.input.ordered.v1",
        "workspace.changes.v1",
        "events.v1",
        "client_focus.v1",
        "multi_surface.v1",
        "mobile.host.wake_cmux.v1",
        "terminal.viewport.v1",
        "agent.chat.v1",
        "push.registration.v1"
      ]
    }
    ```
    *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs:16-39, 94-116`, `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:318-329`.
  * **Rejection Response (`AuthError`):**
    ```json
    {
      "type": "auth_error",
      "reason": "invalid_token"
    }
    ```
    Followed by immediate WebSocket close with close code `1008` (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:335-340`, `ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs:8-14`).

---

## 2. Frame Envelopes

### 2.1 Request Frame (Client -> Gateway)
```json
{
  "id": "req-101",
  "method": "mobile.chat.send",
  "params": {
    "surface_id": "8a7c2b54-...",
    "text": "Refactor auth handler"
  }
}
```

### 2.2 Response Frame (Gateway -> Client)
```json
{
  "id": "req-101",
  "result": {
    "status": "delivered"
  }
}
```

### 2.3 Error Frame (Gateway -> Client)
```json
{
  "id": "req-101",
  "error": {
    "code": -32600,
    "message": "Surface not found or terminated"
  }
}
```
*Standard JSON-RPC error codes:* `CODE_PARSE_ERROR (-32700)`, `CODE_INVALID_REQUEST (-32600)`, `CODE_METHOD_NOT_FOUND (-32601)`, `CODE_INVALID_PARAMS (-32602)`, `CODE_INTERNAL_ERROR (-32603)`, `CODE_BACKEND_UNAVAILABLE (-32000)`.
*Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/rpc.rs:7-13`.

### 2.4 Server Event / Stream Frame (Gateway -> Client)
```json
{
  "event": "agent.chat.turn",
  "data": {
    "surface_id": "8a7c2b54-...",
    "turn_id": "turn-42",
    "role": "assistant",
    "content": "Running test suite...",
    "reasoning": "Inspecting previous run output...",
    "tools": [
      {
        "id": "tool-1",
        "name": "run_command",
        "status": "executing",
        "args": { "command": "cargo test" }
      }
    ]
  }
}
```

---

## 3. RPC Methods Catalog

### 3.1 Host & Daemon Lifecycle
| Method | Params | Description |
|---|---|---|
| `mobile.host.status` | `{}` | Returns cmux daemon status, PID, version, active connections. |
| `mobile.host.wake_cmux` | `{}` | Wakes or starts macOS cmux app if sleeping. |

*Evidence:* `ref/cmux-pocket/crates/cmux-pocket-gateway/src/dispatch/host.rs`.

### 3.2 Workspaces & Surfaces
| Method | Params | Description |
|---|---|---|
| `mobile.workspace.list` | `{}` | Dumps workspace tree and all surfaces. |
| `mobile.workspace.create` | `{ "name"?: string }` | Opens a new workspace. |
| `mobile.workspace.select` | `{ "workspace_id": string }` | Focuses workspace on macOS. |
| `mobile.workspace.rename` | `{ "workspace_id": string, "title": string }` | Renames workspace. |
| `mobile.workspace.close` | `{ "workspace_id": string }` | Closes workspace. |
| `mobile.surface.create` | `{ "workspace_id": string, "type"?: "terminal" \| "browser" }` | Opens new tab/surface. |
| `mobile.surface.close` | `{ "surface_id": string }` | Closes specified surface. |
| `mobile.surface.rename` | `{ "surface_id": string, "title": string }` | Renames surface tab. |

*Evidence:* `ref/cmux-pocket/crates/cmux-pocket-gateway/src/dispatch/workspace.rs`, `surface.rs`.

### 3.3 Agent Chat Mode (Orca-Style)
| Method | Params | Description |
|---|---|---|
| `mobile.chat.readSession` | `{ "surface_id": string, "limit"?: number, "resume_after"?: string }` | Reads recent turns, tool calls, and thoughts from agent transcript. |
| `mobile.chat.subscribe` | `{ "surface_id": string, "session_id"?: string, "agent_kind"?: string, "max_turns"?: number }` | Implemented (`repos/cmux-gateway/src/server.rs`, `handle_subscription`/`chat_watcher`). Gateway samples the session every 500 ms and pushes `{"event":"mobile.chat.update","data":<readSession payload>}` only when lifecycle/subtitle/transcript mtime+size change. First snapshot is sent immediately. Max 8 subscriptions per connection; per-connection (client must re-subscribe after reconnect). Full snapshot per update, not an append diff. |
| `mobile.chat.unsubscribe` | `{ "surface_id": string }` | Aborts the watcher for that surface. |
| `mobile.chat.send` | `{ "surface_id": string, "text": string }` | Injects prompt via bracketed paste (`mobile.chat.send`). |
| `mobile.chat.interrupt` | `{ "surface_id": string }` | Stops active turn (`mobile.chat.interrupt` or Esc-Esc). |
| `mobile.chat.approve` | `{ "surface_id": string, "key"?: string }` | Submits approval key (`\r` or `1`) for pending permission. |

*Evidence:* `ref/orca/src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing.ts:172-174`, `ref/cmux/agent-chat/README.md:19-20`.

### 3.4 Terminal Grid & Live PTY Streaming (Implemented)
| Method | Params | Description |
|---|---|---|
| `mobile.surface.new` | `{ "workspace_id"?: string, "command"?: string }` | Opens a new terminal tab (`+Tab`, no split). |
| `mobile.surface.rename` | `{ "surface_id": string, "title": string }` | Renames an existing tab via `cmux rename-tab`. |
| `mobile.surface.close` | `{ "surface_id": string, "force"?: boolean }` | Closes a tab via `cmux close-surface`. |
| `mobile.terminal.subscribe` | `{ "surface_id": string, "client_id"?: string, "mode"?: "mobile" \| "desktop", "columns"?: number, "rows"?: number, "max_scrollback_rows"?: number }` | Starts 150ms + notify-driven `terminal_watcher` pushing `mobile.terminal.update` events when `terminal_replay_fingerprint` changes. |
| `mobile.terminal.unsubscribe` | `{ "surface_id": string }` | Stops watcher and clears active mobile viewport override if set. |
| `mobile.terminal.viewport` | `{ "surface_id": string, "client_id": string, "mode"?: "mobile" \| "desktop", "columns"?: number, "rows"?: number, "clear"?: boolean }` | Switches `cmux` surface between mobile (`cols×rows`) and desktop (`clear: true`) PTY sizes. |
| `mobile.terminal.replay` | `{ "surface_id": string, "columns"?: number, "rows"?: number, "max_scrollback_rows"?: number }` | Fetches `render_grid` (`cmux.render-grid.v1`) + `size_state` snapshot. |
| `mobile.terminal.input` | `{ "surface_id": string, "text"?: string, "key"?: string, "kind"?: "text" \| "key" }` | Sends raw VT bytes or mapped keystroke to PTY and triggers immediate watcher refresh. |
| `mobile.terminal.paste` | `{ "surface_id": string, "text": string }` | Submits clipboard paste via `mobile.terminal.paste`. |
| `mobile.terminal.scroll` | `{ "surface_id": string, "delta_lines": number, "col"?: number, "row"?: number }` | Scrolls alternate screen / mouse-tracking apps. |

*Evidence:* `repos/cmux-gateway/src/protocol/rpc.rs:32-41`, `repos/cmux-gateway/src/server.rs:372-710,1124-1318`, `repos/cmux-client/src/protocol/rpc.ts:27-41`.

### 3.5 Push Registration
| Method | Params | Description |
|---|---|---|
| `mobile.push.register` | `{ "platform": "apns" \| "fcm" \| "webpush", "token": string, "endpoint"?: string, "auth"?: string, "p256dh"?: string }` | Registers mobile/web device token for background push notifications. |


## One-Time Pairing Ticket Exchange (implemented 2026-11-14)

Source: `repos/cmux-gateway/src/pairing_store.rs`, `server.rs` (`pair_exchange_handler`, `pairing_offer_with_ticket`), client `repos/cmux-client/src/transport/wsClient.ts` (`redeemPendingTicket`).

* `GET /api/pairing` returns `{offer, uri}` where `offer = {v:1, endpoint, token:"", ticket}`; the gateway token is **not** included. Ticket: 128-bit random, TTL 600 s, single-use, at most 16 outstanding.
* `POST /api/pair/exchange {"ticket": "..."}` -> `200 {"token": "<cmux_dev_...>"}` or `401 {"error":"invalid_or_expired_ticket"}`. Device tokens persist in `$CMUX_DEVICES_FILE` or `~/.cmux/devices.json` (mode 0600, max 64) and are accepted by the WebSocket `auth` frame alongside the gateway token.
* Client honors `offer.endpoint` when it is a valid `ws:`/`wss:` URL different from the page origin (persisted as `localStorage.cmux_endpoint`), and redeems `offer.ticket` against the HTTP base derived from that endpoint.
* Direct gateway endpoint is always `ws://host:port/ws`: the gateway has no TLS listener. `wss://` is valid only behind Tailscale Serve on the MagicDNS name (`scripts/tailscale.sh`). Previously `pairing_offer()` emitted `wss://<100.x>:8088/ws`, which could never connect once endpoints were honored.
* Not provided: transport encryption/E2EE, device key pinning, revocation UI. An attacker who can reach the port can still mint a ticket. `scripts/tailscale.sh` and `#token=` URLs still carry the long-lived gateway token (unchanged).


`mobile.chat.readSession` / `mobile.chat.update` payload also carries `has_more: bool` and `total_turns: number` (gateway `server.rs` `session_json`). Clients page older history by re-requesting with a larger `max_turns` (cap 500).

When `lifecycle_state == "waiting"`, `mobile.chat.readSession` / `mobile.chat.update` also carries `awaiting_prompt: string | null` (`repos/cmux-gateway/src/server.rs`, `derive_awaiting_prompt`), prioritizing rich hook `lastBody`, then terminal approval context (`capture_pane` + `extract_approval_screen_context`), then any pending `ToolStart` in `turns`, then hook `toolName`, so Codex/Claude approvals show the actual command/reason in `OrcaChatView.tsx` (`Approve` / `Deny`). `fingerprint()` and `chat_watcher` track `last_body`, `tool_name`, and the extracted screen context so prompt updates push immediately.

## `mobile.chat.send` and per-agent input profiles (2026-11-14)
Params: `{ surface_id, text, agent_kind?, enter? (default true) }`. Gateway (`repos/cmux-gateway/src/cmux/agent_profile.rs`, `bridge.rs::submit_prompt`): `cmux send --paste --force -- <text>`, wait `profile.submit_delay(text)`, then `cmux send-key --force enter`. A trailing `\r`/`\n` in `text` (older clients) is stripped and means submit. Clients must NOT append `\r`.
Why: verified live on Codex 0.169.0 via the `cmux` CLI: `cmux send --force -- $'testA one line\r'` left the draft unsent in the composer; a separate `cmux send-key enter` submitted it; `--paste` keeps multi-line text as one draft (typing it presses Enter on every newline per `cmux send --help`). Orca does the same: text, settle, then Enter alone (`ref/orca/src/main/runtime/terminal/input/runtime-terminal-writer.ts:72-117`), delay = 500 ms + ingest + per-line settle (`ref/orca/src/shared/agent-launch/startup/agent-prompt-injection.ts:15-30,140-170`); per-agent table `ref/orca/src/shared/agent-launch/catalog/tui-agent-config.ts` (agy `submitLineSettleMsPerLine: 45`; codex `submitRetryDelayMs: 1200`; claude "may leave a draft unsent when paste-end and Enter share a write", 50 ms).
Add a new agent: one row in `agent_profile::profile_for` (settle, per-line settle, approve input). Not implemented: Orca's Enter retry while the composer still holds the prompt (codex 1200 ms), startup-dialog guard. Live-verified only for Codex (two-line message and legacy `\r`); Claude/Kiro/agy use the same flow with Orca's constants, [HYPOTHESIS - UNVERIFIED] per agent: send one short message to each from the app.
Client: composer is a `<textarea>` (Enter = newline, only the arrow sends); sent messages are kept as pending sends (`SurfaceDetailView.tsx`) until the transcript echoes them (Orca `pendingSendsAsMessages`), so new sessions without a transcript show the message and "Thinking…" immediately; a failed send restores the text.

## Agent startup dialogs (trust / update / menus) (2026-11-14)
**Orca (verified in source):** three layers.
1. Pre-write trust for workspaces Orca launches itself: `src/main/agent-launch/trust/agent-trust-presets.ts` (`markCodexProjectTrusted`, `markAntigravityWorkspaceTrusted`, ...), best effort ("failure or timeout leaves the agent to ask", `agent-workspace-trust.ts`). Per-agent flag `preflightTrust` in `tui-agent-config.ts`.
2. Screen detection: a live dialog ENDS on a key footer, kind from sentinel phrases (`src/main/runtime/terminal/output/startup-dialog-screen.ts:12-70`, `agent-state-rules/blocked-text-layer.ts`, `terminal/wait/startup-dialog-blocked-signals.ts`); `TrustDialogStatusObserver` projects it into the pane status (blocked), "hooks only start after it".
3. Chat card with aimed answers (`native-chat-approval-envelope.ts`: `folderTrust {trustSend}` = arrow keys + Return, `startupMenu {choices}`); the answer is guarded by `requireStartupDialog` so it is refused if the screen changed (`terminal-send-method.ts:177-186`). Only Claude's menus are aimed ("Only Claude's menu keys are verified (2.1.316)").
**cmux-mobile before:** nothing. Verified hazard: with Codex 0.169.0's trust dialog open, `cmux send --paste` and `cmux send-key enter` succeed even WITHOUT `--force` (cmux's guard only knows hooked agents) and Enter selected "Trust and continue" (written to `~/.codex/config.toml` as `trust_level = "trusted"`). A test of mine did this to `~/projects/tool-x`; reverted (entry removed, diff vs backup = those 3 lines only).
**Now:** `repos/cmux-gateway/src/cmux/startup_dialog.rs` (`detect`, tested on the real captured Codex screen) + `bridge.rs::ensure_no_startup_dialog` before the paste and before Enter in `submit_prompt`; the chat shows the refusal ("The agent is waiting on a startup dialog (folder trust). Open the Terminal tab and answer it first.") and restores the text. Live check: refused, nothing typed, config unchanged; trusted folder still sends.
**Not done (Orca layers 1 and 3):** no auto-trust (it is the user's security decision), no chat card with Trust/Exit buttons, no "blocked" status/push for dialogs, footer variants of other agents/versions beyond those listed in `startup_dialog.rs`. Codex 0.169.0's footer is `enter continue · esc back`, which Orca's footer regex (`esc quit|skip`) would NOT match; keep the detector aligned with observed screens.

## Startup dialog card (2026-11-14)
- Gateway: `startup_dialog.rs::analyze` -> `DialogInfo {kind, title, description, choices[label, keys], fingerprint}`; choices parsed from numbered rows (`› 1. Trust and continue`), keys = `up`/`down` x distance from the highlighted row, then `enter` (Orca `menuKeys`). Key names verified with `cat -v`: `down` -> `^[[B`, `up` -> `^[[A`, `escape` -> `^[`. Fingerprint ignores the highlight.
- `mobile.chat.readSession` / `mobile.chat.update` carry `startup_dialog` (null or `{kind,title,description,fingerprint,aimed,choices:[{label}]}`); polled at most every 2 s while the agent is not working. RPC `mobile.chat.answerDialog {surface_id, fingerprint, choice}` re-reads the screen and refuses if the fingerprint changed, the dialog is gone, or the choice is out of range (Orca `requireStartupDialog`). Keys are never exposed to the client.
- Status/push: `spawn_dialog_watcher` (3 s) reads the screen of agent processes younger than 5 min (`ps etime`), marks the surface `waiting` in the tree (`registry::is_waiting`) and sends one push per dialog fingerprint ("<Agent> needs your answer", data.surfaceId so the notification opens the chat).
- Verified live on Codex 0.169.0 (untrusted folder `tool-x`): snapshot choices [Trust and continue, Back to Agent Command Center]; tree status `waiting`; push dispatched; stale fingerprint and bad choice refused; choice 1 (does not trust) moved Codex to the Agent command center; `~/.codex/config.toml` unchanged. The card never auto-trusts: the user taps the option.
- Chat watermark: `OrcaChatView` renders the agent logo (`AgentIcon`, opacity 0.07) behind the timeline; it breathes (opacity .07 -> .13, 3.6 s) while the agent works, disabled under `prefers-reduced-motion`.

## Live Notification & Client Viewing Protocol (2026-11-16)
- `mobile.client.viewing` (`repos/cmux-gateway/src/protocol/rpc.rs:53`, `repos/cmux-gateway/src/server.rs:845-865`, `repos/cmux-client/src/protocol/rpc.ts`):
  - Request params: `{ "surface_id": string | null, "visible": boolean }`
  - Updates `ClientInfo.viewing_surface` and `ClientInfo.client_visible` for the authenticated WebSocket session so `suppressWhileViewing` skips alerts on the currently viewed surface.
- `mobile.notification.alert` (`repos/cmux-gateway/src/server.rs:300-314,982`, `repos/cmux-client/src/protocol/rpc.ts`):
  - Server-push event payload: `{ notification_id, surface_id, workspace_id, category, agent, agent_display, title, subtitle, body, tag, urgent }`
  - Categories: `"needs-permission" | "turn-finished" | "agent-error" | "cmux-dialog"` (`repos/cmux-gateway/src/push.rs:133`).
- `mobile.notification.dismiss` (`repos/cmux-gateway/src/server.rs:327-343,983`, `repos/cmux-client/src/protocol/rpc.ts`):
  - Server-push event payload: `{ surface_id, tags }`
  - Emitted when a surface returns to `Working` or `Idle`, or when a startup dialog clears; instructs the client and Service Worker (`cmux.notification.dismiss`) to close open notifications matching `tags`.

## `AgentEvent::BackgroundTasks` & System Boundaries (2026-11-25)
- `repos/cmux-gateway/src/protocol/event.rs` & `repos/cmux-client/src/protocol/event.ts`:
  - Added additive `AgentEvent::BackgroundTasks { tasks: Vec<BackgroundTaskEntry> }` (`{ kind: "background-tasks", tasks }`) where each `BackgroundTaskEntry` carries `{ id, kind: "agent" | "command" | "workflow" | "monitor" | "unknown", label, state, summary?, tokens?, started_at?, settled_at? }`.
  - Populated `started_at` and `settled_at` (epoch ms) on both `SubagentEntry` and `BackgroundTaskEntry` from transcript RFC3339 timestamps (`timestamp` / `created_at`) and provider `usage.duration_ms` / `totalDurationMs` so mobile clients render isolated 1s live elapsed timers (`LiveElapsedText`).
  - Claude compaction boundaries (`subtype: "compact_boundary"`, `isCompactSummary: true`) emit deduplicated `AgentTurn { role: "system", events: [{ kind: "status", text: "Context compacted" }] }`.

## `mobile.chat.answerQuestion`, Question Receipts & Thinking Duration (2026-11-25)
- `mobile.chat.answerQuestion` (`repos/cmux-gateway/src/protocol/rpc.rs`, `repos/cmux-gateway/src/cmux/bridge.rs::answer_question`, `repos/cmux-gateway/src/server.rs`, `repos/cmux-client/src/protocol/rpc.ts`):
  - Params: `{ surface_id: string, agent_kind?: string, indices?: number[], other?: string, option_count?: number, multi_select?: boolean }`.
  - Captures the terminal pane (`capture_pane(surface_id, 45)`), locates the live numbered question menu below `Question` / `────` / `? ` headers (`detect_numbered_question_menu`), and navigates from the highlighted cursor row (`>`/`›`/`❯`) via `up`/`down` + `enter` (or `space` + `enter` / digit toggles for multi-select, and `Write-in...` / `Other` row + `paste` + `enter` for custom answers), falling back to `submit_prompt` when no TUI menu is active.
- `AwaitingInput` & `AgentEvent::Thinking` extensions (`repos/cmux-gateway/src/protocol/event.rs`, `repos/cmux-client/src/protocol/event.ts`):
  - `AwaitingInput` adds optional `questions?: AskQuestionItem[]` (`{ question, options, multi_select }`) and `answered?: string` (populated from Antigravity `GENERIC` `A1: ...` tool results with `Created At:`/`Completed At:` headers stripped, and from Claude `AskUserQuestion` `tool_result` blocks).
  - `AgentEvent::Thinking` adds optional `duration_secs?: number` computed from step timestamp deltas in `TranscriptReader`.
