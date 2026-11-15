# CONNECTIVITY & CLOUD INFRASTRUCTURE ARCHAEOLOGY
## Reverse-Engineered Connectivity Analysis Across Orca, cmux, and cmux-pocket

> **Standard:** 100% Evidence-based, strict zero-guessing, concrete citations with file paths and line numbers.

---

## 1. EXECUTIVE SUMMARY & CORE FINDINGS

### Core Question:
*"Do top-tier mobile companion applications (Orca, cmux, cmux-pocket) require an intermediate Cloud Backend (Relay), or can they operate via Direct LAN / P2P / VPN Tunnels?"*

### Authoritative Answer from Code:
**No single approach fits all needs, and an intermediate Cloud Relay is NOT strictly required for the core bidirectional control plane**, but **a Cloud Push Gateway is mandatory if native remote push notifications (Apple APNs / Google FCM) are required while the mobile device is backgrounded/locked.**

| Project | Default Transport | NAT Traversal Mechanism | Fallback Transports | Cloud Relay Needed? | Cloud Push Gateway Needed? | E2EE Architecture |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Orca** (`ref/orca`) | **Direct LAN / Tailscale** (`ws://<ip>:6768`) | Custom WebSocket Cloud Relay (`cloud/apps/relay`) | Cloud Relay (`wss://relay...`) | **Optional** (only outside LAN/Tailnet) | **Yes** (`cloud/apps/push` for APNs/FCM) | NaCl Box (Curve25519-XSalsa20-Poly1305) |
| **cmux** (`ref/cmux`) | **Iroh P2P QUIC** (by EndpointId) | Native Iroh QUIC Holepunching + DERP Relay | Tailscale (Opt-in), Direct LAN, WireGuard (Cloud VMs) | **No central custom relay** (uses decentralized Iroh relays) | **Yes** (`web/services/apns/` + Cloudflare Presence) | TLS 1.3 Raw Public Keys (Ed25519) + E2EE Push |
| **cmux-pocket** (`ref/cmux-pocket`) | **Loopback-Only** (`127.0.0.1:8088`) | External: Tailscale Serve HTTPS or Cloudflare Tunnel | USB Reverse Tether (`adb reverse`) | **None** (Zero cloud infrastructure) | **None** (No remote push notifications) | TLS terminated by Tailscale / Cloudflared |

---

## 2. DEEP DIVE: ORCA CONNECTIVITY ARCHITECTURE

### 2.1. Multi-Path Strategy: LAN, Tailscale, and Relay
Orca implements a **three-tier logical connection client** that dynamically adapts to network reachability:
- Defined in `ref/orca/mobile/src/transport/connection/stable-logical-rpc-client.ts:16`:
  ```typescript
  export type MobileConnectionPath = 'lan' | 'tailscale' | 'relay'
  ```
- Endpoint classifier in `ref/orca/mobile/src/transport/relay/mobile-direct-endpoint-probe.ts:5-7`:
  ```typescript
  export function directPathForEndpoint(endpoint: string): Exclude<MobileConnectionPath, 'relay'> {
    return isTailscaleEndpoint(endpoint) ? 'tailscale' : 'lan'
  }
  ```

### 2.2. Direct LAN Mode
- Desktop Orca listens directly on TCP port `6768` (`ref/orca/mobile/README.md:7`, `ref/orca/mobile/README.md:34`).
- Pairing: QR code encodes `ws://<desktop-ip>:6768` (`ref/orca/mobile/README.md:74-81`).
- Physical phones connect directly over LAN (e.g. `ws://192.168.0.179:6768`) or Tailscale IP.

### 2.3. Dynamic Path Migration: Automatic Upgrade from Relay to Direct
Orca's `MobileEndpointSupervisor` prioritizes low-latency direct connections over cloud relays:
- Inspected in `ref/orca/mobile/src/transport/connection/mobile-endpoint-supervisor.ts:44-47,106-127`:
  When connected via `'relay'`, the supervisor schedules `DirectReturnProbe` (`mobile-direct-return-probe.ts`).
- When the device re-enters the local Wi-Fi or connects to Tailscale, the supervisor performs a seamless in-place session migration (`logical.migrateTo(client, path)`) from Relay to LAN without dropping user interaction.

### 2.4. Why Orca Built `cloud/apps/relay`
- **NAT Traversal & Zero-Config Connectivity:** When users leave home/office without a VPN, standard WebSockets cannot traverse symmetric CGNAT or corporate firewalls.
- **Architecture (`ref/orca/cloud/apps/relay/`):**
  - Director-Cell topology (`app.ts:724-763`, `relay-server.ts:677-769`): Director maps `hostId` to assigned regional Cell servers.
  - Splicer (`ref/orca/cloud/apps/relay/src/connections/splice-forwarder.ts:48-74`): `wireSplice` pipes raw WebSocket frames between the mobile client (`/v1/connect/<hostId>`) and the desktop host (`/v1/host/data/<connId>`).
  - **Zero-Knowledge E2EE:** Relay never sees plaintext; frames are encrypted client-to-host using TweetNaCl Box (`ref/orca/mobile/src/transport/encryption/e2ee.ts:17-67`).

