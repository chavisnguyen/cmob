# AGENTS & COLLABORATION GUIDELINES

Welcome to the **cmux-mobile** engineering project. This repository is dedicated to building a unified mobile (iOS/Android) and web companion application for [cmux](https://cmux.com/), designed to receive real-time notifications from cmux sessions and enable bidirectional control of cmux instances (inspired by the Orca mobile companion for Claude Code, Antigravity/AGY, and Kiro).

All autonomous agents, sub-agents, and contributors working in this repository MUST strictly comply with the operational principles defined below.

---

## 1. SUB-AGENT SPAWNING POLICY (SPAWN FREELY & PARALLELIZE)

* **Unlimited Sub-Agent Spawning Encouraged:** Agents are explicitly authorized and encouraged to spawn specialized sub-agents to parallelize deep research, reverse-engineering, protocol inspection, UI prototyping, and verification.
* **Role Specialization:** Assign discrete, focused responsibilities when spawning sub-agents (e.g., `Protocol Researcher`, `cmux Socket Analyzer`, `Orca UI Reverse Engineer`, `Gateway Architect`, `Test Verifier`, `Context Auditor`).
* **Cross-Agent Coordination:** Sub-agents must report back structured findings and record discoveries directly into long-term memory before completing execution.

---

## 2. LONG-TERM MEMORY IN `/.context/` (MANDATORY KNOWLEDGE BASE)

* **Persistent Knowledge Base:** All technical discoveries, reverse-engineered specifications, architectural designs, API schemas, and decision logs **MUST** be recorded in Markdown files inside the `/.context/` directory.
* **Directory Structure Convention:**
  * `.context/architecture.md`: High-level system architecture, client-gateway-cmux topology.
  * `.context/cmux_socket_api.md`: Reverse-engineered and verified Unix domain socket and CLI commands of `cmux`.
  * `.context/cmux_pocket_analysis.md`: Analysis of `cmux-pocket` (gateway daemon, protocol, Android client).
  * `.context/orca_companion_analysis.md`: Analysis of Orca desktop/mobile UI, notification mechanisms, and chat UI for Claude Code, AGY, and Kiro.
  * `.context/notification_system.md`: Push notification architecture (APNs/FCM/WebPush, agent hooks, completion triggers).
  * `.context/protocol_spec.md`: WebSocket and RPC wire protocol specifications.
  * `.context/roadmap_and_tasks.md`: Active backlog, milestone tracking, and implementation plan.
  * `.context/audit_report.md`: Independent audit reports verifying documentation accuracy against source code.
* **Continuous Updates:** Whenever new findings emerge from code inspection or testing, the relevant file in `/.context/` must be updated immediately so that future agents have complete context.

---

## 3. STRICT EVIDENCE-BASED STANDARD (ZERO GUESSING)

> [!CAUTION]
> **NO GUESSING IS PERMITTED UNDER ANY CIRCUMSTANCES.**
> Every claim, architectural assertion, protocol definition, and implementation detail **MUST HAVE DIRECT, CITABLE EVIDENCE**.

### Strict Requirements:
1. **Concrete Citations & Source-Checking:**
   * Every analysis document and architectural decision must cite exact source files, line numbers, commit hashes, official documentation links, or verified command line outputs.
   * Format references explicitly: e.g., `ref/cmux-pocket/crates/cmux-pocket-protocol/src/rpc.rs:45-80` or `ref/cmux/CLI/FeedEventClassifier.swift:455-517`.
2. **Ban on Convention Extrapolation:**
   * **Never extrapolate:** Even if a pattern appears to be standard industry practice (e.g., assuming an authentication handshake uses JSON-RPC because the rest of the API does, assuming QR pairing uses a generic `//pair` scheme, or assuming Enter `\r` is the approval keystroke for all agents), agents **MUST NOT** extrapolate.
   * Every field name, handshake frame, URI scheme, default port number, and keystroke code **MUST be read directly from actual source code** using file inspection tools or terminal commands prior to documentation or code generation.
3. **Mandatory Pre-Reading Rule:**
   * Asserting any API, CLI flag, struct field, or configuration without first executing a tool to read the containing source file within the current working session is strictly prohibited. Any claim made without prior file reading is classified as an unauthorized assumption.
4. **Independent Fresh-Context Sub-Agent Auditing:**
   * To eliminate hallucination drift and confirmation bias over long context horizons, agents must periodically spawn independent sub-agents with a **completely fresh context window** to cross-verify documentation in `/.context/` and written code against authoritative source repositories.
5. **Hypothesis Handling:**
   * If a technical detail cannot yet be verified through source code, it **MUST** be explicitly labeled:
     `[HYPOTHESIS - UNVERIFIED]`
   * It must be immediately accompanied by a concrete verification recipe (e.g., an exact terminal test command or socket probe script) to confirm or refute it before production implementation.
6. **Integrity of Source Code & Documentation:**
   * Never delete or alter code, comments, or documentation without verifiable justification grounded in source evidence.

---

## 4. DESIGN & USER EXPERIENCE OBJECTIVES

* **Mobile & Web First:** Companion application targeting mobile (iOS and Android) and Web (PWA / responsive web).
* **Notification Reliability:** Low-latency notification delivery when background coding agents (Claude Code, Antigravity/AGY, Kiro, Codex) require human input, complete turns, or encounter errors.
* **Chat & Terminal Control UI:**
  * Clean, developer-friendly Chat UI inspired by **Orca** for chatting with and monitoring `agy`, `claude`, and `kiro`.
  * Responsive terminal / grid view adapted for mobile screens (handling reflow, touch gestures, and keyboard shortcuts).
* **Security & Authentication:** Zero open-internet exposure without end-to-end encryption or secure tunnels (e.g., Bearer tokens, Tailscale HTTPS, Cloudflare Tunnels, or WireGuard).

---

## 5. RELEASE & HOMEBREW PROCESS

### Repo layout
* **Main repo:** `github.com/chavisnguyen/cmob` — this monorepo (`cmux-mobile`), pushed via `git@github.com:chavisnguyen/cmob.git`
* **Homebrew tap:** `github.com/chavisnguyen/homebrew-cmob` — auto-updated by CI, never edit manually
* **Formula template:** `packaging/homebrew/cmob.rb.template` — placeholders `{{VERSION}}`, `{{SHA_ARM}}`, `{{SHA_X64}}`, `{{REPO}}`

### CI/CD workflows (`.github/workflows/`)
* `ci.yml` — runs on every push/PR to `master`: Rust clippy + tests + client checks
* `release.yml` — runs on **GitHub Release published**: `gate → binary (arm64 + x64) → attach → bump-tap`
  * `gate`: verifies `Cargo.toml` version matches the tag, runs full test suite
  * `binary`: builds macOS arm64 and x64 binaries in parallel
  * `attach`: uploads both binaries to the GitHub Release assets
  * `bump-tap`: generates `Formula/cmob.rb` from the template and pushes to `homebrew-cmob`

### Required secrets (repo: `chavisnguyen/cmob`)
* `TAP_TOKEN` — PAT with `contents:write` on `homebrew-cmob`. Already configured. Verify with: `gh secret list --repo chavisnguyen/cmob`

### How to cut a release
```bash
# 1. Bump version in repos/cmux-gateway/Cargo.toml (must match the tag)
# 2. Commit and push
git add -A
git commit -m "cmob X.Y.Z: <summary>"
git push origin master

# 3. Create and push the tag
git tag vX.Y.Z
git push origin vX.Y.Z

# 4. Create the GitHub Release (this triggers the workflow)
gh release create vX.Y.Z --title "cmob X.Y.Z" --notes "..." --repo chavisnguyen/cmob

# 5. Watch the workflow
gh run list --repo chavisnguyen/cmob --limit 5

# 6. Verify Homebrew tap was updated
gh api repos/chavisnguyen/homebrew-cmob/contents/Formula/cmob.rb --jq '.content' | base64 -d | grep version
```

> [!IMPORTANT]
> The tag **must** be pushed to remote **before** creating the GitHub Release.
> The `Cargo.toml` version **must** exactly match the tag (without the `v` prefix). The `gate` job will fail otherwise and block the whole pipeline.

> [!NOTE]
> If the tag already exists on remote (e.g. `rejected: already exists`), the Release may have already been created. Check with `gh release list --repo chavisnguyen/cmob` before re-tagging.

### Installed versions
| Version | Released | Homebrew tap |
|---------|----------|-------------|
| v0.1.0 | 2026-11-15 | ✓ |
| v0.1.1 | 2026-11-15 | ✓ |
| v0.1.2 | 2026-11-16 | ✓ |
| v0.1.3 | 2026-11-18 | ✓ |
| v0.1.4 | 2026-11-18 | ✓ |
| v0.1.5 | 2026-11-18 | ✓ |
| v0.1.6 | 2026-11-18 | ✓ |
