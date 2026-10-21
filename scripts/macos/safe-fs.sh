# Installer helpers (bash, sourced by scripts/install-macos.sh). Root works in folders the role accounts own
# (design tab 6: root only copies, replaces and chowns there): these helpers make sure a link or file planted by such
# an account never turns a root write or chown into one somewhere else. The installer stops every process of the role
# accounts first, so nothing changes between a check and the step after it.
#
# Needs: SAFE_ROOTS (array of the folders the installer may touch), ITMP (root-only staging folder, same volume) and
# a die() function. Tested in tests/unit/g-scripts.test.ts.

# nolink PATH: PATH is inside one of SAFE_ROOTS and no component of it (from /) is a symbolic link
nolink() {
  local cur="" part r ok=0
  for r in "${SAFE_ROOTS[@]}"; do case "$1" in "$r"|"$r"/*) ok=1 ;; esac; done
  [ "$ok" = 1 ] || die "internal: $1 is outside the install folders"
  local -a parts
  IFS=/ read -ra parts <<< "${1#/}"
  for part in "${parts[@]}"; do
    [ "$part" = .. ] && die "$1: '..' in a path"
    cur="$cur/$part"
    if [ -L "$cur" ]; then die "$cur is a symbolic link; refusing to continue (was the install changed by another account?)"; fi
  done
  return 0
}

# mk OWNER GROUP MODE PATH: folder with fixed owner and mode
mk() { nolink "$4"; mkdir -p "$4"; nolink "$4"; chown -h "$1:$2" "$4"; chmod -h "$3" "$4"; }

# put SRC OWNER GROUP MODE DEST: copy SRC into the root-only staging folder, set owner and mode there, then rename it
# over DEST (rename replaces a planted link or hard link instead of writing through it)
put() {
  local t
  nolink "$(dirname "$5")"
  if [ -d "$5" ] && [ ! -L "$5" ]; then die "$5 is a folder"; fi
  t=$(mktemp "$ITMP/put.XXXXXX")
  cat "$1" > "$t"
  chown "$2:$3" "$t"; chmod "$4" "$t"
  mv -f -h "$t" "$5"
}
