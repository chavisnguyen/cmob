# Configuration

cmob needs no configuration. These environment variables exist for unusual setups.

| Variable | Meaning | Default |
|---|---|---|
| `CMUX_GATEWAY_HOST` / `CMUX_GATEWAY_PORT` | bind address (loopback or Tailscale only) | `127.0.0.1` / `8088` |
| `CMUX_GATEWAY_TOKEN` | gateway token for `cmob serve` | read from `~/.cmux/gateway-token` |
| `CMUX_ALLOWED_HOSTS` | extra allowed `Host` names, comma separated | none |
| `CMUX_VAPID_SUBJECT` | `mailto:` or `https:` contact sent with web push | a placeholder address; set your own |
| `CMUX_DEVICES_FILE` | where paired devices are stored | `~/.cmux/devices.json` |
| `CMUX_BUNDLED_CLI_PATH` | path to the `cmux` command | `cmux` from `PATH` |
| `CMUX_HOOK_SESSIONS_DIR` | where cmux keeps agent hook sessions | `~/.cmuxterm` |

The gateway reads them when it starts, so after changing one run `cmob restart`.
