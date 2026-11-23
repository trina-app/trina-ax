#!/bin/sh
# shellcheck disable=SC2029  # the stage folder is meant to expand on this side (it is checked below)
# Prepare a commit on the demo host, from a checkout on the operator's machine, without root and without touching what
# runs: the source by `git archive`, its commit in .git-head, then stage.sh (downloads checked, app built).
#   sh demo-gate/linux/stage-remote.sh <ssh host> <commit> [stage folder, default /var/tmp/trina-demo-stage]
set -eu
HOST=${1:?usage: stage-remote.sh HOST COMMIT [STAGE]}
REF=${2:?usage: stage-remote.sh HOST COMMIT [STAGE]}
# any commit, whatever this checkout has out: one that is not here yet (the queue's merge commit) is fetched by its full id
if ! SHA=$(git rev-parse --verify -q "$REF^{commit}"); then
  printf '%s' "$REF" | grep -qE '^[0-9a-f]{40}$' || { echo "stage-remote: no commit $REF here (give the full id to fetch it)" >&2; exit 2; }
  git fetch -q origin "$REF"
  SHA=$(git rev-parse --verify "$REF^{commit}")
fi
ST=${3:-/var/tmp/trina-demo-stage}
case "$ST" in /*) ;; *) echo "stage-remote: the stage folder must be absolute" >&2; exit 2 ;; esac
case "$ST" in *[!A-Za-z0-9/._-]*) echo "stage-remote: unusual characters in the stage folder" >&2; exit 2 ;; esac
ssh "$HOST" "mkdir -p -m 700 '$ST' && rm -rf '$ST/app' && mkdir '$ST/app'"
git archive "$SHA" | ssh "$HOST" "tar -xf - -C '$ST/app'"
ssh "$HOST" "cd '$ST' && sh app/demo-gate/linux/stage.sh '$ST'"
# only a stage that built says which commit it is: tddeploy --expect refuses one without this
ssh "$HOST" "echo $SHA > '$ST/app/.git-head'"
[ "$(ssh "$HOST" "cat '$ST/app/.git-head'")" = "$SHA" ] || { echo "stage-remote: the stage is not at $SHA" >&2; exit 1; }
echo "stage-remote: $HOST:$ST is at $SHA"
