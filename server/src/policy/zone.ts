// The folders where the owner's and admins' access changes in the members-only zone (docs/DECISIONS.md "Project
// contents only for members"): every entry directly under the top-level projects/ folder (any letter case or Unicode
// form). Code that assumes "access changes only at a rule folder, users/<x> or .system" (files/search.ts allowedRoots,
// devenv/srt/access.ts folderView, chat/read-scope.ts sourceOf) adds these, so a projects/<name> with no rules of its
// own (made by an older build) is still a boundary there.
import fs from 'node:fs'
import path from 'node:path'

/** projects/<name> for every entry under the top-level projects/ folder on disk, as segments (actual names). */
export function projectZoneFolders(root: string): string[][] {
  const out: string[][] = []
  let top: string[] = []
  try { top = fs.readdirSync(root).filter((n) => n.normalize('NFC').toLowerCase() === 'projects') } catch { return out }
  for (const t of top) {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(root, t)) } catch { continue }
    for (const n of names) out.push([t, n])
  }
  return out
}

const segsOf = (rel: string) => rel.split('/').filter(Boolean)
const foldTop = (s: string) => s.normalize('NFC').toLowerCase()
/** At or below projects/<name> (the zone; `projects` folded). */
export const inZone = (rel: string): boolean => { const s = segsOf(rel); return s.length >= 2 && foldTop(s[0]!) === 'projects' }
/** Strictly below projects/<name>: a folder or file inside a team project. */
export const insideProject = (rel: string): boolean => { const s = segsOf(rel); return s.length >= 3 && foldTop(s[0]!) === 'projects' }
/** A path inside a team project cut to its project folder ("projects/<name>/…"), for answers to someone who does not
 * read it: the project's name is known to the owner and admins, nothing inside it is. Anything else as it is. */
export const cutInsideProject = (rel: string): string => { const s = segsOf(rel); return s.length >= 3 && foldTop(s[0]!) === 'projects' ? `${s[0]}/${s[1]}/…` : rel }
