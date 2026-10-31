#!/bin/bash
# One AI turn in a box, the way the launcher would run it (P0 stand-in for mycel-launcher): Claude Code from the
# read-only /opt/claude mount, model calls to the per-box proxy through the in-box forwarder, the per-turn token on
# fd 3 (never in argv or the environment), the engine's lock settings (server/src/engine/claude.ts).
# Run as root (it issues the token as the server account and runs the box as the box account):
#   turn.sh BOX CMD [CMD...]       the stand-in model asks for one Bash call per CMD
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
b=$1; shift
tok=$(sudo -u mycel /usr/bin/python3 -I "$HERE/model-proxy.py" issue "$b" 600 "$@")
U=$(id -u devbox)
extra=()
[ "$(sudo -u devbox XDG_RUNTIME_DIR=/run/user/$U podman inspect -f '{{.HostConfig.NetworkMode}}' "box-$b")" = none ] \
  && extra=(-e HTTPS_PROXY=http://127.0.0.1:3128 -e HTTP_PROXY=http://127.0.0.1:3128)
set +e
# sudo closes inherited descriptors, so the token goes in on stdin and the box account's shell moves it to fd 3
printf %s "$tok" | sudo -u devbox XDG_RUNTIME_DIR=/run/user/$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus \
  bash -c 'exec 3<&0 </dev/null; exec "$@"' turn \
  podman exec --preserve-fds 1 -w /work \
  -e ANTHROPIC_BASE_URL=http://127.0.0.1:4000 -e CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 \
  -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
  -e CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 -e TMPDIR=/tmp -e CLAUDE_CODE_TMPDIR=/tmp "${extra[@]}" \
  "box-$b" /opt/claude/claude -p "spike turn" --output-format stream-json --verbose \
  --allowedTools Bash --permission-mode dontAsk --model claude-sonnet-4-5
rc=$?
sudo -u mycel /usr/bin/python3 -I "$HERE/model-proxy.py" revoke "$b"
exit $rc
