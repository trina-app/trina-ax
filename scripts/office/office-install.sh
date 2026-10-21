#!/bin/bash
# Team AX office mode installer (docs/OFFICE.md). No sudo: everything goes into your own home folder.
#
#   bash office-install.sh [options]          from the unzipped TeamAX-office-<version> folder
#
#   --prefix DIR         install folder (default ~/TeamAX). Data (data/, team/, tls/, config/) is never inside app/,
#                        so running a newer zip's installer again updates the program and keeps everything else.
#   --lan-port N         https port for the desks (default 8443, or what an earlier install chose)
#   --helper-port N      plain-http certificate page (default lan-port - 1; 0 = off)
#   --app-port N         this Mac's own port on 127.0.0.1 (default 47830)
#   --label L            LaunchAgent label (default app.team-ax.office; tests use another one)
#   --run-dir DIR        engine socket folder when the install folder path is too long for a socket (tests)
#   --public-host NAME --tunnel-token-file FILE
#                        the internet address (docs/OFFICE.md "인터넷 주소"): NAME (e.g. app.example.com) reaches this
#                        Mac through a Cloudflare Tunnel whose connector token is in FILE (made on the owner's Mac by
#                        scripts/office/public-address.ts). The token is copied to <prefix>/config/tunnel-token (600)
#                        and the bundled cloudflared runs as a second LaunchAgent. Later: <prefix>/teamax public-address
#   --claude-token-file FILE
#                        recommended (security round 4b): FILE holds the owner's long-lived Claude token, the output of
#                        `claude setup-token` (one sk-ant-oat01-... line). It is copied to <prefix>/config/claude-oauth-token
#                        (600) and Claude runs through the model proxy with a per-turn token and a HOME without this
#                        Mac's login: the AI engine can no longer read the Mac's Claude login. Without it the engine uses
#                        this Mac's own Claude login (it must be logged in). Later: <prefix>/teamax configure
#                        --claude-token-file FILE && <prefix>/teamax restart (back: --claude-auth local-login)
#   --no-open            do not open the setup page in the browser
#   --no-desktop         do not offer the desktop app installers found next to the bundle (below)
#   --update             run by the automatic updater (docs/OFFICE.md "자동 업데이트", server/src/office/update.ts):
#                        nothing interactive, no browser, the Claude Code found earlier is kept when the login check
#                        cannot run here, and the closing instructions are left out
#   --check-only         run the checks, print what would happen, change nothing
#
# Checks: macOS 13+, not root, this Mac's architecture is in the bundle, Claude Code is installed and logged in
# (`claude auth status`; not needed with --claude-token-file), the ports are free (after stopping this installation's own agent). Codex is not used in
# office mode (the clinic's data goes to Anthropic only). Then: copies app/ (only this Mac's architecture) into <prefix>/app, keeps the previous one
# as app.previous, removes the download quarantine from the copied programs, writes config/office.env, installs and
# starts the LaunchAgent (server/src/office/cli.ts install), waits until the server answers and prints the address
# for the desks and the first-run setup link. Desktop app installers (Team-AX-Setup-*-x64.exe, Team-AX-*-mac*.dmg) in
# this folder or the folder it was unzipped into (where the zip usually is) are offered to the members under
# Settings → Apps (the newest per platform). ~/Downloads is looked at only for a platform those have nothing for, and
# its file is offered only after you answer yes. A bundle built with --with-desktop carries desktop.sha256: then only
# the installers it lists (same name and SHA-256) are offered. Later: <prefix>/teamax desktop add <file>.
set -euo pipefail
umask 022

SRC=$(cd "$(dirname "$0")" && pwd)
PREFIX="$HOME/TeamAX"
CONF_ARGS=()
OPEN=1 CHECK_ONLY=0 DESKTOP=1 UPDATE=0 TOKEN_FILE=
die() { echo "office-install: $*" >&2; exit 1; }
say() { echo "office-install: $*"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=$2; shift 2 ;;
    --lan-port|--helper-port|--app-port|--label|--run-dir|--public-host|--tunnel-token-file) [ $# -ge 2 ] || die "$1 needs a value"; CONF_ARGS+=("$1" "$2"); shift 2 ;;
    --claude-token-file) [ $# -ge 2 ] || die "$1 needs a value"; [ -f "$2" ] || die "$2: no such file (the output of 'claude setup-token')"; TOKEN_FILE=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); CONF_ARGS+=("$1" "$TOKEN_FILE"); shift 2 ;;
    --no-open) OPEN=0; shift ;;
    --no-desktop) DESKTOP=0; shift ;;
    --update) UPDATE=1; OPEN=0; DESKTOP=0; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ---- checks ----
