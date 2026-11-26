# cmux-mobile System Architecture

This document defines the complete architectural design of **cmux-mobile**, incorporating the **Web-First Local Gateway (2-Tier)** architecture, Orca-inspired Chat UI, and verified operational edge cases across `cmux`, `orca`, and `cmux-pocket`.

---

## 1. System Topology & Tier Architecture

```
                  ┌───────────────────────────────────────────────┐
                  │                 CLIENT LAYER                  │
                  │                                               │
                  │   ┌───────────────────┐   ┌───────────────┐   │
                  │   │ Mobile Safari/PWA │   │ Desktop Web   │   │
                  │   │ (Standalone Icon) │   │ (Any Browser) │   │
                  │   │ React 19 / Tailw. │   │ React DOM     │   │
                  │   └─────────▲─────────┘   └───────▲───────┘   │
                  └─────────────┼─────────────────────┼───────────┘
                                │ WSS                 │ WSS / WS
                                │ (Tailscale / CF)    │ (Direct LAN)
                  ┌─────────────▼─────────────────────▼───────────┐
                  │            GATEWAY LAYER (macOS DAEMON)       │
                  │                                               │
                  │              cmux-mobile Gateway              │
                  │            (Loopback Port 8088)               │
                  │                                               │
                  │  ┌─────────────────┐   ┌───────────────────┐  │
                  │  │ Static PWA Srv  │   │ Transcript Tailer │  │
                  │  │ (React Bundle)  │   │ (Claude/Agy/Kiro) │  │
                  │  └────────┬────────┘   └─────────┬─────────┘  │
                  │           │                      │            │
                  │  ┌────────▼──────────────────────▼─────────┐  │
                  │  │      VAPID Direct Web Push (HTTPS)      │  │
                  │  │  (Apple web.push / Google FCM Port 443) │  │
                  │  └────────┬────────────────────────────────┘  │
                  │           │                                   │
                  │  ┌────────▼────────────────────────────────┐  │
                  │  │    Dual-Transport cmux Bridge (CLI/UDS) │  │
                  │  └─────────────────────────────────────────┘  │
                  └───────────────────────▲───────────────────────┘
                                          │
                         Subprocess / CLI │ Unix Domain Socket
                         `cmux rpc / send`│ $TMPDIR/cmux-*.sock
                                          ▼
                  ┌───────────────────────────────────────────────┐
                  │                  HOST LAYER                   │
                  │                                               │
                  │               cmux App (macOS)                │
                  │  - Ghostty terminal core                      │
                  │  - Agent sessions (Claude Code, AGY, Kiro)    │
                  │  - Notification hooks & events                │
                  └───────────────────────────────────────────────┘
```

---

## 2. Gateway Layer (macOS Daemon)

The Gateway runs locally on the user's Mac alongside `cmux` and serves as both the static PWA web host and the bidirectional WebSocket control bridge:

