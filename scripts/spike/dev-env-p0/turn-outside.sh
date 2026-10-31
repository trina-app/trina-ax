#!/bin/bash
# One AI turn with the engine OUTSIDE the box: Claude Code runs on the host in its own mount namespace (stand-in for
# the launcher's bwrap sandbox) with the box's paths bind-mounted (/work, /cache); only its Bash tool enters the box
# (boxshell/bash). The token stays on the host side: nothing in the box can read or intercept it.
# Run as root:  turn-outside.sh BOX FOLDER CMD [CMD...]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
b=$1; f=$2; shift 2
tok=$(sudo -u mycel /usr/bin/python3 -I "$HERE/model-proxy.py" issue "$b" 600 "$@")
U=$(id -u devbox)
mkdir -p /work /cache
install -d -o devbox -g devbox -m 0700 "/srv/devbox/vol/$b/cache/tmp"
# host-side path to the per-box model socket (stand-in for the launcher's model proxy port)
command -v socat >/dev/null || apt-get install -y -qq socat >/dev/null
sudo -u devbox socat TCP-LISTEN:4100,bind=127.0.0.1,reuseaddr,fork "UNIX-CONNECT:/srv/trina/proxy/$b/model.sock" &
fwd=$!; trap 'kill $fwd 2>/dev/null' EXIT; sleep 0.3
set +e
printf %s "$tok" | unshare -m sh -c '
  mount --make-rprivate / && mount --bind "$1" /work && mount --bind "$2" /cache || exit 1
  shift 2; exec setpriv --reuid devbox --regid devbox --init-groups --inh-caps=-all "$@"' turn \
  "/srv/devbox/mnt/$b" "/srv/devbox/vol/$b/cache" \
  env -i PATH=/usr/bin:/bin HOME=/cache/home XDG_RUNTIME_DIR=/run/user/$U TRINA_BOX="$b" \
  CLAUDE_CODE_SHELL="$HERE/boxshell/bash" TMPDIR=/cache/tmp CLAUDE_CODE_TMPDIR=/cache/tmp \
  ANTHROPIC_BASE_URL=http://127.0.0.1:4100 CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
  bash -c 'cd /work && exec 3<&0 </dev/null && exec "$@"' turn \
  /srv/devbox/claude/*/claude -p "spike turn" --output-format stream-json --verbose \
  --allowedTools Bash --permission-mode dontAsk --model claude-sonnet-4-5
rc=$?
sudo -u mycel /usr/bin/python3 -I "$HERE/model-proxy.py" revoke "$b"
exit $rc
