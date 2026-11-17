#!/bin/bash
# Job-completed hook of the self-hosted release Mac runner (docs/RELEASE-CI.md 13). Installed root-owned as
# /Library/TrinaCI/job-completed.sh; runs as _trinaci after the last step of every job (also failed and refused ones)
# through ACTIONS_RUNNER_HOOK_JOB_COMPLETED. Nothing a job leaves behind reaches the next one: the checkout, the
# downloaded actions (_actions, reused by the runner otherwise), the tool cache (_tool: setup-bun, setup-go), and the
# whole HOME (bun's install cache, keychains, the keychain search list, git config). Best effort only: the runner is
# one-time and root's supervisor.sh deletes the whole runner folder, HOME and TMPDIR and kills every process of the
# account before the next job. Never fails the job.
# The runner runs hooks with bash -e -o pipefail: set +e (Go's module cache is read-only, rm fails on it otherwise).
set +e +o pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
VOLUME=/Volumes/TrinaCI
WORK="$VOLUME/runner/_work"

# any keychain a job made and did not delete (mac-app.yml deletes its own in an always() step)
security list-keychains -d user -s 2>/dev/null
if [ -d "$WORK" ] && [ ! -L "$WORK" ]; then
  chmod -R u+rwX "$WORK" 2>/dev/null
  find "$WORK" -mindepth 1 -maxdepth 1 ! -name _temp -exec rm -rf {} + 2>/dev/null
fi
if [ "${HOME:-}" = "$VOLUME/home" ] && [ ! -L "$HOME" ]; then
  chmod -R u+rwX "$HOME" 2>/dev/null
  find "$HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
fi
# TMPDIR of the runner and its jobs: everything but the runner's own .NET pipes and diagnostics sockets
if [ -d "$VOLUME/tmp" ] && [ ! -L "$VOLUME/tmp" ]; then
  find "$VOLUME/tmp" -mindepth 1 -maxdepth 1 ! -name 'CoreFxPipe_*' ! -name 'dotnet-diagnostic-*' ! -name 'clr-debug-pipe-*' \
    ! -name '.dotnet' -exec rm -rf {} + 2>/dev/null
fi
echo "trina-mac-release runner: cleaned; $(df -g "$VOLUME" | awk 'NR==2 {print $4}') GB free"
exit 0
