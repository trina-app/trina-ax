#!/bin/bash
# The one list of system packages and downloaded programs (scripts/system/packages.json; docs/DECISIONS.md "One list of
# system packages"). Every install path reads the list through these functions, and none keeps a list of its own
# (tests/unit/system-packages.test.ts):
#   - scripts/install-linux.sh sources the kit's copy (app/<v>/root/packages.sh, signed with the bundle);
#   - scripts/image/customize.sh, scripts/dev-env/srt/install-srt.sh and scripts/dev-env/install-trial.sh source the copy
#     next to them (system/ in a staged folder) or scripts/system/ of the repository;
#   - scripts/office/office-install.sh sources the zip's app/scripts/system/packages.sh;
#   - `mycel-ctl update` runs `<base>/root/packages.sh sync` after a release's root files are in place.
#
# The list is read once (pk_load) with a bun the caller trusts (PK_BUN: the kit's or the bundle's) or with jq. Both turn
# it into the same flat lines (pk_flat; the test compares them), and everything else reads those lines with awk.
# Bash 3.2 (macOS) compatible. Functions return non-zero and print why; the caller decides whether that stops it.
#
#   packages.sh flat     [--list FILE] [--bun BUN]                       the flat lines (tests, debugging)
#   packages.sh groups   [--list FILE] PROFILE|GROUP...                  minimal | default, or group names
#   packages.sh packages [--list FILE] --distro D --arch A PROFILE|GROUP...  the apt packages, one per line
#   packages.sh sync     --id ID --base BASE [--bun BUN]                 mycel-ctl update: the packages of the install's
#                        profile that are missing (apt), then the browser at the pinned version and MYCEL_HTML_PDF_BROWSER
#                        in /etc/default/<id>. Reads <base>/root/install.json (minimal, skipApt). Problems are printed;
#                        the exit code is 0 unless the arguments are wrong (the server works without them).

PK_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PK_LIST=${PK_LIST:-}
PK_BUN=${PK_BUN:-}
PK_FLAT=
# where the Linux browser lives: one per machine, root-owned, shared by every install id
PK_OPT=${PK_OPT:-/opt/trina}
PK_BROWSER=chrome-headless-shell
PK_ENV_KEY=MYCEL_HTML_PDF_BROWSER

pk_err() { echo "packages: $*" >&2; }

# ---- reading the list ----

