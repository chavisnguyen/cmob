# Current cmux-mobile vs Orca Mobile Audit

**Date:** 2026-11-14
**Scope:** Source scan of `repos/cmux-gateway`, `repos/cmux-client`, fixtures/scripts, and `ref/orca`.

## Evidence snapshot

- The project contains a real Rust/Axum gateway and React PWA, not only specifications. The codebase overview reports 47 files, 8,041 LOC, 186 functions, and 78 classes/interfaces across `repos/`.
- `repos/cmux-gateway/src/server.rs:64-70` creates `/health`, `/api/pairing`, `/ws`, and a static fallback. `server.rs:98-196` implements the authenticated WebSocket loop. `server.rs:198-480` dispatches workspace, surface, chat send/read, approve, interrupt, terminal, and push registration methods.
- `repos/cmux-client/src/App.tsx:144-150` refreshes workspaces every 2.5 seconds. `SurfaceDetailView.tsx:112-117` refreshes chat history every second. `RawTerminalView.tsx:79-83` refreshes terminal output every 800ms.

## Working capabilities

1. Three-level workspace -> surface -> detail navigation is implemented in `repos/cmux-client/src/App.tsx:3-7,258-301`, `WorkspaceListView.tsx`, `SurfaceListView.tsx`, and `SurfaceDetailView.tsx`.
2. The gateway merges live `cmux tree --json` and `workspace.list` data with hook-session files in `repos/cmux-gateway/src/scanner/workspace_tree.rs:132-303`.
3. The CLI bridge supports ping, RPC, text input, key input, pane capture, approval, and Ctrl-C interruption in `repos/cmux-gateway/src/cmux/bridge.rs:47-283`.
4. Claude and Antigravity JSONL parsing, tool cards, reasoning, awaiting-input, and subagent data are implemented in `repos/cmux-gateway/src/scanner/transcript.rs:30-350` and the client chat components.
5. The PWA has ANSI rendering and mobile terminal controls in `repos/cmux-client/src/components/terminal/RawTerminalView.tsx:1-288` and `ansiParser.ts`.
6. Pairing/auth basics exist: typed auth frames and close code 1008 in `repos/cmux-gateway/src/server.rs:98-160`; base64url pairing parsing in `repos/cmux-client/src/protocol/pairing.ts:1-202`.
7. The client has mobile layout work for safe areas, keyboard viewport changes, tail pinning, older-message loading, and jump-to-latest in `OrcaChatView.tsx:76-263`.
8. Offline fixtures and parser/tree tests exist in `fixtures/` and `repos/cmux-gateway/tests/offline_mock_test.rs:1-168`; client unit tests include pairing, events, ANSI, and push-manager tests.

## Important gaps and verified risks

### P0: realtime chat subscription is declared but not implemented

`repos/cmux-gateway/src/protocol/rpc.rs:16-20` declares `mobile.chat.subscribe` and `mobile.chat.unsubscribe`, but `server.rs` imports only the session/read/send/approve/interrupt methods and its dispatch table has `METHOD_CHAT_SESSIONS` at `server.rs:307` and `METHOD_CHAT_READ_SESSION` at `server.rs:316`, with no subscribe/unsubscribe branch before the fallback `unknown` branch. The gateway therefore reads transcript files on request; it does not implement Orca's server-side transcript watcher and append stream.

Orca's authoritative implementation provides `nativeChat.readSession`, `nativeChat.subscribe`, and `nativeChat.unsubscribe`, including snapshot, replacement, append, cleanup, and abort handling in `ref/orca/src/main/runtime/rpc/methods/native-chat/native-chat.ts`. The current client's one-second polling is a workable prototype but will be slower, more wasteful, and less reliable during long streaming turns.

### P0: push notification delivery is not functional end-to-end

`repos/cmux-client/src/App.tsx:224-234` explicitly creates a fake endpoint (`https://push.cmux.local/...`) and fake `p256dh`/`auth` values instead of calling `pushManager.subscribe()` and registering the browser's real subscription. `repos/cmux-client/src/notifications/pushManager.ts:84-106` contains the real subscribe helper, but the application does not use it.

On the gateway side, `repos/cmux-gateway/src/push.rs:18-55` only defines subscription storage, deduplication, and listing. It does not send a Web Push request. `server.rs`'s `mobile.push.test` branch only returns status/count. `web-push` is listed in `Cargo.toml`, but no dispatch path is connected to agent lifecycle events. The service worker can display a notification if a push arrives, but no verified producer currently sends one.

