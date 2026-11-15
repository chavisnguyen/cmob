# Orca Companion Architecture & Chat UI Analysis

This document analyzes the architecture, protocol, and Chat UI implementation of [Orca](https://github.com/stablyai/orca) (by Stably AI), based on direct source code inspection of `ref/orca`.

---

## 1. High-Level Architecture Overview

Orca uses an Electron desktop application paired with a cross-platform mobile/web companion:

* **Desktop Host (Electron / Node.js):** Hosts a WebSocket RPC server on port `6768` (`DEFAULT_WS_PORT = 6768`, `ref/orca/src/main/runtime/rpc/server/runtime-rpc-pairing-types.ts:21`).
* **Companion Client (`mobile/`):** React Native / Expo application targeting iOS, Android, and Web (`mobile/web-entry`).
* **Transport & Security:** Authenticated JSON-RPC over WebSocket using device tokens or end-to-end encrypted (E2EE) session envelopes (`ref/orca/mobile/src/transport/rpc/rpc-wire-types.ts:8-31`, `ref/orca/src/main/runtime/rpc/mobile/e2ee/e2ee-channel.ts:1-60`).

---

## 2. Supported AI Coding Agents

Orca has native transcript parsing, status tracking, and chat interaction for leading CLI agents:

| Agent | CLI Binary / Invocation | Transcript / Log Format | References |
|---|---|---|---|
| **Claude Code** (`claude`, `openclaude`) | `claude -p --output-format stream-json` | JSONL in `~/.claude/projects/...` | `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:54-56` |
| **Antigravity** (`antigravity`, `agy`) | `agy` (Google Antigravity CLI) | JSONL in `<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl` | `ref/orca/src/shared/source-control/ai/generation/commit-message-plan.ts:71, 180-184`, `ref/orca/src/cli/accounts/account-selection.ts:4-8, 24` |
| **Kiro** (`kiro`) | `kiro-cli chat --tui` (`$KIRO_HOME` or `~/.kiro`) | Metadata `<id>.json` + `<id>.jsonl` transcript | `ref/orca/src/shared/agent-launch/catalog/tui-agent-config.ts:191-205`, `ref/orca/src/shared/kiro-home.ts:1-8` |
| **Codex** (`codex`) | `codex app-server` (JSON-RPC) | Rollout JSONL in `~/.codex/sessions/...` | `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:60` |
| **OpenCode** (`opencode`) | `opencode acp` (Agent Client Protocol) | SQLite DB / ACP events | `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:57-59` |

---

## 3. Orca Native Chat UI Breakdown (`ref/orca/mobile/src/session/native-chat/`)

Orca transforms raw terminal and agent JSONL transcripts into a modern, rich chat timeline rather than displaying raw ASCII terminal screens.

### 3.1 Key UI Components (`ref/orca/mobile/src/session/native-chat/`)
* **`MobileNativeChatView.tsx` (`ref/orca/mobile/src/session/native-chat/MobileNativeChatView.tsx:1-431`):**
  * The main virtualized chat container orchestrating message lists, gestures, and auto-scroll pins.
* **`MobileNativeChatReasoningRow.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatReasoningRow.tsx:1-130`) & Data Model (`ref/orca/src/shared/native-chat/transcript/native-chat-reasoning-row.ts:8-93`):**
  * Displays model thinking / chain-of-thought in an expandable accordion block with `Brain` and `ChevronRight` icons.
  * **Lifecycle & Headline Transitions:**
    * In-flight or uncompleted: `"Reasoning"`.
    * Completed without duration span: `"Thought"`.
    * Completed with duration: `"Thought for <duration>"` (formatted by `formatNativeChatDuration`).
  * **Disclosure State Store:** Keyed via `nativeChatReasoningDisclosureKey(messageId)` (`reasoning:<id>`) so virtualized row recycling never loses the user's expand/collapse preference.
  * **Bounded Height Scrollview:** Uses `MobileNativeChatOwnedScrollView` with `nestedScrollEnabled` to cap height so open streaming reasoning blocks cannot grow the transcript without bound (`MobileNativeChatReasoningRow.tsx:97-129`).
