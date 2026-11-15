# Security

## Network
- The gateway listens on `127.0.0.1` only. Phones reach it through [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), so it is visible to your tailnet and not to the internet.
- Tailscale (WireGuard) is the encrypted transport. cmob adds no end-to-end encryption of its own.
- Requests with an unexpected `Host` or `Origin` header are rejected (DNS-rebinding guard). Add extra hostnames with `CMUX_ALLOWED_HOSTS`.

## Who can do what
**Anyone who is paired can read and type into your terminals and agents.** Pair only devices you control. If a phone is lost, run `cmob devices` and `cmob devices revoke <id>`: it is disconnected at once and its push notifications stop.

## Tokens
- **Gateway token:** `~/.cmux/gateway-token` (mode 600), created on first use. It never appears on a command line (`ps` would show it to every user); the gateway receives it through the environment. Treat it like a password.
- **Device tokens:** each phone redeems a single-use ticket (valid 10 minutes) from `cmob qr` and gets its own token, stored in `~/.cmux/devices.json`. A device that is not used for 90 days expires.
- **QR codes** carry a ticket, never the gateway token. A used or expired ticket is rejected.
- Only the gateway token can list or revoke devices, and read the connected clients (`/api/devices`, `/api/clients`, `/api/pairing`).

## Where things are stored
| File | Contents |
|---|---|
| `~/.cmux/gateway-token` | gateway token |
| `~/.cmux/devices.json` | per-device tokens |
| `~/.cmux/vapid.json` | Web Push signing keys |
| `~/.cmux/push_subscriptions.json` | phones subscribed to notifications |
| `~/.cmux/gateway.log`, `gateway.pid` | log and process id |

`cmob uninstall` keeps these. Delete `~/.cmux` yourself to forget everything.

## Why the gateway must start inside cmux
cmux only answers socket clients that were started inside cmux (`cmux socket-status` shows `cmuxOnly`). A launchd service is outside cmux, so its gateway would connect but show nothing. That is why autostart is a shell hook, and why `cmob setup` must run in a cmux terminal. cmux also has a `password` socket mode, but changing it is a security decision for the owner of the machine, so cmob does not touch it.

[HYPOTHESIS - UNVERIFIED] Setting `CMUX_SOCKET_PASSWORD` for the gateway should then allow a launchd service. To check: enable password mode, then run `CMUX_SOCKET_PASSWORD=<pw> cmux ping` from a non-cmux terminal.

## Reporting a problem
Open an issue on GitHub. Do not include tokens or the contents of `~/.cmux`.
