# The document kit of an office Mac (docs/OFFICE.md "문서 도구", scripts/system/packages.json group doc-kit-mac).
# Sourced by office-install.sh after scripts/system/packages.sh is loaded (pk_load). No sudo: everything is the
# signed-in user's, in <prefix>/kit, and nobody else can write it (server/src/devenv/kit.ts checks that too).
#
#   <prefix>/kit/<key>/   one complete kit, made and tested in <prefix>/kit/.new.* first, then given its name
#       LibreOffice.app   the DMG's app: sha256 of the DMG, Developer ID signature of The Document Foundation and its
#                         notarisation checked before it is copied
#       python/           the pinned CPython (relocatable) with the document libraries installed into it (pip
#                         --require-hashes --only-binary :all: --no-deps, pypi.org only)
#       node/             the pinned node; srt/ and node-libs/ are npm ci --ignore-scripts of the bundle's locks
#       fonts/            the Noto CJK fonts and their licence (LibreOffice on a Mac draws no Korean without them;
#                         each render links them into its profile: server/src/files/office-profile.ts)
#       .key              the key: the sha256 of every pin above (a changed pin is a new kit)
#   <prefix>/kit/current -> <key>   switched in one rename after the server stopped (dk_switch); the kit before stays
#                         until the next switch, every other one goes
#
# A part whose pin did not change is cloned from the current kit (cp -c: APFS clones share their blocks, so it costs no
# disk and no download). A failure only warns: the server runs with the kit it has (or with none: the AI then builds
# documents with make_file), and the next run of the installer (every automatic update) tries again.

DK_TEAM_ID=7P5S3ZLCN7   # Developer ID Application: The Document Foundation
DK_FORMAT=1             # the kit's layout; a change makes a new kit

dk_say() { echo "office-install: documents: $*"; }
dk_err() { echo "office-install: documents: $*" >&2; }

# the pins this kit is made of, one per line (the key is their sha256); DK_SRC is the unpacked app/ folder
dk__pins() {
  local plat=$1 a f
  pk_art libreoffice "$plat" version >/dev/null && pk_art cpython "$plat" version >/dev/null && pk_art node "$plat" version >/dev/null || return 1
  echo "format $DK_FORMAT $plat"
  for a in libreoffice node cpython; do
    for f in version url sha256; do printf '%s %s %s\n' "$a" "$f" "$(pk_art "$a" "$plat" "$f")" || return 1; done
  done
  for a in noto-sans-cjk noto-serif-cjk noto-cjk-license; do printf '%s %s\n' "$a" "$(pk_art "$a" any sha256)" || return 1; done
  pk_python_requirements doc-kit-mac || return 1
  for f in package-lock.json node-libs.package-lock.json; do printf '%s %s\n' "$f" "$(pk_sha256 "$DK_SRC/scripts/dev-env/srt/$f")"; done
}
# one part's pin (the lines of dk__pins that are about it): a part is cloned from the current kit when its pin is the same
dk__part_pin() { grep -E "^($2)( |$)" "$1" || true; }

# dk__ok DIR: the kit in DIR works (LibreOffice starts, Python imports every library, node loads them, srt starts)
dk__ok() {
  local d=$1 w rc=0
  [ -x "$d/LibreOffice.app/Contents/MacOS/soffice" ] && [ -x "$d/python/bin/python3" ] && [ -x "$d/node/bin/node" ] \
    && [ -f "$d/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" ] && [ -d "$d/node-libs/node_modules/pptxgenjs" ] \
    && [ -f "$d/fonts/NotoSansCJK-VF.otf.ttc" ] || return 1
  w=$(mktemp -d) || return 1
  (cd "$w" && pk__bounded 120 env -i PATH=/usr/bin:/bin HOME="$w" LANG=en_US.UTF-8 "$d/LibreOffice.app/Contents/MacOS/soffice" --version 2>/dev/null | grep -q '^LibreOffice [0-9]') \
    && (cd "$w" && pk__bounded 120 env -i PATH=/usr/bin:/bin HOME="$w" MPLCONFIGDIR="$w" "$d/python/bin/python3" -I -c 'import docx, pptx, openpyxl, lxml, PIL, xlsxwriter, numpy, pandas, matplotlib, reportlab, pypdf, pdfplumber, pypdfium2, pdf2image, defusedxml' >/dev/null 2>&1) \
    && (cd "$w" && pk__bounded 60 env -i PATH=/usr/bin:/bin HOME="$w" NODE_PATH="$d/node-libs/node_modules" "$d/node/bin/node" -e 'require("pptxgenjs"); require("docx")' >/dev/null 2>&1) \
    && (cd "$w" && pk__bounded 60 env -i PATH=/usr/bin:/bin HOME="$w" "$d/node/bin/node" "$d/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" --version >/dev/null 2>&1) || rc=1
  rm -rf "$w"
  return $rc
}

