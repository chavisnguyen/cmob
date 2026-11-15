# secrets/

Nothing in this directory is read by the gateway; it only exists as a git-ignored place to keep local notes.
Everything in it except this file and `.gitignore` is ignored by git.

The gateway keeps its real secrets outside the repo, in `~/.cmux/`:
* `gateway-token`: the gateway token (mode 600)
* `devices.json`: per-device tokens created by pairing
* `vapid.json`: Web Push signing keys
* `push_subscriptions.json`: phones subscribed to push

Never commit any of these.
