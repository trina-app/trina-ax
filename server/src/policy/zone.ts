// The folders where the owner's and admins' access changes in the members-only zone (docs/DECISIONS.md "Project
// contents only for members"): every entry directly under the top-level projects/ folder (policy/access.ts
// isProjectsName: any letter case only where the disk ignores case). Code that assumes "access changes only at a rule folder, users/<x> or .system" (files/search.ts allowedRoots,
// devenv/srt/access.ts folderView, chat/read-scope.ts sourceOf) adds these, so a projects/<name> with no rules of its
// own (made by an older build) is still a boundary there.
import fs from 'node:fs'
import path from 'node:path'
import { isProjectsName } from './access'

/** projects/<name> for every entry under the top-level projects/ folder on disk, as segments (actual names). */
export function projectZoneFolders(root: string): string[][] {
  const out: string[][] = []
  let top: string[] = []
  try { top = fs.readdirSync(root).filter(isProjectsName) } catch { return out }
  for (const t of top) {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(root, t)) } catch { continue }
    for (const n of names) out.push([t, n])
  }
  return out
}

const segsOf = (rel: string) => rel.split('/').filter(Boolean)
/** At or below projects/<name> (the zone; `projects` by isProjectsName). */
export const inZone = (rel: string): boolean => { const s = segsOf(rel); return s.length >= 2 && isProjectsName(s[0]!) }
/** Strictly below projects/<name>: a folder or file inside a team project. */
export const insideProject = (rel: string): boolean => { const s = segsOf(rel); return s.length >= 3 && isProjectsName(s[0]!) }
/** A path inside a team project cut to its project folder ("projects/<name>/…"), for answers to someone who does not
 * read it: the project's name is known to the owner and admins, nothing inside it is. Anything else as it is. */
export const cutInsideProject = (rel: string): string => { const s = segsOf(rel); return s.length >= 3 && isProjectsName(s[0]!) ? `${s[0]}/${s[1]}/…` : rel }