# The flat lines. Fields are separated by a TAB; "-" is an empty field.
#   D <distro> <os id> <version> <suite>          A <arch>
#   G <group> <install>                           GA <group> <artifact>
#   P <group> <package> <floor> <on> <when>       R <group> <package to remove>
#   F <artifact> <platform> <version> <url> <sha256> <size> <dir>
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
}
for (const [n, a] of Object.entries(j.artifacts)) for (const [p, x] of Object.entries(a.platforms)) t("F", n, p, a.version, x.url, x.sha256, x.size, x.dir)
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
        (($v.artifacts // [])[] | ["GA", $g, .])),
    (.artifacts | to_entries[] | .key as $n | .value.version as $ver | .value.platforms | to_entries[]
      | ["F", $n, .key, $ver, .value.url, .value.sha256, .value.size, .value.dir]) )
| map(f) | join("\t")'

# Run PK_BUN as a plain JSON reader: an empty folder of its own as the working folder and no environment (bun reads
# bunfig.toml and .env from the working folder, and BUN_OPTIONS adds arguments).
pk__bun() {
  local w rc=0
  w=$(mktemp -d) || return 1
  (cd "$w" && exec env -i PATH=/usr/bin:/bin HOME="$w" PK_JSON="$PK_LIST" "$PK_BUN" -e "$PK_JS") || rc=$?
  rm -rf "$w"
  return $rc
}
pk_flat() {
  if [ -n "$PK_BUN" ]; then
    [ -x "$PK_BUN" ] || { pk_err "PK_BUN $PK_BUN is not a program"; return 1; }
    pk__bun
  elif command -v jq >/dev/null 2>&1; then
    jq -r "$PK_JQ" "$PK_LIST"
  else
    pk_err "reading $PK_LIST needs jq (apt-get install jq) or the kit's bun"
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
# conditions a package may name ("when"): true here?
pk__userns_restricted() {
  if [ -n "${PK_USERNS_RESTRICTED:-}" ]; then [ "$PK_USERNS_RESTRICTED" = 1 ]; return; fi
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]
}

# ---- groups, packages, artifacts ----
# (group and package names have no spaces: the test checks the list's names. Lists are passed word by word.)
# shellcheck disable=SC2086,SC2116

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
# pk_packages DISTRO ARCH PROFILE|GROUP...: the apt packages for that system, each once, in list order
pk_packages() {
  local d=$1 a=$2 g r=0; shift 2
  g=$(pk_groups "$@") || return 1
  pk__userns_restricted && r=1
  pk__lines | awk -F'\t' -v gs=" $(echo $g) " -v d="$d" -v a="$a" -v r="$r" '
    $1 == "P" && index(gs, " " $2 " ") {
      if ($5 != "-") { n = split($5, on, ","); ok = 0; for (i = 1; i <= n; i++) if (on[i] == d || on[i] == d "/" a) ok = 1; if (!ok) next }
      if ($6 == "userns-restricted" && r != 1) next
      if ($6 != "-" && $6 != "userns-restricted") next
      if (!seen[$3]++) print $3
    }'
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
  pk__lines | awk -F'\t' -v gs=" $(echo $g) " '$1 == "R" && index(gs, " " $2 " ") && !seen[$3]++ { print $3 }'
}
# pk_artifacts PROFILE|GROUP...: the downloaded programs of the groups
pk_artifacts() {
  local g; g=$(pk_groups "$@") || return 1
  pk__lines | awk -F'\t' -v gs=" $(echo $g) " '$1 == "GA" && index(gs, " " $2 " ") && !seen[$3]++ { print $3 }'
}
# pk_art NAME PLATFORM FIELD: version | url | sha256 | size | dir of an artifact (nothing and 1 when the list has none)
pk_art() {
  local col v
  case "$3" in version) col=4 ;; url) col=5 ;; sha256) col=6 ;; size) col=7 ;; dir) col=8 ;; *) pk_err "pk_art: field $3"; return 1 ;; esac
  v=$(pk__lines | awk -F'\t' -v n="$1" -v p="$2" -v c="$col" '$1 == "F" && $2 == n && $3 == p { print $c; exit }')
  [ -n "$v" ] || return 1
  [ "$v" = - ] || echo "$v"
}

# ---- installing ----