### 2.1 Core Responsibilities:
1. **Loopback-Only Binding:** Listens strictly on `127.0.0.1:8088` by default to prevent accidental open-port internet exposure (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:95-120`, `ref/cmux-pocket/crates/cmux-pocket-macos/src/loopback.rs:72-90`).
2. **Bearer Token Authentication:** Every client must present a matching bearer token generated during pairing (`ref/cmux-pocket/crates/cmux-pocket-gateway/src/auth.rs:1-50`, `ref/cmux-pocket/crates/cmux-pocket-protocol/src/auth.rs:16-105`).
3. **Static PWA Serving:** Serves compiled Web UI assets (HTML, CSS, JS, manifest) with gzip compression and caching directly to connecting browsers (`ref/cmux/agent-chat/server.ts:2087-2109`).
4. **VAPID Direct Web Push Engine:** Generates ECDSA P-256 keys and dispatches encrypted Web Push notifications (RFC 8292 / RFC 8030) directly via outbound HTTPS POST (port 443) to Apple (`web.push.apple.com`) and Google FCM (`fcm.googleapis.com`) without any cloud server.

---

## 3. CRITICAL IMPLEMENTATION EDGE CASES & RESOLUTIONS

### 3.1. Edge Case 1: `SocketControlMode.cmuxOnly` Socket Permissions
* **Source Evidence:** [`ref/cmux/Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/SocketControlMode.swift:9-21`](./ref/cmux/Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/SocketControlMode.swift#L9-L21) defines 5 socket modes:
  ```swift
  public enum SocketControlMode: String, CaseIterable, Sendable, SettingCodable {
      case off
      case cmuxOnly      // Default
      case automation    // Permitted for agent hooks
      case password
      case allowAll
  }
  ```
* **Gotcha:** Under default `cmuxOnly`, external processes connecting directly to the raw Unix Domain Socket receive:
  `ERROR: Access denied - only processes started inside cmux can connect` ([`ref/cmux/CLI/cmux.swift:4667-4684`](./ref/cmux/CLI/cmux.swift#L4667-L4684)).
* **Resolution (Dual-Transport Bridge):**
  Following `ref/cmux/agent-chat/cmux-rpc.ts:9-20`, the Gateway wraps `cmux` CLI commands:
  - *Primary Transport:* Spawns `cmux` CLI (`cmux rpc <method> <params>`, `cmux send-key`, `cmux ping`, `repos/cmux-gateway/src/cmux/bridge.rs:41-106`).
  - *Live-Verified Correction (2026-11-14):* Running the `cmux` CLI binary alone does **not** bypass `SocketControlMode.cmuxOnly`. When `cmux-gateway` is launched via macOS `launchd` (`scripts/launchd/com.cmux.mobile.gateway.plist.template`, `XPC_SERVICE_NAME=com.cmux.mobile.gateway`), `/health` returns `{"cmux_alive":false}` and `mobile.workspace.tree` fails with `ERROR: Access denied - only processes started inside cmux can connect`, because `launchd` lacks `CMUX_SOCKET_CAPABILITY` and `cmux` process-tree ancestry.
  - *Verified Operational Resolution:* Start `./scripts/cmux-mobile start` from inside an interactive `cmux` surface (e.g. a dedicated `cmux-gateway` tab) so the daemon inherits `CMUX_SOCKET_CAPABILITY` and `cmux` process ancestry (`cmux_alive: true`, `mobile.workspace.tree` and `mobile.terminal.replay` succeed), unless `SocketControlMode` is relaxed to `automation`/`allowAll`.

### 3.2. Edge Case 2: Session Discovery & Surface Mapping
* **Source Evidence:**
  - **Claude & Codex Sessions:** cmux maintains hook state JSON files at `~/.cmuxterm/<agent>-hook-sessions.json` ([`ref/cmux/agent-chat/transcript-sources.ts:1-60`](./ref/cmux/agent-chat/transcript-sources.ts#L1-L60)). Each entry stores `surfaceId`, `sessionId`, `cwd`, `transcriptPath`, and `runtimeStatus`.
  - **Antigravity (AGY) Sessions:** Stored in `<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl`. Orca detects pending permissions via `ask_question` or `ask_permission` ([`ref/orca/src/shared/agent-hook-listener/providers/antigravity-events.ts:13-15`](./ref/orca/src/shared/agent-hook-listener/providers/antigravity-events.ts#L13-L15)).
* **Resolution:** Gateway maintains an **Active Session Scanner** that monitors both `~/.cmuxterm/*-hook-sessions.json` and `~/.gemini/antigravity-cli/brain/` to construct a live session directory.

### 3.3. Edge Case 3: iOS Safari Web Push Preconditions
* **Source Evidence:** Apple Safari on iOS enforces two strict requirements for the Web Push API:
  1. The web application **MUST be added to the iOS Home Screen** and launched as a standalone PWA. Standard Safari browser tabs have Web Push disabled.
  2. Calling `Notification.requestPermission()` **MUST be triggered by a direct user gesture** (e.g., tapping an explicit "Enable Notifications" button).
* **Resolution:** The Web PWA includes an automatic iOS detection hook displaying an Onboarding Guide: *"Tap Share $\to$ Add to Home Screen to enable instant lock screen notifications"*, followed by an explicit permission prompt.

### 3.4. Edge Case 4: Screen-Guarded Agent Approval Keystrokes
* **Source Evidence:** Different coding agents present different interactive confirmation prompts (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`, `repos/cmux-gateway/src/domain/dialog.rs:498-530`, `repos/cmux-gateway/src/cmux/agent_profile.rs`):
  - **Claude Code & Codex:** Terminal displays a numbered list where selecting `"1"` approves.
  - **Antigravity (AGY), Kiro & OpenCode:** Dialog confirms via `"enter"`, moving the highlight cursor up (`"up"`) first if a numbered menu currently highlights row `> 0`.
* **Resolution:** Gateway's `mobile.chat.approve` captures the terminal screen (`cmux/bridge.rs`), refuses startup dialogs and idle composer screens (preventing accidental `"1"` or `Enter` injection when already approved on desktop), and dispatches the profile-matched approval sequence.

### 3.5. Edge Case 5: Turn Interruption (`Escape` vs OpenCode Double-`Escape`)
* **Source Evidence:** In Claude Code, Codex, Antigravity, Kiro, and OpenCode TUIs, cancelling an in-flight turn or dismissing a prompt modal uses **`Escape`** (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:45-48`), whereas `SIGINT` (`Ctrl+C`) exits several agent CLIs if a turn just settled.
* **Resolution:** Gateway's `mobile.chat.interrupt` (`repos/cmux-gateway/src/services/agent_control.rs:13-29`, `domain/dialog.rs:534-549`, `cmux/bridge.rs:276-289`) resolves `agent_kind` and sends `"escape"` for Claude/Codex/Antigravity/Kiro, and two `"escape"` keys separated by `60ms` for OpenCode (`opencode` / `opencode2`).

---

## 4. Pairing & Remote Network Connectivity

1. **One-Tap QR Code Pairing:**
   * Mac Gateway prints a QR code containing deep-link `cmux-mobile://pair?code=<base64url>` or direct PWA URL `http(s)://<tailscale-ip>:8088/#token=<token>` (adapted from Orca's pairing schema, [`ref/orca/src/shared/remote-runtime/pairing/pairing.ts:12-25`](./ref/orca/src/shared/remote-runtime/pairing/pairing.ts#L12-L25), and cmux-pocket URI, [`ref/cmux-pocket/crates/cmux-pocket-cli/src/uri.rs:112-143`](./ref/cmux-pocket/crates/cmux-pocket-cli/src/uri.rs#L112-L143)).
   * Scanning the QR in the mobile browser stores credentials into encrypted browser `localStorage`, then sanitizes the address bar using `history.replaceState` to prevent token leakage in history or bookmarks ([`ref/orca/src/renderer/src/web/web-pairing.ts:107-116`](./ref/orca/src/renderer/src/web/web-pairing.ts#L107-L116)).
2. **Zero-Trust Ingress Options:**
   * **Tailscale MagicDNS & Funnel (Primary):** `cmob qr --tailscale` enables `tailscale funnel --bg --yes 8088` (`repos/cmux-gateway/src/cli.rs`) to provide public TLS/HTTPS on `https://<mac-tailnet-domain>:443` forwarding to local port `8088`, avoiding DoH / iCloud Private Relay / PNA DNS failures with the Pages-only web app while enforcing gateway auth tokens and single-use pairing tickets.
   * **Direct LAN (Fallback):** Connect to `ws://<local-mac-ip>:8088` within trusted local Wi-Fi networks.
   * **Cloudflare Tunnel (Alternative):** Run `cloudflared tunnel` forwarding to `http://127.0.0.1:8088` ([`ref/cmux-pocket/docs/networking.md:191-260`](./ref/cmux-pocket/docs/networking.md#L191-L260)).

---

## 5. cmux-Native 3-Level Navigation Hierarchy & Adaptive Surface UI

To deliver a developer experience 100% true to the macOS `cmux` desktop client, the mobile interface implements a strict 3-level navigation hierarchy backed directly by live `cmux` RPC and session hook stores:

```
┌────────────────────────────────────────────────────────┐
│ LEVEL 1: WORKSPACES LIST (Sidebar / Home View)         │
│ Matches cmux macOS sidebar:                            │
│ - Pin icon 📌, Custom Title ("Project A", "Tools")     │
│ - Status badge: ⚡ Running (blue) / ⚪ Idle (gray)     │
│ - Current working directory (~/Documents/...)          │
│ - Recent turn / notification snippet (lastBody)        │
└───────────────────────────┬────────────────────────────┘
                            │ tap workspace
                            ▼
┌────────────────────────────────────────────────────────┐
│ LEVEL 2: SURFACES / TERMINALS LIST (Workspace View)    │
│ Lists all surfaces / tabs in active workspace:         │
│ - Surface type: Terminal 💻 / Markdown 📄 / Browser 🌐  │
│ - Tab title ("Đồng bộ dữ liệu...", "lazygit", "~")     │
│ - Active agent badge (Claude / AGY / Codex)            │
│ - Selected tab indicator                               │
└───────────────────────────┬────────────────────────────┘
                            │ tap surface
                            ▼
┌────────────────────────────────────────────────────────┐
│ LEVEL 3: SURFACE DETAIL (Adaptive UI)                  │
│                                                        │
│  ┌─────────────────────────┐  ┌─────────────────────┐  │
│  │ A: AGENT CHAT VIEW      │  │ B: RAW TERMINAL     │  │
│  │ (If agent is active)    │  │ (Shell / non-agent) │  │
│  │                         │  │                     │  │
│  │ - Collapsible Reasoning │  │ - Differential PTY  │  │
│  │ - Tool execution cards  │  │ - Mobile quick-keys │  │
│  │ - One-tap Approval Bar  │  │ - ANSI colors       │  │
│  │ - Toggle raw terminal   │  │                     │  │
│  └─────────────────────────┘  └─────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### 5.1 Source Evidence & Data Mapping:
1. **Level 1 (Workspaces):**
   - Populated from `cmux rpc workspace.list` and `cmux tree --json`.
   - Workspace status (`⚡ Running` vs `⚪ Idle`) is evaluated by querying `~/.cmuxterm/<agent>-hook-sessions.json` for active sessions matching `record.workspaceId == workspace.id && record.runtimeStatus == "running"` (mirroring `ref/cmux/CLI/cmux.swift:2337-2382`).
   - Snippet text is populated from `record.lastBody` or `workspace.latest_conversation_message`.
2. **Level 2 (Surfaces):**
   - Populated from `cmux tree --json` under `panes[].surfaces[]` (`title`, `type`, `tty`, `ref`, `selected`).
   - Mapped to `activeSessionsBySurface` in hook store to detect if an AI agent is attached.
3. **Level 3 (Adaptive Surface):**
   - If surface has an active agent session $\to$ renders Orca-style Chat UI with live turn streaming from `transcriptPath` and interactive approval buttons.
   - If surface is a standard terminal $\to$ renders differential terminal screen with touch-optimized modifier keys.
   - A persistent header button allows instant switching between Chat UI and Raw Terminal view on any surface.


## Surface agent detection (false-positive chat UI fix)

Verified live (gateway `mobile.workspace.tree` vs `cmux tree --json` + `ps -axo tty=,command=`):
- `~/.cmuxterm/*-hook-sessions.json` keeps ended sessions with `lifecycle: running`, so `HookStoreIndex::get_active_session_for_surface` returned a stale agent for a plain shell (ttys005, project-a-workspace).
- `recognize_standby_agent` stripped the path from a cwd-style title (`…/personal/tool/tool-x` -> `tool-x` -> `starts_with("agy")`), and `REMEMBERED_SURFACES` latched it forever (ttys012).

Fix (`repos/cmux-gateway/src/scanner/workspace_tree.rs`): `scan_agent_processes_by_tty()` (`ps -axo tty=,command=`) is authoritative. Hook/Kiro/cached identities are kept only while an agent process of that kind owns the surface's tty; otherwise the cache entry is dropped. Title heuristic is fallback only when the tty is unknown, and only strips absolute paths. If `ps` fails, legacy behaviour is retained. Limitation: assumes the gateway runs on the same host as cmux (same as the existing Kiro tty scan).

---

## 6. Clean Architecture Layering (2026-11-26 Overhaul)

To eliminate monolithic "God-files" and state drift across providers, both Gateway and Client enforce strict inward dependency rules inspired by `ref/orca`:

### 6.1 Gateway Layers (`repos/cmux-gateway/src/`)
```text
transport/ (http_routes.rs, http_guard.rs, ws_session.rs, client_registry.rs,
            rpc/{mod, chat, chat_options, terminal, workspace, push_device, host_tools}.rs)
    │
    ▼
services/  (session_state.rs [SessionStateService — Single Source of Truth],
            agent_control.rs, chat_stream.rs, terminal_stream.rs,
            notification_dispatcher.rs, notification_sources.rs)
    │
    ▼
domain/    (Pure zero-I/O: lifecycle.rs, canonical_turn.rs, noise_filter.rs,
            receipt_normalizer.rs, dialog.rs [box-aware TUI dialog & menu planners])
    ▲
    │
providers/ & io/ (providers/{claude, codex, antigravity, kiro, opencode, common}.rs
                  + io/jsonl_window.rs [safe \n-bounded 64 KiB window + 64B boundary digest])
```
* **Invariants:**
  - `SessionStateService` (`services/session_state.rs`) is the single authority for surface agent resolution (requiring live TTY `agent_kind` match), lifecycle state (`Working | Waiting | Done | Error | Idle`), awaiting prompts, and notifications across all 5 agents (including Kiro and OpenCode).
  - `io/jsonl_window.rs`, `providers/*`, and `domain/canonical_turn.rs` enforce stable byte-offset/row-anchored turn IDs (`turn-@<offset>`, `turn-oc-<seq>`), FIFO tool pairing (`VecDeque` in `providers/antigravity.rs`), `clean_agy_args_json` unquoting, harness noise stripping (`domain/noise_filter.rs`), and structural `turn_digest` hashing so `services/chat_stream.rs` pushes every in-place mutation over `delta` frames.

### 6.2 Client Layers (`repos/cmux-client/src/`)
```text
views/ & components/ (Thin <300-line presentational shells: App, Desktop/MobileWorkspaceShell,
                      SurfaceDetailView, OrcaChatView, ChatTimelineRow, ChatBottomDock, RawTerminalView)
    │
    ▼
state/     (Focused hooks/controllers: useHostSession, useWorkspaceStore, useNavigationShell,
            useNotificationController, useChatSessionController, useTerminalController)
    │
    ▼
domain/    (100% pure reducers & scoped stores: chat/{transcriptReducer, toolPairing,
            workRunGrouping, liveStatus, dockSelector, disclosureStore, composerStore, chatViewModel},
            workspaceTree, notificationCenter, terminalState)
    │
    ▼
transport/ (tokenVault, pairingClient, wsClient) ──▶ protocol/ (wire types)
```

---

## 7. Pure Raw-Speed Transport & Kernel Fast-Paths (2026-11-26)

1. **Persistent Pooled Unix Domain Socket Bridge (`repos/cmux-gateway/src/cmux/uds_client.rs:1-315`, `repos/cmux-gateway/src/cmux/bridge.rs:42-312`):**
   - `CmuxUdsPool` maintains 4 persistent `tokio::net::UnixStream` slots connected directly to `cmux.sock` (`$CMUX_SOCKET_PATH`, `~/.local/state/cmux/cmux.sock`, `/tmp/cmux-<uid>.sock`, `/tmp/cmux.sock`), routing `system.ping`, `system.tree`, `surface.read_text`, and all `rpc` / `rpc_call` (`workspace.list`, `notification.list`, `mobile.terminal.*`) in **~0.6–0.9 ms** (vs **30–40 ms** per `cmux` CLI fork/exec), with automatic 1-retry reconnect on EOF and transparent fallback to the `cmux` CLI binary on `Unavailable` / `AccessDenied` (`SocketControlMode.cmuxOnly`) or mock `with_cli_path` tests.
2. **Native macOS `<libproc.h>` + `KERN_PROCARGS2` Process Scanner (`repos/cmux-gateway/src/scanner/macos_proc.rs:1-290`, `repos/cmux-gateway/src/scanner/workspace_tree.rs:744-805`):**
   - On `#[cfg(target_os = "macos")]`, enumerates PIDs in RAM via `libc::proc_listallpids` + `libc::proc_pidinfo(PROC_PIDTBSDINFO)`, skips non-TTY processes (`e_tdev == NODEV`), maps `e_tdev` via `devname_r`, and queries `sysctl([CTL_KERN, KERN_PROC, KERN_PROCARGS2, pid])` strictly for TTY processes in **1.54 ms** (vs **70.95 ms** spawning `/bin/ps -axo`), preserving the `ps` path on Linux CI.
3. **Event-Driven `kqueue` (`EVFILT_VNODE`) Transcript & Hook Watcher (`repos/cmux-gateway/src/io/file_watch.rs:1-275`, `repos/cmux-gateway/src/services/chat_stream.rs:228-292`):**
   - Registers `O_EVTONLY` descriptors for the active transcript file and `~/.cmuxterm` hook directory on a non-blocking `kqueue` wrapped in `tokio::io::unix::AsyncFd::register_with_interest(..., Interest::READABLE)`, waking `chat_watcher_stream` in **< 1 ms** (+ `8 ms` micro-batch coalesce) instead of waiting on a blind `500 ms` polling timer.
4. **Session-Scoped RAM Caches & Async Route/Component Splitting (`repos/cmux-client/src/hosts/workspaceCache.ts`, `repos/cmux-client/src/components/chat/chatTranscriptCache.ts`, `repos/cmux-client/src/views/SurfaceDetailView.tsx`, `repos/cmux-client/src/components/terminal/useXtermInstance.ts`):**
   - Client caches live strictly in session RAM (`Map`, zero stale `localStorage` flash; legacy keys purged on load) while lazy-loading `OrcaChatView` (warmed 120ms after first paint), `RawTerminalView`, `@xterm/addon-webgl`, `PairHostModal`, `ChangesPanel`, `UsageView`, and `DeviceListView`, cutting the initial entry bundle from **1,373.7 KB** to **405.8 KB** (`123.8 KB` gzip).
