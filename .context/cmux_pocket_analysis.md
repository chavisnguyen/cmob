# cmux-pocket Architecture & Protocol Analysis

This document analyzes the architecture, protocols, and implementation of [cmux-pocket](https://github.com/shiquda/cmux-pocket), based on direct source code inspection of `ref/cmux-pocket`.

---

## 1. High-Level Architecture Overview

```
┌─────────────────────────────────┐
│     Android Client (Compose)    │
│  - Jetpack Compose UI           │
│  - Custom Grid Canvas Renderer  │
│  - Encrypted Keystore Auth      │
└───────────────▲─────────────────┘
                │
                │ TLS Boundary (Tailscale HTTPS / Cloudflare / LAN Proxy)
                │ WSS / WebSocket
                ▼
┌─────────────────────────────────┐
│  cmux-pocket Gateway (macOS)   │
│  - Rust (Tokio + Tungstenite)   │
│  - Strict loopback (127.0.0.1)  │
│  - Port 8088 (Bearer Auth)      │
└───────────────▲─────────────────┘
                │
                │ Subprocess pipes / CLI & UDS Socket
                ▼
┌─────────────────────────────────┐
│           cmux (macOS)          │
│  - Ghostty terminal core        │
│  - PTY & VT emulation           │
└─────────────────────────────────┘
```

*Evidence:* `ref/cmux-pocket/docs/architecture.md:7-11`, `ref/cmux-pocket/README.md:1-43`.

---

## 2. Gateway Implementation (`crates/cmux-pocket-gateway`)

* **Server Binding:**
  * Runs on `127.0.0.1:8088` (strictly loopback; rejects `0.0.0.0` or external network interfaces for security).
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:95-120`, `ref/cmux-pocket/crates/cmux-pocket-macos/src/loopback.rs:1-35`.
* **Authentication:**
  * Requires a cryptographically random Bearer token passed in the initial WebSocket upgrade header or JSON auth message.
  * *Evidence:* Handshake processing in `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:310-340`, token generation in `auth.rs:1-50`, message types in `ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs:16-105`.
  * Client sends: `{ "type": "auth", "token": "<token>", "client_id": "android-client" }`.
  * Gateway responds: `{ "type": "auth_ok", "session_id": "<uuid>", "server_version": "2.0.0", "capabilities": [...] }`.
  * If invalid: sends `{ "type": "auth_error", "reason": "invalid_token" }` and closes connection with WebSocket code `1008`.
* **RPC Dispatcher:**
  * Handles JSON-RPC methods:
    * `mobile.host.status`, `mobile.host.wake_cmux` (`dispatch/host.rs`)
    * `mobile.workspace.list`, `mobile.workspace.create`, `mobile.workspace.select`, `mobile.workspace.rename`, `mobile.workspace.close` (`dispatch/workspace.rs`)
    * `mobile.surface.create`, `mobile.surface.close`, `mobile.surface.rename`, `mobile.surface.focus` (`dispatch/surface.rs`)
    * `mobile.events.subscribe` (`dispatch/events.rs`)
    * `mobile.terminal.input`, `mobile.terminal.scroll`, `mobile.terminal.replay` (`dispatch/terminal.rs`)
    * `mobile.terminal.viewport` (`dispatch/viewport.rs`)
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-gateway/src/dispatch.rs:64-95`.
* **Background Supervisors:**
  * `ScreenPoller`: Polls active screen updates at 50ms intervals or on trigger notifications (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/poller.rs:87-123`).
  * `TreePoller`: Regularly monitors workspace and surface topology changes at 1s intervals (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/poller.rs:125-165`).
  * `AgentEventSupervisor`: Consumes the `cmux events` subprocess stream (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/agent.rs:47-98`).

---

## 3. Protocol Specification (`crates/cmux-pocket-protocol`)

### 3.1 Wire Format: `cmux.render-grid.v1`
* Rather than sending raw ANSI VT escape sequences to the phone (which would require a full terminal emulator on mobile), `cmux-pocket` normalizes terminal screens into differential grid frames.
* *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/render.rs:7-35`.
* **Frame Structure:**
  * `rows`: Array of row structures containing styled spans (`text`, `foreground`, `background`, `bold`, `italic`, `underline`).
  * `cursor`: `{ row, column, visible, style, blinking }`.
  * `screen`: Screen identifier (`primary` or `alternate`).
  * `state_seq`: Monotonically increasing sequence number per surface to detect dropped frames.
  * `epoch`: Render epoch identifier (`epoch-live-xxxxxx`).

### 3.2 Agent Completion Normalization
* The gateway listens to `cmux events` and filters for agent completion triggers.
* *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/agent.rs:53-100`.
* Detected events:
  * Frame type: `event`
  * Event name prefix: `agent.hook.` with `hook_event_name` in `["stop", "sessionend"]`
  * OR `category == "turn-complete"`
* Converts raw events into an `AgentSessionCompleted` payload containing:
  * `surface_id`: UUID of the surface
  * `workspace_id`: Workspace containing the agent
  * `agent_kind`: Identifier of the agent (e.g. `claude`, `codex`)
  * `category`: `"turn-complete"`

---

## 4. Android Client Implementation (`android/`)

* **Framework:** 100% Kotlin & Jetpack Compose.
* **Rendering Strategy:**
  * Custom Compose Canvas drawing text runs using bundled `MapleMono-NF` (Maple Mono Nerd Font, `fonts/MapleMono-NF-Regular.ttf`).
  * *Evidence:* `ref/cmux-pocket/android/app/src/main/java/app/cmuxpocket/ui/TerminalCanvasRenderer.kt:18-25`, `ref/cmux-pocket/android/app/src/main/java/app/cmuxpocket/ui/TerminalCanvas.kt:149, 316`.
  * ARGB color memoization and row-level cache pictures prevent full repaints when only the cursor or single line changes.
* **Security & Tokens:**
  * Stores gateway endpoints and Bearer tokens in `EncryptedSharedPreferences` backed by the hardware Android Keystore.
  * Android auto-backup is disabled to prevent credential leakage: `android:allowBackup="false"`.
  * *Evidence:* `ref/cmux-pocket/README.md:18`, `ref/cmux-pocket/android/app/src/main/AndroidManifest.xml:22`.
* **Pairing:**
  * Camera scans pairing QR codes formatted with custom scheme:
    `cmux-pocket://import?v=1&host=<host>&port=<port>&tls=<true|false>&token=<token>&name=<name>`
  * *Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cli/src/uri.rs:112-143`, `ref/cmux-pocket/android/app/src/main/java/app/cmuxpocket/ui/CmuxImportUri.kt:47-60`.

---

## 5. Architectural Strengths & Key Limitations

### 5.1 Strengths:
1. **Lightweight Mobile Footprint:** No heavy VT100 / Xterm.js emulator needed on Android; server does the ANSI parsing and sends compact grid diffs.
2. **Robust Viewport Management:** Automatic viewport generation reporting and non-sticky leases prevent the mobile client from resizing or distorting the desktop user's terminal geometry permanently (`ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:159-206`).
3. **Loopback & Tunnel Security:** Zero unauthenticated exposure; built-in CLI wizards for Tailscale MagicDNS HTTPS and Cloudflare Tunnel (`ref/cmux-pocket/crates/cmux-pocket-cli/src/tailscale.rs`, `cloudflare.rs`).

### 5.2 Limitations:
1. **No iOS or Web Support:** The client is built exclusively with Kotlin/Jetpack Compose for Android.
2. **Terminal Grid Only (No Chat UI):** Lacks structured Agent Chat views (no message bubbles, collapsible reasoning/thinking blocks, or interactive git diffs).
3. **No Native Push Notifications:** Only alerts if the Android app is running in foreground/background with an active WebSocket connection. Does not support APNs (Apple Push Notifications) or Firebase Cloud Messaging (FCM) when the app is killed.
