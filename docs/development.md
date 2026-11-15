# Development

## Layout
```
repos/cmux-gateway/   Rust daemon and the `cmob` command (Tokio, Axum, rust-embed)
repos/cmux-client/    the phone app, a PWA (Vite+, React 19, Tailwind CSS)
scripts/              init, dev, build and test helpers
packaging/homebrew/   formula template used by the release workflow
.context/             long-term project notes and audit log
```
The client is built first and embedded into the gateway binary, so `cmob` is one file.

## Build from source
Needs Rust 1.80+, Node 20+, `pnpm` 9+ and [Vite+](https://viteplus.dev) (`curl -fsSL https://vite.plus | bash`).

```bash
make init      # check prerequisites, install dependencies
make build     # client + gateway into repos/cmux-gateway/target/release/cmob
make install   # build, then run `cmob setup` (inside cmux)
make dev       # gateway on :8088 plus the Vite+ dev server
make test      # gateway and client tests
make status    # same as `cmob status`
```

`cmob serve` runs the gateway in the foreground. `cmob start` runs the same thing in the background.

## Releases
Create a GitHub Release with a tag such as `v0.2.0` that matches `version` in `repos/cmux-gateway/Cargo.toml`. The workflow in `.github/workflows/release.yml` then:

1. runs the client checks and all tests,
2. builds `cmob-macos-arm64` and `cmob-macos-x64` and smoke-tests them,
3. attaches both to the release,
4. rewrites `Formula/cmob.rb` in the `homebrew-cmob` tap from `packaging/homebrew/cmob.rb.template`.

Step 4 needs the repository secret `TAP_TOKEN`: a token with write access to the tap repository (`gh secret set TAP_TOKEN --repo chavisnguyen/cmob`).

## Notes for contributors
- The default branch is `master`.
- Client code must pass `vp check` (it includes formatting): run `vp check --fix`.
- Findings and decisions are recorded in `.context/` (see `AGENTS.md`).
