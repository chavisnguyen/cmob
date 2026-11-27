# cmux markdown surfaces: where the file path lives

Goal: let cmob open the `.md` file behind a cmux `markdown` surface (see `.context/protocol_spec.md` for the planned RPC).

## Verified (2026-11-27, cmux 0.65.2 build 113, macOS)
- Live `cmux tree --all --json --id-format both`: a `type:"markdown"` surface has only
  `active, focused, here, id, index, index_in_pane, pane_id, pane_ref, ref, render_health, selected, selected_in_pane, title, tty, type, url` — **no path** (`url` is null, `title` is the file name).
- `cmux identify --surface <ref>` ignores the target and returns the *focused* surface (a terminal in the probe) — not usable.
- cmux docs (`skills/cmux-markdown/SKILL.md`, `references/commands.md`, https://raw.githubusercontent.com/manaflow-ai/cmux/main/...):
  `cmux markdown open <path>` prints `OK surface=… pane=… path=<absolute>` (`--json`: `window_id, workspace_id, pane_id, surface_id, path`) — path is only returned at open time.
  Panel is read-only, live-reloads on file change, saved/restored across sessions and re-read from disk on restore; the path is shown as a breadcrumb.
  `cmux read-selection` can read the selection from a Markdown surface (not the whole file).
- **Session snapshot has the path**: `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`
  → `windows[].tabManager.workspaces[].panels[]` entries with `type:"markdown"` and `markdown.filePath` (string).
  The panel's `id` equals the live tree surface `id` (checked: `65585FF4-…` in both). A sibling `stableSurfaceId` also exists (different value; do not use for matching).
  File mtime was ~35 s old when probed, so it is autosaved frequently (exact interval NOT measured).

## Implication / design
- Resolve `surface.id → filePath` by reading that snapshot in the gateway. It is an undocumented internal format → treat as best-effort; fail soft (viewer says "path unavailable").
- [HYPOTHESIS - UNVERIFIED] A markdown tab opened seconds ago may not be in the snapshot yet. Verify: `cmux markdown open /tmp/x.md --json`, then immediately inspect the snapshot for `filePath` containing `x.md` and time how long it takes.
- [HYPOTHESIS - UNVERIFIED] Bundle id differs for nightly/debug builds (`session-<bundle id>.json`); gateway should glob `session-*.json` and prefer the newest.
- File read RPC must be restricted (see roadmap): markdown/text extensions only, size cap, canonicalize + reject symlink escape. Path allowlist = paths that appear as `markdown.filePath` in the snapshot (the user already opened them in cmux), plus workspace cwd tree.

## Revised design (2026-11-27, after user clarification)
User flow to replicate: an agent writes a `.md` and mentions it in chat; in cmux the user clicks it and a panel opens. The chat text already carries the path, so **no snapshot lookup is needed** for this flow.
- Evidence (60 most recent Claude transcripts under `~/.claude/projects`, assistant text blocks): md files are mentioned as inline-code relative paths 488×, absolute inline-code 2×, markdown link with relative path 1×, `file://` links 0×. => detect inline-code and link paths; resolve relative to the workspace dir.
- Client: `components/chat/mdPath.ts` (`parseMarkdownPath`, `resolveSiblingPath`), `ChatFileLinkContext`, tappable chip in `NativeChatProse` (inline code + links), `components/files/MarkdownFileViewer.tsx` (read-only, polls `since_mtime_ms` every 4 s like cmux live-reload; links inside the doc resolve relative to that doc). Wired in `views/SurfaceDetailView.tsx`.
- Gateway: `services/file_read.rs` + RPC `mobile.file.read` `{workspace_id, path, since_mtime_ms?}`; base dir = `workspace_dir()` (same resolver as git diff). Containment by canonicalize+prefix (blocks `..`, absolute, symlink escape), extensions md/mdx/markdown/txt, 512 KiB cap.
- Verified end-to-end against a real workspace (own gateway instance, port 18099): relative/nested/absolute-in-workspace OK, unchanged via mtime OK, `../` and an existing outside `.md` rejected, `.toml` rejected, missing rejected.
- Known limits: files outside the workspace dir cannot be opened (e.g. a plan in another project); relative paths resolve from the workspace's current directory, not the agent's own cwd. Markdown *tabs* (`surface_type: markdown`) still show "can't be rendered inline" (`SurfaceDetailView.tsx`); the snapshot `filePath` route above could serve them later.
