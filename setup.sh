#!/usr/bin/env bash
set -euo pipefail

# Local Coding Agent — one-command setup.
# Builds the VS Code extension and installs it. The local model is started
# separately with ./scripts/start-kat-coder.sh (see the README).

cd "$(dirname "$0")"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

bold "Local Coding Agent · setup"

command -v node >/dev/null 2>&1 || die "Node.js 20+ is required — install from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v))."
ok "Node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is required."
ok "npm $(npm -v)"

if ! command -v code >/dev/null 2>&1; then
  info "The VS Code 'code' command is not on your PATH."
  info "In VS Code: Command Palette → \"Shell Command: Install 'code' command in PATH\", then re-run."
  die "'code' CLI is needed to install the extension."
fi
ok "VS Code $(code --version | head -1)"

bold "Installing dependencies"
npm install
ok "Dependencies installed"

bold "Building and packaging"
npm run compile
npm run package
VSIX="$(ls -t local-coding-agent-*.vsix 2>/dev/null | head -1)"
[ -n "${VSIX:-}" ] || die "No .vsix was produced."
ok "Built $VSIX"

bold "Installing into VS Code"
code --install-extension "$VSIX" --force
ok "Installed $VSIX"

bold "Done 🎉"
cat <<'NEXT'

Next steps:
  1. Start a local model (keep the terminal open; first run downloads it):
       brew install llama.cpp
       ./scripts/start-kat-coder.sh
  2. Reload VS Code: Command Palette → "Developer: Reload Window".
  3. Open the "Local Coding Agent" view in the Activity Bar and start chatting.

Only 8–16 GB of RAM? Run a smaller model:
  MODEL_REPO=Qwen/Qwen2.5-Coder-7B-Instruct-GGUF MODEL_QUANT=Q4_K_M \
  MODEL_ALIAS=qwen2.5-coder-7b CONTEXT_SIZE=16384 ./scripts/start-kat-coder.sh
  ...then set  localCodingAgent.model = qwen2.5-coder-7b  in VS Code settings.
NEXT
