#!/bin/bash
# Print the first-run setup link of the Trina AX container (docs/INSTALL-DOCKER.md "First run").
#   docker compose exec trina-ax trina-ax-setup-link
# The link holds the one-time setup code: keep it private. It works until the owner account exists.
set -euo pipefail
BASE=/var/lib/mycel
PORT=${TRINA_AX_PORT:-47820}
if [ ! -e "$BASE/data/setup-token" ] || [ ! -f "$BASE/setup/code" ]; then
  echo "setup is done: the team has an owner." >&2
  echo "Owner password recovery: docker compose exec trina-ax $BASE/root/mycel-account reset-link" >&2
  exit 1
fi
CODE=$(tr -d '[:space:]' < "$BASE/setup/code")
echo "http://127.0.0.1:$PORT/setup?token=$CODE"