* **`MobileNativeChatToolRun.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatToolRun.tsx:1-365`):**
  * Renders individual tool calls (File Read, File Edit, Bash Execution, Web Search) with paired outputs (`pairNativeChatToolResults`).
  * Summarizes tool actions as natural sentences (`nativeChatToolRunSentence`, e.g. "Read 3 files").
  * Inlines file modifications via `buildEditCards` and `MobileNativeChatDiffCard.tsx`.
  * Caps open member listings at `MEMBERS_MIN_HEIGHT = 288` (matching desktop's 18rem).
* **`MobileNativeChatSubagentGroup.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatSubagentGroup.tsx:1-197`) & Data Model (`ref/orca/src/shared/native-chat/transcript/native-chat-subagent-summary.ts:1-70`):**
  * Groups parallel or hierarchical sub-agents into a collapsible card with `Bot` icon and status dot.
  * **Terminal States:** `idle`, `completed`, `failed`, `stopped`, `unverifiable`.
  * **Precedence Rules:**
    * Settled: `SETTLED_PRECEDENCE = ['failed', 'stopped', 'unverifiable', 'idle', 'completed']` (the worst outcome wins; `completed` only shows when all children succeed).
    * Adverse: `ADVERSE_PRECEDENCE = ['failed', 'stopped', 'unverifiable']` reported immediately so failures remain visible during fan-out.
  * **Defensive Normalization:** Unknown future agent states normalize to `unverifiable` rather than `working` so rows never spin indefinitely.
  * **Latching:** `canReplaceSubagentState(current, next)` prevents stale progress ticks from reverting settled children back to `working`.
  * **Isolated 1-Second Clock:** `Elapsed` component uses `useNow(1_000, counting)` so clock ticks cannot trigger re-renders of the parent message list (`MobileNativeChatSubagentGroup.tsx:37-49`).
  * **Token Scale Formatting:** `formatSubagentTokens` formats scale as `12.5k` or `1.2M` (`native-chat-subagent-group-header.ts:40-47`).
* **`MobileNativeChatAwaitingInputRow.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatAwaitingInputRow.tsx:1-117`):**
  * Activated when an agent requests tool permission, asks questions, or presents multi-choice prompts (`subject.kind === 'question'` or `'questions'`).
  * Announcements use accessible `accessibilityLiveRegion="polite"` so screen readers announce pending prompts whole.
* **`MobileNativeChatDiffCard.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatDiffCard.tsx:1-216`):**
  * Inlines syntax-highlighted git unified diffs for modified files directly within chat bubbles.
* **`MobileNativeChatRewindButton.tsx` (`ref/orca/mobile/src/session/native-chat/transcript/MobileNativeChatRewindButton.tsx:1-51`):**
  * Allows the user to rewind / rollback the agent's turn to an earlier prompt or checkpoint.
* **`extractAntigravityUserRequest` (`ref/orca/src/shared/agent-hook-listener/transcript-lines.ts:9-17`):**
  * Strips internal agent execution tags like `<USER_REQUEST>` and `</USER_REQUEST>` so that raw prompt metadata envelopes are never leaked into the user's conversational chat bubbles:
    ```typescript
    function extractAntigravityUserRequest(content: string): string | undefined {
        const opener = '<USER_REQUEST>';
        const startIndex = content.indexOf(opener);
        const bodyStartIndex = startIndex === -1 ? -1 : startIndex + opener.length;
        const endIndex = bodyStartIndex === -1 ? -1 : content.indexOf('</USER_REQUEST>', bodyStartIndex);
        const text = bodyStartIndex === -1 || endIndex === -1 ? content : content.slice(bodyStartIndex, endIndex);
        const trimmed = text.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    ```
  * Used in `extractUserPromptTextFromLine` when `record.source === 'USER_EXPLICIT' || record.source === 'USER'` and `record.type === 'USER_INPUT'`.
* **`NativeChatTurnActivityLine.tsx` (`ref/orca/src/renderer/src/components/native-chat/messages/reasoning/NativeChatTurnActivityLine.tsx:1-85`):**
  * Displays an immediate in-flight activity line directly below the user prompt or active turn while the agent is processing (`isWorking` or `isSubmitting`).
  * Features `data-native-chat-turn-activity="true"` with accessibility live region (`aria-live="polite"`, `aria-atomic="true"`).
  * Status label resolution via `describeNativeChatActiveTurnLabel(line)`: maps `'thinking'` to `"Thinking"`, `'stopping'` to `"Stopping…"`, `'working'` to `"Working…"`, or arbitrary tool/command activity text (`resolved.text`).
  * Prevents "dead air" feeling by providing instant visual and assistive-tech feedback the moment a turn is submitted or executing in background.