# LibreOffice from its DMG into DIR/LibreOffice.app: the list's sha256 and size, then (the image mounted read-only, in
# a folder of ours, never shown in the Finder) the app's Developer ID signature of The Document Foundation and Apple's
# notarisation, then a copy
dk__libreoffice() {
  local dir=$1 plat=$2 mnt rc=0 team
  pk_fetch "$(pk_art libreoffice "$plat" url)" "$(pk_art libreoffice "$plat" sha256)" "$(pk_art libreoffice "$plat" size || true)" "$dir/lo.dmg" || return 1
  mnt=$(mktemp -d "$dir/.mnt.XXXXXX") || return 1
  if ! hdiutil attach -nobrowse -readonly -noautoopen -noverify -mountpoint "$mnt" "$dir/lo.dmg" </dev/null >/dev/null 2>&1; then
    rmdir "$mnt"; rm -f "$dir/lo.dmg"; dk_err "the LibreOffice disk image does not open"; return 1
  fi
  if [ ! -d "$mnt/LibreOffice.app" ]; then dk_err "no LibreOffice.app in the disk image"; rc=1
  elif ! codesign --verify --deep --strict "$mnt/LibreOffice.app" 2>/dev/null; then dk_err "LibreOffice.app: its signature does not check"; rc=1
  else
    team=$(codesign -dv "$mnt/LibreOffice.app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
    if [ "$team" != "$DK_TEAM_ID" ]; then dk_err "LibreOffice.app is signed by team '$team', not The Document Foundation ($DK_TEAM_ID)"; rc=1
    elif ! spctl -a -t exec "$mnt/LibreOffice.app" 2>/dev/null; then dk_err "LibreOffice.app is not notarised by Apple (spctl)"; rc=1
    elif ! ditto "$mnt/LibreOffice.app" "$dir/LibreOffice.app"; then dk_err "LibreOffice.app could not be copied"; rc=1
    fi
  fi
  hdiutil detach "$mnt" -quiet 2>/dev/null || hdiutil detach "$mnt" -force -quiet 2>/dev/null || true
  rmdir "$mnt" 2>/dev/null || true
  rm -f "$dir/lo.dmg"
  return $rc
}

# CPython (relocatable, so the libraries go into it and no venv is needed) with the list's wheels
dk__python() {
  local dir=$1 plat=$2 req k env=()
  pk_fetch "$(pk_art cpython "$plat" url)" "$(pk_art cpython "$plat" sha256)" "$(pk_art cpython "$plat" size || true)" "$dir/py.tar.gz" || return 1
  tar -xzf "$dir/py.tar.gz" -C "$dir" && rm -f "$dir/py.tar.gz" && [ -x "$dir/python/bin/python3" ] || { dk_err "CPython did not unpack"; return 1; }
  req=$(mktemp) || return 1
  pk_python_requirements doc-kit-mac > "$req" || { rm -f "$req"; return 1; }
  for k in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do [ -z "${!k:-}" ] || env+=("$k=${!k}"); done
  if ! pk__bounded "${PK_FETCH_BUDGET:-480}" env -i PATH=/usr/bin:/bin HOME="$dir" LANG=en_US.UTF-8 ${env[@]+"${env[@]}"} \
    "$dir/python/bin/python3" -I -m pip install --isolated --no-cache-dir --disable-pip-version-check --no-input --quiet \
    --index-url=https://pypi.org/simple --require-hashes --only-binary=:all: --no-deps -r "$req" >&2; then
    rm -f "$req"; dk_err "the document libraries did not install (the list's wheels from pypi.org)"; return 1
  fi
  rm -f "$req"
}

# node, srt and the Node libraries (npm ci of the bundle's locks: every package is checked by its integrity)
dk__node() {
  local dir=$1 plat=$2 top lock
  top=$(pk_art node "$plat" dir) || return 1
  pk_fetch "$(pk_art node "$plat" url)" "$(pk_art node "$plat" sha256)" "$(pk_art node "$plat" size || true)" "$dir/node.tar.xz" || return 1
  tar -xJf "$dir/node.tar.xz" -C "$dir" && rm -f "$dir/node.tar.xz" && [ -d "$dir/$top" ] && mv "$dir/$top" "$dir/node" || { dk_err "node did not unpack"; return 1; }
  grep -qF "\"resolved\": \"$(pk_art srt any url)\"" "$DK_SRC/scripts/dev-env/srt/package-lock.json" || { dk_err "the bundle's srt lock does not pin the list's srt"; return 1; }
  for lock in srt node-libs; do
    mkdir -p "$dir/$lock"
    if [ "$lock" = srt ]; then cp "$DK_SRC/scripts/dev-env/srt/package.json" "$DK_SRC/scripts/dev-env/srt/package-lock.json" "$dir/srt/"
    else cp "$DK_SRC/scripts/dev-env/srt/node-libs.package.json" "$dir/node-libs/package.json"; cp "$DK_SRC/scripts/dev-env/srt/node-libs.package-lock.json" "$dir/node-libs/package-lock.json"; fi
    (cd "$dir/$lock" && pk__bounded "${PK_FETCH_BUDGET:-480}" env -i PATH="$dir/node/bin:/usr/bin:/bin" HOME="$dir/$lock" npm_config_cache="$dir/.npm" \
      "$dir/node/bin/npm" ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error >&2) || { dk_err "npm ci of $lock failed"; return 1; }
  done
  # npm and node's C headers are for the install only, never for a run (about 80 MB)
  rm -rf "$dir/.npm" "$dir/node/include" "$dir/node/lib/node_modules/npm" "$dir/node/lib/node_modules/corepack" "$dir/node/bin/npm" "$dir/node/bin/npx" "$dir/node/bin/corepack"
}

dk__fonts() {
  local dir=$1 a
  mkdir -p "$dir/fonts"
  for a in noto-sans-cjk:NotoSansCJK-VF.otf.ttc noto-serif-cjk:NotoSerifCJK-VF.otf.ttc noto-cjk-license:LICENSE-NotoCJK.txt; do
    pk_fetch "$(pk_art "${a%%:*}" any url)" "$(pk_art "${a%%:*}" any sha256)" "$(pk_art "${a%%:*}" any size || true)" "$dir/fonts/${a#*:}" || return 1
  done
}

# dk_prepare PREFIX PLATFORM: the pinned kit complete, tested and named <prefix>/kit/<key>; current is not touched (the
# server may run meanwhile). 0 = ready (made now or before).
dk_prepare() {
  local prefix=$1 plat=$2 dest="$1/kit" pins key tmp cur part pat t0
  DK_SRC=${DK_SRC:-$SRC/app}
  [ -f "$DK_SRC/scripts/dev-env/srt/package-lock.json" ] || { dk_err "this bundle has no document kit locks"; return 1; }
  pins=$(mktemp) || return 1
  dk__pins "$plat" > "$pins" || { rm -f "$pins"; dk_err "the list has no document kit for $plat"; return 1; }
  key=$(pk_sha256 "$pins" | cut -c1-16)
  [ ! -L "$dest" ] || { rm -f "$pins"; dk_err "$dest is a link"; return 1; }
  mkdir -p "$dest" && chmod 755 "$dest" || { rm -f "$pins"; return 1; }
  rm -rf "$dest"/.new.* 2>/dev/null || true
  if [ "$(cat "$dest/$key/.key" 2>/dev/null || true)" = "$key" ] && dk__ok "$dest/$key"; then rm -f "$pins"; DK_KEY=$key; return 0; fi
  t0=$(date +%s)
  tmp=$(mktemp -d "$dest/.new.XXXXXX") || { rm -f "$pins"; return 1; }
  cur=""; [ -f "$dest/current/.pins" ] && cur="$dest/current"
  if [ -n "$cur" ]; then dk_say "updating the document kit (LibreOffice $(pk_art libreoffice "$plat" version)): only what changed is downloaded"
  else dk_say "getting the document kit (LibreOffice $(pk_art libreoffice "$plat" version), Python and Node libraries, fonts; about 450 MB to download, 1.4 GB on disk, a few minutes)"; fi
  # each part: cloned from the current kit when its pin is the same, else fetched
  for part in "libreoffice:^libreoffice" "python:^cpython |==" "node:^node |^srt |package-lock.json|node-libs.package-lock.json" "fonts:^noto-"; do
    pat=${part#*:}
    if [ -n "$cur" ] && [ "$(dk__part_pin "$pins" "$pat")" = "$(dk__part_pin "$cur/.pins" "$pat")" ]; then
      case "${part%%:*}" in
        libreoffice) cp -cR "$cur/LibreOffice.app" "$tmp/" ;;
        python) cp -cR "$cur/python" "$tmp/" ;;
        node) cp -cR "$cur/node" "$cur/srt" "$cur/node-libs" "$tmp/" ;;
        fonts) cp -cR "$cur/fonts" "$tmp/" ;;
      esac || { rm -rf "$tmp" "$pins"; dk_err "could not copy ${part%%:*} from the current kit"; return 1; }
    else
      case "${part%%:*}" in
        libreoffice) dk__libreoffice "$tmp" "$plat" ;;
        python) dk__python "$tmp" "$plat" ;;
        node) dk__node "$tmp" "$plat" ;;
        fonts) dk__fonts "$tmp" ;;
      esac || { rm -rf "$tmp" "$pins"; return 1; }
    fi
  done
  cp "$pins" "$tmp/.pins"; rm -f "$pins"
  # nobody else writes it; no quarantine flag (curl sets none, an archive tool may copy one)
  chmod -R a+rX,go-w "$tmp"
  xattr -dr com.apple.quarantine "$tmp" 2>/dev/null || true
  if ! dk__ok "$tmp"; then rm -rf "$tmp"; dk_err "the new kit does not work on this Mac; the kit before stays"; return 1; fi
  printf '%s\n' "$key" > "$tmp/.key"
  rm -rf "${dest:?}/$key"
  mv "$tmp" "$dest/$key" || return 1
  DK_KEY=$key
  dk_say "kit ready in $(( $(date +%s) - t0 )) s ($(du -sh "$dest/$key" 2>/dev/null | cut -f1 | tr -d ' ') on disk)"
}

# dk_switch PREFIX: current -> the kit dk_prepare made (DK_KEY), when it works; else current stays. The kit before stays
# until the next switch (a render may still use it), every other one goes. Prints the kit's path through current.
dk_switch() {
  local dest="$1/kit" cv prev keep v
  [ -n "${DK_KEY:-}" ] && [ -d "$dest/$DK_KEY" ] || { [ -f "$dest/current/.key" ] && echo "$dest/current"; return 1; }
  cv=$(readlink "$dest/current" 2>/dev/null || true)
  prev=$(tr -cd '0-9a-f' < "$dest/.previous" 2>/dev/null || true)
  if [ "$cv" != "$DK_KEY" ]; then
    pk__swap_link "$DK_KEY" "$dest/current" || return 1
    prev=$cv
    if [ -n "$prev" ]; then printf '%s\n' "$prev" > "$dest/.previous"; else rm -f "$dest/.previous"; fi
  fi
  for keep in "$dest"/*; do
    [ -d "$keep" ] && [ ! -L "$keep" ] || continue
    v=${keep##*/}
    case "$v" in "$DK_KEY"|"$prev") continue ;; esac
    rm -rf "$keep"
  done
  echo "$dest/current"
}
