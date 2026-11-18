#!/usr/bin/env bash
# Production build: the release Rust binary. The web app is not part of it: it is deployed to GitHub Pages
# (.github/workflows/deploy-pages.yml) and talks to the gateway over the websocket.
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPTS_DIR/lib.sh"

command -v cargo >/dev/null 2>&1 || { error "Missing prerequisite: cargo (Rust)"; exit 1; }

info "Building release Rust binary in repos/cmux-gateway..."
cd "$ROOT/repos/cmux-gateway"
cargo build --release
success "Release binary built: $ROOT/repos/cmux-gateway/target/release/cmob"

info "Build complete! Run it with:"
info "  ./repos/cmux-gateway/target/release/cmob setup   (inside cmux)"
