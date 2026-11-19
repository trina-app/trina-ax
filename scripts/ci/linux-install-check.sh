#!/usr/bin/env bash
# The Linux desktop packages on a GitHub ubuntu-24.04 runner (.github/workflows/desktop.yml, docs/decisions/
# 20261119-linux-desktop-app.md "CI"): the .deb installed, started, updated over and removed, then the AppImage started
# where the sandbox cannot run. Two unsigned builds of the same commit, an old and a new version, as the Windows job does.
#
#   linux-install-check.sh full  <old.deb> <new.deb> <new.AppImage>
#   linux-install-check.sh start <the.deb>            (arm64 runner: install, start, remove)
#
# Environment: OLD_VERSION / NEW_VERSION (the .deb's form, `~` for `-`), PACKAGE (the .deb's package name), EXE (the
# program, its AppArmor profile, its menu entry), PRODUCT (the window's name), SCHEME (links), LOG_DIR.
set -euo pipefail

mode=${1:?full or start}
LOG_DIR=${LOG_DIR:-${RUNNER_TEMP:-/tmp}/linux-install-logs}
mkdir -p "$LOG_DIR"
: "${PACKAGE:?}" "${EXE:?}" "${PRODUCT:?}" "${SCHEME:?}"

step() { echo "::group::$*"; }
done_step() { echo "::endgroup::"; }
fail() { echo "::error::$*"; exit 1; }

# Chromium's sandbox uses user namespaces. Ubuntu 24.04 lets a program create one only through an AppArmor profile
# (kernel.apparmor_restrict_unprivileged_userns=1): the .deb installs that profile, the AppImage cannot. Set here, not
# taken from the runner image, so both checks below mean the same on every image.
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1 > /dev/null

DESKTOP_FILE=/usr/share/applications/$EXE.desktop
PROFILE=/etc/apparmor.d/$EXE

# the folder the app keeps its data in (a fresh one per check run; never the runner's own)
DATA=$(mktemp -d "${RUNNER_TEMP:-/tmp}/linux-app-data.XXXXXX")
# its own home too: xdg-mime and the link handler write ~/.config/mimeapps.list
HOME_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/linux-app-home.XXXXXX")

installed_program() { dpkg-query -L "$PACKAGE" | grep -E "/$EXE\$" | grep '^/opt/' | head -n 1; }

# Start the app under a virtual display and wait for its first window. Then check that it runs sandboxed: no process
# has --no-sandbox, and its renderers live in a user namespace of their own. `$1`: a name for the logs.
start_app() {
  local name=$1 program=$2
  local log="$LOG_DIR/$name.log"
  echo "starting $program ($name)"
  # shellcheck disable=SC2016
  HOME="$HOME_DIR" MYCEL_DESKTOP_USER_DATA="$DATA" timeout 150 xvfb-run -a -s '-screen 0 1440x900x24' bash -c '
    set -u
    "$0" > "$1" 2>&1 &
    pid=$!
    # polled, not `search --sync`: one search dies on an X BadWindow when a window goes away while it is read
    found=0
    for _ in $(seq 1 120); do xdotool search --onlyvisible --class "^$2\$" > /dev/null 2>&1 && { found=1; break; }; sleep 0.5; done
    if [ "$found" != 1 ]; then
      echo "no window within 60 s"; kill "$pid" 2> /dev/null; exit 3
    fi
    echo "window: $(xdotool search --onlyvisible --class "^$2\$" getwindowname 2> /dev/null | head -n 1)"
    sleep 3
    # the processes of the app by program name (never this shell, whose text names the flags it looks for)
    pids=$(pgrep -x "$2" || true)
    [ -n "$pids" ] || { echo "the app is not running"; exit 4; }
    for p in $pids; do
      if tr "\0" " " < "/proc/$p/cmdline" | grep -q -- "--no-sandbox"; then echo "runs without the sandbox: $(tr "\0" " " < "/proc/$p/cmdline")"; kill "$pid"; exit 5; fi
    done
    echo "app processes: $(echo $pids | wc -w)"
    main_ns=$(readlink "/proc/$pid/ns/user")
    own=0
    for p in $pids; do
      tr "\0" " " < "/proc/$p/cmdline" 2> /dev/null | grep -q -- "--type=renderer" || continue
      [ "$(readlink "/proc/$p/ns/user" 2> /dev/null)" != "$main_ns" ] && own=$((own + 1))
    done
    echo "renderers in their own user namespace: $own"
    [ "$own" -gt 0 ] || { echo "no renderer is sandboxed in a user namespace"; kill "$pid"; exit 6; }
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2> /dev/null || exit 0; sleep 0.5; done
    kill -9 "$pid" 2> /dev/null; exit 0
  ' "$program" "$log" "$EXE" || { cat "$log"; fail "$name: the app did not start sandboxed with a window"; }
}

