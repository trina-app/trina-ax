// Admin › Folder permissions › By folder: the tree (GET /api/admin/access/tree). One level of the team folder at a time,
// each child with who sees it (every active person once, grouped by the rule that decided for them), where that comes
// from and the risks worth a warning. Like ./access-rows.ts this reads nothing: the server (admin/access-explain.ts)
// gives the folders on disk and the people, the web mock server (web/test/mock/server.ts) its own, and both answer with
// these functions. Every "who" is RuleSet.explain, the same computation as access(); nothing here decides access.
//
// Hidden on purpose, as in the other answers: users/ is one row (how many personal folders) and nothing in it is
// listed; .system/, temp names and names the team folder refuses never appear (access-rows.ts shownSegs).
import type { AccessFolderKind, AccessTreeLevel, AccessTreeNode, AccessTreeResponse, AccessTreeRisk, AccessTreeWho } from '@mycel/shared/api'
import { MAX_DEPTH, MAX_PATH_CHARS } from '../policy/names'
import type { Principal, RuleSet } from '../policy/access'
import { cmp, ruleFolderOf, segsOf, shownSegs } from './access-rows'

/** children per page of one level: default and most */
export const TREE_ROWS = 200
export const MAX_TREE_ROWS = 500
/** open=1: the levels on the way down to marked folders, breadth first, while the answer has at most this many
 * children in all and this many levels (each opened level gives its first page; the rest opens on request) */
export const OPEN_ROWS = 600
export const OPEN_LEVELS = 40
/** an opened level is not started with fewer rows than this left */
const OPEN_MIN_ROWS = 20

/** What makes a folder worth opening the way to, and what it is (the person answer's kinds). */
export interface TreeMark { kinds: Set<AccessFolderKind>; group?: { id: string; name: string }; projects?: { id: string; name: string }[]; connected?: { id: string; name: string } }

export interface TreeSource {
  rules: RuleSet
  /** active people */
  people: readonly Principal[]
  groupName(id: string): string | null
  personName(id: string): string | null
  /** the names of the folders inside a shown folder that exists (any order; nothing else is listed) */
  children(segs: readonly string[]): string[]
  /** a shown folder inside it exists (looked at for each child of a page, and for the folder asked for when it is
   * there); never through a link */
  hasFolders(segs: readonly string[]): boolean
  /** a real folder is at `segs` (every step a folder, no link): the rule folders the "rule folders only" list shows */
  isFolder(segs: readonly string[]): boolean
  /** group, project and connected folders (rule folders come from `rules`) */
  marks: ReadonlyMap<string, TreeMark>
  /** personal folders (active people), said on the users/ row */
  personal: number
}

const USERS = 'users'
/** kinds in the contract's order, so an answer reads the same every time */
const KIND_ORDER: readonly AccessFolderKind[] = ['top', 'rules', 'group', 'project', 'connected', 'personal']
const sortKinds = (k: Iterable<AccessFolderKind>) => [...k].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b))
/** skills/ and below as the skills guard compares it (server/src/skills/guard.ts inSkills): the first name without
 * letter case or Unicode form, so a team folder that serves `Skills/` is said to be the team's AI instructions too */
export const isSkills = (p: string) => (p.split('/')[0] ?? '').normalize('NFC').toLowerCase() === 'skills'
/** the tree's own order: segment by segment, so a folder comes before what is inside it and then its next sibling
 * (`a`, `a/b`, `a-c`), as a level lists its children by name */
export function treeCmp(a: string, b: string): number {
  const x = segsOf(a), y = segsOf(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = cmp(x[i]!, y[i]!)
    if (c) return c
  }
  return x.length - y.length
}

