#!/bin/bash
# Staging install on this Mac (docs/TEST-ENV.md "스테이징 설치"): a second, long-lived production install that stays
# next to the dev server — id mycel-stage, role accounts _axssrv / _axsagt, server on 127.0.0.1:19190, model proxy on
# 19191, no office-network TLS — with the real Claude Code and Codex CLI at the versions pinned in versions.json. It is
# where real turns run as the engine account (sandbox + pf + model proxy), and where updates, the subscription token and
# the Codex engine login are tried, as often as needed. Never give it a public address.
#
#   sudo scripts/stage.sh deploy                build a bundle from this checkout (as $SUDO_USER) and install it, or
#                                               update the installed one (a newer version, like an in-app update)
#   sudo scripts/stage.sh status                daemons, health, version, engines
#   sudo scripts/stage.sh account ARGS…         root/mycel-account (create-owner --username … --name … --team …,
#                                               reset-link, list-owners)
#   pbpaste | sudo scripts/stage.sh claude-token  store the owner's `claude setup-token` token for the server account
#   sudo scripts/stage.sh codex-login|codex-status|codex-logout   the engine account's own ChatGPT login (device code)
#   sudo scripts/stage.sh logs                  the server log, last lines
#   sudo scripts/stage.sh remove [--delete-data]  uninstall (the data stays unless --delete-data)
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

ID=mycel-stage SRV=_axssrv AGT=_axsagt PORT=19190 PROXY_PORT=19191
BASE="/Library/Application Support/$ID"
REPO=$(cd "$(dirname "$0")/.." && pwd -P)

die() { echo "stage: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
cmd=${1:-}; shift || true

admin_js() { cd / && sudo -u "$SRV" env MYCEL_MODE=prod MYCEL_CONFIG="$BASE/config/server.json" HOME="$BASE/data" "$BASE/app/current/bin/bun" "$BASE/app/current/server/src/admin.js" "$@"; }

case "$cmd" in
  deploy)
    [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || die "deploy builds as the invoking user: run it with sudo from your own account"
    U_HOME=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')
    as_user() { sudo -u "$SUDO_USER" -H env PATH="$U_HOME/.bun/bin:$U_HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"; }
    pin() { as_user "$U_HOME/.bun/bin/bun" -e "console.log(require('$REPO/versions.json')['$1'])"; }
    # the engines at the pinned versions (the admin screen calls any other version unsupported)
    CLAUDE_V=$(pin claude-code) CODEX_V=$(pin codex-cli)
    CLAUDE_BIN="$U_HOME/.local/share/claude/versions/$CLAUDE_V"
    [ -x "$CLAUDE_BIN" ] || die "Claude Code $CLAUDE_V not found at $CLAUDE_BIN (install that version: claude install $CLAUDE_V)"
    CODEX_BIN=$(ls -d "$U_HOME"/.codex/packages/standalone/releases/"$CODEX_V"-*/bin/codex 2>/dev/null | head -1)
    [ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ] || die "Codex CLI $CODEX_V (standalone) not found under $U_HOME/.codex/packages"
    VERSION="$(as_user "$U_HOME/.bun/bin/bun" -e "console.log(require('$REPO/server/package.json').version)")-stage.$(date +%Y%m%d%H%M)"
    OUT="$REPO/dist/stage"
    echo "stage: building $VERSION from $(as_user git -C "$REPO" rev-parse --short HEAD)$(as_user git -C "$REPO" diff --quiet HEAD || echo ' (with uncommitted changes)')"
    (cd "$REPO" && as_user rm -rf "$OUT" && as_user "$U_HOME/.bun/bin/bun" run build >/dev/null && as_user "$U_HOME/.bun/bin/bun" scripts/build-bundle.ts --version "$VERSION" --out "$OUT")
    "$REPO/scripts/install-macos.sh" --from "$OUT" --id "$ID" --server-user "$SRV" --agent-user "$AGT" \
      --port "$PORT" --tls-port 0 --proxy-port "$PROXY_PORT" --allow-unsigned --no-power --skip-tmutil \
      --engine claude="$CLAUDE_BIN" --engine codex="$CODEX_BIN" --codex-models "$U_HOME/.codex/models_cache.json"
    echo "stage: http://127.0.0.1:$PORT"
    ;;
  status)
    # pf runs once (loads the anchor and exits 0); the launcher and the server stay running
    for d in pf launcher server; do printf '%-9s %s\n' "$d" "$(launchctl print "system/app.treesoop.$ID.$d" 2>/dev/null | awk -F' = ' '/^\tstate =/{s=$2} /^\tlast exit code =/{e=$2} END{print s (e != "" ? ", last exit " e : "")}' || true)"; done
    printf 'health    %s\n' "$(curl -s -m 5 "http://127.0.0.1:$PORT/api/health" || echo 'no answer')"
    printf 'version   %s\n' "$(readlink "$BASE/app/current" 2>/dev/null || echo 'not installed')"
    printf 'codex     %s\n' "$(admin_js codex-status 2>&1 | tail -1)"
    printf 'claude    %s\n' "$([ -s "$BASE/secrets/claude-oauth-token" ] && echo 'token stored' || echo 'no token yet (pbpaste | sudo scripts/stage.sh claude-token)')"
    ;;
  account) "$BASE/root/mycel-account" "$@" ;;
  claude-token) "$BASE/root/set-claude-token" ;;
  codex-login|codex-status|codex-logout) admin_js "$cmd" ;;
  logs) tail -n "${1:-80}" "/Library/Logs/$ID/server/server.log" 2>/dev/null || ls -R "/Library/Logs/$ID" ;;
  remove) "$REPO/scripts/uninstall-macos.sh" --id "$ID" --server-user "$SRV" --agent-user "$AGT" "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