[ "${TEAMAX_TEST_UNAME:-$(uname -s)}" = Darwin ] || die "Team AX office mode runs on macOS"
[ "$(id -u)" != 0 ] || die "do not use sudo: run it as the Mac user whose Claude Code login the team will use"
OSV=${TEAMAX_TEST_OSVERSION:-$(sw_vers -productVersion 2>/dev/null || echo 0)}
[ "${OSV%%.*}" -ge 13 ] 2>/dev/null || die "macOS 13 or newer is needed (this Mac: $OSV)"
case "${TEAMAX_TEST_ARCH:-$(uname -m)}" in
  arm64) ARCH=darwin-arm64 ;;
  x86_64) ARCH=darwin-amd64 ;;
  *) die "unsupported processor $(uname -m)" ;;
esac
[ -f "$SRC/app/VERSION" ] && [ -x "$SRC/app/bin/$ARCH/bun" ] && [ -f "$SRC/app/server/src/office.js" ] || die "$SRC is not an unpacked TeamAX-office bundle for $ARCH"
VERSION=$(tr -d '[:space:]' < "$SRC/app/VERSION")
case "$PREFIX" in /*) ;; *) PREFIX="$PWD/$PREFIX" ;; esac
# where desktop app installers may be: inside this folder and next to it (the zip's folder); ~/Downloads only as a
# fallback that asks first; desktop.sha256 in the bundle = only the installers built with it
DESKTOP_ARGS=("$SRC" "$(dirname "$SRC")")
if [ -d "$HOME/Downloads" ] && [ "$(cd "$HOME/Downloads" && pwd -P)" != "$(cd "$(dirname "$SRC")" && pwd -P)" ]; then
  DESKTOP_ARGS+=(--fallback "$HOME/Downloads")
fi
[ -f "$SRC/desktop.sha256" ] && DESKTOP_ARGS+=(--manifest "$SRC/desktop.sha256")
[[ "$PREFIX" != *$'\n'* && "$PREFIX" != *:* ]] || die "the install folder may not contain ':' or a line break"

# Claude Code: the engine is this Mac's own login (the owner's subscription)
CLAUDE=${TEAMAX_CLAUDE_BIN:-}
if [ -z "$CLAUDE" ]; then
  for c in "$(command -v claude 2>/dev/null || true)" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE=$c; break; fi
  done
fi
# subscription mode (a setup-token now or from an earlier install): the Mac's own login is not used
SUBSCRIPTION=0
if [ -n "$TOKEN_FILE" ]; then SUBSCRIPTION=1
elif [ -f "$PREFIX/config/office.env" ] && grep -q '^TEAMAX_CLAUDE_AUTH=subscription$' "$PREFIX/config/office.env"; then SUBSCRIPTION=1; fi
if [ "$UPDATE" = 1 ]; then
  # an automatic update keeps the installation's Claude Code; a login that lapsed is the owner's to fix, not a reason
  # to leave the clinic on the old version (the server reports it in Admin > System)
  if [ -n "$CLAUDE" ] && [ -x "$CLAUDE" ]; then CONF_ARGS+=(--claude-bin "$CLAUDE"); fi
else
[ -n "$CLAUDE" ] && [ -x "$CLAUDE" ] || die "Claude Code is not installed for this user. Install it (curl -fsSL https://claude.ai/install.sh | bash), run 'claude', log in with the subscription account, then run this again."
if [ "$SUBSCRIPTION" = 0 ]; then
  AUTH=$("$CLAUDE" auth status 2>/dev/null || true)
  echo "$AUTH" | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true' || die "Claude Code is installed ($CLAUDE) but not logged in. Run 'claude' in Terminal, log in (/login) with the subscription account, then run this again (or pass --claude-token-file with the output of 'claude setup-token')."
fi
CONF_ARGS+=(--claude-bin "$CLAUDE")
fi
BUN_SRC="$SRC/app/bin/$ARCH/bun"
"$BUN_SRC" --version >/dev/null 2>&1 || { xattr -d com.apple.quarantine "$BUN_SRC" 2>/dev/null || true; "$BUN_SRC" --version >/dev/null 2>&1 || die "$BUN_SRC does not run on this Mac"; }

say "Team AX office mode $VERSION ($ARCH) -> $PREFIX"
if [ "$UPDATE" != 1 ]; then
if [ "$SUBSCRIPTION" = 1 ]; then
  say "Claude Code: $CLAUDE with the owner's setup-token (subscription mode: the AI engine does not use or see this Mac's Claude login)"
else
  say "Claude Code: $CLAUDE (logged in; the AI engine uses this Mac's Claude login. Safer: --claude-token-file, see --help)"
  # the engine can write ~/.claude.json (the CLI keeps its login there); the server removes MCP servers from it, and this
  # account should run `claude` only to log in again (an MCP server planted there would run outside the sandbox)
  say "Use 'claude' on this Mac account only to log in again (/login); check 'claude mcp list' shows no servers first."
fi
fi
if [ "$CHECK_ONLY" = 1 ]; then
  # settings are validated by the same code the install uses, written into a throwaway folder
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  if [ -f "$PREFIX/config/office.env" ]; then mkdir -p "$T/config"; cp "$PREFIX/config/office.env" "$T/config/office.env"; fi
  "$BUN_SRC" "$SRC/app/server/src/office.js" configure --home "$T" --as-home "$PREFIX" "${CONF_ARGS[@]}" | sed 's/^/  /'
  TL=$(sed -n 's/^TEAMAX_LABEL=//p' "$T/config/office.env")
  if launchctl print "gui/$(id -u)/$TL" >/dev/null 2>&1; then
    say "ports: in use by this installation's running agent ($TL), reused by the update"
  else
    "$BUN_SRC" "$SRC/app/server/src/office.js" check-ports --home "$T" || die "a port is taken (see above)"
    say "ports: free"
  fi
  if [ -d "$PREFIX/app" ]; then say "would update $PREFIX/app (data/, team/, tls/, config/ kept)"; else say "would install into $PREFIX"; fi
  # read-only: compared with what $PREFIX already offers
  [ "$DESKTOP" = 0 ] || "$BUN_SRC" "$SRC/app/server/src/office.js" desktop --home "$PREFIX" add-from --dry-run "${DESKTOP_ARGS[@]}" | sed 's/^/  /'
  say "check only: nothing changed"
  exit 0
fi

# ---- settings first (validates ports and the socket path before anything is copied) ----
mkdir -p "$PREFIX"
chmod 755 "$PREFIX"
"$BUN_SRC" "$SRC/app/server/src/office.js" configure --home "$PREFIX" "${CONF_ARGS[@]}" > /dev/null
LABEL=$(sed -n 's/^TEAMAX_LABEL=//p' "$PREFIX/config/office.env")

# ---- stop a running installation before its program is replaced (the server and its cloudflared) ----
launchctl bootout "gui/$(id -u)/$LABEL.tunnel" >/dev/null 2>&1 || true
if launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then sleep 1; fi

# ---- the ports must be free now (another program, e.g. a second installation, would make the server wait forever) ----
"$BUN_SRC" "$SRC/app/server/src/office.js" check-ports --home "$PREFIX" || die "a port is taken (see above); nothing was changed except config/office.env. If this installation was running, start it again: $PREFIX/teamax start"

# ---- program: this Mac's architecture only ----
NEW="$PREFIX/app.new"
rm -rf "$NEW"
mkdir -p "$NEW/bin" "$NEW/native/bin"
for p in server scripts web docs teamax VERSION versions.json; do [ -e "$SRC/app/$p" ] && cp -R "$SRC/app/$p" "$NEW/$p"; done
cp -R "$SRC/app/bin/$ARCH/." "$NEW/bin/"
cp -R "$SRC/app/native/bin/$ARCH" "$NEW/native/bin/$ARCH"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
chmod -R go-w "$NEW"
"$NEW/bin/bun" --version >/dev/null || die "the copied bun does not run"
if [ -d "$PREFIX/app" ]; then rm -rf "$PREFIX/app.previous"; mv "$PREFIX/app" "$PREFIX/app.previous"; fi
mv "$NEW" "$PREFIX/app"
ln -sfn app/teamax "$PREFIX/teamax"
for d in data team tls config; do mkdir -p "$PREFIX/$d"; chmod 700 "$PREFIX/$d"; done
mkdir -p "$PREFIX/logs"

# ---- agent ----
INSTALL_ARGS=(install --home "$PREFIX")
[ "$OPEN" = 1 ] || INSTALL_ARGS+=(--no-open)
"$PREFIX/app/bin/bun" "$PREFIX/app/server/src/office.js" "${INSTALL_ARGS[@]}" || die "the server did not start; see $PREFIX/logs/office.log ($PREFIX/teamax logs)"

# ---- desktop app installers next to the bundle: offered under Settings → Apps (a failure is reported, not fatal) ----
if [ "$DESKTOP" = 1 ]; then
  say "데스크톱 앱 설치 파일 찾는 중 / looking for desktop app installers: $SRC, $(dirname "$SRC")"
  "$PREFIX/app/bin/bun" "$PREFIX/app/server/src/office.js" desktop --home "$PREFIX" add-from "${DESKTOP_ARGS[@]}" | sed -l 's/^/  /' || true
fi

if [ "$UPDATE" = 1 ]; then say "updated to $VERSION"; exit 0; fi

# ---- what the owner still has to do (needs an admin or a person; shown, not run) ----
FW=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || true)
PUBLIC=$(sed -n 's/^TEAMAX_PUBLIC_HOST=//p' "$PREFIX/config/office.env")
cat <<EOF

=== 설치 끝 / installed: $VERSION ===
명령 / command:  $PREFIX/teamax status | info | card | logs | restart | setup-link | reset-link | backup | public-address | desktop
설치 가이드 / guide:  $PREFIX/app/docs/OFFICE.md (PDF: 압축을 푼 폴더의 Team-AX-치과-설치가이드.pdf)
EOF
if [ -n "$PUBLIC" ]; then
  cat <<EOF

인터넷 주소 / internet address:  https://$PUBLIC
  데스크는 Edge로 이 주소를 열면 됩니다 (인증서 설치 필요 없음). 첫 설정(소유자 계정)은 이 맥에서만 합니다.
  desks open this address in Edge (no certificate to install). The first-run setup is done on this Mac only.
EOF
fi
cat <<EOF

데스크 카드를 인쇄하세요 / print the desk card:  $PREFIX/teamax card
  카드의 지문(thumbprint)으로 데스크가 인증서를 확인합니다. 데스크가 많으면 $PREFIX/tls/ca.cer 를 USB로 나눠 주면 더 안전합니다.

이 맥이 계속 켜져 있게 / keep this Mac running (docs/OFFICE.md):
  1. 잠자기 끄기·정전 후 자동 켜짐 (관리자 암호 필요, 한 번만) / never sleep, start after a power cut:
       sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
  2. 공유기에서 이 맥의 주소를 고정 (DHCP 예약) / reserve this Mac's address in the router (DHCP reservation)
  3. 정전 뒤: FileVault가 켜져 있으면 맥 앞에서 암호를 한 번 입력하면 Team AX가 스스로 켜집니다.
     after a power cut with FileVault on, type the Mac password once at the Mac; Team AX starts by itself.
EOF
case "$FW" in
  *enabled*|*"State = 1"*|*"State = 2"*)
    cat <<EOF
  4. 방화벽이 켜져 있습니다 / the firewall is on: when macOS asks whether "bun" may accept incoming connections,
     click Allow. Or once, in Terminal:
       sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$PREFIX/app/bin/bun" --unblockapp "$PREFIX/app/bin/bun"
EOF
    ;;
esac
