#!/bin/bash
# Job-started hook of the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as
# /Library/TrinaCI/job-started.sh; the runner runs it (as the runner account _trinaci) before the first step of every job
# through ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's root-owned .env. A failing hook fails the job before any step
# of the workflow runs, so this is the host-side gate a workflow cannot skip: only release.yml from a v* tag of
# trina-app/trina-ax (push of the tag, or "Run workflow" with that tag) may run here. Pull requests, forks, other
# workflows and branches are refused, whatever their runs-on says.
# GITHUB_* variables cannot be overridden by a workflow's env (the runner sets them). For a called workflow
# (mac-app.yml, mac-whisper.yml) GITHUB_WORKFLOW_REF is the caller's, release.yml.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
VOLUME=/Volumes/TrinaCI
MIN_FREE_GB=20

fail() { echo "::error::trina-mac-release runner refused this job: $*"; exit 1; }

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

# the volume has a quota (setup.sh); a job that would hit it is better refused here than half-built
free_gb=$(df -g "$VOLUME" 2>/dev/null | awk 'NR==2 {print $4}')
[ -n "$free_gb" ] && [ "$free_gb" -ge "$MIN_FREE_GB" ] || fail "only ${free_gb:-?} GB free on $VOLUME (needs $MIN_FREE_GB)"

# a previous job's leftovers in HOME (tool installs, caches, keychains, git config) never reach this job
if [ "${HOME:-}" = "$VOLUME/home" ]; then
  find "$HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  security list-keychains -d user -s 2>/dev/null
fi
echo "trina-mac-release runner: ${GITHUB_WORKFLOW_REF} (${GITHUB_EVENT_NAME}), ${free_gb} GB free"
exit 0
