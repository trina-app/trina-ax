// The folder access of a run (docs/research/srt-dev-env.md 3.3). A run is not locked to a project: it may read and
// write exactly the team folders that the person who owns the chat (and their AI) may open now, under the folder rules
// (policy/access.ts RuleSet). This file turns those rules into srt's four lists. It has no side effects; the runner
// builds the lists again for every command and every job start, and the tracker compares them while a run lasts.
//
// Access only changes at a folder that has rules, so the candidates are the team root, every rule folder and the
// person's own personal folder. Each candidate gets the access RuleSet.access gives it, and an entry is written only
// where the access differs from the nearest candidate above it:
//   read below none   -> read (allowRead)      write below anything else -> write (allowWrite)
//   read below write  -> denyWrite             none below read or write  -> denyRead
// srt applies its entries shallowest first (a tmpfs over a denied folder, then the allowed folders inside it bound back,
// then a deeper tmpfs), so the deepest entry decides, as the rules do. One case is stricter than the rules: write below
// a read-only folder below a write folder. srt's denyWrite wins over an allowWrite inside it, so that folder is
// read-only in a run (fail closed). The tests check both facts against RuleSet.access.
//
// Fixed parts, whatever the rules say:
//   - users/ is hidden as a whole (it would list everyone's personal folder names); the person's own users/<id> is
//     writable again. Other people's personal folders stay hidden, for owners and admins too.
//   - .system/ is hidden.
//
// A run (owner decision Q0 (b), docs/research/srt-dev-env.md 0.6): only the starting folder (the project folder) and
// the person's own folder are writable. Every other folder that the person may write is read-only in the run. So a
// command writes no file outside the change window of the project folder (other than the person's own folder), it
// cannot copy a file into a folder that more people can see (except the project folder), and it cannot plant code
// (.git/hooks, package.json scripts, a Makefile, .envrc) in a shared folder for another person's run (G-SRT-11).
// Skill folders (review S8, docs/DECISIONS.md "Skill folders: the AI's file actions"): a run never writes the person's
// own skills (users/<id>/skills) or the skills folder of the group's or project's folder it starts in, nor anything in a
// skill folder at all. What people's AI follows changes only behind a card; before, a command could write or delete a
// project's skills with none. A start folder that is a skill folder, in one, or groups/ or projects/ themselves writes
// no team folder (fail closed). An absent skills folder is made as an srt mount point while the run lives
// (placeholders.ts holdSkillFolders), so the deny holds for a folder the command would make.
// Read scope of a project run (QA TC-095, Dion's report of 2026-11-07, docs/DECISIONS.md "Write only in the starting
// folder"): a run that starts in a project folder could read every folder the person may read and copy a file from one
// of them into the project folder, which more people may see, with no card (copy_files asks first). With `people` (the
// team's active people), a folder outside the starting folder stays readable in such a run only when everyone who can
// see the starting folder can read it too, so nothing a run copies into the project folder reaches a new person. Every
// other folder is hidden in the run, the person's own users/<id> too when the project has other people (fail closed:
// a run then cannot read or write the own folder). A run in the chat's work folder (start null) writes only the own
// folder, so it keeps the person's whole read access. Without `people` the view is as before (the tests of the rules).
// folderView with no run gives the person's access (what the person may open); with a run, the access of that run.
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import { atLeast, type Access, type Principal, type RuleSet } from '../../policy/access'
// the path rule of skill roots, from shared/ (this folder runs on its own in tests/linux/Dockerfile.srt)
import { skillRootOf } from '@mycel/shared/skill-roots'

/** Team-relative folder paths ('' = the team root), each list shallowest first. */
export interface FolderView { read: string[]; write: string[]; denyRead: string[]; denyWrite: string[] }

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const depth = (p: string) => (p === '' ? 0 : p.split('/').length)
const isUnder = (child: string, parent: string) => parent === '' || child === parent || child.startsWith(parent + '/')

/** The access of a candidate in a run: RuleSet.access, with users/ and .system/ fixed. */
function accessOf(rules: Pick<RuleSet, 'access'>, p: Principal, folder: string): Access {
  const s = segsOf(folder)
  if (s[0] === PRODUCT.systemDir) return 'none'
  if (s[0] === 'users') return s.length >= 2 && s[1] === p.id ? 'write' : 'none'
  return rules.access(p, s)
}

/** The folders that a run may write. start: the starting folder, team-relative (a project folder); null: the run
 * starts in the chat's work folder (outside the team folder), so only the person's own folder is writable. */
export interface RunWrites { start: string | null }

const holderWord = (s: string | undefined) => { const f = (s ?? '').normalize('NFC').toLowerCase(); return f === 'groups' || f === 'projects' }
/** The skill folders a run must not write though they are inside what it writes: the person's own skills, and the
 * skills folder of the group's or project's folder it starts in (team-relative). */