pk_installed() { [ "$(dpkg-query -W -f '${db:Status-Status}' "$1" 2>/dev/null || true)" = installed ]; }
# pk_missing PACKAGE...: those not installed, one per line
pk_missing() { local p; for p in "$@"; do pk_installed "$p" || echo "$p"; done; }
# pk_apt_install [APT-OPTION...] -- PACKAGE...: apt-get update (once per run) and install without recommends.
# PK_APT_SNAPSHOT=<YYYYMMDDTHHMMSSZ> installs from that snapshot of the archive (apt 2.7+: Debian 13, Ubuntu 24.04), for an
# image that must be rebuilt with the same package versions.
pk_apt_install() {
  local opts=() snap=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do opts+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || return 0
  if [ -n "${PK_APT_SNAPSHOT:-}" ]; then
    [[ "$PK_APT_SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { pk_err "PK_APT_SNAPSHOT $PK_APT_SNAPSHOT is not YYYYMMDDTHHMMSSZ"; return 1; }
    snap=(--snapshot "$PK_APT_SNAPSHOT")
  fi
  export DEBIAN_FRONTEND=noninteractive
  if [ -z "${PK_APT_UPDATED:-}" ]; then
    apt-get update -qq ${snap[@]+"${snap[@]}"} >/dev/null || { pk_err "apt-get update failed"; return 1; }
    PK_APT_UPDATED=1
  fi
  apt-get install -y -qq --no-install-recommends ${snap[@]+"${snap[@]}"} ${opts[@]+"${opts[@]}"} "$@" >/dev/null \
    || { pk_err "apt-get install failed: $*"; return 1; }
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

pk_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# pk_fetch URL SHA256 SIZE OUT: https only, the file must have the pinned sha256 (and size); nothing is left otherwise
pk_fetch() {
  local url=$1 sha=$2 size=$3 out=$4 got n
  case "$url" in https://*) ;; *) pk_err "$url: only https"; return 1 ;; esac
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { pk_err "$url: the list has no sha256"; return 1; }
  command -v curl >/dev/null 2>&1 || { pk_err "curl is missing (the core group installs it)"; return 1; }
  curl --proto =https --proto-redir =https --tlsv1.2 -fsSL --retry 3 -o "$out" "$url" || { rm -f "$out"; pk_err "downloading $url failed"; return 1; }
  got=$(pk_sha256 "$out")
  [ "$got" = "$sha" ] || { rm -f "$out"; pk_err "$url: sha256 $got, the list pins $sha"; return 1; }
  if [ -n "$size" ]; then
    n=$(wc -c < "$out" | tr -d ' ')
    [ "$n" = "$size" ] || { rm -f "$out"; pk_err "$url: $n bytes, the list says $size"; return 1; }
  fi
}

# pk_browser_install DEST PLATFORM: the pinned chrome-headless-shell as DEST/<version>/<dir>/, DEST/current -> it, every
# other version removed. Prints the program's path through current (what MYCEL_HTML_PDF_BROWSER names). As root the
# folder is root's; otherwise the caller's (an office Mac). Either way nobody else can write it (html-pdf.ts
# trustedBrowser). Already there with the pinned sha256: nothing is downloaded.
pk_browser_install() {
  local dest=$1 plat=$2 v url sha size dir tmp old
  v=$(pk_art "$PK_BROWSER" "$plat" version) || { pk_err "the list has no $PK_BROWSER for $plat"; return 1; }
  url=$(pk_art "$PK_BROWSER" "$plat" url) sha=$(pk_art "$PK_BROWSER" "$plat" sha256)
  size=$(pk_art "$PK_BROWSER" "$plat" size || true) dir=$(pk_art "$PK_BROWSER" "$plat" dir)
  [[ "$v" =~ ^[0-9][0-9.]*$ ]] && [[ "$dir" =~ ^[A-Za-z0-9._-]+$ ]] || { pk_err "$PK_BROWSER: bad version or dir in the list"; return 1; }
  [ ! -L "$dest" ] || { pk_err "$dest is a link"; return 1; }
  if [ ! -d "$dest" ]; then mkdir -p "$dest" && chmod 755 "$dest" || return 1; fi
  if [ ! -x "$dest/$v/$dir/$PK_BROWSER" ] || [ "$(cat "$dest/$v/.sha256" 2>/dev/null || true)" != "$sha" ]; then
    command -v unzip >/dev/null 2>&1 || { pk_err "unzip is missing (the browser group installs it)"; return 1; }
    tmp=$(mktemp -d "$dest/.new.XXXXXX") || return 1
    if ! pk_fetch "$url" "$sha" "$size" "$tmp/b.zip"; then rm -rf "$tmp"; return 1; fi
    if ! (cd "$tmp" && unzip -q b.zip) || [ ! -f "$tmp/$dir/$PK_BROWSER" ]; then rm -rf "$tmp"; pk_err "$url: no $dir/$PK_BROWSER in the archive"; return 1; fi
    rm -f "$tmp/b.zip"
    printf '%s\n' "$sha" > "$tmp/.sha256"
    [ "$(id -u)" != 0 ] || chown -R 0:0 "$tmp"
    chmod -R go-w "$tmp"; chmod 755 "$tmp"
    # a download needs no quarantine flag (curl sets none), but an archive tool may copy one
    [ "${PK_UNAME_S:-$(uname -s)}" != Darwin ] || xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true
    rm -rf "${dest:?}/${v:?}"
    mv "$tmp" "$dest/$v"
  fi
  ln -sfn "$v/$dir" "$dest/current"
  for old in "$dest"/* "$dest"/.new.*; do
    [ -e "$old" ] || [ -L "$old" ] || continue
    case "${old##*/}" in current|"$v") continue ;; esac
    rm -rf "$old"
  done
  echo "$dest/current/$PK_BROWSER"
}
# pk_browser_check PROGRAM: it starts and says its version (the libraries it loads are there)
pk_browser_check() { "$1" --version 2>/dev/null | head -n 1 | grep -q '[0-9]'; }

# pk_set_env FILE KEY [VALUE]: FILE (/etc/default/<id>, the server unit's EnvironmentFile) gets KEY=VALUE once; every
# other line stays (mycel-enroll's, safe-ops', the administrator's). No VALUE: the line goes (and an empty file).
pk_set_env() {
  local f=$1 k=$2 v=${3:-} t
  [ ! -L "$f" ] || { pk_err "$f is a link"; return 1; }
  [ -f "$f" ] || [ -n "$v" ] || return 0
  t=$(mktemp) || return 1
  { [ ! -f "$f" ] || grep -v "^[[:space:]]*${k}[[:space:]]*=" "$f" || true; } > "$t"
  [ -z "$v" ] || printf '%s=%s\n' "$k" "$v" >> "$t"
  if [ -f "$f" ] && cmp -s "$t" "$f"; then rm -f "$t"; return 0; fi
  if ! grep -q '[^[:space:]]' "$t"; then rm -f "$t" "$f"; return 0; fi
  mkdir -p "$(dirname "$f")"
  install -m 644 "$t" "$f" || { rm -f "$t"; return 1; }
  rm -f "$t"
}

# ---- sync (mycel-ctl update) ----

pk__sync() {
  local id='' base='' distro arch profile=default skip=0 pkgs missing v path problems
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) id=${2:-}; shift 2 ;;
      --base) base=${2:-}; shift 2 ;;
      --bun) PK_BUN=${2:-}; shift 2 ;;
      *) pk_err "sync: unknown option $1"; return 2 ;;
    esac
  done
  [[ "$id" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ -n "$base" ] || { pk_err "sync: needs --id and --base"; return 2; }
  [ "$(id -u)" = 0 ] || { pk_err "sync: run as root"; return 2; }
  pk_load "$PK_HERE/packages.json" || return 0
  if grep -Eq '"minimal"[[:space:]]*:[[:space:]]*true' "$base/root/install.json" 2>/dev/null; then profile=minimal; fi
  if grep -Eq '"skipApt"[[:space:]]*:[[:space:]]*true' "$base/root/install.json" 2>/dev/null; then skip=1; fi
  distro=$(pk_distro) || { echo "packages: this system is not in the list; nothing installed"; return 0; }
  arch=$(pk_arch) || return 0
  pkgs=$(pk_packages "$distro" "$arch" "$profile") || return 0
  # (package names have no spaces: the test checks the list's names)
  # shellcheck disable=SC2086
  missing=$(pk_missing $pkgs | tr '\n' ' ')
  # shellcheck disable=SC2086
  if [ -z "${missing// /}" ]; then :
  elif [ "$skip" = 1 ]; then echo "packages: missing (installed with --skip-apt, so not installed here): $missing"
  elif pk_apt_install -- $missing; then echo "packages: installed $missing"
  else echo "packages: could not install $missing; sudo install-linux.sh repair tries again"; fi
  problems=$(pk_check_floors "$distro" "$arch" "$profile" | tr '\n' ';') || echo "packages: $problems"
  if pk_artifacts "$profile" | grep -qx "$PK_BROWSER"; then
    v=$(pk_art "$PK_BROWSER" "linux-$arch" version || true)
    if path=$(pk_browser_install "$PK_OPT/$PK_BROWSER" "linux-$arch") && pk_browser_check "$path"; then
      pk_set_env "/etc/default/$id" "$PK_ENV_KEY" "$path" || true
      echo "packages: $PK_BROWSER $v ($path)"
    else
      echo "packages: $PK_BROWSER $v is not installed; HTML to PDF stays off until sudo install-linux.sh repair or the next update"
    fi
  else
    pk_set_env "/etc/default/$id" "$PK_ENV_KEY" "" || true
  fi
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
