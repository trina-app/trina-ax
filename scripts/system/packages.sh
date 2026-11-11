#!/bin/bash
# The one list of system packages and downloaded programs (scripts/system/packages.json; docs/DECISIONS.md "One list of
# system packages"). Every install path reads the list through these functions, and none keeps a list of its own
# (tests/unit/system-packages.test.ts):
#   - scripts/install-linux.sh sources the kit's copy (app/<v>/root/packages.sh, signed with the bundle);
#   - scripts/image/customize.sh, scripts/dev-env/srt/install-srt.sh, scripts/dev-env/install-trial.sh and
#     scripts/dev-env/vm-setup.sh source the copy next to them (system/ in a staged folder) or scripts/system/;
#   - scripts/office/office-install.sh sources the zip's app/scripts/system/packages.sh;
#   - `mycel-ctl update` runs `<base>/root/packages.sh sync` once a release's root files and app are in place.
#
# The list is read once (pk_load). A bundle carries it flattened too (root/packages.flat, written by build-bundle.ts with
# the list's sha256 on its first line), so root reads it with awk alone; otherwise with a bun the caller trusts (PK_BUN:
# the kit's or the bundle's) or with jq. The readers give the same flat lines (pk_flat; the test compares them).
# Bash 3.2 (macOS) compatible. Functions return non-zero and print why; the caller decides whether that stops it.
#
#   packages.sh flat     [--list FILE] [--bun BUN]                       the flat lines (tests, debugging)
#   packages.sh groups   [--list FILE] PROFILE|GROUP...                  minimal | default, or group names
#   packages.sh packages [--list FILE] --distro D --arch A PROFILE|GROUP...  the apt packages, one per line
#   packages.sh sync     --id ID --base BASE [--bun BUN]                 mycel-ctl update: bring this machine to the list
#                        of <base>/root: the missing packages of the install's profile (apt, only when install.json says
#                        skipApt false), then the browser at the pinned version and MYCEL_HTML_PDF_BROWSER in
#                        /etc/default/<id>, and the Python programs in /opt/trina/python/<name>. Writes
#                        <base>/root/packages.synced (the list's sha256 and the result: ok, incomplete = try again later,
#                        blocked = needs an administrator). Exit 0 unless the arguments are wrong: the server works
#                        without these.

PK_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PK_LIST=${PK_LIST:-}
PK_BUN=${PK_BUN:-}
PK_FLAT=
# where the Linux browser lives: one per machine, root-owned, shared by every install id
PK_OPT=${PK_OPT:-/opt/trina}
PK_BROWSER=chrome-headless-shell
PK_ENV_KEY=MYCEL_HTML_PDF_BROWSER
# the descriptor of the browser folder's lock (flock); other descriptors stay the caller's
PK_LOCK_FD=7

pk_err() { echo "packages: $*" >&2; }

# ---- reading the list ----

