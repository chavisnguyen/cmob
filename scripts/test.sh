#!/usr/bin/env bash
# Run all tests and verification across gateway and client.
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPTS_DIR/lib.sh"

check_prereqs
load_vite_plus

info "Running Gateway Rust tests..."
cd "$ROOT/repos/cmux-gateway"
cargo test
success "Gateway tests passed."

info "Running Client Vite+ checks and tests..."
cd "$ROOT/repos/cmux-client"
vp check
vp test --run
success "Client checks and unit tests passed."

success "All test suites passed!"
