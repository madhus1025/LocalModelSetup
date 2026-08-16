#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${LOCAL_AGENT_ENDPOINT:-http://127.0.0.1:8080/v1}"

curl --fail --silent --show-error "${ENDPOINT}/models"
printf '\n'