# The flat lines. Fields are separated by a TAB; "-" is an empty field.
#   D <distro> <os id> <version> <suite>          A <arch>
#   G <group> <install>                           GA <group> <artifact>
#   P <group> <package> <floor> <on> <when>       R <group> <package to remove>
#   F <artifact> <platform> <version> <url> <sha256> <size> <dir>
#   X <artifact> <revoked version>                (a version that must not stay, even when newer than the pin)
#   GY <group> <python program>                   Y <program> <version> <python floor> <file in bin/>
#   W <program> <name==version> <sha256 sha256 ...>   (a wheel pip installs, with the sha256 of each file it may take)
PK_JS='const j = JSON.parse(require("fs").readFileSync(process.env.PK_JSON, "utf8"))
if (j.format !== 1) throw new Error("format " + j.format)
const o = [], f = (x) => x === undefined || x === null || x === "" ? "-" : String(x), t = (...a) => o.push(a.map(f).join("\t"))
for (const [k, d] of Object.entries(j.distros)) t("D", k, d.id, d.version, d.suite)
for (const a of j.arches) t("A", a)
for (const [g, v] of Object.entries(j.groups)) {
  t("G", g, v.install)
  for (const [n, s] of Object.entries(v.packages ?? {})) {
    const p = typeof s === "string" ? { min: s } : s
    t("P", g, n, (p.min ?? "").replace(/^>=/, ""), (p.on ?? []).join(","), p.when)
  }
  for (const n of v.remove ?? []) t("R", g, n)
  for (const a of v.artifacts ?? []) t("GA", g, a)
  for (const y of v.python ?? []) t("GY", g, y)
}
for (const [n, a] of Object.entries(j.artifacts)) for (const [p, x] of Object.entries(a.platforms)) t("F", n, p, a.version, x.url, x.sha256, x.size, x.dir)
for (const [n, a] of Object.entries(j.artifacts)) for (const v of a.revoked ?? []) t("X", n, v)
for (const [n, y] of Object.entries(j.python ?? {})) t("Y", n, y.version, y.python.replace(/^>=/, ""), y.program)
for (const [n, y] of Object.entries(j.python ?? {})) for (const [r, h] of Object.entries(y.requirements)) t("W", n, r, h)
console.log(o.join("\n"))'
PK_JQ='def f: if . == null or . == "" then "-" else tostring end;
if .format != 1 then error("format \(.format)") else . end
| ( (.distros | to_entries[] | ["D", .key, .value.id, .value.version, .value.suite]),
    (.arches[] | ["A", .]),
    (.groups | to_entries[] | .key as $g | .value as $v
      | ["G", $g, $v.install],
        (($v.packages // {}) | to_entries[] | (.value | if type == "string" then {min: .} else . end) as $p
          | ["P", $g, .key, (($p.min // "") | sub("^>="; "")), (($p.on // []) | join(",")), $p.when]),
        (($v.remove // [])[] | ["R", $g, .]),
        (($v.artifacts // [])[] | ["GA", $g, .]),
        (($v.python // [])[] | ["GY", $g, .])),
    (.artifacts | to_entries[] | .key as $n | .value.version as $ver | .value.platforms | to_entries[]
      | ["F", $n, .key, $ver, .value.url, .value.sha256, .value.size, .value.dir]),
    (.artifacts | to_entries[] | .key as $n | (.value.revoked // [])[] | ["X", $n, .]),
    ((.python // {}) | to_entries[] | ["Y", .key, .value.version, (.value.python | sub("^>="; "")), .value.program]),
    ((.python // {}) | to_entries[] | .key as $n | .value.requirements | to_entries[] | ["W", $n, .key, .value]) )
| map(f) | join("\t")'

pk_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# Run PK_BUN as a plain JSON reader: an empty folder of its own as the working folder and no environment (bun reads
# bunfig.toml and .env from the working folder, and BUN_OPTIONS adds arguments).
pk__bun() {
  local w rc=0
  w=$(mktemp -d) || return 1
  (cd "$w" && exec env -i PATH=/usr/bin:/bin HOME="$w" PK_JSON="$PK_LIST" "$PK_BUN" -e "$PK_JS") || rc=$?
  rm -rf "$w"
  return $rc
}
# the list's flat copy next to it (<list>.flat, from a bundle), when its first line names the list's sha256
pk__flat_file() {
  local f="${PK_LIST%.json}.flat" want
  [ "$f" != "$PK_LIST" ] && [ -f "$f" ] || return 1
  want="#sha256 $(pk_sha256 "$PK_LIST")"
  [ "$(head -n 1 "$f")" = "$want" ] || return 1
  sed 1d "$f"
}
pk_flat() {
  if pk__flat_file; then return 0
  elif [ -n "$PK_BUN" ]; then
    [ -x "$PK_BUN" ] || { pk_err "PK_BUN $PK_BUN is not a program"; return 1; }
    pk__bun
  elif command -v jq >/dev/null 2>&1; then
    jq -r "$PK_JQ" "$PK_LIST"
  else
    pk_err "reading $PK_LIST needs its .flat copy, jq (apt-get install jq) or the kit's bun"
    return 1
  fi
}
# pk_need_reader: PK_BUN or jq, else (root, apt) jq installed now; jq is in the default groups anyway (devenv)
pk_need_reader() {
  [ -z "$PK_BUN" ] || return 0
  ! command -v jq >/dev/null 2>&1 || return 0
  if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then pk_apt_install -- jq && return 0; fi
  pk_err "reading the list needs jq (apt-get install jq) or the kit's bun"
  return 1
}
# pk_load [FILE]: read the list once. FILE defaults to packages.json next to this script.
pk_load() {
  [ -z "${1:-}" ] || PK_LIST=$1
  [ -n "$PK_LIST" ] || PK_LIST=$PK_HERE/packages.json
  case "$PK_LIST" in /*) ;; *) PK_LIST=$PWD/$PK_LIST ;; esac
  [ -f "$PK_LIST" ] || { pk_err "no list at $PK_LIST"; return 1; }
  PK_FLAT=$(pk_flat) || { pk_err "cannot read $PK_LIST"; PK_FLAT=; return 1; }
  [ -n "$PK_FLAT" ] || { pk_err "$PK_LIST is empty"; return 1; }
}
pk__lines() { printf '%s\n' "$PK_FLAT"; }

# ---- this machine ----

# pk_distro [OS-ID VERSION-ID]: the list's key for this system (/etc/os-release), or nothing and 1 when the list does
# not support it. The installers accept no other release: that is the pin of the distribution.
# shellcheck disable=SC2120 # the arguments are optional (install-linux.sh passes them)
pk_distro() {
  local id=${1:-} ver=${2:-}
  if [ -z "$id" ]; then
    [ -r /etc/os-release ] || return 1
    id=$(. /etc/os-release && echo "${ID:-}"); ver=$(. /etc/os-release && echo "${VERSION_ID:-}")
  fi
  local k
  k=$(pk__lines | awk -F'\t' -v i="$id" -v v="$ver" '$1 == "D" && $3 == i && $4 == v { print $2; exit }')
  [ -n "$k" ] || return 1
  echo "$k"
}
# pk_arch: amd64 | arm64 (the list's names), from uname -m
pk_arch() {
  case "${PK_UNAME_M:-$(uname -m)}" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}
# pk_platform: linux-amd64 | linux-arm64 | darwin-arm64 | darwin-amd64 (the artifacts' platform names)
pk_platform() {
  local a; a=$(pk_arch) || return 1
  case "${PK_UNAME_S:-$(uname -s)}" in Linux) echo "linux-$a" ;; Darwin) echo "darwin-$a" ;; *) return 1 ;; esac
}
# pk_os_identity: "<ID>-<VERSION_ID>/<machine-id>", the system this sync runs on (packages.synced "os"; mycel-ctl's
# osIdentity reads the same files the same way). The machine-id is new on every clone of the image, so a reimage that
# keeps the data disk (and the record on it) is a new system. Nothing when neither file can be read.
pk_os_identity() {
  local osr=${PK_OS_RELEASE:-/etc/os-release} mid=${PK_MACHINE_ID:-/etc/machine-id} id='' ver='' m=''
  [ -r "$osr" ] || [ -r "$mid" ] || return 0
  if [ -r "$osr" ]; then
    id=$(. "$osr" && echo "${ID:-}"); ver=$(. "$osr" && echo "${VERSION_ID:-}")
  fi
  [ ! -r "$mid" ] || m=$(tr -cd '0-9a-f' < "$mid")
  # no cut: GNU cut ends its output with a newline, BSD cut does not; the name has no newline on any system
  local s; s=$(printf '%s-%s/%s' "$(printf '%s' "$id" | tr -cd 'A-Za-z0-9._-')" "$(printf '%s' "$ver" | tr -cd 'A-Za-z0-9._-')" "$m")
  printf '%s' "${s:0:128}"
}
# conditions a package may name ("when"): true here?
pk__userns_restricted() {
  if [ -n "${PK_USERNS_RESTRICTED:-}" ]; then [ "$PK_USERNS_RESTRICTED" = 1 ]; return; fi
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]
}

# ---- groups, packages, artifacts ----
# (group and package names have no spaces: the test checks the list's names. Lists are passed word by word.)

# pk_groups PROFILE|GROUP...: group names in list order. minimal = the always groups; default = always + default.
pk_groups() {
  local w out
  [ $# -gt 0 ] || { pk_err "pk_groups: no profile or group"; return 1; }
  for w in "$@"; do
    case "$w" in
      minimal|default) ;;
      *) pk__lines | awk -F'\t' -v g="$w" '$1 == "G" && $2 == g { f = 1 } END { exit !f }' || { pk_err "no group or profile \"$w\" in the list"; return 1; } ;;
    esac
  done
  out=$(pk__lines | awk -F'\t' -v want=" $* " '
    $1 == "G" {
      i = $3
      if (index(want, " " $2 " ") || (index(want, " minimal ") && i == "always") || (index(want, " default ") && (i == "always" || i == "default"))) print $2
    }')
  printf '%s\n' "$out" | sed '/^$/d'
}
# pk__words: lines -> " a b c " (a group set for awk's index())
pk__words() { printf ' %s ' "$(printf '%s\n' "$1" | tr '\n' ' ')"; }
# pk_packages DISTRO ARCH PROFILE|GROUP...: the apt packages for that system, each once, in list order. A name that is
# not a Debian package name (a leading -, a glob character, a space) stops it: callers pass the names word by word.
pk_packages() {
  local d=$1 a=$2 g r=0; shift 2
  g=$(pk_groups "$@") || return 1
  pk__userns_restricted && r=1
  pk__lines | awk -F'\t' -v gs="$(pk__words "$g")" -v d="$d" -v a="$a" -v r="$r" '
    $1 == "P" && index(gs, " " $2 " ") {
      if ($5 != "-") { n = split($5, on, ","); ok = 0; for (i = 1; i <= n; i++) if (on[i] == d || on[i] == d "/" a) ok = 1; if (!ok) next }
      if ($6 == "userns-restricted" && r != 1) next
      if ($6 != "-" && $6 != "userns-restricted") next
      if ($3 !~ /^[a-z0-9][a-z0-9.+-]*$/) { print "packages: not a package name in the list: " $3 > "/dev/stderr"; bad = 1; exit 1 }
      if (!seen[$3]++) print $3
    }
    END { exit bad }'
}
# pk_floors DISTRO ARCH PROFILE|GROUP...: "package floor" for the packages that have one
pk_floors() {
  local d=$1 a=$2 p; shift 2
  p=" $(pk_packages "$d" "$a" "$@" | tr '\n' ' ') " || return 1
  pk__lines | awk -F'\t' -v ps="$p" '$1 == "P" && $4 != "-" && index(ps, " " $3 " ") && !seen[$3]++ { print $3, $4 }'
}
# pk_removals GROUP...: packages the groups remove (the image: no SSH server)
pk_removals() {
  local g; g=$(pk_groups "$@") || return 1
  pk__lines | awk -F'\t' -v gs="$(pk__words "$g")" '$1 == "R" && index(gs, " " $2 " ") && !seen[$3]++ {
    if ($3 !~ /^[a-z0-9][a-z0-9.+-]*$/) { print "packages: not a package name in the list: " $3 > "/dev/stderr"; exit 1 }
    print $3 }'
}
# pk_artifacts PROFILE|GROUP...: the downloaded programs of the groups
pk_artifacts() {
  local g; g=$(pk_groups "$@") || return 1
  pk__lines | awk -F'\t' -v gs="$(pk__words "$g")" '$1 == "GA" && index(gs, " " $2 " ") && !seen[$3]++ { print $3 }'
}
# pk_art NAME PLATFORM FIELD: version | url | sha256 | size | dir of an artifact (nothing and 1 when the list has none)
pk_art() {
  local col v
  case "$3" in version) col=4 ;; url) col=5 ;; sha256) col=6 ;; size) col=7 ;; dir) col=8 ;; *) pk_err "pk_art: field $3"; return 1 ;; esac
  v=$(pk__lines | awk -F'\t' -v n="$1" -v p="$2" -v c="$col" '$1 == "F" && $2 == n && $3 == p { print $c; exit }')
  [ -n "$v" ] || return 1
  [ "$v" = - ] || echo "$v"
}

# ---- apt ----

pk_installed() { [ "$(dpkg-query -W -f '${db:Status-Status}' "$1" 2>/dev/null || true)" = installed ]; }
# pk_missing PACKAGE...: those not installed, one per line
pk_missing() { local p; for p in "$@"; do pk_installed "$p" || echo "$p"; done; }
# KB of "<number> <unit>" as apt prints sizes (kB and MB are 1000-based there; near enough for a free-space check)
pk__kb() { awk -v s="$1" 'BEGIN { split(s, a, " "); gsub(",", "", a[1]); u = a[2]; f = (u == "GB") ? 1000000 : (u == "MB") ? 1000 : (u == "kB") ? 1 : 0.001; printf "%d\n", a[1] * f + 0.5 }'; }
# pk_apt_space PACKAGE...: room for what apt says it would download and add, plus 256 MB; prints why not
pk_apt_space() {
  local out need add c u
  out=$(LC_ALL=C apt-get install --no-install-recommends --assume-no -o DPkg::Lock::Timeout=300 "$@" 2>/dev/null || true)
  need=$(printf '%s\n' "$out" | sed -n 's#^Need to get \([0-9.,]* [kMG]*B\)[/ ].*#\1#p' | head -n 1)
  add=$(printf '%s\n' "$out" | sed -n 's#^After this operation, \([0-9.,]* [kMG]*B\) of additional.*#\1#p' | head -n 1)
  need=$(pk__kb "${need:-0 B}"); add=$(pk__kb "${add:-0 B}")
  # the archives' and the files' file systems: one free-space need when they are the same
  c=$(df -Pk /var/cache/apt/archives 2>/dev/null | awk 'NR == 2 { print $1, $4 }')
  u=$(df -Pk /usr 2>/dev/null | awk 'NR == 2 { print $1, $4 }')
  [ -n "$c" ] && [ -n "$u" ] || return 0
  if [ "${c%% *}" = "${u%% *}" ]; then
    [ "${c#* }" -ge $((need + add + 262144)) ] || { echo "not enough disk space: apt needs about $(( (need + add) / 1024 )) MB, $(( ${c#* } / 1024 )) MB are free"; return 1; }
  else
    [ "${c#* }" -ge $((need + 131072)) ] || { echo "not enough space in /var/cache/apt: $(( need / 1024 )) MB to download, $(( ${c#* } / 1024 )) MB free"; return 1; }
    [ "${u#* }" -ge $((add + 131072)) ] || { echo "not enough space in /usr: $(( add / 1024 )) MB to add, $(( ${u#* } / 1024 )) MB free"; return 1; }
  fi
}
# PK_APT_UNIT=1 (set by sync: mycel-ctl runs it inside the update unit): apt runs as a transient systemd unit of its own
# (systemd-run --wait --collect), outside the update unit's cgroup. Neither mycel-ctl's deadline, nor the end of the
# update unit, nor its TimeoutStartSec can stop it mid-transaction (systemd stops a unit's whole cgroup; a setsid child
# would go with it), and its output goes to PK_APT_LOG, never through a pipe a dying caller could close. Elsewhere (an
# administrator's installer, a chroot image build: systemd-run would reach the host's systemd there) apt runs directly.
PK_APT_LOG=${PK_APT_LOG:-/var/log/trina-packages-apt.log}
PK_SYSTEMD_DIR=${PK_SYSTEMD_DIR:-/run/systemd/system}
pk__apt() {  # apt-get ARG...
  local env=(-E DEBIAN_FRONTEND=noninteractive -E LC_ALL=C) k
  if [ "${PK_APT_UNIT:-}" = 1 ] && [ -d "$PK_SYSTEMD_DIR" ] && command -v systemd-run >/dev/null 2>&1; then
    for k in http_proxy https_proxy no_proxy all_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY; do
      [ -z "${!k:-}" ] || env+=(-E "$k=${!k}")
    done
    printf '%s apt-get %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$PK_APT_LOG" 2>/dev/null || true
    systemd-run --quiet --wait --collect --unit="trina-packages-apt-$$-${RANDOM}" -p "StandardOutput=append:$PK_APT_LOG" \
      -p "StandardError=append:$PK_APT_LOG" "${env[@]}" apt-get "$@"
  else
    DEBIAN_FRONTEND=noninteractive apt-get "$@" >/dev/null
  fi
}
# pk_apt_install [APT-OPTION...] -- PACKAGE...: apt-get update (once per run), a free-space check, and install without
# recommends. Both wait up to 5 minutes for dpkg's lock (unattended-upgrades). Exit 3: not enough disk space.
# PK_APT_SNAPSHOT=<YYYYMMDDTHHMMSSZ> installs from that snapshot of the archive (apt 2.7+; used on Debian 13, the image's
# system; needs ca-certificates), for an image that must be rebuilt with the same package versions.
pk_apt_install() {
  local opts=() snap=() why
  while [ $# -gt 0 ] && [ "$1" != -- ]; do opts+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || return 0
  if [ -n "${PK_APT_SNAPSHOT:-}" ]; then
    [[ "$PK_APT_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { pk_err "PK_APT_SNAPSHOT $PK_APT_SNAPSHOT is not YYYYMMDDTHHMMSSZ"; return 1; }
    # (the Release files of a snapshot older than their week have expired: their signature is still checked)
    snap=(--snapshot "$PK_APT_SNAPSHOT" -o Acquire::Check-Valid-Until=false)
  fi
  export DEBIAN_FRONTEND=noninteractive
  if [ -z "${PK_APT_UPDATED:-}" ]; then
    pk__apt update -qq -o DPkg::Lock::Timeout=300 ${snap[@]+"${snap[@]}"} || { pk_err "apt-get update failed"; return 1; }
    PK_APT_UPDATED=1
  fi
  if ! why=$(pk_apt_space ${snap[@]+"${snap[@]}"} "$@"); then pk_err "$why; nothing installed"; return 3; fi
  pk__apt install -y -qq --no-install-recommends -o DPkg::Lock::Timeout=300 ${snap[@]+"${snap[@]}"} ${opts[@]+"${opts[@]}"} "$@" \
    || { pk_err "apt-get install failed: $*$([ "${PK_APT_UNIT:-}" != 1 ] || echo " (log: $PK_APT_LOG)")"; return 1; }
}
# pk_check_floors DISTRO ARCH PROFILE|GROUP...: prints each package that is missing or below its floor; 1 if any
pk_check_floors() {
  local line pkg min have bad=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    pkg=${line%% *} min=${line#* }
    have=$(dpkg-query -W -f '${Version}' "$pkg" 2>/dev/null || true)
    if [ -z "$have" ]; then echo "package $pkg is not installed"; bad=1
    elif ! dpkg --compare-versions "$have" ge "$min"; then echo "package $pkg is $have, at least $min is needed"; bad=1; fi
  done <<EOF
$(pk_floors "$@")
EOF
  return $bad
}

# ---- downloads ----

# pk__bounded SECONDS COMMAND...: COMMAND, stopped (TERM, then KILL) when it runs longer than SECONDS, whatever it does
pk__bounded() {
  local s=$1 p w rc=0
  shift
  "$@" &
  p=$!
  # (the watchdog's own waits are interruptible, so stopping it never waits for its sleep)
  ( trap 'kill $sp 2>/dev/null; exit 0' TERM
    sleep "$s" & sp=$!; wait $sp
    kill -TERM "$p" 2>/dev/null
    sleep 5 & sp=$!; wait $sp
    kill -KILL "$p" 2>/dev/null ) &
  w=$!
  wait "$p" || rc=$?
  kill -TERM "$w" 2>/dev/null || true
  wait "$w" 2>/dev/null || true
  return $rc
}
# pk_fetch URL SHA256 SIZE OUT: https only, and bounded: every try gives up below 10 KB/s for 60 s or after 20 s without
# a connection, and all tries together stop after PK_FETCH_BUDGET seconds (default 480). The file must have the pinned
# sha256 (and size); nothing is left otherwise.
pk_fetch() {
  local url=$1 sha=$2 size=$3 out=$4 got n budget=${PK_FETCH_BUDGET:-480} start left try=0 rc
  case "$url" in https://*) ;; *) pk_err "$url: only https"; return 1 ;; esac
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { pk_err "$url: the list has no sha256"; return 1; }
  command -v curl >/dev/null 2>&1 || { pk_err "curl is missing (the core group installs it)"; return 1; }
  start=$(date +%s)
  while :; do
    try=$((try + 1))
    left=$(( budget - ($(date +%s) - start) ))
    [ "$left" -ge 5 ] || { rm -f "$out"; pk_err "downloading $url: stopped after ${budget} s (PK_FETCH_BUDGET)"; return 1; }
    rc=0
    pk__bounded "$left" curl --proto =https --proto-redir =https --tlsv1.2 -fsSL --connect-timeout 20 --speed-limit 10240 \
      --speed-time 60 --max-time "$left" -o "$out" "$url" || rc=$?
    [ "$rc" != 0 ] || break
    rm -f "$out"
    [ "$try" -lt 3 ] || { pk_err "downloading $url failed (curl exit $rc, $try tries)"; return 1; }
    sleep 2
  done
  got=$(pk_sha256 "$out")
  [ "$got" = "$sha" ] || { rm -f "$out"; pk_err "$url: sha256 $got, the list pins $sha"; return 1; }
  if [ -n "$size" ]; then
    n=$(wc -c < "$out" | tr -d ' ')
    [ "$n" = "$size" ] || { rm -f "$out"; pk_err "$url: $n bytes, the list says $size"; return 1; }
  fi
}

# ---- the browser ----
# DEST (/opt/trina/chrome-headless-shell, <prefix>/browser/chrome-headless-shell) holds <version>/<dir>/ folders and
# current -> <version>/<dir>. Each version folder is complete and verified before it gets its name; current changes only
# to a version that runs (--version); the version before stays until the next switch, as a print may still use it; a
# version newer than the list's (another install's newer kit) stays current; one lock (flock) serializes all of it.
# As root everything is root's; otherwise the caller's (an office Mac). Nobody else can write it (html-pdf.ts
# trustedBrowser).

# pk__newer A B: version A is newer than B (dotted numbers)
pk__newer() { awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m; for (i = 1; i <= k; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 1 }'; }
# the pin for PLATFORM: PK_V PK_URL PK_SHA PK_SIZE PK_DIR
pk__browser_pin() {
  PK_V=$(pk_art "$PK_BROWSER" "$1" version) || { pk_err "the list has no $PK_BROWSER for $1"; return 1; }
  PK_URL=$(pk_art "$PK_BROWSER" "$1" url) PK_SHA=$(pk_art "$PK_BROWSER" "$1" sha256)
  PK_SIZE=$(pk_art "$PK_BROWSER" "$1" size || true) PK_DIR=$(pk_art "$PK_BROWSER" "$1" dir)
  [[ "$PK_V" =~ ^[0-9][0-9.]*$ ]] && [[ "$PK_DIR" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && case "$PK_DIR" in *..*) false ;; esac \
    || { pk_err "$PK_BROWSER: bad version or dir in the list"; return 1; }
}
# DEST and its parent made, 755 whatever the umask; DEST locked (released by pk__unlock)
pk__browser_dest() {
  local dest=$1
  [ ! -L "$dest" ] || { pk_err "$dest is a link"; return 1; }
  mkdir -p "$dest" || return 1
  chmod 755 "$(dirname "$dest")" "$dest" || return 1
  if command -v flock >/dev/null 2>&1; then
    eval "exec $PK_LOCK_FD>\"\$dest/.lock\"" || return 1
    flock -w 900 "$PK_LOCK_FD" || { pk__unlock; pk_err "$dest is locked by another install for 15 minutes"; return 1; }
  fi
}
pk__unlock() { eval "exec $PK_LOCK_FD>&-"; }
# pk__current_version DEST: the version current points to, or nothing
pk__current_version() { local c; c=$(readlink "$1/current" 2>/dev/null || true); [ -z "$c" ] || echo "${c%%/*}"; }
# pk_browser_check PROGRAM: it starts and says its version (the libraries it loads are there)
pk_browser_check() { [ -f "$1" ] && "$1" --version 2>/dev/null | head -n 1 | grep -q '[0-9]'; }
# pk__revoked VERSION: the list revokes this version of the browser (its "revoked": a bad pin rolled back)
pk__revoked() { [ -n "$1" ] && pk__lines | awk -F'\t' -v n="$PK_BROWSER" -v v="$1" '$1 == "X" && $2 == n && $3 == v { f = 1 } END { exit !f }'; }
# current is runnable, newer than the pin and not revoked (a repair from an older kit keeps it; a revoked version goes
# back to the pin even when it is newer)
pk__newer_current() {
  local dest=$1 cv
  cv=$(pk__current_version "$dest")
  [ -n "$cv" ] && ! pk__revoked "$cv" && pk__newer "$cv" "$PK_V" && pk_browser_check "$dest/current/$PK_BROWSER"
}

# pk_browser_prepare DEST PLATFORM: the pinned version complete, verified and runnable in DEST/<version>, downloaded and
# tested in DEST/.new.* first. current is not touched, so a server may run meanwhile. A download that does not run here
# (a library missing) is kept as DEST/.untested-<version> and tested again next time, without a new download.
pk_browser_prepare() {
  local dest=$1 plat=$2 tmp old rc=0
  pk__browser_pin "$plat" || return 1
  pk__browser_dest "$dest" || return 1
  pk__browser_prepare_locked "$dest" || rc=$?
  pk__unlock
  return $rc
}
pk__browser_prepare_locked() {
  local dest=$1 tmp old prog
  # leftovers of a run that was stopped (we hold the lock)
  rm -rf "$dest"/.new.* "$dest"/.old.* "$dest"/current.new.* 2>/dev/null || true
  if pk__newer_current "$dest"; then return 0; fi
  if [ "$(cat "$dest/$PK_V/.sha256" 2>/dev/null || true)" = "$PK_SHA" ] && pk_browser_check "$dest/$PK_V/$PK_DIR/$PK_BROWSER"; then return 0; fi
  tmp=$(mktemp -d "$dest/.new.XXXXXX") || return 1
  if [ "$(cat "$dest/.untested-$PK_V/.sha256" 2>/dev/null || true)" = "$PK_SHA" ]; then
    rmdir "$tmp" && mv "$dest/.untested-$PK_V" "$tmp" || return 1
  else
    command -v unzip >/dev/null 2>&1 || { rm -rf "$tmp"; pk_err "unzip is missing (the browser group installs it)"; return 1; }
    if ! pk_fetch "$PK_URL" "$PK_SHA" "$PK_SIZE" "$tmp/b.zip"; then rm -rf "$tmp"; return 1; fi
    if ! (cd "$tmp" && unzip -q b.zip) || [ ! -f "$tmp/$PK_DIR/$PK_BROWSER" ]; then rm -rf "$tmp"; pk_err "$PK_URL: no $PK_DIR/$PK_BROWSER in the archive"; return 1; fi
    rm -f "$tmp/b.zip"
    printf '%s\n' "$PK_SHA" > "$tmp/.sha256"
    [ "$(id -u)" != 0 ] || chown -R 0:0 "$tmp"
    chmod -R a+rX,go-w "$tmp"
    # a download needs no quarantine flag (curl sets none), but an archive tool may copy one
    [ "${PK_UNAME_S:-$(uname -s)}" != Darwin ] || xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true
  fi
  prog="$tmp/$PK_DIR/$PK_BROWSER"
  if ! pk_browser_check "$prog"; then
    rm -rf "$dest/.untested-$PK_V"; mv "$tmp" "$dest/.untested-$PK_V"
    pk_err "$PK_BROWSER $PK_V does not start here (a library of the browser group missing?); the old version stays"
    return 1
  fi
  if [ -e "$dest/$PK_V" ]; then old=$(mktemp -d "$dest/.old.XXXXXX") && mv "$dest/$PK_V" "$old/"; fi
  mv "$tmp" "$dest/$PK_V" || return 1
  rm -rf "${old:-}" "$dest/.untested-$PK_V"
}

# pk__swap_link TARGET LINK: LINK -> TARGET, replaced in one rename (GNU mv -T, BSD mv -h)
pk__swap_link() {
  local t=$1 l=$2 n="$2.new.$$"
  rm -f "$n"; ln -s "$t" "$n" || return 1
  mv -T "$n" "$l" 2>/dev/null || mv -h "$n" "$l" 2>/dev/null || { rm -f "$n"; pk_err "cannot replace $l"; return 1; }
}

# pk_browser_switch DEST PLATFORM: current -> the prepared pinned version when it runs; else current stays when it runs.
# Prints the program's path through current (what MYCEL_HTML_PDF_BROWSER names), or nothing and 1 when no version runs.
pk_browser_switch() {
  local dest=$1 plat=$2 rc=0
  pk__browser_pin "$plat" || return 1
  pk__browser_dest "$dest" || return 1
  pk__browser_switch_locked "$dest" || rc=$?
  pk__unlock
  return $rc
}
pk__browser_switch_locked() {
  local dest=$1 cv prev keep v switched=0
  cv=$(pk__current_version "$dest")
  # the version a switch replaced: kept until the next switch, whoever runs the sync in between (another install id)
  prev=""
  [ ! -f "$dest/.previous" ] || prev=$(tr -cd 'A-Za-z0-9._-' < "$dest/.previous")
  # a revoked version is never kept as the one before
  ! pk__revoked "$prev" || prev=""
  if pk__newer_current "$dest"; then
    echo "packages: $PK_BROWSER $cv stays: it is newer than this list's $PK_V (another install put it there)" >&2
  elif pk_browser_check "$dest/$PK_V/$PK_DIR/$PK_BROWSER"; then
    if [ "$(readlink "$dest/current" 2>/dev/null || true)" != "$PK_V/$PK_DIR" ]; then
      pk__swap_link "$PK_V/$PK_DIR" "$dest/current" || return 1
      switched=1
      prev=""
      [ -z "$cv" ] || [ "$cv" = "$PK_V" ] || pk__revoked "$cv" || prev=$cv
    fi
  elif ! pk__revoked "$cv" && pk_browser_check "$dest/current/$PK_BROWSER"; then
    echo "packages: $PK_BROWSER $PK_V is not ready here; $cv stays" >&2
  else
    # current never names a program that does not run (the office supervisor names whatever current points to), nor a
    # revoked version: HTML to PDF stays off until the pin is ready
    rm -f "$dest/current"
    if pk__revoked "$cv"; then pk_err "$PK_BROWSER $cv is revoked by the list and $PK_V is not ready; HTML to PDF is off until it is"; fi
    pk_err "no $PK_BROWSER runs in $dest"
    return 1
  fi
  cv=$(pk__current_version "$dest")
  [ "$prev" != "$cv" ] || prev=""
  if [ "$switched" = 1 ]; then
    if [ -n "$prev" ]; then printf '%s\n' "$prev" > "$dest/.previous"; else rm -f "$dest/.previous"; fi
  fi
  # what stays: current's version and the previous one; every other version and leftover goes
  for keep in "$dest"/*; do
    [ -d "$keep" ] && [ ! -L "$keep" ] || continue
    v=${keep##*/}
    case "$v" in "$cv"|"$prev") continue ;; esac
    rm -rf "$keep"
  done
  [ -n "$prev" ] && [ -d "$dest/$prev" ] || rm -f "$dest/.previous"
  for keep in "$dest"/.untested-*; do
    [ -e "$keep" ] || continue
    [ "${keep##*/.untested-}" = "$PK_V" ] || rm -rf "$keep"
  done
  echo "$dest/current/$PK_BROWSER"
}
# pk_browser_install DEST PLATFORM: prepare, then switch (the switch also when the download failed: an older version
# that runs stays current)
pk_browser_install() {
  pk_browser_prepare "$1" "$2" || true
  pk_browser_switch "$1" "$2"
}

# ---- Python programs ----
# DEST (/opt/trina/python/<name>) holds venvs named <version>-<sha12> (sha12: the start of the sha256 of the
# requirements below, so a changed wheel is a new folder) and current -> one of them. A venv names its own path inside
# (bin/ scripts), so it is built where it stays: a folder without its .sha256 is unfinished and is built again. current
# changes only to a venv whose program starts (--help); the one before stays until the next switch, as a running server
# may still use it. pip gets only the list's wheels: exact versions, --require-hashes, --only-binary :all:, --no-deps,
# PyPI only, no configuration, cache or environment of the machine. Same lock as the browser's (pk__browser_dest).

# pk_pythons PROFILE|GROUP...: the Python programs of the groups
pk_pythons() {
  local g; g=$(pk_groups "$@") || return 1
  pk__lines | awk -F'\t' -v gs="$(pk__words "$g")" '$1 == "GY" && index(gs, " " $2 " ") && !seen[$3]++ { print $3 }'
}
# pk_py NAME FIELD: version | python (the floor, 3.N) | program
pk_py() {
  local col v
  case "$2" in version) col=3 ;; python) col=4 ;; program) col=5 ;; *) pk_err "pk_py: field $2"; return 1 ;; esac
  v=$(pk__lines | awk -F'\t' -v n="$1" -v c="$col" '$1 == "Y" && $2 == n { print $c; exit }')
  [ -n "$v" ] && [ "$v" != - ] || return 1
  echo "$v"
}
# pk_python_requirements NAME: pip's requirements file, one line per wheel with every sha256 the list allows
pk_python_requirements() {
  pk__lines | awk -F'\t' -v n="$1" '$1 == "W" && $2 == n {
    if ($3 !~ /^[a-z0-9][a-z0-9-]*==[0-9][0-9A-Za-z.!+]*$/) { print "packages: not a pinned requirement: " $3 > "/dev/stderr"; bad = 1; exit 1 }
    k = split($4, h, " "); line = $3
    for (i = 1; i <= k; i++) { if (h[i] !~ /^[0-9a-f]{64}$/) { print "packages: " $3 ": not a sha256" > "/dev/stderr"; bad = 1; exit 1 } line = line " --hash=sha256:" h[i] }
    print line; found = 1 }
    END { exit bad || !found }'
}
# pk_python_check DIR PROGRAM: the venv's program starts (all its imports load) and says how to use it
pk_python_check() {
  local w rc=0
  [ -x "$1/bin/$2" ] && [ -x "$1/bin/python" ] || return 1
  w=$(mktemp -d) || return 1
  (cd "$w" && pk__bounded 120 env -i PATH=/usr/bin:/bin HOME="$w" LANG=C.UTF-8 "$1/bin/$2" --help >/dev/null 2>&1) || rc=$?
  rm -rf "$w"
  return $rc
}
# the pin of NAME: PY_V PY_MIN PY_PROG PY_SHA PY_KEY, and the requirements in the file PY_REQ (the caller removes it)
pk__python_pin() {
  PY_V=$(pk_py "$1" version) && PY_MIN=$(pk_py "$1" python) && PY_PROG=$(pk_py "$1" program) \
    || { pk_err "the list has no python program $1"; return 1; }
  [[ "$PY_V" =~ ^[0-9][0-9A-Za-z.!+]*$ ]] && [[ "$PY_MIN" =~ ^3\.[0-9]+$ ]] && [[ "$PY_PROG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { pk_err "python $1: bad version, python or program in the list"; return 1; }
  PY_REQ=$(mktemp) || return 1
  pk_python_requirements "$1" > "$PY_REQ" || { rm -f "$PY_REQ"; pk_err "python $1: no requirements in the list"; return 1; }
  PY_SHA=$(pk_sha256 "$PY_REQ") PY_KEY="$PY_V-$(pk_sha256 "$PY_REQ" | cut -c1-12)"
}
# pk_python_install DEST NAME: the pinned venv in DEST/<version>-<sha12>, current -> it when its program starts. Prints
# the program's path through current, or nothing and 1 (then a current that starts stays).
pk_python_install() { pk__python_locked pk__python_install_locked "$@"; }
# pk_python_prepare DEST NAME: only the venv (built and its program started); current is not touched, so a server may run
# meanwhile (install-linux.sh builds it before it stops the server; pk_python_install then finds it and only switches)
pk_python_prepare() { pk__python_locked pk__python_build_locked "$@"; }
pk__python_locked() {  # FN DEST NAME
  local fn=$1 dest=$2 name=$3 rc=0
  pk__python_pin "$name" || return 1
  if pk__browser_dest "$dest"; then
    "$fn" "$dest" "$name" || rc=$?
    pk__unlock
  else rc=1; fi
  rm -f "$PY_REQ"
  return $rc
}
pk__python_build_locked() {
  local dest=$1 name=$2 dir py k env=()
  dir="$dest/$PY_KEY"
  # built by pk_python_prepare in this run (the same pin): no second start of the program
  if [[ "${PK_PY_PREPARED:-}" == *" $dir:$PY_SHA "* ]] && [ "$(cat "$dir/.sha256" 2>/dev/null || true)" = "$PY_SHA" ]; then return 0; fi
  if [ "$(cat "$dir/.sha256" 2>/dev/null || true)" != "$PY_SHA" ] || ! pk_python_check "$dir" "$PY_PROG"; then
    py=$(command -v python3 2>/dev/null) || { pk_err "python $name: python3 is missing (apt-get install python3 python3-venv)"; return 1; }
    "$py" -c "import sys; sys.exit(sys.version_info < ($(echo "$PY_MIN" | tr . ,),))" \
      || { pk_err "python $name needs Python $PY_MIN or later; this system has $("$py" -c 'import sys; print(sys.version.split()[0])')"; return 1; }
    # (a venv cannot be moved: it is built in its folder, finished when .sha256 is written)
    [ ! -L "$dir" ] || { pk_err "$dir is a link"; return 1; }
    rm -rf "$dir"
    "$py" -m venv "$dir" >/dev/null 2>&1 || { rm -rf "$dir"; pk_err "python $name: python3 -m venv failed (apt-get install python3-venv)"; return 1; }
    for k in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do [ -z "${!k:-}" ] || env+=("$k=${!k}"); done
    if ! pk__bounded "${PK_FETCH_BUDGET:-480}" env -i PATH=/usr/bin:/bin HOME="$dir" LANG=C.UTF-8 ${env[@]+"${env[@]}"} \
      "$dir/bin/python" -I -m pip install --isolated --no-cache-dir --disable-pip-version-check --no-input --quiet \
      --index-url=https://pypi.org/simple --require-hashes --only-binary=:all: --no-deps -r "$PY_REQ" >&2; then
      rm -rf "$dir"; pk_err "python $name $PY_V: pip install failed (the list's wheels from pypi.org)"; return 1
    fi
    [ "$(id -u)" != 0 ] || chown -R 0:0 "$dir"
    chmod -R a+rX,go-w "$dir"
    if ! pk_python_check "$dir" "$PY_PROG"; then rm -rf "$dir"; pk_err "python $name $PY_V: $PY_PROG does not start here"; return 1; fi
    printf '%s\n' "$PY_SHA" > "$dir/.sha256"
  fi
  PK_PY_PREPARED="${PK_PY_PREPARED:- } $dir:$PY_SHA "
}
pk__python_install_locked() {
  local dest=$1 name=$2 dir cv prev keep v
  dir="$dest/$PY_KEY"
  pk__python_build_locked "$dest" "$name" || return 1
  # current -> it; the venv before stays (a running server may still use it), every other one goes
  cv=$(readlink "$dest/current" 2>/dev/null || true)
  prev=""
  [ ! -f "$dest/.previous" ] || prev=$(tr -cd 'A-Za-z0-9._!+-' < "$dest/.previous")
  if [ "$cv" != "$PY_KEY" ]; then
    pk__swap_link "$PY_KEY" "$dest/current" || return 1
    prev=$cv
    if [ -n "$prev" ]; then printf '%s\n' "$prev" > "$dest/.previous"; else rm -f "$dest/.previous"; fi
  fi
  for keep in "$dest"/*; do
    [ -d "$keep" ] && [ ! -L "$keep" ] || continue
    v=${keep##*/}
    case "$v" in "$PY_KEY"|"$prev") continue ;; esac
    rm -rf "$keep"
  done
  [ -n "$prev" ] && [ -d "$dest/$prev" ] || rm -f "$dest/.previous"
  echo "$dest/current/bin/$PY_PROG"
}

# ---- files of the install ----

# pk_set_env FILE KEY [VALUE]: FILE (/etc/default/<id>, the server unit's EnvironmentFile) gets KEY=VALUE once; every
# other line stays (mycel-enroll's, safe-ops', the administrator's). No VALUE: the line goes (and an empty file).
# Written next to FILE and renamed into place.
pk_set_env() {
  local f=$1 k=$2 v=${3:-} t d
  [ ! -L "$f" ] || { pk_err "$f is a link"; return 1; }
  [ -f "$f" ] || [ -n "$v" ] || return 0
  d=$(dirname "$f"); mkdir -p "$d" || return 1
  t=$(mktemp "$d/.${f##*/}.XXXXXX") || return 1
  { [ ! -f "$f" ] || grep -v "^[[:space:]]*${k}[[:space:]]*=" "$f" || true; } > "$t"
  [ -z "$v" ] || printf '%s=%s\n' "$k" "$v" >> "$t"
  if [ -f "$f" ] && cmp -s "$t" "$f"; then rm -f "$t"; return 0; fi
  if ! grep -q '[^[:space:]]' "$t"; then rm -f "$t" "$f"; return 0; fi
  chmod 644 "$t" && mv -f "$t" "$f" || { rm -f "$t"; return 1; }
}
# pk_write_synced FILE LIST-SHA256 RESULT DETAIL BROWSER: <base>/root/packages.synced, one JSON line (mycel-ctl status,
# Admin › System › Diagnostics). RESULT: ok | incomplete (mycel-ctl tries again after some hours) | blocked (an
# administrator's step; tried again when the list changes)
pk_write_synced() {
  local f=$1 sum=$2 res=$3 detail browser t
  detail=$(printf '%s' "$4" | tr '\t\r\n' '   ' | tr -d '"\\\000-\037\177' | cut -c1-600)
  browser=$(printf '%s' "${5:-}" | tr -cd 'A-Za-z0-9._-')
  t=$(mktemp "$(dirname "$f")/.packages.synced.XXXXXX") || return 1
  printf '{"format":1,"list":"%s","result":"%s","at":"%s","browser":"%s","detail":"%s","os":"%s"}\n' "$sum" "$res" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$browser" "$detail" "$(pk_os_identity)" > "$t"
  chmod 644 "$t" && mv -f "$t" "$f" || { rm -f "$t"; return 1; }
}

# ---- sync (mycel-ctl update) ----

# pk__apt_allowed INSTALL-JSON: may an unattended sync run apt? When the install said skipApt false, or when it is a
# hosted install ("hosted": true) that did not say skipApt true: the hosting service owns that machine and its image
# came with the list's packages, so nobody manages its packages by hand. A self-hosted install from before the list wrote
# no skipApt (unknown: the administrator may manage packages by hand), and --skip-apt says true.
pk__apt_allowed() {
  grep -Eq '"skipApt"[[:space:]]*:[[:space:]]*false' "$1" 2>/dev/null && return 0
  grep -Eq '"hosted"[[:space:]]*:[[:space:]]*true' "$1" 2>/dev/null && ! grep -Eq '"skipApt"[[:space:]]*:[[:space:]]*true' "$1" 2>/dev/null
}

# pk_worse A B: the worse of two results (ok < incomplete < blocked)
pk_worse() { case "$1:$2" in blocked:*|*:blocked) echo blocked ;; incomplete:*|*:incomplete) echo incomplete ;; *) echo ok ;; esac; }

pk__sync() {
  local id='' base='' distro arch profile=default why path res=ok detail='' sum ij v rc p
  local pkgs=() browser_pkgs=() missing=() first=() rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) id=${2:-}; shift 2 || shift ;;
      --base) base=${2:-}; shift 2 || shift ;;
      --bun) PK_BUN=${2:-}; shift 2 || shift ;;
      *) pk_err "sync: unknown option $1"; return 2 ;;
    esac
  done
  [[ "$id" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ -n "$base" ] || { pk_err "sync: needs --id and --base"; return 2; }
  [ "$(id -u)" = 0 ] || { pk_err "sync: run as root"; return 2; }
  # apt as a transient unit of its own (pk__apt): this script runs inside mycel-ctl's update unit
  PK_APT_UNIT=1
  ij=$base/root/install.json
  pk_load "$PK_HERE/packages.json" || return 0
  sum=$(pk_sha256 "$PK_LIST")
  # a line for mycel-ctl (its notes) and for packages.synced
  note() { echo "packages: $*"; detail="${detail:+$detail; }$*"; }
  if grep -Eq '"minimal"[[:space:]]*:[[:space:]]*true' "$ij" 2>/dev/null; then profile=minimal; fi
  distro=$(pk_distro) || { note "this system is not in the list; nothing installed"; pk_write_synced "$base/root/packages.synced" "$sum" blocked "$detail" "" || true; return 0; }
  arch=$(pk_arch) || return 0
  while IFS= read -r p; do [ -z "$p" ] || pkgs+=("$p"); done <<EOF
$(pk_packages "$distro" "$arch" "$profile")
EOF
  if pk_groups "$profile" | grep -qx browser; then
    while IFS= read -r p; do [ -z "$p" ] || browser_pkgs+=("$p"); done <<EOF
$(pk_packages "$distro" "$arch" browser)
EOF
  fi
  while IFS= read -r p; do [ -z "$p" ] || missing+=("$p"); done <<EOF
$(pk_missing ${pkgs[@]+"${pkgs[@]}"})
EOF
  if [ ${#missing[@]} -gt 0 ]; then
    if ! pk__apt_allowed "$ij"; then
      note "missing: ${missing[*]} (not installed unattended: this install was made with --skip-apt or before the list; sudo install-linux.sh repair installs them)"
      res=blocked
    else
      # the browser's libraries first, in a transaction of their own: one package of another group that cannot be
      # installed must not keep the browser from working
      for p in "${missing[@]}"; do
        case " ${browser_pkgs[*]:-} " in *" $p "*) first+=("$p") ;; *) rest+=("$p") ;; esac
      done
      for v in first rest; do
        if [ "$v" = first ]; then set -- ${first[@]+"${first[@]}"}; else set -- ${rest[@]+"${rest[@]}"}; fi
        [ $# -gt 0 ] || continue
        if why=$(pk_apt_install -- "$@" 2>&1); then note "installed $*"
        else
          rc=$?
          note "could not install $*: $(printf '%s' "$why" | tail -n 1)"
          # a full disk needs an administrator; anything else is tried again later
          if [ "$rc" = 3 ]; then res=$(pk_worse "$res" blocked); else res=$(pk_worse "$res" incomplete); fi
        fi
      done
    fi
  fi
  if ! why=$(pk_check_floors "$distro" "$arch" "$profile" | tr '\n' ';'); then
    note "${why%;}"
    res=$(pk_worse "$res" incomplete)
  fi
  v=""
  if pk_artifacts "$profile" | grep -qx "$PK_BROWSER"; then
    pk_browser_prepare "$PK_OPT/$PK_BROWSER" "linux-$arch" || res=$(pk_worse "$res" incomplete)
    if path=$(pk_browser_switch "$PK_OPT/$PK_BROWSER" "linux-$arch"); then
      pk_set_env "/etc/default/$id" "$PK_ENV_KEY" "$path" || true
      v=$(pk__current_version "$PK_OPT/$PK_BROWSER")
      note "$PK_BROWSER $v ($path)"
    else
      pk_set_env "/etc/default/$id" "$PK_ENV_KEY" "" || true
      note "no $PK_BROWSER runs here; HTML to PDF stays off"
      res=$(pk_worse "$res" incomplete)
    fi
  else
    pk_set_env "/etc/default/$id" "$PK_ENV_KEY" "" || true
  fi
  # the Python programs (the server finds each at $PK_OPT/python/<name>/current/bin/<program>)
  for p in $(pk_pythons "$profile"); do
    if path=$(pk_python_install "$PK_OPT/python/$p" "$p"); then note "$p $(pk_py "$p" version) ($path)"
    else note "$p $(pk_py "$p" version || true) was not installed; what needs it stays off"; res=$(pk_worse "$res" incomplete); fi
  done
  pk_write_synced "$base/root/packages.synced" "$sum" "$res" "$detail" "$v" || pk_err "cannot write $base/root/packages.synced"
  return 0
}

pk__main() {
  local cmd=${1:-} d='' a=''
  [ $# -gt 0 ] && shift
  case "$cmd" in
    sync) pk__sync "$@"; return ;;
    flat|groups|packages) ;;
    *) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; [ -z "$cmd" ] || [ "$cmd" = -h ] || [ "$cmd" = --help ]; return ;;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) PK_LIST=$2; shift 2 ;;
      --bun) PK_BUN=$2; shift 2 ;;
      --distro) d=$2; shift 2 ;;
      --arch) a=$2; shift 2 ;;
      *) break ;;
    esac
  done
  pk_load || return 1
  case "$cmd" in
    flat) pk__lines ;;
    groups) pk_groups "$@" ;;
    packages)
      [ -n "$d" ] || d=$(pk_distro) || { pk_err "this system is not in the list: give --distro"; return 1; }
      [ -n "$a" ] || a=$(pk_arch) || return 1
      pk_packages "$d" "$a" "$@" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  umask 022
  pk__main "$@"
fi
