#!/bin/bash
# Job-started hook of the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as
# /Library/TrinaCI/job-started.sh; the runner runs it (as the runner account _trinaci) before the first step of every job
# through ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's root-owned .env. A failing hook fails the job before any step
# of the workflow runs, so this is the host-side gate a workflow cannot skip: only release.yml from a v* tag of
# trina-app/trina-ax (push of the tag, or "Run workflow" with that tag) may run here. Pull requests, forks, other
# workflows and branches are refused, whatever their runs-on says.
# GITHUB_* variables cannot be overridden by a workflow's env (the runner sets them). For a called workflow
# (mac-app.yml, mac-whisper.yml) GITHUB_WORKFLOW_REF is the caller's, release.yml.
# A failing hook marks the job failed but the runner may still run the job's `if: always()` steps, so a refusal also
# kills this account's Runner.Worker and then every process of the account (kill -9 -1 as a non-root user reaches
# only its own processes): nothing of the job runs. pkill/kill work in the sandbox; ps does not (setuid programs
# cannot start inside sandbox-exec).
# The runner is one-time (supervisor.sh), so the next job gets a fresh runner after root has cleaned up.
# The runner runs hooks with bash -e -o pipefail: set +e, so a cleanup command that fails never fails a trusted job.
set -u +e +o pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
VOLUME=/Volumes/TrinaCI
MIN_FREE_GB=20

fail() {
  echo "::error::trina-mac-release runner refused this job: $*"
  [ "$(id -u)" != 0 ] || exit 1
  pkill -9 -U "$(id -u)" -f 'bin/Runner\.Worker' 2>/dev/null
  pkill -9 -U "$(id -u)" -f 'bin/Runner\.Listener' 2>/dev/null
  kill -9 -1 2>/dev/null
  exit 1
}

[ "${GITHUB_REPOSITORY:-}" = "trina-app/trina-ax" ] || fail "repository '${GITHUB_REPOSITORY:-}'"
case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch) ;;
  *) fail "event '${GITHUB_EVENT_NAME:-}' (only a v* tag push or Run workflow of release.yml)" ;;
esac
case "${GITHUB_REF:-}" in
  refs/tags/v*) ;;
  *) fail "ref '${GITHUB_REF:-}' (only v* tags)" ;;
esac
case "${GITHUB_WORKFLOW_REF:-}" in
  "trina-app/trina-ax/.github/workflows/release.yml@refs/tags/v"*) ;;
  *) fail "workflow '${GITHUB_WORKFLOW_REF:-}' (only release.yml at a v* tag)" ;;
esac

# the tagged commit must be on main (as release.yml's prepare requires): someone who may bypass the tag ruleset could
# otherwise tag any commit and bring their own release.yml. Public API, no token: identical/behind = on main.
cmp=""; http=""
for _ in 1 2 3; do
  body=$(curl -sS -m 20 -w '\n%{http_code}' "https://api.github.com/repos/trina-app/trina-ax/compare/main...${GITHUB_SHA:-none}?per_page=1" 2>/dev/null)
  http=${body##*$'\n'}
  cmp=""
  # error replies carry a "status" too (e.g. "404"): read it only from a 200
  [ "$http" = 200 ] && cmp=$(printf '%s' "${body%$'\n'*}" | /usr/bin/jq -r '.status // empty' 2>/dev/null)
  [ -n "$cmp" ] && break
  [ "$http" = 404 ] && break
  sleep 5
done
case "$cmp" in
  identical | behind) ;;
  "") case "$http" in
        403 | 429) fail "GitHub API rate limit (unauthenticated, shared office IP): could not check that ${GITHUB_SHA:-?} is on main; run the job again later" ;;
        404) fail "commit ${GITHUB_SHA:-?} is not in trina-app/trina-ax" ;;
        *) fail "could not check that ${GITHUB_SHA:-?} is on main (GitHub API HTTP ${http:-?}); run the job again" ;;
      esac ;;
  *) fail "commit ${GITHUB_SHA:-?} is not on main ($cmp)" ;;
esac

# the volume has a quota (setup.sh); a job that would hit it is better refused here than half-built
free_gb=$(df -g "$VOLUME" 2>/dev/null | awk 'NR==2 {print $4}')
[ -n "$free_gb" ] && [ "$free_gb" -ge "$MIN_FREE_GB" ] || fail "only ${free_gb:-?} GB free on $VOLUME (needs $MIN_FREE_GB)"

# a previous job's leftovers in HOME (tool installs, caches, keychains, git config) never reach this job
if [ "${HOME:-}" = "$VOLUME/home" ]; then
  chmod -R u+rwX "$HOME" 2>/dev/null
  find "$HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  security list-keychains -d user -s 2>/dev/null
fi
echo "trina-mac-release runner: ${GITHUB_WORKFLOW_REF} (${GITHUB_EVENT_NAME}), ${free_gb} GB free"
exit 0