check_installed() {
  local want=$1
  local v
  v=$(dpkg-query -W -f='${Version}' "$PACKAGE")
  [ "$v" = "$want" ] || fail "installed version is $v, not $want"
  echo "installed $PACKAGE $v"
  local program
  program=$(installed_program)
  [ -n "$program" ] && [ -x "$program" ] || fail "no program $EXE under /opt"
  [ -x "/usr/bin/$EXE" ] || fail "no /usr/bin/$EXE"
  [ -f "$DESKTOP_FILE" ] || fail "no menu entry $DESKTOP_FILE"
  grep -q "^MimeType=.*x-scheme-handler/$SCHEME" "$DESKTOP_FILE" || fail "the menu entry does not take $SCHEME:// links"
  grep -q "^StartupWMClass=$EXE\$" "$DESKTOP_FILE" || fail "the menu entry's StartupWMClass is not $EXE"
  [ -f "$PROFILE" ] || fail "no AppArmor profile $PROFILE"
  sudo grep -q "^$EXE " /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile $EXE is not loaded"
  check_icon
  echo "menu entry, link type, icon and AppArmor profile are there"
}

# The menu entry's Icon= name at the sizes GNOME looks up (QA TC-5353: only a 1024 px picture shipped, and GNOME's
# hicolor lookup stops at 512, so the grid and the dock showed a generic gear): 256 and 512 px PNGs of that name, each
# really that size, and the scalable SVG.
check_icon() {
  local icon size f
  icon=$(sed -n 's/^Icon=//p' "$DESKTOP_FILE" | head -n 1)
  [ -n "$icon" ] || fail "the menu entry names no Icon"
  case "$icon" in /*) fail "the menu entry's Icon is a path ($icon), not a name the icon theme looks up" ;; esac
  for size in 256 512; do
    f=/usr/share/icons/hicolor/${size}x${size}/apps/$icon.png
    [ -f "$f" ] || fail "no ${size}x${size} icon $f for Icon=$icon"
    file "$f" | grep -q "PNG image data, $size x $size" || fail "$f is not a $size x $size PNG: $(file -b "$f")"
  done
  [ -f "/usr/share/icons/hicolor/scalable/apps/$icon.svg" ] || fail "no scalable icon for Icon=$icon"
  echo "icon $icon: $(dpkg-query -L "$PACKAGE" | grep -c "/hicolor/.*/apps/$icon\.") sizes in hicolor"
}

check_handler() {
  local h
  h=$(HOME="$HOME_DIR" xdg-mime query default "x-scheme-handler/$SCHEME" || true)
  [ "$h" = "$EXE.desktop" ] || fail "$SCHEME:// links go to '$h', not $EXE.desktop"
  echo "$SCHEME:// links open $h"
}

if [ "$mode" = start ]; then
  deb=${2:?the .deb}
  step "install $(basename "$deb")"
  sudo apt-get install -y "$(realpath "$deb")" > "$LOG_DIR/install.log" 2>&1 || { cat "$LOG_DIR/install.log"; fail "the install did not finish"; }
  check_installed "${NEW_VERSION:?}"
  done_step
  step "start"
  start_app start "$(installed_program)"
  check_handler
  done_step
  XX
  done_step
  echo "arm64 .deb: installed, started sandboxed, removed"
  exit 0
fi

[ "$mode" = full ] || fail "unknown mode $mode"
old=${2:?old .deb} new=${3:?new .deb} appimage=${4:?new AppImage}
: "${OLD_VERSION:?}" "${NEW_VERSION:?}"

step "1. install the old version ($OLD_VERSION)"
sudo apt-get install -y "$(realpath "$old")" > "$LOG_DIR/install-old.log" 2>&1 || { cat "$LOG_DIR/install-old.log"; fail "the install did not finish"; }
check_installed "$OLD_VERSION"
done_step