### 2.5. Why Orca Built `cloud/apps/push`
- **Mobile Background Suspension:** iOS and modern Android terminate background WebSockets within seconds to save battery.
- **Push Server Implementation (`ref/orca/cloud/apps/push/src/push-server.ts:63-100`):**
  - Manages Apple APNs (HTTP/2 transport via `node:http2`) and Google FCM (HTTP/v1 fetch).
  - Provides endpoints: `/v1/host/challenge` & `/v1/host/session` for host authentication, `/v1/devices` for device token registration, and `/v1/send` for dispatching notifications.
  - Desktop Orca invokes `PushGatewayClient` (`ref/orca/src/main/runtime/push/push-gateway-client.ts:60-95`) to wake the phone when background agents complete turns or ask questions.

---

## 3. DEEP DIVE: CMUX CONNECTIVITY ARCHITECTURE

### 3.1. Architectural Evolution: Tailscale to Iroh P2P
In `ref/cmux/plans/feat-ios-iroh/DESIGN.md:1-17`, the engineering decision was made (Lawrence, 2026-06-09):
- **Iroh became the DEFAULT transport; Tailscale became an opt-in fallback.**
- Rationale: Onboarding must "just work" with sign-in + dial-by-EndpointId, requiring **no VPN install, no network setup, and zero cloud port forwarding**.
- Protocol: Length-prefixed JSON frames (`MobileSyncFrameCodec`) ride on an Iroh QUIC bidirectional stream dialed by `EndpointId`.

### 3.2. Iroh P2P & Relay Topology
- **P2P QUIC Holepunching:** Uses n0 discovery and Iroh relays (`presets::N0` and `relay.n0.iroh-canary.iroh.link`). QUIC holepunches to a direct socket path whenever possible; if symmetric NAT prevents direct P2P, Iroh relays forward encrypted packets (`ref/cmux/plans/feat-ios-iroh/DESIGN.md:48-54`).
- **Cryptographic Security:** End-to-end encrypted with TLS 1.3 using raw public keys (`EndpointId` = 32-byte Ed25519 public key). Relays cannot decrypt traffic (`ref/cmux/plans/feat-ios-iroh/DESIGN.md:55-70`).
- **Iroh Relay Minter:** `ref/cmux/services/iroh-relay-minter/README.md:1-30` implements a Vercel Rust microservice holding `IROH_SERVICES_API_SECRET` to mint 24-hour RCAN tokens (`relay:use`) for client relay usage.

### 3.3. Cloud Infrastructure for Discovery & Presence
Although cmux uses P2P QUIC for data transport, it utilizes lightweight cloud services for discovery:
1. **Cloudflare Worker Presence (`ref/cmux/workers/presence/README.md:1-35`):**
   - Durable Objects (`TeamPresence`, `AccountControlPlane`) track online heartbeats (`/v1/presence/heartbeat`), snapshots, and control WebSocket (`/v1/control/socket`).
2. **Cloudflare Worker Iroh-v2 (`ref/cmux/workers/iroh-v2/README.md:1-25`):**
   - Manages global `EndpointID` ownership mapping and directory state backed by PlanetScale DB.

### 3.4. Other Transports in cmux
- **WireGuard Cloud VPN (`ref/cmux/Packages/iOS/CmuxMobileCloud/Sources/CmuxMobileCloud/`):**
  - Used for cloud VMs / remote development environments via `CloudSystemVPNController.swift` and `CloudAttachEndpoint.swift` (`ws://[vpc ipv6]:1337/v1/link`).
- **NIOSSH (`ref/cmux/Packages/iOS/CmuxMobileSSH/Sources/CmuxMobileSSH/SSHConnection.swift`):**
  - Direct SSH transport into servers.
- **Port Forwarding (`ref/cmux/Packages/iOS/CmuxMobileTunnel/Sources/CmuxMobileTunnel/TunnelPortForward.swift:1-57`):**
  - In-app loopback port forwarder (`ssh -L` pattern) to render localhost desktop web previews inside the iOS app.

### 3.5. cmux Push Notification Architecture
- **Web Push Gateway (`ref/cmux/web/services/apns/`):**
  - HTTP/2 APNs sender (`sender.ts:1-60`) using JWT ES256 authentication (`node:http2` + `node:crypto`).
  - Endpoints in Next.js: `/api/device-tokens` (device registration) and `/api/notifications/push` (trigger).
- **End-to-End Encrypted Push:**
  - `ref/cmux/web/services/apns/encryptedPayload.ts:1-20`: Defines `EncryptedPushPayload` (v2). The Mac encrypts notification content before sending it to the web gateway.
  - `ref/cmux/ios/NotificationService/NotificationService.swift:11-60`: An iOS `UNNotificationServiceExtension` intercepts the APNs notification, looks up pinned sender keys in Keychain, decrypts the payload client-side, and suppresses notifications if decryption or sender verification fails.

