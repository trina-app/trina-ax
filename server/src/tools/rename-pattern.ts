// rename_files' pattern (tools/file-moves.ts), in a module of its own: a room's change card works out the same new
// names before the call (chat/turn.ts roomChangeWrites and its details), and the tool checks each item again when it
// runs. Plain text only, never a regular expression from the AI: names are matched on the server's own thread, and an
// AI's regular expression can take seconds on one name (review of #1327). Every match is found with indexOf, in time
// that grows with the name's length only.
import { parseInput } from '../policy/resolve'
import { inSkills } from '../skills/guard'

/** Where in a name `find` counts: anywhere (every occurrence is replaced), only at its start, or only at its end. */
export type RenameAt = 'anywhere' | 'start' | 'end'

/** The new name of `name`: every `find` replaced (`at` anywhere), or the one at its start or end; null when there is
 * no match or the name stays the same. */
export function patternName(name: string, find: string, replace: string, at: RenameAt = 'anywhere'): string | null {
  if (!find) return null
  let out: string
  if (at === 'start') { if (!name.startsWith(find)) return null; out = replace + name.slice(find.length) }
  else if (at === 'end') { if (!name.endsWith(find)) return null; out = name.slice(0, name.length - find.length) + replace }
  else { if (!name.includes(find)) return null; out = name.split(find).join(replace) }
  out = out.normalize('NFC')
  return out === name ? null : out
}

/** A team path as the file layer reads it (policy/resolve.ts parseInput: no empty or "." names), NFC; null when it is
 * not one. */
export function teamSegs(p: unknown): string[] | null {
  try { return parseInput(p).map((x) => x.normalize('NFC')) } catch { return null }
}

/** Files that tell an AI what to do: team skills and rules (skills/), a person's skills, and instruction files by name,
 * matched on the path as the file layer resolves it (any spelling: "./", "//", "a/./b", a trailing "/", letter case).
 * What a call would write there is shown in full on a room's change card, or the call is not made from a room. */
export function instructionLike(rel: string): boolean {
  const segs = teamSegs(rel)
  if (!segs?.length) return false
  const p = segs.join('/')
  return inSkills(p) || /^users\/[^/]+\/skills(\/|$)/i.test(p) || /^(CLAUDE|AGENTS|GEMINI|SKILL)\.md$/i.test(segs.at(-1)!)
}