step "2. start it"
start_app old "$(installed_program)"
# the app registers the link handler on its first packaged start
check_handler
[ -n "$(ls -A "$DATA")" ] || fail "the app wrote nothing to its data folder"
done_step

step "3. install the new version ($NEW_VERSION) over it"
sudo apt-get install -y "$(realpath "$new")" > "$LOG_DIR/install-new.log" 2>&1 || { cat "$LOG_DIR/install-new.log"; fail "the install over the old version did not finish"; }
check_installed "$NEW_VERSION"
check_handler
[ -n "$(ls -A "$DATA")" ] || fail "the data folder is gone after the update"
start_app new "$(installed_program)"
done_step

step "4. remove it"
program_dir=$(dirname "$(installed_program)")
sudo apt-get remove -y "$PACKAGE" > "$LOG_DIR/remove.log" 2>&1 || { cat "$LOG_DIR/remove.log"; fail "the remove did not finish"; }
dpkg-query -W -f='${Status}' "$PACKAGE" 2> /dev/null | grep -q 'install ok installed' && fail "still installed"
[ ! -e "/usr/bin/$EXE" ] || fail "/usr/bin/$EXE is left"
[ ! -e "$program_dir/$EXE" ] || fail "$program_dir/$EXE is left"
[ ! -f "$DESKTOP_FILE" ] || fail "the menu entry is left"
[ ! -f "$PROFILE" ] || fail "the AppArmor profile file is left"
if sudo grep -q "^$EXE " /sys/kernel/security/apparmor/profiles; then fail "the AppArmor profile is still loaded"; fi
# the handler named the menu entry, which is gone: nothing answers the links now
h=$(HOME="$HOME_DIR" xdg-mime query default "x-scheme-handler/$SCHEME" || true)
if [ -n "$h" ] && [ -f "/usr/share/applications/$h" ]; then fail "$SCHEME:// links still open $h"; fi
[ -n "$(ls -A "$DATA")" ] || fail "the data folder is gone after the remove (it stays, as documented)"
echo "removed; the data folder stays"
done_step

step "5. the AppImage where the sandbox cannot run"
# the AppImage's static runtime needs no libfuse2, only a fusermount program (fuse3, from the workflow's tools step)
command -v fusermount3 > /dev/null || command -v fusermount > /dev/null || fail "no fusermount (the workflow installs fuse3)"
chmod +x "$appimage"
log="$LOG_DIR/appimage.log"
APPDATA=$(mktemp -d "${RUNNER_TEMP:-/tmp}/linux-appimage-data.XXXXXX")
# its AppRun adds --no-sandbox when `unshare -Ur true` fails (above: it does); the app shows its dialog and no window
# shellcheck disable=SC2016
HOME="$HOME_DIR" MYCEL_DESKTOP_USER_DATA="$APPDATA" timeout 150 xvfb-run -a -s '-screen 0 1440x900x24' bash -c '
  set -u
  "$0" > "$1" 2>&1 &
  pid=$!
  # polled (see start_app): windows of the app come and go while its dialog opens
  found=0
  for _ in $(seq 1 120); do xdotool search --onlyvisible --name "\.deb" > /dev/null 2>&1 && { found=1; break; }; sleep 0.5; done
  if [ "$found" != 1 ]; then
    echo "no .deb dialog within 60 s"; kill "$pid" 2> /dev/null; exit 3
  fi
  echo "dialog: $(xdotool search --onlyvisible --name "\.deb" getwindowname 2> /dev/null | head -n 1)"
  if xdotool search --onlyvisible --class "^$2\$" getwindowname 2> /dev/null | grep -qv "\.deb"; then echo "the app opened a window"; kill "$pid"; exit 4; fi
  # Escape is Quit (the cancel button)
  xdotool search --onlyvisible --name "\.deb" windowactivate --sync key --clearmodifiers Escape 2> /dev/null || xdotool key Escape
  for _ in $(seq 1 40); do kill -0 "$pid" 2> /dev/null || exit 0; sleep 0.5; done
  echo "the app did not quit after the dialog"; kill -9 "$pid"; exit 5
' "$appimage" "$log" "$EXE" || { cat "$log"; fail "the AppImage did not refuse to run without the sandbox"; }
grep -q -- 'started without the sandbox' "$log" || { cat "$log"; fail "the app did not say why it quit"; }
echo "the AppImage showed the .deb dialog and quit"
done_step

echo "Linux packages: install, start, update over, remove and the AppImage refusal all passed"