/** The tree's marked folders: rule folders and the source's marks, outside users/, .system/ and temp names. */
function markedPaths(src: TreeSource): Map<string, TreeMark> {
  const out = new Map<string, TreeMark>()
  for (const f of src.rules.ruleFolders()) {
    if (f === '' || !shownSegs(f)) continue
    out.set(f, { kinds: new Set(['rules']) })
  }
  for (const [p, m] of src.marks) {
    if (p === '' || !shownSegs(p)) continue
    const c = out.get(p)
    if (!c) { out.set(p, { ...m, kinds: new Set(m.kinds) }); continue }
    for (const k of m.kinds) c.kinds.add(k)
    if (m.group) c.group = m.group
    if (m.projects) c.projects = [...(c.projects ?? []), ...m.projects]
    if (m.connected) c.connected = m.connected
  }
  return out
}

/** For every folder above a marked folder: how many marked folders are below it. */
function belowCounts(marked: ReadonlyMap<string, TreeMark>): Map<string, number> {
  const below = new Map<string, number>()
  for (const p of marked.keys()) {
    const segs = p.split('/')
    for (let k = 0; k < segs.length; k++) {
      const a = segs.slice(0, k).join('/')
      below.set(a, (below.get(a) ?? 0) + 1)
    }
  }
  return below
}

const RANK = { none: 0, read: 1, write: 2 } as const

/**
 * People that no rule on the way up from `at` can tell apart: the same role, the same groups among those the rules
 * there name, and not named by a person rule there. Every one of them gets the same RuleSet.explain at `at` (the rules
 * of other groups never apply on that way), so it runs once per such class, on one of them.
 */
function classesAt(src: TreeSource, at: readonly string[]): { p: Principal; n: number }[] {
  const gi = new Map<string, number>()
  const named = new Set<string>()
  for (let len = at.length; len >= 0; len--) {
    for (const r of src.rules.rulesAt(at.slice(0, len).join('/'))) {
      if (r.subjectId === null) continue
      if (r.subjectType === 'group' && !gi.has(r.subjectId)) gi.set(r.subjectId, gi.size)
      else if (r.subjectType === 'user') named.add(r.subjectId)
    }
  }
  const classes = new Map<string, { p: Principal; n: number }>()
  const bits = gi.size <= 30
  for (const p of src.people) {
    let key: string
    if (named.has(p.id)) key = `u\u0000${p.id}`
    else {
      let mask = 0
      const idx: number[] = []
      for (const g of p.groups) {
        const i = gi.get(g)
        if (i === undefined) continue
        if (bits) mask |= 1 << i
        else idx.push(i)
      }
      key = `${p.role}\u0000${bits ? mask : [...new Set(idx)].sort((a, b) => a - b).join(',')}`
    }
    const c = classes.get(key)
    if (c) c.n++
    else classes.set(key, { p, n: 1 })
  }
  return [...classes.values()]
}

/** Everyone active at the deciding folder `at`, grouped (most access first, then most people). */
function whoAt(src: TreeSource, at: readonly string[]): AccessTreeWho[] {
  const groups = new Map<string, AccessTreeWho>()
  for (const { p, n } of classesAt(src, at)) {
    const e = src.rules.explain(p, at)
    let key: string
    let row: Omit<AccessTreeWho, 'count'>
    if (e.reason.kind === 'rule') {
      const d = e.reason.rules[0]
      const subject = d ? { type: d.subjectType, id: d.subjectId, name: d.subjectId === null ? null : d.subjectType === 'group' ? src.groupName(d.subjectId) : d.subjectType === 'user' ? src.personName(d.subjectId) : null } : null
      key = `rule\u0000${e.reason.folder}\u0000${d?.subjectType ?? ''}\u0000${d?.subjectId ?? ''}\u0000${e.access}`
      row = { reason: 'rule', folder: e.reason.folder, subject, access: e.access }
    } else {
      // outside users/ the only other steps are the owner and admins, and no rule for them
      const reason = e.reason.kind === 'owner-admin' ? 'owner-admin' : 'no-rule'
      key = `${reason}\u0000${e.access}`
      row = { reason, folder: null, subject: null, access: e.access }
    }
    const g = groups.get(key)
    if (g) g.count += n
    else groups.set(key, { ...row, count: n })
  }
  return [...groups.values()].sort((a, b) => RANK[b.access] - RANK[a.access] || b.count - a.count || cmp(a.reason, b.reason) || cmp(a.folder ?? '', b.folder ?? '') || cmp(a.subject?.id ?? '', b.subject?.id ?? ''))
}