---

## 4. DEEP DIVE: CMUX-POCKET (ZERO CLOUD INFRASTRUCTURE)

### 4.1. The Loopback-Only Philosophy
`cmux-pocket` was deliberately designed with **zero hosted cloud servers**:
- The Rust gateway daemon (`cmux-pocket-gateway`) binds strictly to loopback:
  - Source: `ref/cmux-pocket/crates/cmux-pocket-macos/src/loopback.rs:72-90` (`validate_loopback_host`).
  - Strict rejection: Denies `0.0.0.0`, `::`, and public/LAN IPs. Only permits `127.0.0.0/8`, `::1`, and `localhost`.
  - Default listener: `ws://127.0.0.1:8088` (`ref/cmux-pocket/docs/networking.md:58-63`).

### 4.2. How Remote Connectivity Works Without a Cloud Server
cmux-pocket relies on **user-provided secure ingress tunnels**:
1. **Tailscale Serve HTTPS (`ref/cmux-pocket/docs/networking.md:121-167`):**
   - Command: `cmux-pocket setup --tailscale`.
   - Tailscale daemon terminates TLS on port 443 with a MagicDNS domain and reverse-proxies to `ws://127.0.0.1:8088`.
   - Android client connects securely to `wss://<mac-tailscale-name>:443` over the Tailnet VPN.
2. **Cloudflare Tunnel (`ref/cmux-pocket/docs/networking.md:191-260`):**
   - User runs `cloudflared` on macOS mapped to `http://127.0.0.1:8088`.
   - Cloudflare edge terminates public HTTPS/WSS and tunnels traffic securely to the Mac.
3. **USB Reverse Tethering:**
   - Command: `adb reverse tcp:8088 tcp:8088`.
   - Phone connects to `ws://127.0.0.1:8088` directly via USB cable.

### 4.3. The Inherent Limitation: No Remote Push Notifications
Because cmux-pocket has zero hosted servers:
- It **cannot send APNs or FCM push notifications**.
- When the Android app is closed or in deep sleep, it cannot receive alerts when Claude or Antigravity finishes a task.
- The user must keep the app foregrounded or manually inspect it.

---

## 5. COMPARATIVE TRADE-OFF MATRIX

| Dimension | Model 1: Cloud-Assisted (Orca / cmux) | Model 2: Self-Served / Pure Tunnel (cmux-pocket) |
| :--- | :--- | :--- |
| **User Setup Friction** | **Zero / Low**: Scan QR or sign in with account; connects instantly anywhere. | **Medium / High**: Requires setting up Tailscale on both devices or installing Cloudflare Tunnel (`cloudflared`). |
| **NAT Traversal** | Handled automatically via Relay (Orca) or Iroh P2P + DERP (cmux). | Handled by Tailscale WireGuard overlay or Cloudflare outbound tunnel. |
| **Background Push Notifications** | **Fully supported**: Desktop triggers Cloud APNs/FCM gateway to wake phone. | **Unsupported**: Impossible without a cloud backend holding Apple/Google push keys. |
| **Operating Cost** | Ongoing infrastructure cost (Relay servers, Cloudflare Workers, PostgreSQL, APNs certs). | **$0 / Free**: User provides own tunnels; no servers to maintain or scale. |
| **Security & Privacy** | Requires E2EE (TweetNaCl in Orca, TLS 1.3 in cmux) so cloud relay cannot snoop. | Highly secure by default; zero third-party relay code, traffic stays on private VPN/tunnel. |
| **Offline / Air-gapped LAN** | Fully supported in Orca via Direct LAN mode; cmux supports direct LAN fallback. | Supported via USB reverse or local TLS reverse proxy on LAN. |

---

## 6. ARCHITECTURAL RECOMMENDATION FOR CMUX-MOBILE

To achieve the best balance of user experience, privacy, and development speed, **cmux-mobile should adopt a hybrid, phased connectivity approach**:

1. **Phase 1 (Local & Direct First - Inspired by cmux-pocket & Orca LAN):**
   - Provide direct WebSocket connection on LAN (`ws://<lan-ip>:port` or `wss://` with self-signed/Tailscale).
   - Support Tailscale HTTPS out of the box via Tailscale Serve / Tailnet IPs (`isTailscaleEndpoint`).
   - Zero cloud infrastructure required for MVP development and local testing.
2. **Phase 2 (Decentralized P2P - Inspired by cmux Iroh):**
   - Implement Iroh P2P QUIC transport for peer-to-peer holepunching without deploying proprietary relay infrastructure.
3. **Phase 3 (Push Gateway - Inspired by Orca `cloud/apps/push` & cmux `web/services/apns`):**
   - Deploy a lightweight, dedicated Push Gateway service (Cloudflare Worker or minimal Node container) solely responsible for holding Apple APNs / Google FCM credentials and dispatching waking pushes.
   - Maintain strict End-to-End Encryption (E2EE) so the push server only carries opaque, encrypted ciphertext payloads.