### 3.2 Tail Following, Scroll Anchoring & Long List Windowing

Direct inspection of `ref/orca/mobile/src/session/native-chat/transcript/use-mobile-native-chat-tail-follow.ts` and `MobileNativeChatPageList.tsx` reveals how Orca solves the long chat transcript problem:

1. **Auto-Pin to Tail on Enter (`use-mobile-native-chat-tail-follow.ts:60-105`):**
   * **Initial State:** `following: true` and `atTail: true`.
   * When an agent session mounts or content resizes, `pinToTail()` runs non-animated `scrollToEnd({ animated: false })` or `scrollToOffset({ offset: height })`.
   * Non-animated scroll is strictly required: competing animated endpoints drift backward during active token streaming.
2. **Threshold-Based Detachment (`AT_TAIL_SLOP = 80px`):**
   * `distanceFromTail(event) = contentSize.height - (contentOffset.y + layoutMeasurement.height)`.
   * When `distanceFromTail > 80`, the reader has scrolled up to inspect history: `following` switches to `false` and `showJumpToTail` becomes `true`.
   * The floating pill `NativeChatJumpToLatest` ("Jump to latest") animates into view. Tapping it triggers `scrollToEnd` and re-engages `following = true`.
3. **Windowed Memory Management for Long Sessions (`MobileNativeChatPageList.tsx:39-49`):**
   * `FIRST_ROWS = 24`, `DRAW_BATCH = 12`, `DRAW_AHEAD_SCREENS = 3`, `TRIM_SCREENS = 6`.
   * While following streaming output, rows drawn past 6 screens above the tail are trimmed from the DOM/renderer to prevent runaway memory consumption.
4. **Reading Drift Anchoring (`mobileNativeChatReadingPlace`):**
   * When prepending older history chunks, Orca anchors the first visible row (`minIndexForVisible: 0/1`) and offsets `scrollTop` by `(newScrollHeight - prevScrollHeight)` so the user's reading position never jerks or jumps.

---

## 4. Mobile RPC Methods (`ref/orca/src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing.ts`)

Orca desktop exposes granular RPC methods consumed by the mobile companion:

* **Session & Chat Methods:**
  * `nativeChat.readSession`: Reads the tail or paginated history of an agent transcript (`ref/orca/src/main/runtime/rpc/methods/native-chat/native-chat.ts:93-100`).
  * `nativeChat.subscribe`: Real-time WebSocket stream for new transcript turns and tool events.
  * `nativeChat.unsubscribe`: Tears down transcript listeners.
* **Terminal Fallback:**
  * `terminal.subscribe`: Streams raw terminal frames when switching from Chat mode to Terminal mode.
  * `terminal.input`: Sends keystrokes to the underlying PTY.
  * `terminal.resize`: Adjusts terminal dimensions.

---

## 5. Pairing, Authentication & E2EE Architecture

Direct inspection of `ref/orca` reveals a sophisticated 2-layer authentication and cryptographic framing architecture:

### 5.1 Pairing Offer & QR Encoding
* **`WebPairingOffer` Schema (`ref/orca/src/renderer/src/web/web-pairing.ts:20-28`):**
  The pairing payload contains:
  ```typescript
  export type WebPairingOffer = {
    v: 2
    endpoint: string           // e.g. "ws://192.168.1.50:6768" or "wss://..."
    deviceToken: string        // Temporary initial pairing token
    publicKeyB64: string       // Host ECDH public key (base64)
    pairedDeviceId?: string
    scope?: 'mobile' | 'runtime'
    hostDescriptor?: RuntimeHostDescriptor
  }
  ```
* **URI Scheme (`ref/orca/src/shared/remote-runtime/pairing/pairing.ts:12-25`):**
  * Format: `orca://pair?code=<base64url(json)>`
  * Android camera intents and Expo Router retain query parameters reliably.
  * Browser web client reads code from URL query params (`?pairing=`, `?pair=`, `?code=`, `?token=`) or URL hash (`#code=`) via `readPairingInputFromLocation` (`ref/orca/src/renderer/src/web/web-pairing.ts:56-75`).
  * Immediately after importing, Orca calls `window.history.replaceState` via `clearPairingInputFromAddressBar` (`ref/orca/src/renderer/src/web/web-pairing.ts:126-134`) to strip credentials from the address bar to prevent browser history leakage.