/** Every member (not the owner or an admin) writes there; false when there are no members. */
const allWrite = (who: readonly AccessTreeWho[]) => {
  const members = who.filter((w) => w.reason !== 'owner-admin')
  return members.length > 0 && members.every((w) => w.access === 'write')
}
/** Some member cannot open it. */
const someShut = (who: readonly AccessTreeWho[]) => who.some((w) => w.reason !== 'owner-admin' && w.access === 'none')

/** One answer's computations: "who" once per deciding folder (a folder without rules answers like the nearest folder
 * with rules above it), the marked folders once. */
export function treeContext(src: TreeSource) {
  const ruleFolders = new Set(src.rules.ruleFolders())
  const marked = markedPaths(src)
  const below = belowCounts(marked)
  const memo = new Map<string, AccessTreeWho[]>()
  const who = (segs: readonly string[]): AccessTreeWho[] => {
    const at = ruleFolderOf(ruleFolders, segs)
    const key = at ?? '\u0000'
    let w = memo.get(key)
    if (!w) memo.set(key, (w = whoAt(src, at === null ? segs : segsOf(at))))
    return w
  }
  // a rule on the root that lets members in as everyone or as members (what decide() gives them there, so a "member:
  // none" beside "everyone: read" opens nothing)
  const rootOpens = () => who([]).some((w) => w.reason === 'rule' && w.folder === '' && w.access !== 'none' && (w.subject?.type === 'everyone' || (w.subject?.type === 'role' && w.subject.id === 'member')))

  /** `exists`: false for a folder asked for that is not there (nothing is looked at inside it: a link is not followed) */
  const node = (segs: readonly string[], exists = true): AccessTreeNode => {
    const path = segs.join('/')
    if (segs.length === 1 && segs[0] === USERS) {
      return { name: USERS, path: USERS, kinds: ['personal'], rules: 0, folders: false, marked: 0, who: [], risks: [], restricted: false, people: src.personal }
    }
    const w = who(segs)
    const m = marked.get(path)
    const risks: AccessTreeRisk[] = []
    // the topmost folder where every member writes (below it the same is inherited, said once); in skills/ the
    // skills folder itself always says it
    if (allWrite(w)) {
      const parentAll = segs.length > 0 && allWrite(who(segs.slice(0, -1)))
      if (isSkills(path)) { if (segs.length === 1 || !parentAll) risks.push('skills-everyone-writes') }
      else if (!parentAll) risks.push('everyone-writes')
    }
    if (segs.length === 0 && rootOpens()) risks.push('root-everyone')
    return {
      name: segs.length ? segs[segs.length - 1]! : '', path,
      kinds: m ? sortKinds(m.kinds) : [], ...(m?.group ? { group: m.group } : {}), ...(m?.projects ? { projects: m.projects } : {}), ...(m?.connected ? { connected: m.connected } : {}),
      rules: src.rules.rulesAt(path).length,
      folders: exists && segs.length < MAX_DEPTH && src.hasFolders(segs),
      marked: below.get(path) ?? 0,
      who: w, risks, restricted: someShut(w),
    }
  }

  /** The children of a folder that the tree may show, by name (byte order): users/ at the root as its one row. */
  const childNames = (segs: readonly string[]): string[] => {
    if (segs.length >= MAX_DEPTH) return []
    const base = segs.join('/')
    const names = new Set<string>()
    for (const n of src.children(segs)) {
      if (segs.length === 0 && n === USERS) { names.add(n); continue }
      const p = base ? `${base}/${n}` : n
      if (p.length > MAX_PATH_CHARS || !shownSegs(p)) continue
      names.add(n)
    }
    if (segs.length === 0) names.add(USERS)
    return [...names].sort(cmp)
  }

  const level = (segs: readonly string[], o: { cursor?: string; limit: number }): AccessTreeLevel => {
    const all = childNames(segs)
    const from = o.cursor === undefined ? all : all.filter((n) => cmp(n, o.cursor!) > 0)
    const items = from.slice(0, o.limit)
    return {
      path: segs.join('/'), children: items.map((n) => node([...segs, n])), total: all.length,
      nextCursor: from.length > items.length ? items[items.length - 1]! : null,
    }
  }

  return { node, level, who }
}

