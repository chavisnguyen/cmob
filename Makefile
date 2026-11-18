SHELL := /usr/bin/env bash
# `cmob` from PATH (Homebrew) when installed, otherwise the binary this checkout builds.
CMOB := $(shell command -v cmob 2>/dev/null || echo repos/cmux-gateway/target/release/cmob)
# cmux-mobile Coordinator Hub Makefile
.PHONY: help init dev build test install tailscale status clean

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "%-12s %s\n", $$1, $$2}'

init: ## Verify prerequisites and install dependencies across all repos
	@scripts/init.sh

dev: ## Launch Gateway and Vite+ Client concurrently in development mode
	@scripts/dev.sh

build: ## Compile the release Rust binary (the web app is deployed to GitHub Pages)
	@scripts/build.sh

test: ## Run unit and integration tests across Gateway and Client
	@scripts/test.sh

install: build ## Build, then run `cmob setup` (inside cmux): autostart + Tailscale Serve
	@repos/cmux-gateway/target/release/cmob setup

tailscale: ## Print the pairing QR for a phone (same as `cmob qr --tailscale`)
	@$(CMOB) qr --tailscale

status: ## Show gateway health, connected clients and paired devices
	@$(CMOB) status

clean: ## Clean build artifacts and dist directories
	@rm -rf repos/cmux-gateway/target repos/cmux-client/dist
	@echo "Cleaned build artifacts."
