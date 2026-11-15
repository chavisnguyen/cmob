#!/usr/bin/env bash
# Run cmux-mobile in development mode: Rust Gateway + Vite+ Client
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "$SCRIPTS_DIR/lib.sh"

check_prereqs
load_vite_plus

info "Starting cmux-mobile in development mode..."
info "Gateway port: 8088"
info "Press Ctrl+C to terminate both servers."

trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

# 1. Start Gateway in background
(
  cd "$ROOT/repos/cmux-gateway"
  info "Starting the gateway on 127.0.0.1:8088..."
  cargo run -- serve
) &

# 2. Start Vite+ client dev server
(
  cd "$ROOT/repos/cmux-client"
  info "Starting cmux-client Vite+ dev server..."
  vp dev
) &

wait
