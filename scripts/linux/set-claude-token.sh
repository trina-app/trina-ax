#!/bin/bash
# Store the owner's long-lived Claude subscription token (subscription mode) on a Linux server: the Linux port of
# scripts/macos/set-claude-token.sh (linux-runtime spec 3.5.3). Installed as <install>/root/set-claude-token
# (root-owned) by scripts/install-linux.sh. Run it as root; the token is read from standard input, never from the
# command line (argv is visible to every process on the server):
#
#   claude setup-token                      # (on any computer) approve in the browser, copy the sk-ant-oat01-… token
#   sudo /var/lib/mycel/root/set-claude-token < token.txt     (or: xclip -o | sudo …, or paste and press Ctrl-D)
#
#   sudo …/set-claude-token --remove        # forget the token (Claude stops answering)
#   options: --base DIR (install folder; default: the folder above this script's root/)
#
# All white space of the paste is removed before the check, so a token a terminal wrapped over several lines is
# stored whole (docs/INSTALL.md known issue 14). The token lands in <install>/secrets/claude-oauth-token, owned by the
# server account, mode 600, in the server's 700 secrets folder: the engine account can never read it, and the engine
# sandbox does not mount it. The server reads it on every model request, so no restart is needed. Root never writes
# through what a role account could have planted there: the installer's safe-fs helpers (no symbolic link on the way,
# written in a root-only folder and renamed into place).
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
die() { echo "set-claude-token: $*" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
BASE="" REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || die "--base needs a folder"; BASE=$2; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    # never echo the argument: it may be the token itself, pasted in the wrong place
    *) die "unknown option (the token goes on standard input, not on the command line)" ;;
  esac
done
# unprivileged only for the repository's own tests (tests/unit/g-scripts.test.ts), which own the whole test folder
[ "$(id -u)" = 0 ] || [ "${MYCEL_SET_TOKEN_TEST:-}" = 1 ] || die "run as root: sudo \"$0\" < token.txt"
[ -n "$BASE" ] || BASE=$(dirname "$HERE")
BASE=$(cd "$BASE" 2>/dev/null && pwd -P) || die "install folder not found"
SECRETS="$BASE/secrets"
[ -d "$SECRETS" ] && [ ! -L "$SECRETS" ] || die "$SECRETS is missing; is the team server installed here?"
# the server account owns the secrets folder (installer: mk <server> <server group> 700 secrets)
SRV_USER=$(stat -c %U "$SECRETS")
SRV_GRP=$(stat -c %G "$SECRETS")
if [ "$(id -u)" = 0 ]; then
  [[ "$SRV_USER" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ "$SRV_USER" != root ] || die "$SECRETS is owned by $SRV_USER, not a team server role account; refusing"
fi
[ "$(stat -c %a "$SECRETS")" = 700 ] || die "$SECRETS must be mode 700"
DEST="$SECRETS/claude-oauth-token"

# shellcheck disable=SC2034  # used by safe-fs.sh
SAFE_ROOTS=("$BASE")
ITMP=$(mktemp -d "$BASE/.token-tmp.XXXXXX")
trap 'rm -rf "$ITMP"' EXIT
# the installer's helpers, root-owned next to this script (root/safe-fs.sh; scripts/linux/ in the repository)
[ -f "$HERE/safe-fs.sh" ] && [ ! -L "$HERE/safe-fs.sh" ] || die "safe-fs.sh missing next to $0"
# shellcheck source=safe-fs.sh
. "$HERE/safe-fs.sh"

if [ "$REMOVE" = 1 ]; then
  nolink "$SECRETS"
  if [ -e "$DEST" ] || [ -L "$DEST" ]; then mv -f -T "$DEST" "$ITMP/old"; fi
  echo "set-claude-token: removed; Claude stops answering until a new token is stored"
  exit 0
fi

[ ! -t 0 ] || die "give the token on standard input: sudo \"$0\" < token.txt"
# at most 4 KB; every blank, tab, CR and line break removed (a wrapped paste is joined, not cut at the first line)
TOKEN=$(head -c 4096 | tr -d '[:space:]')
# the full token: sk-ant-oat01- and at least 80 more characters (a real one has about 95); a paste cut short at a line
# wrap is refused instead of being stored and failing at the first message
[[ "$TOKEN" =~ ^sk-ant-oat[0-9][0-9]-[A-Za-z0-9_-]{80,1000}$ ]] || die "this does not look like a whole token from \`claude setup-token\` (sk-ant-oat01-… with about 95 more characters); nothing changed"
printf '%s\n' "$TOKEN" > "$ITMP/token"
unset TOKEN
put "$ITMP/token" "$SRV_USER" "$SRV_GRP" 600 "$DEST"
echo "set-claude-token: stored for $SRV_USER (mode 600); Claude answers with it from the next message, valid for one year"
