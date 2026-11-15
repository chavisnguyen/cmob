# Troubleshooting

Start with `cmob status`. It shows the gateway, cmux, Tailscale, connected clients and paired devices.

| Symptom | Cause and fix |
|---|---|
| Phone says `ERR_NAME_NOT_RESOLVED` | Tailscale is off on the phone. Turn it on. |
| App opens but shows no workspaces, and `cmob status` says cmux is not reachable | The gateway was not started inside cmux. Run `cmob stop`, then `cmob start` from a cmux terminal. |
| `cmob setup` says to run it inside cmux | cmux refuses connections from other programs. Open a terminal inside cmux and run it there. |
| `cmob qr --tailscale` says Tailscale Serve is already serving something else | cmob will not overwrite it. See it with `tailscale serve status`, then remove it or point it at `127.0.0.1:8088` yourself. |
| No **Scan** button, or the camera does not open | The page must be served over HTTPS (use the Tailscale address) and the browser must be allowed to use the camera. |
| "Invalid token" in the app | The token changed. Pair again with `cmob qr --tailscale`. |
| The QR code is cut off | It is about 35 lines tall. Enlarge the terminal, or open the printed link on the phone. |
| No notifications on iPhone | Add the page to your Home Screen first (Share, then Add to Home Screen), then allow notifications. |
| The gateway does not start | `cmob logs` shows why. Port 8088 may be taken: `lsof -iTCP:8088 -sTCP:LISTEN`. |

Logs live in `~/.cmux/gateway.log`.
