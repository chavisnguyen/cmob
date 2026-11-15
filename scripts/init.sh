#!/usr/bin/env bash
# Initialize cmux-mobile workspace: verify prerequisites, install client dependencies, verify gateway build.
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPTS_DIR/lib.sh"

info "Initializing cmux-mobile coordinator hub at $ROOT..."

check_prereqs

# 1. Initialize Client (VitePlus)
info "Setting up repos/cmux-client dependencies..."
cd "$ROOT/repos/cmux-client"
pnpm install
success "repos/cmux-client dependencies installed."

# 2. Check Gateway (Rust)
info "Checking repos/cmux-gateway Cargo dependencies..."
cd "$ROOT/repos/cmux-gateway"
cargo check
success "repos/cmux-gateway checked successfully."

success "cmux-mobile workspace initialized successfully!"
info "Next steps:"
info "  make dev    # Launch both gateway and Vite client in dev mode"
info "  make build  # Compile client PWA bundle and embed into gateway binary"
info "  make test   # Run full test suite across gateway and client"