### P0: pairing endpoint is parsed but ignored by the WebSocket client

`repos/cmux-client/src/protocol/pairing.ts:10-15` stores `PairingOffer.endpoint`, but `repos/cmux-client/src/transport/wsClient.ts:154-165` always builds the socket URL from the current browser origin. The imported endpoint is not persisted as the connection target. A QR offer for a different host/Tailscale endpoint can therefore authenticate with the token but connect to the wrong origin or fail entirely.

### P1: security is materially below Orca

The gateway uses a reusable bearer token. `wsClient.ts:55-64` stores it in `localStorage`, `sessionStorage`, and a cookie. Orca's mobile flow includes a one-time pairing-ticket exchange in `ref/orca/mobile/src/pairing/pairing-ticket-exchange.ts` and E2EE primitives/key derivation in `ref/orca/src/renderer/src/web/web-paired-e2ee-primitives.ts`. The current project has neither one-time ticket exchange, device identity, key pinning, nor E2EE framing. Tailscale reduces network exposure, but does not replace application-level device authorization.

### P1: agent support is broader in labels than in parser implementation

`HookStoreIndex::scan_dir` in `repos/cmux-gateway/src/scanner/hook_store.rs:182-214` scans only files ending `-hook-sessions.json` under `~/.cmuxterm` (or `CMUX_HOOK_SESSIONS_DIR`). It does not scan a dedicated Kiro session directory or Codex rollout store. `TranscriptReader` detects only Antigravity record types and sends every other JSONL record through `parse_claude_line` in `repos/cmux-gateway/src/scanner/transcript.rs:62-74`. Surface title heuristics recognize Kiro/Codex/OpenCode, but recognition alone does not provide their transcript adapters. The README and protocol types advertise Claude, AGY, Kiro, and Codex; the verified native parser path is strongest for Claude and AGY.

### P1: terminal parity is only a polling/capture approximation

The project uses `cmux capture-pane` and an HTML `<pre>` refreshed every 800ms. Orca exposes terminal stream/ack/viewport/input methods and keeps a mobile native-chat terminal stream, while this project has no implemented terminal subscribe, ack, resize, or viewport RPC branch. The current approach is useful for monitoring and basic commands but will miss high-rate output, TUI interaction details, and efficient incremental updates.

### P1: several Orca interaction features are missing or simplified

The current client has reasoning, tool, subagent, approval, diff, copy, and jump-to-latest components. Compared with the scanned Orca mobile source under `ref/orca/mobile/src/session/native-chat/`, it still lacks or simplifies: native transcript subscription/resume points, queued follow-ups, attachments/dictation/image viewing, file opening from chat, structured agent-session launch/mutation, rewind, host/worktree/SSH routing, richer task/checklist surfaces, and the broader Git/GitHub/browser operations exposed in Orca's mobile RPC route table (`ref/orca/src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing.ts`).

## Quality verdict

- **As a prototype/internal tool:** good foundation, approximately **7/10**. The navigation model is coherent, the gateway-to-cmux bridge is concrete, the chat presentation is thoughtfully adapted for a phone, and offline fixtures make core parsing testable.
- **As a reliable daily-driver replacement for Orca:** approximately **4/10** today. The two largest user-facing promises, live updates and lock-screen notifications, are not implemented end-to-end. Pairing/security and agent compatibility also lag Orca.
- **Production readiness:** not ready until P0 items are fixed and verified with live tests. The project should avoid claiming "real-time push" or "multi-agent parity" until those paths have a real event producer, real browser subscription, and agent-specific transcript tests.

## Recommended order

1. Implement a gateway transcript watcher plus WebSocket subscription lifecycle and client event merge/resume logic.
2. Replace fake push data with the browser subscription, configure VAPID keys securely, dispatch notifications from verified hook lifecycle transitions, and test service-worker click routing.
3. Persist and honor the pairing endpoint; then add one-time device-token exchange and E2EE/device pinning before exposing beyond a trusted tailnet.
4. Add explicit Codex and Kiro transcript/session adapters, with fixtures and tests for each.
5. Add terminal streaming/resize/ack and backpressure before optimizing visual polish.
6. Add Orca parity features selectively: attachments/images, queued follow-ups, rewind, file open/diff, and host/worktree routing.

## macOS lock screen versus sleep

