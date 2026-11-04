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
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import { atLeast, type Access, type Principal, type RuleSet } from '../../policy/access'

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

export function folderView(rules: Pick<RuleSet, 'access' | 'ruleFolders'>, p: Principal): FolderView {
  const cands = new Set<string>(['', 'users', `users/${p.id}`, PRODUCT.systemDir])
  for (const f of rules.ruleFolders()) {
    const s = segsOf(f)
    // rules under users/ are ignored by the rules themselves; a temp name never has rules that matter
    if (s[0] === 'users' || s[0] === PRODUCT.systemDir || s.some((x) => x.startsWith(PRODUCT.tmpPrefix))) continue
    cands.add(f)
  }
  const sorted = [...cands].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  const out: FolderView = { read: [], write: [], denyRead: [], denyWrite: [] }
  const got = new Map<string, Access>()
  for (const c of sorted) {
    const a = accessOf(rules, p, c)
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
