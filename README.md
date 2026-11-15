# cmob - Cmux Mobile

**Watch and control your [cmux](https://cmux.com/) terminals and coding agents (Claude Code, Antigravity, Kiro, Codex) from your phone.** Get notified when an agent needs you or finishes, chat with it, and see or type into its terminal, from a web app (PWA) that runs over your own Tailscale network.

---

## Architecture Overview

cmux-mobile follows a **Web-First Local Gateway (2-Tier)** architecture structured as a Coordinator Hub:

```
cmux-mobile/
├── repos/
│   ├── cmux-gateway/    # High-performance Rust daemon (Tokio, Axum, rust-embed)
│   └── cmux-client/     # Mobile & Web PWA Companion (Vite+, React 19, Tailwind CSS, Oxlint)
├── documents/           # Project specifications and architecture documents
├── scripts/             # Coordinator scripts (init, dev, build, test, tailscale)
├── secrets/             # gitignored local credentials & VAPID keys
├── .context/            # Persistent long-term agent memory (strictly evidence-based)
└── Makefile             # Developer shortcuts (make init, make dev, make build, make test)
```

For complete technical specifications, see [`.context/architecture.md`](.context/architecture.md) and [`.context/protocol_spec.md`](.context/protocol_spec.md).

---

## Install

```bash
brew tap chavisnguyen/cmob
brew install cmob
```

You need the [cmux](https://cmux.com/) app on your Mac and [Tailscale](https://tailscale.com/) on the Mac and the phone (it gives the phone the HTTPS address that the camera, push and the PWA need).

## Use

In a terminal **inside cmux**:

```bash
cmob setup            # one time: token, autostart, gateway, Tailscale Serve
cmob qr --tailscale   # prints a QR code; scan it from the app
cmob status           # is it healthy, who is connected
```

On the phone, open the web app, then menu → **Hosts & devices** → **Scan**. The code works once and expires after 10 minutes. Every phone gets its own token and shows up by name. Run `cmob qr --tailscale` again for another phone.

| Command | What it does |
|---|---|
| `cmob setup` | One-time setup (run inside cmux). Safe to run again |
| `cmob qr --tailscale` | QR code that pairs a phone |
| `cmob status` | Gateway, cmux, Tailscale, connected clients, paired devices |
| `cmob devices` / `cmob devices revoke <id>` | List paired phones, or cut one off |
| `cmob start` / `stop` / `restart` | Control the background gateway |
| `cmob logs [-f]` | Show or follow the gateway log |
| `cmob uninstall` | Remove autostart and stop the gateway |

`cmob setup` adds a small, clearly marked block to `~/.zshrc` (the previous file is saved as `.zshrc.cmob.bak`) so the gateway starts whenever a terminal opens inside cmux. `cmob uninstall` removes it.

## Build from source

Needs Rust 1.80+, Node 20+, `pnpm` 9+ and [Vite+](https://viteplus.dev) (`curl -fsSL https://vite.plus | bash`).

```bash
make init      # check prerequisites, install dependencies
make build     # client + gateway into one binary: repos/cmux-gateway/target/release/cmob
make install   # build, then run `cmob setup` (inside cmux)
make dev       # gateway on :8088 plus the Vite+ dev server
make test      # gateway and client tests
```

---

## Security model
* The gateway listens on `127.0.0.1` only. Phones reach it through Tailscale Serve, so it is visible to your tailnet and not to the internet. Tailscale (WireGuard) is the encrypted transport; the gateway adds no end-to-end encryption of its own.
* **Anyone who is paired can read and type into your terminals and agents.** Pair only devices you control, and cut off a lost phone with `cmob devices revoke`.
* The gateway token lives in `~/.cmux/gateway-token` (mode 600, created on first use). It is passed to the process through the environment, never the command line. Per-device tokens are stored in `~/.cmux/devices.json` and expire after 90 days without use.
* Pairing codes carry a single-use ticket and never the gateway token.
* Requests with an unexpected `Host` or `Origin` header are rejected (DNS-rebinding guard). Add extra hostnames with `CMUX_ALLOWED_HOSTS`.

## Why `cmob setup` must run inside cmux
cmux only answers socket clients that were started inside cmux (`cmux socket-status` shows `cmuxOnly`). A launchd service is outside cmux, so its gateway connects but shows no workspaces. That is why autostart is a shell hook: every terminal cmux opens runs it. cmux also has a `password` socket mode, but changing it is a security decision for the machine owner, so cmob does not touch it. [HYPOTHESIS - UNVERIFIED] Setting `CMUX_SOCKET_PASSWORD` for the gateway should then allow a launchd service; verify with `CMUX_SOCKET_PASSWORD=... cmux ping` from a non-cmux terminal after enabling password mode.

## Configuration
| Variable | Meaning | Default |
|---|---|---|
| `CMUX_GATEWAY_HOST` / `CMUX_GATEWAY_PORT` | bind address (loopback or Tailscale only) | `127.0.0.1` / `8088` |
| `CMUX_GATEWAY_TOKEN` | gateway token for `cmob serve` | read from `~/.cmux/gateway-token` |
| `CMUX_ALLOWED_HOSTS` | extra allowed `Host` names, comma separated | none |
| `CMUX_VAPID_SUBJECT` | `mailto:` or `https:` contact sent with web push | a placeholder address; set your own |
| `CMUX_DEVICES_FILE` | where paired devices are stored | `~/.cmux/devices.json` |

## Troubleshooting
* **Phone says `ERR_NAME_NOT_RESOLVED`:** Tailscale is off on the phone. Turn it on.
* **App opens but shows no workspaces, `cmob status` says cmux is not reachable:** the gateway was not started inside cmux. Run `cmob stop`, then `cmob start` from a cmux terminal.
* **No Scan button, or the camera does not open:** the page must be served over HTTPS (use the Tailscale address) and the browser must be allowed to use the camera.
* **"Invalid token":** the token changed. Pair again with `cmob qr --tailscale`.
* **QR code is cut off:** it is about 35 lines tall. Enlarge the terminal, or copy the printed link to the phone.

## Limitations
* macOS only. Linux and Windows are not supported.
* The Back gesture, swipe navigation and push notifications with the app closed have been checked only in part on real devices.
* The gateway handles each socket one request at a time, so one slow request delays that phone's others.

## License
[MIT](LICENSE)

---

## References & Credits
* [cmux](https://github.com/manaflow-ai/cmux)
* [orca](https://github.com/stablyai/orca)
* [cmux-pocket](https://github.com/shiquda/cmux-pocket)
* [vite+](https://viteplus.dev)