export function runSkillFolders(run: RunWrites, personId: string): string[] {
  const s = run.start ? run.start.split('/') : []
  return [`users/${personId}/skills`, ...(s.length === 2 && holderWord(s[0]) && s[1] ? [`${run.start}/skills`] : [])]
}
/** A start folder that is a skill folder or in one, or groups/ or projects/ themselves: no team folder is written. */
const skillStart = (start: string) => skillRootOf(start) !== null || (!start.includes('/') && holderWord(start))

/** May a run with this starting folder write in `folder` (when the rules let the person write there)? Never in a skill
 * folder (runSkillFolders). */
export const runMayWrite = (run: RunWrites, personId: string, folder: string) =>
  ((run.start !== null && !skillStart(run.start) && isUnder(folder, run.start)) || isUnder(folder, `users/${personId}`)) && !runSkillFolders(run, personId).some((f) => isUnder(folder, f))

/** Who may see `folder` (team-relative): every person whose access there is not none, with users/ and .system/ fixed. */
const audienceOf = (rules: Pick<RuleSet, 'access'>, people: readonly Principal[], folder: string) =>
  people.filter((q) => accessOf(rules, q, folder) !== 'none').map((q) => q.id)

export function folderView(rules: Pick<RuleSet, 'access' | 'ruleFolders'>, p: Principal, run?: RunWrites, people?: readonly Principal[]): FolderView {
  // the team root as a starting folder would make every folder writable again: fail closed
  if (run && run.start !== null && (run.start === '' || run.start.split('/').some((x) => x === '' || x === '.' || x === '..'))) throw new Error(`not a starting folder: ${JSON.stringify(run.start)}`)
  const cands = new Set<string>(['', 'users', `users/${p.id}`, PRODUCT.systemDir])
  // access can change at the starting folder too (write in it, read above it), also when it has no rules of its own
  if (run?.start) cands.add(run.start)
  // and at the skill folders inside what the run writes: read-only there (runMayWrite)
  if (run) for (const f of runSkillFolders(run, p.id)) cands.add(f)
  for (const f of rules.ruleFolders()) {
    const s = segsOf(f)
    // rules under users/ are ignored by the rules themselves; a temp name never has rules that matter
    if (s[0] === 'users' || s[0] === PRODUCT.systemDir || s.some((x) => x.startsWith(PRODUCT.tmpPrefix))) continue
    cands.add(f)
  }
  const sorted = [...cands].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  // a project run: the people who see the starting folder (the person included); a folder outside it is read only when
  // all of them read it too (see the note above folderView)
  const startAudience = run?.start && people ? audienceOf(rules, [...people.filter((q) => q.id !== p.id), p], run.start) : null
  const coversStart = (folder: string) => {
    if (!startAudience) return true
    const readers = new Set(audienceOf(rules, [...people!.filter((q) => q.id !== p.id), p], folder))
    return startAudience.every((id) => readers.has(id))
  }
  const out: FolderView = { read: [], write: [], denyRead: [], denyWrite: [] }
  const got = new Map<string, Access>()
  for (const c of sorted) {
    let a = accessOf(rules, p, c)
    if (run && a === 'write' && !runMayWrite(run, p.id, c)) a = 'read'
    if (startAudience && a !== 'none' && !isUnder(c, run!.start!) && !coversStart(c)) a = 'none'
    got.set(c, a)
    // the nearest candidate above (the team root has none above it: none)
    let parent: Access = 'none'
    if (c !== '') {
      const s = segsOf(c)
      for (let len = s.length - 1; len >= 0; len--) {
        const up = s.slice(0, len).join('/')
        if (got.has(up)) { parent = got.get(up)!; break }
      }
    }
    if (a === parent) continue
    if (a === 'write') out.write.push(c)
    else if (a === 'read') (parent === 'none' ? out.read : out.denyWrite).push(c)
    else out.denyRead.push(c)
  }
  return out
}

/** What srt gives a path, as a model of how srt applies the lists (the deepest of denyRead, allowRead and allowWrite
 * decides what is seen; any denyWrite above wins over allowWrite). Tests compare it with RuleSet.access. */
export function viewAccess(v: FolderView, rel: string): Access {
  let best: { d: number; a: 'none' | 'read' | 'write' } = { d: -1, a: 'none' }
  const take = (list: string[], a: 'none' | 'read' | 'write') => { for (const f of list) if (isUnder(rel, f) && depth(f) >= best.d) best = { d: depth(f), a } }
  // at the same depth a deny is applied after an allow of the same path in no case here: entries are unique per path
  take(v.read, 'read'); take(v.write, 'write'); take(v.denyRead, 'none')
  if (best.a === 'none') return 'none'
  if (best.a === 'read') return 'read'
  return v.denyWrite.some((f) => isUnder(rel, f)) ? 'read' : 'write'
}

/** A short hash of a view (plus anything else that must not change while a run lasts). */
export function viewHash(v: FolderView, extra = ''): string {
  return crypto.createHash('sha256').update(JSON.stringify([v.read, v.write, v.denyRead, v.denyWrite, extra])).digest('hex').slice(0, 32)
}

/** May the person write `rel` in a run (the same answer as viewAccess, for a quick check by the tool)? */
export const viewWrites = (v: FolderView, rel: string) => atLeast(viewAccess(v, rel), 'write')
