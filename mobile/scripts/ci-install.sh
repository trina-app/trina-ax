#!/usr/bin/env bash
# CI (ci.yml, job "mobile"): install this package's locked dependencies for the typecheck. npm retries its fetches
# itself. A registry that stays unreachable after that (ETIMEDOUT, ECONNRESET, EAI_AGAIN, ENOTFOUND, a registry 5xx)
# says nothing about the code: it warns and the typecheck is skipped. Every other failure (package.json out of step
# with the lockfile, an integrity mismatch, ...) fails, because the release scripts would fail on it too.
# Writes installed=true|false to $GITHUB_OUTPUT when it is set.
set -uo pipefail
cd "$(dirname "$0")/.."
log=$(mktemp)
trap 'rm -f "$log"' EXIT
installed() { if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "installed=$1" >> "$GITHUB_OUTPUT"; fi; }
npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=4 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]]; then installed true; exit 0; fi
# npm's own error code line ("npm error code X", older npm "npm ERR! code X"), not any text in the output
if grep -Eq '^npm (error|ERR!) code (ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|E5[0-9][0-9])$' "$log"; then
  echo "::warning::npm could not reach the registry after retries; the mobile typecheck did not run"
  installed false
  exit 0
fi
installed false
exit "$status"
