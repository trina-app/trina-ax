#!/bin/bash
# Team AX: store the owner's long-lived Claude subscription token (design tab 6 "AI 구독 연결", subscription mode).
# Installed as <install>/root/set-claude-token (root-owned) by scripts/install-macos.sh. Run it with admin rights; the
# token is read from standard input, never from the command line (argv is visible to every process on the Mac):
#
#   claude setup-token                      # approve in the browser, copy the sk-ant-oat01-… token it prints once
#   pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"
#   pbcopy < /dev/null                      # empty the clipboard
#
#   sudo …/set-claude-token --remove        # forget the token (Claude stops answering)
#   options: --base DIR (install folder; default: the folder above this script's root/)
#
# The token lands in <install>/secrets/claude-oauth-token, owned by the server account, mode 600, in the server's 700
# secrets folder: the engine account (_axagent) can never read it. The server reads it on every model request, so no
# restart is needed; the model proxy puts it on the requests of every Claude turn (the engine only ever sees a
# per-turn token). Root never writes through what a role account could have planted there: the same safe-fs helpers
# as the installer (no symbolic link on the way, written in a root-only folder and renamed into place).
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
die() { echo "set-claude-token: $*" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
BASE="" REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    # never echo the argument: it may be the token itself, pasted in the wrong place
    *) die "unknown option (the token goes on standard input, not on the command line)" ;;
  esac
done
# unprivileged only for the repository's own tests (tests/unit/g-scripts.test.ts), which own the whole test folder
[ "$(id -u)" = 0 ] || [ "${MYCEL_SET_TOKEN_TEST:-}" = 1 ] || die "run as root: pbpaste | sudo \"$0\""
[ -n "$BASE" ] || BASE=$(dirname "$HERE")
BASE=$(cd "$BASE" 2>/dev/null && pwd -P) || die "install folder not found"
SECRETS="$BASE/secrets"
[ -d "$SECRETS" ] && [ ! -L "$SECRETS" ] || die "$SECRETS is missing; is Team AX installed here?"
# the server account owns the secrets folder (installer: mk <server> <server group> 700 secrets)
SRV_USER=$(stat -f %Su "$SECRETS")
SRV_GRP=$(stat -f %Sg "$SECRETS")
if [ "$(id -u)" = 0 ]; then
  [[ "$SRV_USER" =~ ^_[a-z][a-z0-9]{2,30}$ ]] || die "$SECRETS is owned by $SRV_USER, not a Team AX role account; refusing"
fi
[ "$(stat -f %Lp "$SECRETS")" = 700 ] || die "$SECRETS must be mode 700"
DEST="$SECRETS/claude-oauth-token"

SAFE_ROOTS=("$BASE")
ITMP=$(mktemp -d "$BASE/.token-tmp.XXXXXX")
trap 'rm -rf "$ITMP"' EXIT
# the installer's helpers, root-owned next to this script (root/safe-fs.sh; scripts/macos/ in the repository)
[ -f "$HERE/safe-fs.sh" ] && [ ! -L "$HERE/safe-fs.sh" ] || die "safe-fs.sh missing next to $0"
# shellcheck source=safe-fs.sh
. "$HERE/safe-fs.sh"

if [ "$REMOVE" = 1 ]; then
  nolink "$SECRETS"
  if [ -e "$DEST" ] || [ -L "$DEST" ]; then mv -f -h "$DEST" "$ITMP/old"; fi
  echo "set-claude-token: removed; Claude stops answering until a new token is stored"
  exit 0
fi

[ ! -t 0 ] || die "paste the token on standard input: pbpaste | sudo \"$0\""
# at most 4 KB, first line, surrounding blanks and a trailing CR removed
TOKEN=$(head -c 4096 | head -n 1 | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
# (no {20,1000}: the macOS regex library caps a repeat count at 255)
[[ "$TOKEN" =~ ^sk-ant-oat[0-9][0-9]-[A-Za-z0-9_-]{20,}$ ]] && [ ${#TOKEN} -le 1013 ] || die "this does not look like a token from \`claude setup-token\` (sk-ant-oat01-…); nothing changed"
printf '%s\n' "$TOKEN" > "$ITMP/token"
unset TOKEN
put "$ITMP/token" "$SRV_USER" "$SRV_GRP" 600 "$DEST"
echo "set-claude-token: stored for $SRV_USER (mode 600); Claude answers with it from the next message, valid for one year"
