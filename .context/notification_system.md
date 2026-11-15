# Notification System Architecture

This document specifies the notification system for **cmux-mobile**, detailing how events from `cmux` and background coding agents (`claude`, `agy`, `kiro`) are detected, categorized, and pushed to mobile (iOS / Android) and Web clients.

---

## 1. Notification Event Sources in cmux

`cmux` features an integrated notification classifier and event bus:

### 1.1 Notification CLI Commands
* **`cmux notify`**
  * Emits notifications with titles, subtitles, bodies, reply prompts, and workspace/surface associations.
  * *Evidence:* `ref/cmux/CLI/CMUXCLI+TaskHelp.swift:328-335`, `ref/cmux/CLI/cmux.swift:9447`, `ref/cmux/CLI/Commands/NotificationCommands.swift:14`.
  * Usage:
    ```bash
    cmux notify --title "Agent Ready" --body "Claude finished generating diff" --workspace <ws-id> --surface <surface-id>
    ```
* **Management Commands:**
  * `cmux list-notifications`
  * `cmux dismiss-notification`
  * `cmux mark-notification-read`
  * `cmux clear-notifications`
  * *Evidence:* `ref/cmux/CLI/cmux.swift:6920`, `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:253`.

### 1.2 Agent Hook Notification Classifier & Attention V1 Commands
In `ref/cmux/CLI/AgentHookNotificationPolicy.swift:10-58`, cmux categorizes agent events into four canonical groups:

| Category | Identifier | Trigger Scenarios | Priority | Default Action |
|---|---|---|---|---|
| **Needs Permission** | `needs-permission` | Agent pauses for tool execution approval, bash command confirmation, or interactive question | High (Actionable) | Interactive notification with "Approve" / "Deny" buttons |
| **Turn Complete** | `turn-complete` | Agent finishes current thinking/tool loops and reaches idle state | Normal | "Task completed" summary notification |
| **Idle Reminder** | `idle-reminder` | Agent has been waiting for human response for > N minutes | Low | Gentle reminder |
| **Other / Error** | `other` | Agent crashed, hit usage limits, or unhandled exception | Urgent | Error banner |

*Evidence:* `ref/cmux/CLI/AgentHookNotificationPolicy.swift:13-24`, `ref/cmux/CLI/FeedEventClassifier.swift:36, 455-517`.

#### Attention V1 Wire Format:
When an agent encounters a tool requiring approval (e.g. executing bash or modifying files), `FeedEventClassifier.swift:505` constructs an Attention V1 socket command:
```
notify_target_async <workspaceUUID> <surfaceUUID> <displayName>|<subtitle>|<body>|<meta>
```
1. **Pipe Delimiter Sanitization (`FeedEventClassifier.swift:511-517`):**
   * Input text is stripped of newlines, trimmed, and any literal pipe characters `|` are replaced with broken pipe `¦` (`\u{00A6}`) to prevent delimiter injection.
2. **Security & Privacy Boundary (`FeedEventClassifier.swift:450-454`):**
   * The notification body names **strictly the tool name** (e.g. `bash needs approval`), **never the tool arguments or inputs**:
     > *"The notification body deliberately names only the TOOL... and never the tool input: commands can embed credentials, and notification banners reach lock screens, paired phones, and the recorded notification history."*
3. **Structured Meta Segment (`AgentHookNotificationPolicy.swift:40-58`):**
   * Format: `c=<category>;p=<0|1>[;a=<agentKind>][;n=<0|1>][;k=<correlationKey>]`
   * `c=`: Category (`needs-permission`, `turn-complete`, `idle-reminder`).
   * `p=`: Pending status (`1` for active wait, `0` for settled).
   * `a=`: Case-preserving agent registry identifier (validated by `isValidAgentKindTag`, 1-64 ASCII `[A-Za-z0-9._-]`).
   * `n=`: Subagent flag (`1` for nested subagent worker, `0` or omitted for root).
   * `k=`: Opaque notification UUID correlation key.
4. **Resolution & Clearing (`FeedEventClassifier.swift:471-473`):**
   * When tool execution completes, the prompt is resolved and cmux emits:
     ```
     clear_notifications --tab=<workspaceUUID> --panel=<surfaceUUID>
     ```

---

## 2. Real-Time Detection via `cmux events`

The gateway connects to the live event stream by executing:
```bash
cmux events --category agent --category notification --reconnect --no-heartbeat
```
*Evidence:* `ref/cmux-pocket/crates/cmux-pocket-cmux/src/args.rs:258-268`.

### Event Frame Structure:
```json
{
  "type": "event",
  "name": "agent.hook.stop",
  "payload": {
    "hook_event_name": "stop",
    "surface_id": "surface-uuid-1234",
    "workspace_id": "workspace-uuid-5678",
    "agent": {
      "kind": "claude",
      "category": "turn-complete"
    }
  }
}
```
*Evidence:* `ref/cmux-pocket/crates/cmux-pocket-protocol/src/agent.rs:55-100`.

