// rename_files' pattern (tools/file-moves.ts), in a module of its own: a room's change card works out the same new
// names before the call (chat/turn.ts roomChangeWrites), so a planted rename onto an instruction file is seen there.

/** The pattern of `find`: plain text (every occurrence), or with `regex` a JavaScript regular expression. Throws on an
 * invalid one. */
export function renamePattern(find: string, regex: boolean): RegExp {
  return new RegExp(regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')
}

/** A regular expression from the AI that may take very long on a 255-character name (a repeated group that itself
 * repeats, "(a+)+", "(x*)*", "(?:a|aa)+"): refused, since names are matched on the server's own thread. */
export function riskyPattern(src: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(src) || /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/.test(src) || /\\[1-9]/.test(src)
}

/** The new name of `name` for rename_files' pattern (every match of `find` replaced), or null: no match, or the same
 * name. `find` is plain text unless `regex` (then $1 … in `replace` are its groups; with plain text "$" is a "$"). */
export function patternName(name: string, find: RegExp, replace: string, regex: boolean): string | null {
  find.lastIndex = 0
  if (!find.test(name)) return null
  find.lastIndex = 0
  const out = regex ? name.replace(find, replace) : name.replace(find, () => replace)
  return out === name ? null : out.normalize('NFC')
}