### 5.2 One-Time Ticket Exchange (`pairing.exchange-ticket`)
* **Source:** `ref/orca/mobile/src/pairing/pairing-ticket-exchange.ts:25-60`.
* **Mechanism:**
  1. Desktop displays a QR code with an initial pairing ticket.
  2. Mobile scans QR, connects, and checks if host supports `PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY`.
  3. Mobile generates 24 cryptographically random bytes: `ExpoCrypto.getRandomBytes(24)` formatted as a 48-character hex string.
  4. Mobile sends RPC call `pairing.exchange-ticket` with `{ deviceToken }`.
  5. The host invalidates the scanned QR ticket and latches the new client-generated `deviceToken`.
  6. *Security Benefit:* The QR code displayed on screen becomes single-use; eavesdroppers or screen onlookers cannot reuse the scanned code.

### 5.3 Cryptographic Framing & E2EE v2 Handshake
* **Source:** `ref/orca/src/renderer/src/web/web-token-framing.ts:25-75`, `ref/orca/src/renderer/src/web/web-runtime-connection-auth.ts:40-120`.
* Orca does not transmit bare tokens in plaintext over WebSockets. Instead, it runs an E2EE v2 handshake (`createPairedE2EEClientHandshake`) using ECDH P-256 key agreement (`WEB_PAIRED_E2EE_PRIMITIVES`, `ref/orca/src/renderer/src/web/web-paired-e2ee-primitives.ts:1-40`).
* **Device Keys (Ed25519) vs Token Fallback:**
  * Modern clients generate an Ed25519 signing keypair stored in secure enclave / IndexedDB (`web-device-key.ts`).
  * If the browser lacks Ed25519 capability, Orca shows a security guidance warning that the session is tab-limited or falls back to a reusable token (`ref/orca/src/renderer/src/web/web-pairing-security-guidance.ts:8-35`).

---

## 6. Lessons & Design Principles for cmux-mobile

