# cmux-mobile Development Roadmap & Task Backlog

This document defines the actionable milestones, implementation phases, and test gates for **cmux-mobile**, following the **Web-First Local Gateway (2-Tier)** architecture.

---

## Milestone 1: Shared Protocol & Wire Specifications
- [x] **M1.1: Coordinator Hub Workspace Scaffolding:**
  - Setup coordinator hub layout (`repos/cmux-gateway`, `repos/cmux-client` powered by Vite+ `vp`, `scripts/`, `documents/`, `secrets/`, `Makefile`).
  - Tested and verified: `make build`, `make test`, `make help`.
- [x] **M1.2: Authentication Protocol:**
  - Implemented handshake frames (`auth`, `auth_ok`, `auth_error` with close code 1008) in Rust (`repos/cmux-gateway/src/protocol/auth.rs`) and TypeScript (`repos/cmux-client/src/protocol/auth.ts`) based on `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:310-340`.
- [x] **M1.3: QR Pairing URI Format & Address Bar Sanitization:**
  - Implemented QR pairing payload with base64url JSON offer (`cmux-mobile://pair?code=...`) inspired by Orca (`ref/orca/src/shared/remote-runtime/pairing/pairing.ts:12-25`, `ref/orca/src/renderer/src/web/web-pairing.ts:28-40`).
  - Implemented browser address bar secret stripping (`clearPairingFromAddressBar` with `history.replaceState`) after token import (`ref/orca/src/renderer/src/web/web-pairing.ts:107-116`).
  - Unit tests verified: Rust (`cargo test`) and Vitest (`vp test`).
- [x] **M1.4: Unified Agent Event Model:**
  - Defined `AgentEvent`, `AgentTurn`, `AgentRole`, `SubagentEntry`, `AwaitingInput` types in Rust (`repos/cmux-gateway/src/protocol/event.rs`) and TypeScript (`repos/cmux-client/src/protocol/event.ts`) based on `ref/orca/src/shared/native-chat/native-chat-types.ts:1-120` and `ref/cmux/agent-chat/types.ts:1-110`.
- [x] **M1.5: JSON-RPC Wire Contract:**
  - Defined standard RPC envelope (`JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`) and error codes in Rust (`repos/cmux-gateway/src/protocol/rpc.rs`) and TypeScript (`repos/cmux-client/src/protocol/rpc.ts`) based on `ref/cmux-pocket/crates/cmux-pocket-protocol/src/rpc.rs:7-13`.
  - Methods defined: `mobile.chat.sessions`, `mobile.chat.readSession`, `mobile.chat.subscribe`, `mobile.chat.unsubscribe`, `mobile.chat.send`, `mobile.chat.approve`, `mobile.chat.interrupt`, `mobile.host.status`, `mobile.workspace.list`, `mobile.push.register`.
- [x] **M1.6: Tier 1 Test Gate:**
  - Implemented unit tests validating golden Claude transcript fixtures from `ref/cmux/agent-chat/test/transcript.test.ts:50-64` in both Rust (`cargo test`) and TypeScript (`vp test`).
  - All 12 Rust tests and 11 Vitest tests passing with 0 warnings and 0 errors.

---

## Milestone 2: Gateway Core & cmux Socket Integration (macOS Rust Daemon)
- [x] **M2.1: Rust Gateway Server & Loopback/Tailscale Enforcement:**
  - Built Tokio + Axum server listening on port `8088` with strictly enforced loopback/Tailscale bind validator (`src/loopback.rs`, `ref/cmux-pocket/crates/cmux-pocket-gateway/src/server.rs:95-120`).
  - Implemented static asset handler embedding Vite+ React 19 PWA bundle via `rust-embed` with MIME type resolution and SPA fallback (`src/static_files.rs`).
  - Implemented WebSocket upgrade at `/ws` with mandatory 5s authentication handshake frame enforcement and close code `1008` rejection (`src/server.rs`).
  - Added CLI banner and `/api/pairing` endpoint exposing `PairingOffer` and deep-link URI (`cmux-mobile://pair?code=...`).