`Ctrl+Cmd+Q` locks the macOS session; it is not itself a sleep command. If the Mac remains awake, cmux and its child agent processes normally continue running. If macOS also enters system sleep, user-space execution and network activity are suspended; local agents generally resume with the terminal state after wake, but active API/SSH/WebSocket connections may timeout or reconnect. Apple documents display-off and automatic-sleep settings separately: https://support.apple.com/en-sg/guide/mac-help/mchlp2995/mac.

For cmux-mobile specifically, the Mac-side gateway can remain alive while the Mac is only locked, but the phone PWA WebSocket is not a reliable background channel. The project currently has no verified end-to-end push producer; see `repos/cmux-client/src/App.tsx:224-234` and `repos/cmux-gateway/src/push.rs:18-55`. Therefore lock-screen monitoring from the phone is not reliable until push delivery is implemented.

## Sleep/wake source audit

The source has no macOS sleep/wake-specific lifecycle handler. `repos/cmux-client/src/transport/wsClient.ts:211-231` reconnects when the browser emits `close`, but it has no application heartbeat/ping and no recovery path when a half-open WebSocket remains `OPEN`. `wsClient.ts` request timeout only rejects the request; it does not close the socket or trigger reconnect. `repos/cmux-gateway/src/server.rs:236-238` only answers incoming WebSocket Ping frames; it does not emit a periodic heartbeat. `App.tsx:143-151` and `RawTerminalView.tsx:142-148` use polling without an in-flight guard, so a slow/suspended connection can accumulate requests; `SurfaceDetailView.tsx:72-77` has a guard only for chat reads. `caffeinate` is an OS-level command and is not integrated with this application.

## Update 2026-11-14 (after M5.5)

Resolved since the audit above (evidence: `.context/roadmap_and_tasks.md` M5.5, tests in `server.rs`, `pairing_store.rs`, `transcript.rs`, `kiro_store.rs`):
- P0 realtime chat subscription: implemented as server-side watcher push (full snapshot on change, not Orca's append stream).
- P0 pairing endpoint ignored: fixed; plus one-time ticket exchange and per-device tokens (no E2EE, no key pinning).
- P1 Kiro/Codex adapters: Kiro verified on real data; Codex written from Orca fixtures and unverified live.

Still open and unchanged: P0 push delivery (fake subscription in `App.tsx`, stub in `push.rs`), terminal streaming, heartbeat/sleep-wake, attachments/queued follow-ups/rewind/host routing.

## Update 2026-11-14 (after M5.6)

Resolved since M5.5 (evidence: `.context/roadmap_and_tasks.md` M5.6, `repos/cmux-gateway/src/server.rs`, `repos/cmux-client/src/components/terminal/RawTerminalView.tsx`, `terminalViewport.ts`, `renderGridToAnsi.ts`):
- **Terminal streaming & resize:** Replaced `<pre>` 800 ms polling and `$` command bar with `@xterm/xterm` + `Unicode11Addon` + `WebglAddon` (DOM fallback), fed by `mobile.terminal.subscribe` -> `mobile.terminal.update` (`render_grid`) and direct PTY input/paste/scroll (`mobile.terminal.input`, `mobile.terminal.paste`, `mobile.terminal.scroll`).
- **Desktop / Mobile view toggle (no font zoom):** Added `Mobile`/`Desktop` toggle with live `cols×rows` badge; Mobile mode dynamically sets `cmux` PTY dimensions via `mobile.terminal.viewport`, while Desktop mode clears the mobile override (`clear: true`) and applies Orca `computeDesktopFitScale` + pinch-to-zoom/pan. Font-size zoom controls were intentionally removed per user requirement.
- **Tab management (+Tab / Rename / Close, no splits):** `mobile.surface.new` uses `cmux new-surface --type terminal --focus true` (no `new-split`), and `mobile.surface.rename` uses `cmux rename-tab`.
- **Live gateway verification:** Verified over Tailscale Serve (`https://machine.tailnet.ts.net/health` -> `cmux_alive: true`) and WebSocket (`mobile.workspace.tree`: 7 workspaces; `mobile.terminal.replay`: `132x52`, `hasGrid: true`). Also discovered `launchd` fails `cmuxOnly` authorization (`Access denied`); gateway must be started from inside a `cmux` surface unless socket control mode is changed.

Still open: P0 push delivery (fake subscription in `App.tsx`, stub in `push.rs`), E2EE/key pinning, heartbeat/sleep-wake, attachments/queued follow-ups/rewind/host routing.
