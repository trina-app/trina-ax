#!/bin/bash
# Dev environment on a Mac team server (docs/DECISIONS.md "Dev environment on a Mac team server"): the root part.
# scripts/install-macos.sh runs it (on by default; --no-dev-env turns it off and runs uninstall-srt-mac.sh). It is
# idempotent. Bash 3.2 (macOS).
#
#   install-srt-mac.sh --id ID --base BASE --server-user SRV --prefix PREFIX --slots N [--bun BUN] [--name NAME]
#
# What it does:
#   - Python 3 (the list's pinned python-build-standalone tarball) in /opt/trina/python3-<version>, link
#     /opt/trina/python3;
#   - node (the list's pinned tarball for this Mac, scripts/system/packages.json) in /opt/trina/node-v<version>, link
#     /opt/trina/node; srt (package-lock.json, npm ci --ignore-scripts) in /opt/trina/srt/<version> with full.mjs
#     (srt-full.mjs) and mac.mjs (srt-mac.mjs); /opt/trina/devenv/run-wrap-mac. All root's; no account can change them.
#   - the dev slot accounts PREFIX1..PREFIXN (one uid per run at a time) and their group PREFIX: role accounts (UID
#     450-499, hidden, shell /usr/bin/false, no password, home /var/empty);
#   - /etc/sudoers.d/<id>-devenv: the server account may run /opt/trina/devenv/run-wrap-mac as a slot account, with the
#     environment it gives (SETENV), and nothing else (checked with visudo -c);
#   - an ACL on <base>/team and <base>/devenv (and what is in them now): the slot group and the server account may
#     read and write there, and new files inherit it. The srt sandbox decides what one run may open; the ACL only lets
#     the slot accounts reach the team folder at all (the server owns it, mode 700).
# It prints the ACL entries (one line each) for the server's environment (MYCEL_DEV_ENV_ACL).
set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
HERE=$(cd "$(dirname "$0")" && pwd -P)
OPT=/opt/trina
ID="" BASE="" SRV_USER="" PREFIX="" SLOTS="" PK_BUN="" NAME=""
die() { echo "install-srt-mac: $*" >&2; exit 1; }
say() { echo "install-srt-mac: $*" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=$2; shift 2 ;;
    --base) BASE=$2; shift 2 ;;
    --server-user) SRV_USER=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --slots) SLOTS=$2; shift 2 ;;
    --bun) PK_BUN=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ "$(id -u)" = 0 ] || die "run as root"