- [x] **M2.2: Dual-Transport cmux Bridge:**
  - Implemented Dual-Transport Bridge (`src/cmux/bridge.rs`) resolving `SocketControlMode.cmuxOnly` (`ref/cmux/Packages/macOS/CmuxSettings/Sources/CmuxSettings/Values/SocketControlMode.swift:9-21`):
    - Primary Transport: Blessed subprocess execution for `cmux rpc`, `cmux send-key`, `cmux ping` (`ref/cmux/agent-chat/cmux-rpc.ts:9-20`).
    - Approval mapping: `"1"` for Claude/Codex, `"\r"` (Enter) for Antigravity/Kiro (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`).
    - Interrupt mapping: `SIGINT \x03` via `cmux send-key --surface=<id> $'\x03'`.
    - Live verified against running cmux app (`cmux_alive: true`).
- [x] **M2.3: Active Session Scanner & Multi-Agent Transcript Tailers:**
  - Scan `~/.cmuxterm/<agent>-hook-sessions.json` for Claude & Codex active surfaces (`ref/cmux/agent-chat/transcript-sources.ts:1-60`).
  - Scan `<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl` for Antigravity (AGY).
  - Kiro: **correction (2026-11-14)** the earlier `~/.kiro/sessions/*.jsonl` path was wrong. Verified layout is `<KIRO_HOME>/sessions/<hash>/sess_<uuid>/messages.jsonl` + `session.json`, with live leases in `<KIRO_HOME>/session-leases/sess_<uuid>.lease` (see M5.5).
  - Implement 3-Level Navigation RPC:
    - `mobile.workspace.tree`: Returns full hierarchy matching cmux macOS sidebar (`id`, `title`, `pinned`, `status: running/idle`, `cwd`, `lastBody`, `surfaces: [...]`).
    - `mobile.workspace.list`: Summary of active workspaces.
    - `mobile.surface.get`: Metadata, terminal PTY status, active agent session.
  - Implement keystroke mapping for approvals: `"1"` for Claude/Codex vs `"\r"` for Antigravity/Kiro (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`).
  - Implement interrupt mapping: `SIGINT \x03` via `cmux send-key --surface=<id> $'\x03'`.
  - Audited and verified with 22 Rust tests, 12 TypeScript unit tests, and live cmux WebSocket integration (`scripts/test_live_tree.js`).
- [x] **M2.5: Tier 2 Test Gate (Offline Mock & Golden Fixtures for CI/CD):**
  - Saved sanitized golden test fixtures in `fixtures/` and `repos/cmux-gateway/tests/fixtures/` (`cmux_tree.json`, `cmux_workspace_list.json`, `claude_hook_sessions.json`, `antigravity_hook_sessions.json`, `claude_transcript.jsonl`, `antigravity_transcript.jsonl`).
  - Implemented `repos/cmux-gateway/tests/offline_mock_test.rs` executing offline in 0.01s without requiring a live cmux socket (adapted from `ref/cmux-pocket/crates/cmux-pocket-cmux/src/mock.rs:1-50` and `ref/orca/mobile/src/test-support/rpc-recording/README.md:1-100`).
  - Added automated GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- [x] **M2.4: VAPID Web Push Engine:**
  - Implemented `PushService` in `repos/cmux-gateway/src/push.rs` for subscription lifecycle and bounded deduplication.
  - Implemented RPC methods `mobile.push.register` and `mobile.push.test` in `repos/cmux-gateway/src/server.rs`.
  - Integrated `web-push` engine for RFC 8291 / RFC 8292 push dispatch.

---

## Milestone 3: Mobile-First Web PWA & Orca Chat UI (cmux-Native 3-Level Navigation)
- [x] **M3.1: PWA Setup & iOS Safari Onboarding:**
  - Configured PWA manifest (`public/manifest.webmanifest`), theme-color, touch icons, and viewport-fit=cover in `index.html`.
  - Implemented iOS Safari PWA Onboarding Banner in `src/App.tsx` and standalone mode detection in `src/notifications/pushManager.ts`.
  - Persistent WebSocket transport with auto-reconnect, token modal, and connection indicator (`src/transport/wsClient.ts`).
- [x] **M3.2: Level 1 — Workspaces View (cmux macOS Sidebar Look):**
  - Rendered list of workspaces matching cmux macOS sidebar: Pin icon 📌, custom title, status badge (`⚡ Running` / `⚪ Idle`), working directory, and notification snippet (`lastBody`) (`src/views/WorkspaceListView.tsx`).
- [x] **M3.3: Level 2 — Surfaces & Terminals List View:**
  - Tapping a workspace navigates into surface list: Terminal 💻 / Markdown 📄 / Browser 🌐 tabs with active selection and agent indicators (`src/views/SurfaceListView.tsx`).
- [x] **M3.4: Level 3 — Adaptive Surface View (Orca Chat vs Terminal):**
  - If Agent session active $\to$ renders Orca-style Chat View.
  - If standard shell/tab $\to$ renders Terminal View with interactive modifiers.
  - Persistent header switch toggle between Chat UI and Raw Terminal (`src/views/SurfaceDetailView.tsx`).
- [x] **M3.5: Orca-Style Chat Timeline & Reasoning Accordion:**
  - Message timeline supporting 60 FPS scrolling and streaming tokens (`src/components/chat/OrcaChatView.tsx`).
  - Collapsible thinking card with Brain icon and disclosure state memory.
- [x] **M3.6: Tool Execution Cards & Sub-Agent Cards:**
  - Render terminal commands, file reads, and file edits with status badges and paired outputs (`src/components/chat/OrcaChatView.tsx`).
- [x] **M3.7: Orca Composer Control Swap & Contextual Approval Card:**
  - Dynamic Control Swap (`ref/orca/mobile/src/session/native-chat/composer/MobileNativeChatComposerSendSlot.tsx:80-110`): Send button swaps dynamically into a Stop button (`Square` icon, `text-rose-400`) when agent is working/submitting and input draft is empty; reverts to Send arrow when typing or idle.
  - Contextual Approval Card (`ref/orca/mobile/src/session/native-chat/conversation/MobileNativeChatPromptCard.tsx:1-85`): Removed static sticky bottom bar taking up permanent viewport space; replaced with contextual approval card rendered strictly when `latestAwaiting` is present with one-tap `Approve` and `Deny (X)`.
  - Keystroke mapping: `\r` (Enter) for Antigravity/Kiro vs `1` for Claude/Codex (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`).
  - Mobile Horizontal Scroll Elimination: Enforced `[overflow-wrap:anywhere] min-w-0 max-w-full break-all` across `NativeChatProse.tsx` matching Orca markdown CSS, `overflow-x-hidden` on scroll containers, and replaced `w-screen` (`100vw` scrollbar overflow) with `w-full max-w-full`.
  - Hook State Termination Detection: Refactored `HookSessionRecord::is_running()` to check `"Stop"` / `"StopFailure"` / `idle` hook events before treating process as running, eliminating infinite spinning `Stop •` state.
- [x] **M3.8: Orca Mobile Parity Upgrade (Bottom Pinning, Windowing & Live Sending):**
  - **Immediate Bottom Pinning:** Implemented Orca Mobile's pinning lifecycle (`pinToTailAfterContentResize` / `scrollToEnd({ animated: false })`) with double-RAF and `ResizeObserver` on `contentRef` so opening a surface anchors directly at the newest turn.
  - **Long Turn Pagination & Windowing:** Added 30-turn windowing with top "Load earlier messages (X earlier)" header and auto-pagination on scroll (`scrollTop < 60`) with delta scroll-height compensation to prevent jumping.
  - **Consecutive Tool Aggregation:** Stripped empty reasoning/delta events so sequential tool executions fold into a single compact sentence row (`Ran X commands • Done`).
  - **Verified cmux Literal Text Injection:** Replaced faulty `cmux send-key` with `cmux send [--surface=<id>] --force -- <text>\n` (`cmux send --help`), allowing bidirectional mobile chat prompts to deliver cleanly to cmux agents.
  - **Immediate Live Feedback (`NativeChatTurnActivityLine`):** Implemented Orca parity activity line (`ref/orca/src/renderer/src/components/native-chat/messages/reasoning/NativeChatTurnActivityLine.tsx:1-85`) rendering immediate spinner and status ("Thinking…", "Working…") when `isWorking` or `isSubmitting` is active, wired directly to gateway `mobile.chat.readSession` (`is_working`, `last_event`, `last_subtitle`).
  - **Orca Sleek Scrollbars:** Added `data-orca-scrollbars="sleek"` and custom CSS scrollbar rules from Orca mobile web bundle to `index.html`.
  - **Live Verification via MCP:** Verified via MCP `1craft-browseruse` on real Chrome (CDP port 9222, profile `chrome-profile`).

---

## Milestone 4: Remote Ingress, Notifications & E2E Validation
- [x] **M4.1: Remote Ingress Automation:**
  - Automated Tailscale HTTPS Serve background proxy via `scripts/tailscale.sh` (`tailscale serve --bg 8088`), MagicDNS resolution (`machine.tailnet.ts.net`), and terminal QR code emission.
- [x] **M4.2: Web Push Service Worker & ANSI Color Engine:**
  - Registered Service Worker at `/sw.js` (`public/sw.js`), handling push events and lock-screen notification clicks with deep-linking to active session surfaces.
  - ECMA-48 ANSI SGR color parser in `ansiParser.ts` for real-time mobile terminal stream.
- [x] **M4.3: Tier 3 Test Gate (Live Multi-Agent E2E Integration):**
  - Live interactive validation with running `cmux`, `antigravity-cli`, and `claude`. Verified dual-agent transcripts, 1-tap approvals (`\r` vs `1`), interrupt, and key dispatch over both localhost and Tailscale WSS.
- [x] **M4.4: iOS WebClip Persistence & 100dvh Viewport Fixes:**
  - Dynamic 100dvh viewport layout and safe-area inset preservation preventing bottom composer clipping on Safari/Chrome iOS (`src/index.css`, `src/App.tsx`, `src/views/SurfaceDetailView.tsx`, `src/components/chat/OrcaChatView.tsx`, `src/components/terminal/RawTerminalView.tsx`).
  - Standalone iOS WebClip 4-tier token cross-hydration (URL hash `#token=...`, HTTP `Set-Cookie`, `localStorage`, `sessionStorage`, and early inline script in `index.html`, `static_files.rs`).
  - Verified across 22 client Vitest tests, 52 gateway Cargo tests, and live curl probes.
- [x] **M4.5: iPhone Dynamic Island / Notch & Safe-Area Layout Stabilization:**
  - Analyzed architecture of major production PWAs (Telegram Web, Linear, Twitter, Discord, Orca).
  - Extended Level 3 header height to `calc(2.75rem + env(safe-area-inset-top, 0px))` with `padding-top: env(safe-area-inset-top, 0px)` at `SurfaceDetailView.tsx:158`, seamlessly extending background `#1a1b24` behind the Dynamic Island / Notch while positioning controls safely in the 44px band below the status bar.
  - Padded global status bar and PWA banner in `App.tsx:203,224` with `env(safe-area-inset-top)`.
  - Added horizontal `safe-left safe-right` utilities across all headers, lists, and bottom action composers to protect against landscape notch collisions.
  - Formally verified and signed off by independent clean-context auditor in Section 27 of `audit_report.md`.
- [x] **M4.6: Keyboard Gap Elimination & Header De-Blur / Edge-to-Edge Parity:**
  - Replaced `apple-mobile-web-app-status-bar-style: black-translucent` with `content="black"` in `index.html:14`, permanently eliminating Apple WebKit's top frosted blur overlay (`UIVisualEffectView`) over the header.
  - Eliminated redundant `safe-left safe-right` utilities in `SurfaceDetailView.tsx:158`, `App.tsx`, and list views, curing the pinched-in ("lẹm vào") margins and restoring natural edge-to-edge `px-3` layout.
  - Implemented dynamic iOS virtual keyboard tracking via `window.visualViewport` (`window.innerHeight - vv.height > 100`) in `OrcaChatView.tsx:215-239,345-349` and `RawTerminalView.tsx:102-121,238-242`. When keyboard appears, `safe-bottom` (34px) is removed and replaced with tight `pt-1.5 pb-1.5`, making the composer sit flush with zero dead space above the keyboard.
  - Set CSS `--app-height: ${vv.height}px` on `#root` and `body` in `App.tsx:154-171` and `index.css:8,11,14`.
  - Formally verified and signed off by independent clean-context auditor in Section 28 of `audit_report.md`.
- [x] **M4.7: Cache-Control Headers, In-App Reload & WebKit Viewport Scroll Lock:**
  - Injected strict HTTP Cache-Control headers in `cmux-gateway/src/static_files.rs:37-51`: `no-cache, no-store, must-revalidate, max-age=0` on `index.html` and SPA fallbacks, and `public, max-age=31536000, immutable` on `/assets/*`. Cured iOS WebClip stale bundle caching across app restarts.
  - Added dedicated in-app Force Reload button (`RefreshCw`) with query parameter cache-busting timestamp (`?reload=<timestamp>`) and `v4.6.2` version badge in `App.tsx:185-193,272-286` and `SurfaceDetailView.tsx:164-172,211-218`.
  - Enforced iOS WebKit layout viewport scroll lock (`window.scrollTo(0, 0)`) on input focus and visualViewport resize across `App.tsx:157-182`, `OrcaChatView.tsx:220-263,420`, and `RawTerminalView.tsx:104-125,262`, preventing WebKit from scrolling the header off screen and creating an extraneous 50px keyboard gap.
  - Formally audited and signed off by independent clean-context auditor in Section 29 of `audit_report.md`. All 22 client tests and 52 gateway tests PASS.

---

## Milestone 5: Production Hardening, Surface Management & Mobile Experience

- [x] **M5.1: Real-Time Web Push Trigger Daemon & Background Hook Dispatcher:**
  - Implemented background hook push dispatcher `spawn_push_dispatcher` in `repos/cmux-gateway/src/server.rs:65-115`, ticking every 2000ms and monitoring `HookStoreIndex::scan_dir()`.
  - Dispatches `"{agent} Needs Approval"` (`needs-permission`) with 15s cooldown on `AgentLifecycleState::Waiting`.
  - Dispatches `"{agent} Turn Complete"` (`turn-finished`) with 20s cooldown on `AgentLifecycleState::Done`.
  - Burst cooldown gate `should_dispatch(surface_id, category, cooldown_secs)` in `repos/cmux-gateway/src/push.rs:78-89` keying on `"{surface_id}:{category}"`, matching Orca's `reserveNotificationCooldown` standard (`ref/orca/src/main/runtime/push/notifications/terminal-agent-phone-push.ts:125-128`).
  - Ring buffer history in `PushService` (capacity 50) and RPC endpoint `mobile.push.history` in `server.rs:470-478`.
  - Added CLI bridge methods `new_split_surface` and `close_surface` with RPC handlers `mobile.surface.new` and `mobile.surface.close` in `bridge.rs:266-297` and `server.rs:479-519`.
  - Audited and verified by clean-context subagent in Section 30 of `audit_report.md`. All 22 client tests and 54 gateway tests PASS.

- [x] **M5.2: Surface & Session Management from Mobile (Quick Switcher, Create, Close):**
  - Implemented `NewSurfaceModal.tsx` in `repos/cmux-client/src/components/surface/` with presets for login shell, Claude Code (`claude`), and Antigravity (`agy`), direction selector (`right` vs `down`), and custom command support.
  - Implemented `CloseSurfaceDialog.tsx` with process-termination warning and high-contrast destructive action.
  - Implemented `QuickSurfaceSwitcher.tsx` horizontal ribbon matching Orca session tabs standard (`ref/orca/src/renderer/src/components/native-chat/session/status/structured-agent-session-tabs.ts:1-50` and `native-chat-tab-agent-entry.ts:1-15`) with surface type icons, real-time agent status indicators (`running` pulse, `waiting` bounce), active tab auto-scroll (`scrollIntoView`), inline tab close button, and quick split button.
  - Updated `SurfaceListView.tsx` with active status badge, TTY path, live AI agent indicators, quick-action split modal, and surface closure dialog.
  - Updated `SurfaceDetailView.tsx` with Orca tab retention pattern (`ref/orca/src/renderer/src/components/editor/model-lifetime/retention/closed-editor-tab-controller.ts:43-100`) redirecting focus to sibling surfaces upon closure or returning cleanly to `SurfaceListView`, mounting `QuickSurfaceSwitcher` beneath the compact 44px mobile header.
  - Wired `handleCreateSurface` (`mobile.surface.new`) and `handleCloseSurface` (`mobile.surface.close`) in `App.tsx` triggering immediate workspace tree synchronization.
  - Formally audited and signed off by independent clean-context auditor in Section 31 of `audit_report.md`. All 25 client tests, 54 gateway tests, and live WebSocket probes PASS.

- [x] **M5.3: Terminal Touch Enhancements & Extended Modifiers:**
  - Implemented extended modifier key rail in `repos/cmux-client/src/components/terminal/RawTerminalView.tsx` matching Orca standards (`ref/orca/mobile/src/terminal/terminal-accessory-keys.ts:1-180` and `terminal-key-definitions.ts:1-220`): directional navigation (`↑`, `↓`, `←`, `→`), shell symbols (`|`, `/`, `~`, '`', `-`, `_`), control chords (`^C`, `^D`, `^Z`, `^L`, `^R`), and essential keys (`Esc`, `Tab`, `⇧Tab`, `Enter`).
  - Implemented Orca sticky modifier state machine (`ref/orca/mobile/src/terminal/terminal-sticky-modifiers.ts:1-47`): 3 states (`off`, `once` armed with amber indicator, `locked` with pulsing white indicator), 350ms double-tap lock window, and automatic one-shot consumption on character dispatch.
  - Added dynamic 6-step font zooming presets (`[0.75, 0.85, 1.0, 1.15, 1.3, 1.5]`) matching `ref/orca/mobile/src/terminal/terminal-text-scales.ts:1-3` with +/- zoom controls, percentage indicator, and `localStorage` persistence.
  - Added momentum touch scrolling (`-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain`), floating "Latest" scroll-to-bottom snap button, and terminal blinking block cursor representation.
  - Added `TERMINAL_READ` and `TERMINAL_SEND` constants to `RPC_METHODS` in `rpc.ts`.
  - Added 5 unit tests in `terminalEnhancements.test.ts`.
  - Formally audited and signed off by independent clean-context auditor in Section 32 of `audit_report.md`. All 30 client tests, 54 gateway tests, and live WebSocket key/text probes PASS.

- [x] **M5.4: Native macOS `launchd` Service & CLI Daemon Manager:**
  - Created native macOS `launchd` Property List template `scripts/launchd/com.cmux.mobile.gateway.plist.template` conforming to Apple LaunchAgent specs (`KeepAlive.Crashed: true`, `SuccessfulExit: false`, `ProcessType: Interactive`, explicit Apple Silicon / Intel Homebrew `PATH`, and standard stdout/stderr logs in `~/.cmux/logs/`). Verified with Apple `plutil -lint`.
  - Created comprehensive CLI daemon manager `scripts/cmux-mobile` with 10 subcommands (`status`, `start`, `stop`, `restart`, `logs`, `install`, `uninstall`, `url`, `qr`, `help`), robust PID validation via `kill -0`, launchd integration, and live HTTP health probing.
  - Implemented automated test harness `scripts/test_daemon_manager.sh` (5/5 tests passing).
  - Orca architectural parity referenced from `ref/orca/src/shared/serve-bundle-coordination.ts:6-26`, `ref/orca/src/shared/serve-bundle-park.ts:1-75`, and `ref/orca/docs/agents-md-refs/macos-daemon-tcc-attribution.md:1-100`.
  - Formally audited and signed off by independent clean-context auditor in Section 33 of `audit_report.md`. All 30 client tests, 54 gateway tests, and 5 daemon manager tests PASS.

  - Subagent clean-context audit and sign-off in Section 33 of `audit_report.md`.

- [x] **M5.5: Realtime Chat Subscription, Pairing Endpoint/Ticket Exchange, Kiro & Codex Adapters (2026-11-14):**
  - `mobile.chat.subscribe`/`unsubscribe` implemented: per-connection `chat_watcher` pushes `mobile.chat.update` on change (`server.rs`); client `SurfaceDetailView.tsx` subscribes, re-subscribes on reconnect, and keeps a 5 s safety poll (1 s when not subscribed). Test: `server::tests::chat_watcher_pushes_on_transcript_change`.
  - Pairing: client honors `offer.endpoint` (validated `ws:`/`wss:`), one-time ticket exchange (`pairing_store.rs`, `POST /api/pair/exchange`), device tokens persisted 0600. Fixed gateway emitting `wss://` for a plain-HTTP listener. Test: `server::tests::pairing_ticket_exchange_flow`, `pairing_store::tests`.
  - Kiro: `scanner/kiro_store.rs` maps lease `parentPid` -> `ps -o tty=` -> cmux surface `tty`; `TranscriptReader::parse_kiro_line` handles user/assistant(Reasoning|Say|Summary)/tool_call/tool_result/pending_interaction/interaction_resolved/sub_agent_*/turn_end. Verified against 16 real local sessions (671 turns, no parse failures; 3 `error` events == 3 `turn_end stopReason=error`) and live `cmux tree` (2 Kiro surfaces attached).
  - Codex: `parse_codex_line` handles `session_meta.history_mode` paginated (`event_msg/item_completed`: UserMessage, AgentMessage, CommandExecution) vs legacy (`response_item`: message, function_call(_output), custom_tool_call(_output)). Shapes taken from `ref/orca/src/main/codex/__fixtures__/codex-rollout-*.jsonl` and Orca scanner tests. **[HYPOTHESIS - UNVERIFIED]** against a live Codex install (none on this machine; `~/.codex` absent) and against legacy `response_item.message.content` arrays (`output_text`/`input_text`). Verify: run `codex` in a cmux surface, then `cat ~/.cmuxterm/codex-hook-sessions.json` and call `mobile.chat.readSession` for that surface. Codex sessions still depend on cmux writing `codex-hook-sessions.json` with `transcriptPath` (not verified here).
  - Still open: terminal streaming/resize/ack, real Web Push delivery (`push.rs:133` is still a stub), E2EE/key pinning, heartbeat/sleep-wake recovery, Kiro approval keystroke `\r` not re-verified against Kiro CLI.

- [x] **M5.6: Orca-Parity Live Terminal (`@xterm/xterm`), Desktop/Mobile View Toggle & Tab Management (2026-11-14):**
  - Replaced `<pre>` polling + `$` command bar in `repos/cmux-client/src/components/terminal/RawTerminalView.tsx` with real `@xterm/xterm` + `Unicode11Addon` + `WebglAddon` (with DOM fallback on context loss), driven by `mobile.terminal.subscribe` / `mobile.terminal.update` and `convertRenderGridToAnsi` (`repos/cmux-client/src/components/terminal/renderGridToAnsi.ts`).
  - Removed font size zoom controls (`FONT_SCALES` / `ZoomIn` / `ZoomOut`) per user requirement.
  - Added **Desktop / Mobile** view toggle (`Monitor` / `Smartphone` + live `cols×rows` badge) using `repos/cmux-client/src/components/terminal/terminalViewport.ts`: Mobile mode calculates `cols×rows` from container + xterm cell metrics and sends `mobile.terminal.viewport`; Desktop mode clears mobile viewport override (`clear: true`) and applies Orca `computeDesktopFitScale` + pinch-to-zoom & `clampDesktopPan`.
  - Direct PTY keystroke input (`term.onData` -> `mobile.terminal.input`), clipboard `Paste` (`mobile.terminal.paste`), sticky `Ctrl`/`Alt` latches, DECCKM arrow encoding, touch scrollback / `mobile.terminal.scroll`, and keyboard dismiss.
  - Tab management (`+Tab`, Rename, Close — no horizontal/vertical splits): `repos/cmux-gateway/src/cmux/bridge.rs:267-306` (`new_surface`, `rename_tab`), `repos/cmux-gateway/src/server.rs:1124-1195`, `NewSurfaceModal.tsx`, `RenameSurfaceModal.tsx`, `QuickSurfaceSwitcher.tsx`, `SurfaceListView.tsx`, `SurfaceDetailView.tsx`, and `App.tsx`.
  - Verified with `make test` (41 lib + 41 bin + 2 integration Rust tests; `vp check` clean; 35/35 client tests across 6 files) and `make build` (production PWA + release `cmux-gateway` binary).

- [x] **Live Deployment & Operational Findings (2026-11-14):**
  - **Root cause of blank white screen on phone reload:** Running `./scripts/cmux-mobile restart` from an ephemeral agent `exec_command` shell caused its `nohup` child process (`PID 73683`) to be reaped when the command exited, leaving port `8088` offline and causing Tailscale Serve (`https://machine.tailnet.ts.net`) to return `502`.
  - **Root cause of `launchd` `cmuxOnly` failure:** Installing via `./scripts/cmux-mobile install` (`~/Library/LaunchAgents/com.cmux.mobile.gateway.plist`) kept the daemon alive, but `cmux ping` (`/health` `cmux_alive: false`) and `mobile.workspace.tree` failed with `ERROR: Access denied - only processes started inside cmux can connect`. `launchd` does not inherit `CMUX_SOCKET_CAPABILITY` or `cmux` process ancestry.
  - **Verified fix:** Uninstalled the `launchd` plist and launched `./scripts/cmux-mobile restart` inside a dedicated `cmux` tab (`cmux-gateway`, `surface:1000050047` in `workspace:1000050004`), yielding `PID 75796`, `HTTP/2 200 OK` on `https://machine.tailnet.ts.net/` + `/assets/index-puuqldG4.js`, `{"cmux_alive":true}`, `7` workspaces via `mobile.workspace.tree`, and `132x52` `render_grid` via `mobile.terminal.replay`.
  - **Build script note:** `scripts/build.sh:18` quotes the glob `rm -rf "$ROOT/repos/cmux-gateway/assets/*"`, so stale hashed JS/CSS files accumulate in `repos/cmux-gateway/assets/assets/` across builds (harmless to `index.html`, slightly increases embedded binary size).

- [x] **M5.7: Orca Mobile UI/UX Ergonomics & Monochrome Theme Overhaul (2026-11-14):**
  - Replaced generic dark-navy/indigo styling with Orca Mobile neutral monochrome palette (`#0a0a0a` base, `#141416` panels, `#242428`/`#262626` raised controls, `#3276f2` accent, `ref/orca/mobile/src/theme/mobile-theme.ts:7-45`).
  - Decluttered Level 3 header (`repos/cmux-client/src/views/SurfaceDetailView.tsx:222-358`): removed 4 cramped `12px` icon buttons from the top bar, expanded header height to `52px` + safe-area-top with readable `15px` title, `Chat | Term` segmented control, and a single `⋯` (`MoreHorizontal`) menu (`44px` rows for New Tab, Rename Tab, Reload App, Close Tab).
  - Upgraded tap targets & typography across `App.tsx:266-352`, `WorkspaceListView.tsx:16-94`, `SurfaceListView.tsx:45-210`, `QuickSurfaceSwitcher.tsx:28-112`, `RawTerminalView.tsx:830-1030` (`36px` Orca keycaps matching `ref/orca/mobile/src/terminal/session/terminal-dock-styles.ts:4-110`, `13px` key labels, white latch border & inverted solid-white lock), `OrcaChatView.tsx:400-450` (`15px` input to avoid iOS Safari auto-zoom, `36px` Send/Stop button), and `NewSurfaceModal.tsx` / `RenameSurfaceModal.tsx` / `CloseSurfaceDialog.tsx` (`44px` inputs & buttons).
  - Verified with `make test` (41 lib + 41 bin + 2 integration Rust tests; `vp check` clean; 35/35 client tests), `make build`, and live restart inside `surface:1000050047` (`PID 84611`, `HTTP/2 200 OK` on `/assets/index-BANQd68Z.js`, `cmux_alive: true`).
