#!/usr/bin/env bash
# Production build: compile Vite+ client PWA, copy to gateway assets, build release Rust binary.
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPTS_DIR/lib.sh"

check_prereqs
load_vite_plus

info "Step 1/3: Building repos/cmux-client with Vite+..."
cd "$ROOT/repos/cmux-client"
vp build
success "Client PWA bundle built in repos/cmux-client/dist/"

info "Step 2/3: Syncing client bundle into repos/cmux-gateway/assets/..."
mkdir -p "$ROOT/repos/cmux-gateway/assets"
rm -rf "$ROOT/repos/cmux-gateway/assets/*"
cp -r "$ROOT/repos/cmux-client/dist/"* "$ROOT/repos/cmux-gateway/assets/"

# Sanity assertion: ensure real Vite bundle was synced, not a placeholder
if [ ! -d "$ROOT/repos/cmux-gateway/assets/assets" ] || grep -q "placeholder" "$ROOT/repos/cmux-gateway/assets/index.html" 2>/dev/null; then
  error "Sanity assertion failed: assets do not contain real Vite bundle!"
  exit 1
fi
success "Assets synced and verified in repos/cmux-gateway/assets/"

info "Step 3/3: Building release Rust binary in repos/cmux-gateway..."
cd "$ROOT/repos/cmux-gateway"
cargo build --release
success "Release binary built: $ROOT/repos/cmux-gateway/target/release/cmob"

info "Build complete! Run it with:"
info "  ./repos/cmux-gateway/target/release/cmob setup   (inside cmux)"
