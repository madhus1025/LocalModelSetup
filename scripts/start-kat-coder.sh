#!/usr/bin/env bash
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-bartowski/Kwaipilot_KAT-Coder-V2.5-Dev-GGUF}"
MODEL_QUANT="${MODEL_QUANT:-Q5_K_M}"
MODEL_ALIAS="${MODEL_ALIAS:-kat-coder-v2.5-dev}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
CONTEXT_SIZE="${CONTEXT_SIZE:-65536}"

if ! command -v llama-server >/dev/null 2>&1; then
  printf '%s\n' "llama-server was not found. Install current llama.cpp with: brew install llama.cpp" >&2
  exit 1
fi

exec llama-server \
  --hf-repo "${MODEL_REPO}:${MODEL_QUANT}" \
  --alias "${MODEL_ALIAS}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --ctx-size "${CONTEXT_SIZE}" \
  --cors-origins localhost \
  --no-webui \
  --jinja
