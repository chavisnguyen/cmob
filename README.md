# cmob

[![release](https://img.shields.io/github/v/release/chavisnguyen/cmob)](https://github.com/chavisnguyen/cmob/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Cmux Mobile.** Your coding agents keep working in [cmux](https://cmux.com/) on your Mac. **cmob puts them on your phone**: see which ones are running, read what they did, answer when they need you, and type into the terminal, from anywhere on your own Tailscale network.

![cmob on a phone: workspaces, chat, terminal](docs/images/demo.png)

*Invented demo projects. cmob runs against your real cmux.*

## What you can do

- **See everything at a glance.** Every cmux workspace and tab, with whether its agent is running or idle and the last thing it said.
- **Read the work, not a wall of text.** The chat view shows replies with code blocks and tables, tool calls, reasoning, diffs and sub-agents. Long messages fold.
- **Answer from the couch.** Send a message, approve a permission prompt, interrupt a turn, attach a photo or dictate. Slash commands work too.
- **Get pinged.** A push notification when an agent needs approval, finishes a turn, or shows a dialog. Pick which ones you want.
- **Drop into the real terminal** when chat is not enough, with a key row (Ctrl, Alt, Esc, Tab, arrows) built for a phone.
- **Review changes.** A git diff view for the workspace, and buttons to open, rename or close tabs.

Built for Claude Code, Codex, Kiro and Antigravity. cmob also recognises OpenCode, Grok, Gemini, Aider and a few others, but those are less tested.

## Install

You need: a Mac with the [cmux](https://cmux.com/) app, and [Tailscale](https://tailscale.com/) on the Mac and on your phone. No Node, no Rust, no repo clone.

```bash
brew tap chavisnguyen/cmob
brew install cmob
```

## Set up

In a terminal **inside cmux**:

```bash
cmob setup            # one time
cmob qr --tailscale   # prints a QR code
```

On your phone, open the address printed under the QR code (or scan it with the camera), then in the app: menu → **Hosts & devices** → **Scan**. Add the page to your Home Screen on iPhone to get notifications.

![from the workspace list to chat to the terminal](docs/images/demo.gif)

Check that everything is healthy at any time:

```bash
cmob status
```

```
Gateway     ✓ running on 127.0.0.1:8088 (v0.1.1)
cmux        ✓ connected
Autostart   ✓ installed
Tailscale   ✓ https://your-mac.your-tailnet.ts.net
Connected   1 client
  - device          Safari · iPhone    up 3m
Paired      1 device (cmob devices)
```

Stuck? See [Troubleshooting](docs/troubleshooting.md).

## Commands

| Command | What it does |
|---|---|
| `cmob setup` | One-time setup (run inside cmux). Safe to run again |
| `cmob qr --tailscale` | QR code that pairs a phone. Run it again for another phone |
| `cmob status` | Gateway, cmux, Tailscale, connected clients, paired devices |
| `cmob devices` | List paired phones |
| `cmob devices revoke <id>` | Cut one phone off. It is disconnected and gets no more notifications |
| `cmob start` / `stop` / `restart` | Control the background gateway |
| `cmob logs [-f]` | Show or follow the gateway log |
| `cmob uninstall` | Remove autostart and stop the gateway |

`cmob setup` adds a small, marked block to `~/.zshrc` so the gateway starts whenever a terminal opens inside cmux (your old file is kept as `.zshrc.cmob.bak`). `cmob uninstall` removes it.

## Is it safe?

The gateway only listens on your Mac (`127.0.0.1`). Your phone reaches it through Tailscale, so it is visible to your tailnet and not to the internet. Each phone gets its own token from a single-use QR code, and you can revoke any of them.

**Anyone you pair can read and type into your terminals and agents**, so pair only devices you control. Details: [Security](docs/security.md).

## Docs

- [Security](docs/security.md): how pairing and tokens work, what is stored where
- [Troubleshooting](docs/troubleshooting.md): `ERR_NAME_NOT_RESOLVED`, empty workspace list, camera, tokens
- [Configuration](docs/configuration.md): environment variables
- [Development](docs/development.md): build from source, tests, releases

## Limitations

- macOS only. Linux and Windows are not supported.
- The Back gesture, swipe navigation and notifications with the app closed have been checked only in part on real devices.
- Each phone's requests are handled one at a time, so one slow request delays that phone's others.

## Credits

Built for [cmux](https://github.com/manaflow-ai/cmux). UI ideas from [Orca](https://github.com/stablyai/orca) and [cmux-pocket](https://github.com/shiquda/cmux-pocket).

## License

[MIT](LICENSE)
