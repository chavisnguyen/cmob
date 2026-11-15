#!/usr/bin/env bash
# Shared helpers and environment setup for cmux-mobile coordinator hub.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT

# Colors
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_GREEN='\033[32m'
C_BLUE='\033[34m'
C_YELLOW='\033[33m'
C_RED='\033[31m'

info() {
  printf "${C_BLUE}${C_BOLD}[INFO]${C_RESET} %s\n" "$*"
}

success() {
  printf "${C_GREEN}${C_BOLD}[SUCCESS]${C_RESET} %s\n" "$*"
}

warn() {
  printf "${C_YELLOW}${C_BOLD}[WARN]${C_RESET} %s\n" "$*"
}

error() {
  printf "${C_RED}${C_BOLD}[ERROR]${C_RESET} %s\n" "$*" >&2
}

# Ensure Vite+ environment is loaded
load_vite_plus() {
  if [ -x "$ROOT/repos/cmux-client/node_modules/.bin/vp" ]; then
    export PATH="$ROOT/repos/cmux-client/node_modules/.bin:$PATH"
  fi
  if [ -f "$HOME/.config/vite-plus/env" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.config/vite-plus/env"
  fi
}

check_prereqs() {
  local missing=()
  command -v cargo >/dev/null 2>&1 || missing+=("cargo (Rust)")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")

  load_vite_plus
  command -v vp >/dev/null 2>&1 || missing+=("vp (Vite+ from https://viteplus.dev)")

  if [ ${#missing[@]} -gt 0 ]; then
    error "Missing prerequisites: ${missing[*]}"
    error "Please install required tools before proceeding."
    return 1
  fi
}