/**
 * The answer for one folder (`segs`, actual names; `exists` from the caller): the folder itself, its children (a page)
 * and, with `open` and no cursor, the levels on the way down to marked folders (breadth first, the first page of each,
 * within OPEN_ROWS children and OPEN_LEVELS levels).
 */
export function treeAnswer(src: TreeSource, segs: readonly string[], exists: boolean, q: { cursor?: string; limit?: number; open?: boolean }): AccessTreeResponse {
  const tc = treeContext(src)
  const limit = Math.min(q.limit ?? TREE_ROWS, MAX_TREE_ROWS)
  const first = exists ? tc.level(segs, { cursor: q.cursor, limit }) : { path: segs.join('/'), children: [], total: 0, nextCursor: null }
  const levels = [first]
  if (q.open && q.cursor === undefined) {
    let rows = first.children.length
    const queue = first.children.filter((c) => c.marked > 0 && c.folders).map((c) => c.path)
    while (queue.length && levels.length < OPEN_LEVELS && OPEN_ROWS - rows >= OPEN_MIN_ROWS) {
      const p = queue.shift()!
      const l = tc.level(segsOf(p), { limit: Math.min(limit, OPEN_ROWS - rows) })
      levels.push(l)
      rows += l.children.length
      for (const c of l.children) if (c.marked > 0 && c.folders) queue.push(c.path)
    }
  }
  return {
    path: segs.join('/'), exists,
    people: src.people.length, members: src.people.filter((p) => p.role === 'member').length,
    self: tc.node(segs, exists), levels,
  }
}

/**
 * "Rule folders only" (rules=1): the folders with rules at or below `segs` that are there on disk (not hidden, not
 * deeper than 64), in the tree's order, a page at a time (the cursor is the last path), and `above`: the folders on
 * the way to them that are not in the page themselves (the root aside), so the screen draws them as a tree.
 */
export function ruledAnswer(src: TreeSource, segs: readonly string[], exists: boolean, q: { cursor?: string; limit?: number }): AccessTreeResponse {
  const tc = treeContext(src)
  const limit = Math.min(q.limit ?? TREE_ROWS, MAX_TREE_ROWS)
  const base = segs.join('/')
  const all = (exists ? src.rules.ruleFolders() : [])
    .filter((f) => f !== '' && (base === '' || f === base || f.startsWith(base + '/')) && f.length <= MAX_PATH_CHARS && shownSegs(f) !== null && segsOf(f).length <= MAX_DEPTH && src.isFolder(segsOf(f)))
    .sort(treeCmp)
  const from = q.cursor === undefined ? all : all.filter((p) => treeCmp(p, q.cursor!) > 0)
  const items = from.slice(0, limit)
  const inPage = new Set(items)
  const above = new Map<string, AccessTreeNode>()
  for (const p of items) {
    const ps = segsOf(p)
    for (let k = 1; k < ps.length; k++) {
      const a = ps.slice(0, k).join('/')
      if (!inPage.has(a) && !above.has(a)) above.set(a, tc.node(ps.slice(0, k)))
    }
  }
  return {
    path: base, exists,
    people: src.people.length, members: src.people.filter((p) => p.role === 'member').length,
    self: tc.node(segs, exists),
    levels: [{ path: base, children: items.map((p) => tc.node(segsOf(p))), total: all.length, nextCursor: from.length > items.length ? items[items.length - 1]! : null }],
    above: [...above.values()],
  }
}