[ "$(uname -s)" = Darwin ] || die "macOS only (Linux: install-srt.sh)"
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad --id"
[ -d "$BASE" ] && [ ! -L "$BASE" ] || die "--base $BASE is not a folder"
[[ "$SRV_USER" =~ ^_[a-z][a-z0-9]{2,30}$ ]] && id "$SRV_USER" >/dev/null 2>&1 || die "bad --server-user"
[[ "$PREFIX" =~ ^_[a-z][a-z0-9]{0,30}dev$ ]] || die "--prefix must look like _axdev"
[[ "$SLOTS" =~ ^[0-9]{1,2}$ ]] && [ "$SLOTS" -ge 2 ] && [ "$SLOTS" -le 16 ] || die "--slots must be 2-16"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,40}$ ]] || NAME=$ID
[ -x /usr/bin/sandbox-exec ] || die "no /usr/bin/sandbox-exec on this Mac"
for f in package.json package-lock.json srt-full.mjs srt-mac.mjs run-wrap-mac; do [ -f "$HERE/$f" ] || die "$HERE/$f is missing"; done
SRT_VERSION=$(sed -n 's/.*"@anthropic-ai\/sandbox-runtime": "\([0-9.]*\)".*/\1/p' "$HERE/package.json" | head -n 1)
[[ "$SRT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json does not pin srt"
SRT_DIR=$OPT/srt/$SRT_VERSION

# the list of packages and its reader: next to this file (system/, a bundle) or the repository's scripts/system/
SYS=$HERE/system; [ -f "$SYS/packages.sh" ] || SYS=$HERE/../../system
[ -f "$SYS/packages.sh" ] && [ -f "$SYS/packages.json" ] || die "no list of packages (system/packages.sh)"
# shellcheck source=../../system/packages.sh
. "$SYS/packages.sh"
pk_load "$SYS/packages.json" || die "cannot read the list of packages"
PLATFORM=$(pk_platform) || die "unknown machine $(uname -m)"
NODE_VERSION=$(pk_art node "$PLATFORM" version) || die "the list has no node for $PLATFORM"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the list's node version $NODE_VERSION is not a version"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
install -d -o root -g wheel -m 755 "$OPT" "$OPT/srt" "$OPT/devenv"
# root runs what is in /opt/trina: nobody else may change it
for d in "$OPT" "$OPT/srt" "$OPT/devenv"; do
  [ ! -L "$d" ] && [ "$(stat -f %u "$d")" = 0 ] && [ -z "$(find "$d" -maxdepth 0 -perm +022)" ] || die "$d must belong to root, and only root may write to it"
done

# ---- node (pinned tarball) ----
NODE_DIR=$OPT/node-v$NODE_VERSION
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "node $NODE_VERSION"
  NODE_TOP=$(pk_art node "$PLATFORM" dir) && [[ "$NODE_TOP" =~ ^node-v[0-9.]+-darwin-[a-z0-9]+$ ]] || die "the list's node has no folder name for $PLATFORM"
  pk_fetch "$(pk_art node "$PLATFORM" url)" "$(pk_art node "$PLATFORM" sha256)" "$(pk_art node "$PLATFORM" size)" "$TMP/node.tar.xz" \
    || die "node tarball: not downloaded, or not the one the list pins"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP"
  [ -d "$TMP/$NODE_TOP" ] || die "node tarball: no $NODE_TOP in it"
  rm -rf "$NODE_DIR"; mv "$TMP/$NODE_TOP" "$NODE_DIR"
  chown -R root:wheel "$NODE_DIR"; chmod -R go-w "$NODE_DIR"
fi
ln -sfn "node-v$NODE_VERSION" "$OPT/node"
"$OPT/node/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||a===22&&b>=21?0:1)' || die "node is older than 22.21"

# ---- Python 3 (pinned python-build-standalone tarball): a run installs libraries with pip into the project or its
# home, never system programs, so the base runtime comes from here ----
PY_VERSION=$(pk_art cpython "$PLATFORM" version) || die "the list has no cpython for $PLATFORM"
[[ "$PY_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the list's cpython version $PY_VERSION is not a version"
PY_DIR=$OPT/python3-$PY_VERSION
if [ ! -x "$PY_DIR/bin/python3" ]; then
  say "python $PY_VERSION"
  PY_TOP=$(pk_art cpython "$PLATFORM" dir) && [ "$PY_TOP" = python ] || die "the list's cpython has no folder name for $PLATFORM"
  pk_fetch "$(pk_art cpython "$PLATFORM" url)" "$(pk_art cpython "$PLATFORM" sha256)" "$(pk_art cpython "$PLATFORM" size)" "$TMP/python.tar.gz" \
    || die "python tarball: not downloaded, or not the one the list pins"
  mkdir "$TMP/py" && tar -xzf "$TMP/python.tar.gz" -C "$TMP/py"
  [ -x "$TMP/py/$PY_TOP/bin/python3" ] || die "python tarball: no $PY_TOP/bin/python3 in it"
  rm -rf "$PY_DIR"; mv "$TMP/py/$PY_TOP" "$PY_DIR"
  chown -R root:wheel "$PY_DIR"; chmod -R go-w "$PY_DIR"
fi
ln -sfn "python3-$PY_VERSION" "$OPT/python3"
"$OPT/python3/bin/python3" -c 'import ssl, sqlite3, venv, pip' || die "python $PY_VERSION is not complete (ssl, sqlite3, venv, pip)"
# git, make and cc come from Apple's Command Line Tools (not pinned: Apple's own, updated by Software Update)
[ -x /Library/Developer/CommandLineTools/usr/bin/git ] || say "warning: no Command Line Tools on this Mac: a run has no git, make or cc (install them: xcode-select --install)"

# ---- srt (pinned lockfile, no install scripts) ----
if [ ! -f "$SRT_DIR/cli.js" ] || ! cmp -s "$HERE/package-lock.json" "$SRT_DIR/package-lock.json"; then
  say "srt $SRT_VERSION"
  NEW=$(mktemp -d "$OPT/srt/.new.XXXXXX")
  cp "$HERE/package.json" "$HERE/package-lock.json" "$NEW/"
  ( cd "$NEW" && env -i HOME="$NEW" PATH="$OPT/node/bin:/usr/bin:/bin" "$OPT/node/bin/npm" ci --ignore-scripts --omit=dev --no-audit --no-fund --cache "$NEW/.npm" >/dev/null ) || { rm -rf "$NEW"; die "npm ci failed"; }
  rm -rf "$NEW/.npm"
  ln -sfn node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js "$NEW/cli.js"
  chown -R root:wheel "$NEW"; chmod -R go-w "$NEW"; chmod 755 "$NEW"
  rm -rf "$SRT_DIR"; mv "$NEW" "$SRT_DIR"
fi
install -o root -g wheel -m 644 "$HERE/srt-full.mjs" "$SRT_DIR/full.mjs"
install -o root -g wheel -m 644 "$HERE/srt-mac.mjs" "$SRT_DIR/mac.mjs"
"$OPT/node/bin/node" "$SRT_DIR/full.mjs" --self-test >/dev/null || die "full.mjs does not refuse addresses and local names"
"$OPT/node/bin/node" "$SRT_DIR/mac.mjs" --self-test >/dev/null || die "mac.mjs does not add the localhost rules (a new srt version?)"
[ "$("$OPT/node/bin/node" "$SRT_DIR/cli.js" --version)" = "$SRT_VERSION" ] || die "srt does not answer --version $SRT_VERSION"
for old in "$OPT"/srt/*/; do
  old=${old%/}; [ "$old" = "$SRT_DIR" ] && continue
  if pgrep -f "$old/" >/dev/null 2>&1; then say "kept $old: a run still uses it"; else rm -rf "$old"; fi
done
install -o root -g wheel -m 755 "$HERE/run-wrap-mac" "$OPT/devenv/run-wrap-mac"

# ---- the dev slot accounts and their group ----
used_ids() { { dscl . -list /Users UniqueID; dscl . -list /Groups PrimaryGroupID; } | awk '{print $2}' | sort -n -u; }
free_id() { local n; for n in $(seq 450 499); do used_ids | grep -qx "$n" || { echo "$n"; return 0; }; done; return 1; }
if ! dscl . -read "/Groups/$PREFIX" PrimaryGroupID >/dev/null 2>&1; then
  gid=$(free_id) || die "no free id in 450-499 for the group $PREFIX"
  dscl . -create "/Groups/$PREFIX" PrimaryGroupID "$gid" || die "could not create the group $PREFIX"
  dscl . -create "/Groups/$PREFIX" RealName "$NAME dev runs ($ID)"
  dscl . -create "/Groups/$PREFIX" Password '*'
fi
GID=$(dscl . -read "/Groups/$PREFIX" PrimaryGroupID | awk '{print $2}')
ACCOUNTS=()
for n in $(seq 1 "$SLOTS"); do
  u=$PREFIX$n
  if ! dscl . -read "/Users/$u" UniqueID >/dev/null 2>&1; then
    uid=$(free_id) || die "no free id in 450-499 for $u"
    dscl . -create "/Users/$u" || die "could not create $u"
    dscl . -create "/Users/$u" UniqueID "$uid"
    dscl . -create "/Users/$u" PrimaryGroupID "$GID"
    dscl . -create "/Users/$u" UserShell /usr/bin/false
    dscl . -create "/Users/$u" NFSHomeDirectory /var/empty
    dscl . -create "/Users/$u" RealName "$NAME dev run $n ($ID)"
    dscl . -create "/Users/$u" IsHidden 1
    dscl . -create "/Users/$u" Password '*'
  fi
  [ "$(dscl . -read "/Users/$u" PrimaryGroupID | awk '{print $2}')" = "$GID" ] || die "$u is not in the group $PREFIX"
  ACCOUNTS+=("$u")
done

# ---- sudoers: the server account runs run-wrap-mac as a slot account, nothing else ----
grep -Eq '^#includedir /private/etc/sudoers.d|^@includedir /private/etc/sudoers.d' /etc/sudoers || die "/etc/sudoers does not read /private/etc/sudoers.d"
RUNAS=$(IFS=,; echo "${ACCOUNTS[*]}")
cat > "$TMP/sudoers" <<EOF
# $NAME ($ID) dev environment (scripts/dev-env/srt/install-srt-mac.sh; removed by uninstall-srt-mac.sh).
# The server account starts and stops runs as a dev slot account: only run-wrap-mac, only these accounts, with the
# run's environment (SETENV). No password, no terminal.
Defaults:$SRV_USER !lecture, !requiretty
Defaults!$OPT/devenv/run-wrap-mac !use_pty
$SRV_USER ALL=($RUNAS) NOPASSWD:SETENV: $OPT/devenv/run-wrap-mac
EOF
visudo -cf "$TMP/sudoers" >/dev/null || die "the sudoers rule does not parse"
install -o root -g wheel -m 440 "$TMP/sudoers" "/etc/sudoers.d/$ID-devenv"
visudo -c >/dev/null || { rm -f "/etc/sudoers.d/$ID-devenv"; die "sudoers is not valid with the rule; removed it"; }

# ---- the ACL of the run folders ----
# writesecurity: a run may change the mode (and ACL) of a team file it may write that another account owns (the server,
# or an earlier run's dev account). Without it, overwriting such a file with Python's shutil.copy, cp -p or rsync -a ends
# in EPERM when the mode is copied (Mac mini, 2026-11-12). Seatbelt allows mode and ACL changes only in the run's
# writable folders (checked: shared/, the team root and users/ refuse them), and their parents team/ and users/ stay
# closed to every other account of the Mac, so a wider entry there reaches no one new. No chown right.
PERMS=list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,read,write,append,execute,delete,file_inherit,directory_inherit
ACES=("group:$PREFIX allow $PERMS" "user:$SRV_USER allow $PERMS")
SRV_GRP=$(id -gn "$SRV_USER")
for d in team devenv; do
  [ -L "$BASE/$d" ] && die "$BASE/$d is a link"
  [ -d "$BASE/$d" ] || install -d -o "$SRV_USER" -g "$SRV_GRP" -m 700 "$BASE/$d"
  # chmod +a adds an entry only once; files of other accounts (a slot's) have it inherited already
  for a in "${ACES[@]}"; do chmod -R +a "$a" "$BASE/$d" 2>/dev/null || chmod +a "$a" "$BASE/$d" || die "could not set the ACL on $BASE/$d"; done
done

# ---- check: the server account can start run-wrap-mac as the first slot, and only that ----
OUT=$(cd / && sudo -n -u "$SRV_USER" sudo -n -u "${ACCOUNTS[0]}" "$OPT/devenv/run-wrap-mac" check 2>&1) || die "the server account cannot run run-wrap-mac as ${ACCOUNTS[0]}: $OUT"
[ "$OUT" = "ok ${ACCOUNTS[0]}" ] || die "run-wrap-mac check answered: $OUT"
if (cd / && sudo -n -u "$SRV_USER" sudo -n -u "${ACCOUNTS[0]}" /bin/sh -c true) >/dev/null 2>&1; then die "the sudoers rule is too wide (the server account ran /bin/sh as ${ACCOUNTS[0]})"; fi
if (cd / && sudo -n -u "$SRV_USER" sudo -n -u root "$OPT/devenv/run-wrap-mac" check) >/dev/null 2>&1; then die "the sudoers rule is too wide (root)"; fi
say "done: srt $SRT_VERSION, node $NODE_VERSION, slots ${ACCOUNTS[*]}"
printf '%s\n' "${ACES[@]}"