1. **Dual-Mode Experience (Chat UI + Terminal Grid):**
   * Default to an Orca-style **Chat UI** for coding agents (`agy`, `claude`, `kiro`), because mobile users want clean summaries, collapsible reasoning, one-tap approvals, and diff cards.
   * Provide a quick toggle to switch into a **Terminal Grid** view (using `cmux-pocket`'s differential render grid) when low-level TUI access is required.
2. **Unified Transcript Tailers:**
   * Read agent transcripts directly from disk or hook session registries (`~/.cmuxterm/claude-hook-sessions.json`, `~/.kiro/`, `<appDataDir>/brain/`) as cmux's `agent-chat` sidecar does.
3. **Low-Latency Notification Bridge:**
   * Hook into cmux's `AgentHookNotifyCategory` (`needs-permission`, `turn-complete`) to push actionable notifications to phone lock screens.
4. **Pragmatic Pairing & Authentication Evolution:**
   * **Phase 1 (Essential Security):** Adopt Orca's QR encoding pattern (`cmux-mobile://pair?code=<base64url>`) and URL fragment importing (`#token=`), with Bearer token authentication over TLS / Tailscale / loopback.
   * **Phase 2 (Hardened E2EE & Ticket Swap):** Adopt Orca's `pairing.exchange-ticket` single-use ticket exchange and optional E2EE v2 cryptographic framing for open relay topologies.

---

## 7. Orca Composer Control Swap & Contextual Approval Semantics

### 7.1 Composer Action Swap (`Send` vs `Stop`)
* **Sources:**
  * `ref/orca/mobile/src/session/native-chat/composer/MobileNativeChatComposerSendSlot.tsx:80-110`
  * `ref/orca/mobile/src/session/native-chat/composer/mobile-native-chat-composer-layout.ts:1-12`
  * `ref/orca/src/renderer/src/components/native-chat/composer/controls/NativeChatComposerActions.tsx:106-177`
* **Orca Design Principle:**
  * Orca never displays a permanent, static interrupt button or sticky approval bar taking up persistent mobile viewport height.
  * Instead, Orca utilizes a **Dynamic Control Swap** in the composer's action slot:
    * When `isWorking` or `isSubmitting` is `true` AND no draft text is typed: the action button swaps into a `Stop` button (`Square` icon with `fill-current text-rose-400`). Tapping it sends an interrupt signal (`SIGINT` / `\x03`).
    * When draft text is present or the agent is idle: the button displays `Send` (`ArrowUp` / `Send` icon).
  * Rule function in `mobile-native-chat-composer-layout.ts`:
    ```typescript
    export function mobileNativeChatComposerShowsStop(input: {
      canStop: boolean;
      sendBlocked: boolean;
      canSend: boolean;
      editing: boolean;
      draft: string;
      attachmentCount: number;
    }): boolean {
      const nothingTyped = input.draft.trim().length === 0 && input.attachmentCount === 0;
      return input.canStop && (input.sendBlocked || nothingTyped || (!input.editing && !input.canSend));
    }
    ```

### 7.2 Contextual Approval Card (`MobileNativeChatPromptCard`)
* **Sources:**
  * `ref/orca/mobile/src/session/native-chat/conversation/MobileNativeChatPromptCard.tsx:1-85`
  * `ref/orca/src/renderer/src/components/native-chat/conversation/slots/native-chat-transcript-tail-row.ts:140-195`
* **Orca Design Principle:**
  * One-tap `Approve` and `Deny (X)` controls are strictly contextual. They are only rendered when the agent enters an `awaitingInput` / `needsInput` state (e.g. tool invocation confirmation, permission gate, or user prompt choice).
  * Once the turn completes or the user approves, the prompt card immediately dismisses, returning maximum screen real estate to the transcript.

### 7.3 Hook Lifecycle State Detection
* **Sources:**
  * `ref/orca/src/shared/agent-hook-listener/providers/antigravity-events.ts:25-95`
  * `ref/orca/src/shared/agent-hook-listener/compatible-lifecycle-events.ts:40-120`
* **State Machine Invariant:**
  * A running agent CLI (e.g. `agy`, `claude`) maintains its parent REPL process, which keeps the OS process alive (`pid` exists).
  * However, turn activity terminates when a hook event named `"Stop"`, `"StopFailure"`, or lifecycle `"idle"` / `"needsInput"` is received.
  * The gateway daemon must check `hook_event_name` before treating process status as `is_running = true`, preventing infinite spinning `Stop •` state indicators.

## Subagents & chat paging in Orca (verified 2026-11-14)
- Antigravity subagents: detected from the live hook stream, not transcripts. `src/shared/agent-hook-listener/providers/antigravity-events.ts:17-19` (`invoke_subagent`/`send_message` tools) records the caller's `conversationId` as `subagentParent` per pane (`:93-100`); later events with a different `conversationId` and no `lastUserInput` are dropped (`:73-81`, comment: "Subagents run inside the parent agy under their own conversationId and never carry user input"). Stop with fullyIdle=false is held open while helpers run (`:104-106`).
- Claude: hook payload `agent_id` present => child (`claude-events.ts:51,60`); transcripts use `isSidechain`/`parent_tool_use_id` (`src/main/claude/transcripts/claude-transcript-root-prompt.ts:6`).
- Mobile native chat session = the pane's `agentStatus.providerSession` (`mobile/src/session/native-chat/mobile-native-chat-eligibility.ts:64-79`), no "latest updated" scan. Subagents render inline in the parent transcript (`mobile-native-chat-projection.ts` `foldSubagentItems`) and as nested child rows in sidebar/dashboard.
- Paging: `INITIAL_LIMIT=40`, `PAGE=60`, `MAX_MESSAGES=2000` (`use-mobile-native-chat-session.ts:58-60`), offset cursor `beforeOffset` + `hasMore`; triggers: near-top scroll after a user drag (`MobileNativeChatView.tsx:255-268`) and geometry prefetch `at < 40 rows && screens < 10` (`transcript/MobileNativeChatPageList.tsx:45-46,277-279`), which also covers content shorter than the viewport; failure => tap-to-retry only.
- cmux-mobile difference: we only see the hook-store snapshot (last event per session), not the event stream, so we detect subagents from the transcript's first line (`SYSTEM_MESSAGE ... sender=<parent>`). Our paging re-reads with growing `max_turns` (15 + 15), not an offset cursor.

## Hidden / placeholder reasoning (verified 2026-11-14)
- Orca native chat has no Kiro transcript decoder: `resolveNativeChatTranscriptAgent` maps only claude/openclaude, opencode/opencode2/zcode, codex/grok/omp (`ref/orca/src/shared/native-chat/native-chat-agent-support.ts:50-64`).
- Orca's only Kiro transcript parser (AI Vault) reads the flat `<uuid>.json` + `.jsonl` store (`kind: Prompt | AssistantMessage | ToolResults`) and ignores ACP V3 `sessions/*/sess_*/messages.jsonl` (comment at `src/main/ai-vault/scanners/kiro/session-scanner-kiro-parser.ts:29-31`). It drops every `thinking` block (`toPreviewBlocks` keeps only text/json/toolUse/toolResult, `:37-64`).
- Claude analogue: a `thinking` block becomes a text block only when its text is non-empty (`src/main/native-chat/transcript-record-blocks.ts:78-82`); `redacted_thinking` (encrypted only) falls to `default` -> `null` (`:91-109`); a record whose blocks all decode to nothing is dropped (`transcript-line-decoders-claude.ts:110-112`). Same rule as cmux-mobile: placeholder/encrypted reasoning never renders.
- cmux-mobile: Kiro ACP V3 `Reasoning` with content `"..."` (+ `reasoningSignature`) skipped in `repos/cmux-gateway/src/scanner/transcript.rs` `parse_kiro_line`.

## Orca: which transcript/session a pane owns (verified 2026-11-14; corrects the Antigravity note above)
All in `ref/orca/src/shared/agent-hook-listener/pane-provider-session.ts` `readPaneProviderSession` (:44-107): "The provider session a hook names for its pane; child agents' hooks never name their own."
- Codex: any hook payload carrying `agent_id` is a child => returns `null`, so a subagent can never replace the pane's `providerSession`/`transcriptPath` (`:62-64`). Child events only update the roster (`providers/codex-events.ts:100-140, 229-262`); the roster is enriched from the child rollout's `session_meta` (`src/shared/codex-subagent-identity.ts`: `payload.source.subagent.thread_spawn`, `agent_nickname`, `agent_path`).
- Antigravity: Orca DOES read the transcript's first record. A hook only becomes the pane's session if the first record is `source === 'USER_EXPLICIT' && type === 'USER_INPUT'`; otherwise `null` (`:85-96`, reader `transcript-reader.ts:8-35`, "Read origin evidence from the first record only; later user records cannot establish root ownership"). This is the same signal cmux-mobile uses (first line `USER_INPUT` vs `SYSTEM_MESSAGE ... sender=`). The earlier statement "Orca does not read the transcript's first line" was wrong.
- Droid: sub-session detected by `callingSessionId` in the first record (`:111-121`); worker hooks keep the orchestrator's session.
- Difference: Orca filters at hook-ingest time. cmux writes `~/.cmuxterm/*-hook-sessions.json` itself without that filter and does not store `agent_id`, so cmux-mobile must repair afterwards: Antigravity via first-record check (`hook_store.rs::parent_session_id`), Codex via `session_meta.payload.parent_thread_id` (`resolve_codex_top_level_rollout`).

## Subagent cards in cmux-mobile (implemented 2026-11-14)
Chat shows one collapsible card per turn (existing `MobileNativeChatSubagentGroup`) fed by `AgentEvent::Subagents`:
- Codex (`scanner/transcript.rs`): paginated history -> `event_msg/item_completed` item `CollabAgentToolCall` with `tool:"spawn_agent"`, `receiver_agents[{thread_id, agent_nickname}]`, `prompt` (role from "You are the `Role`"); legacy history -> `function_call spawn_agent` + output `{"agent_id","nickname"}`. wait/close_agent hidden. State/tokens from the child rollout (`codex_child_status`: last `task_complete` => completed; `task_started` or no marker + written <= 10 min ago => working; else unverifiable; tokens = last `token_count.info.total_token_usage.total_tokens`). Child rollout located via `find_codex_rollout` (`~/.codex/sessions/Y/M/D/rollout-*-<thread id>.jsonl`). Verified live: Project C 3 children (1 completed, 2 unverifiable), Project B 3 completed. No failure marker observed => failed is never inferred.
- Antigravity: `invoke_subagent` card; the following `GENERIC` result `Created the following subagent: {"conversationId": ...}` binds the child id (and is no longer rendered as chat text); a later parent `SYSTEM_MESSAGE ... sender=<child id>` marks it completed. Verified live: ids bound, `completed`.
- Kiro: existing `sub_agent_start/complete` records.
- Not done: Claude subagents (no sample on this machine), per-child transcript drill-down, subagent badge in the surface list.