---

## 3. Push Delivery Pipeline (Mobile & Web)

```
┌────────────────────────────────────────┐
│              cmux daemon               │
│  - Emits socket events & notify hooks  │
└───────────────────▲────────────────────┘
                    │
                    │ stdout / `cmux events`
                    ▼
┌────────────────────────────────────────┐
│          cmux-mobile Gateway           │
│  - Parses & normalizes agent events    │
│  - Deduplicates repeated alerts        │
│  - Filters by user mute/focus rules    │
└─────────┬────────────────────┬─────────┘
          │                    │
  (App Connected)       (App Suspended / Killed)
          │                    │
          │ WebSocket          │ HTTPS Dispatcher
          ▼                    ▼
┌──────────────────┐  ┌───────────────────────────────────┐
│ Active Mobile /  │  │ Unified Push Notification Gateway │
│ Web Client (WSS) │  │ - APNs (Apple iOS / watchOS)      │
│ - In-app toast   │  │ - FCM (Android Google Play)       │
│ - Sound / Haptic │  │ - WebPush (Browser PWA / VAPID)   │
└──────────────────┘  └─────────────────▲─────────────────┘
                                        │
                                        ▼
                              ┌───────────────────┐
                              │ Mobile Lockscreen │
                              │ Actionable Prompt │
                              │ [Allow]   [Deny]  │
                              └───────────────────┘
```

### 3.1 Push Channels:
1. **APNs (Apple Push Notification service):**
   * Delivers low-latency alerts to iOS devices even when the app is suspended or killed.
   * Actionable categories: `CATEGORY_AGENT_PERMISSION` with actions `ACTION_APPROVE` and `ACTION_DENY`.
2. **FCM (Firebase Cloud Messaging):**
   * Delivers high-priority push messages to Android devices.
3. **WebPush (RFC 8291 / RFC 8292 with VAPID):**
   * Delivers desktop and mobile browser notifications for the Web PWA client without requiring native app stores.

### 3.2 Actionable Notification Payloads:
When receiving a `needs-permission` push, tapping "Approve" directly on the phone lock screen sends an authenticated mutation back to the Gateway:
```json
{
  "method": "mobile.terminal.input",
  "params": {
    "surface_id": "surface-uuid-1234",
    "text": "1",
    "kind": "key"
  }
}
```
* **Agent Approval Key Resolution:**
  * In `ref/orca/src/shared/native-chat/native-chat-agent-support.ts:66-68`, `nativeChatApprovalAcceptKey(agent)` resolves:
    * `opencode`: returns `\r` (Enter).
    * `claude`, `openclaude`, `codex`, `grok`, `omp`: returns `'1'` (or `'y'`).
  * The gateway checks the running surface's agent kind and maps the "Approve" action to the appropriate accept key.

## Real Web Push + PWA native feel (implemented)

Previously `PushService::dispatch` only logged (`push.rs`) and the client registered a fake subscription (`push.cmux.local`). Now:
- Gateway (`repos/cmux-gateway/src/push.rs`): VAPID P-256 keys generated once and stored in `~/.cmux/vapid.json` (0600); subscriptions persisted in `~/.cmux/push_subscriptions.json`; `dispatch` encrypts (aes128gcm) and POSTs via `web-push` crate; 404/410 endpoints pruned; `needs-permission` => urgency high, TTL 1h. `CMUX_VAPID_SUBJECT` overrides the `sub` claim.
- RPC: `mobile.push.vapidKey` -> `{public_key}` (base64url uncompressed point); `mobile.push.test` now sends a real notification.
- Client: `App.tsx` fetches the key, `pushManager.subscribe`, `mobile.push.register`; re-registers on each connect while permission is granted.
- Back navigation: `src/native/navigation.ts` (History API `pushState`/`popstate`; edge-swipe back only on iOS standalone to avoid double back on Android).
- Haptics: `src/native/haptics.ts`. Android: `navigator.vibrate`. iOS: a scripted `label.click()` does NOT vibrate (user-reported, matches ios-haptics README: needs a trusted tap on the label). Now every `<button>` gets a transparent `<label>` overlay wired to a hidden `<input type=checkbox switch>` (port of https://github.com/tijnjh/ios-haptics/blob/main/src/index.ts). Programmatic `haptic()` is a no-op on iOS (edge-swipe/back has no haptic there). [HYPOTHESIS - UNVERIFIED on device] verify: tap any button in the iPhone PWA (iOS >= 17.4, Settings > Sounds & Haptics > System Haptics ON).
- Push needs HTTPS origin (Tailscale HTTPS / tunnel); iOS needs Add to Home Screen (16.4+). Verification recipe: enable notifications in the app, then call `mobile.push.test` and check `/tmp/cmux-gateway.log` for "Web Push delivered".
