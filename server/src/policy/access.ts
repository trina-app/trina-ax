// Folder permission resolution (design tab 2 "폴더와 권한 규칙"). Paths are arrays of ACTUAL on-disk names
// (see resolve.ts) and are compared exactly — never case-folded.
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'

export type Access = 'none' | 'read' | 'write'
export type Role = 'owner' | 'admin' | 'member'
export interface Principal { id: string; name: string; role: Role; groups: string[] }
export type SubjectType = 'everyone' | 'role' | 'group' | 'user'

interface Rule { subject_type: SubjectType; subject_id: string | null; access: Access }
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const BY_RANK: readonly Access[] = ['none', 'read', 'write']
export const atLeast = (a: Access, b: Access) => RANK[a] >= RANK[b]

/** Inside the deciding folder: personal > group (widest) > role > everyone. A lower number decides first. */
const TIERS = ['user', 'group', 'role', 'everyone'] as const
const TIER: Record<SubjectType, number> = { user: 0, group: 1, role: 2, everyone: 3 }
const NO_TIER = TIERS.length

/**
 * Why a person has the access they have at a path (RuleSet.explain): the branch of the permission function that
 * decided, in its order.
 * - system: `.system/` (nobody, owner included) · temp: a server temp name in the path (nobody)
 * - own-personal: `users/<me>/…` (write) · other-personal: `users/<someone else>/…` (nobody, owner and admin
 *   included) · users-root: `users/` itself (read, nobody writes there)
 * - owner-admin: the owner or an admin (write everywhere else)
 * - rule: the deepest folder on the way up that has a rule for the person (`folder`, '' = team root), the step that
 *   decided there (`tier`) and that step's rules for the person (`rules`; the widest access among them wins)
 * - no-rule: no folder on the way up has a rule for the person (only the owner and admins)
 */
export type AccessReasonKind = 'system' | 'temp' | 'own-personal' | 'other-personal' | 'users-root' | 'owner-admin' | 'rule' | 'no-rule'
export interface DecidingRule { subjectType: SubjectType; subjectId: string | null; access: Access }
export type AccessReason =
  | { kind: Exclude<AccessReasonKind, 'rule'> }
  | { kind: 'rule'; folder: string; tier: SubjectType; rules: DecidingRule[] }
export interface Explained { access: Access; reason: AccessReason }

/** Where decide() leaves why it answered. access() passes none, so the hot path allocates nothing for it. */
interface Why { kind: AccessReasonKind; folderLen: number; tier: number; rules: readonly Rule[] | null }

export function loadPrincipal(db: Database, userId: string): Principal | null {
  const u = db.query("SELECT id, name, role, status FROM users WHERE id = ?").get(userId) as any
  if (!u || u.status !== 'active') return null
  const groups = (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[]).map((r) => r.group_id)
  return { id: u.id, name: u.name, role: u.role, groups }
}

export class RuleSet {
  private byPath = new Map<string, Rule[]>()
  constructor(rows: { path: string; subject_type: Rule['subject_type']; subject_id: string | null; access: Access }[]) {
    for (const r of rows) {
      const list = this.byPath.get(r.path) ?? []
      list.push({ subject_type: r.subject_type, subject_id: r.subject_id, access: r.access })
      this.byPath.set(r.path, list)
    }
  }
  static load(db: Database): RuleSet {
    return new RuleSet(db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as any)
  }
  /** folder paths that carry at least one rule */
  ruleFolders(): string[] { return [...this.byPath.keys()] }
  /** the rules of one folder path ('' = team root), as stored */
  rulesAt(folder: string): DecidingRule[] {
    return (this.byPath.get(folder) ?? []).map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
  }

  access(p: Principal, segs: readonly string[]): Access { return this.decide(p, segs, null) }

  /** access() and the reason for it, from the same computation (admin screens: "why can this person see this?") */
  explain(p: Principal, segs: readonly string[]): Explained {
    const why: Why = { kind: 'no-rule', folderLen: 0, tier: NO_TIER, rules: null }
    const access = this.decide(p, segs, why)
    if (why.kind !== 'rule') return { access, reason: { kind: why.kind } }
    const tier = TIERS[why.tier]!
    const rules = why.rules!.filter((r) => r.subject_type === tier && applies(r, p))
      .map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
      .sort((a, b) => (RANK[b.access] - RANK[a.access]) || String(a.subjectId ?? '').localeCompare(String(b.subjectId ?? '')))
    return { access, reason: { kind: 'rule', folder: segs.slice(0, why.folderLen).join('/'), tier, rules } }
  }

  /** THE resolution. Both access() and explain() come from here, so the answer and its reason never drift apart. */
  private decide(p: Principal, segs: readonly string[], why: Why | null): Access {
    if (segs.length && segs[0] === PRODUCT.systemDir) { if (why) why.kind = 'system'; return 'none' }
    for (let i = 0; i < segs.length; i++) if (segs[i]!.startsWith(PRODUCT.tmpPrefix)) { if (why) why.kind = 'temp'; return 'none' }
    // users/<id>/ (tab 2 rules 2-3): the person's own folder is always write; anyone else's is none for every role,
    // owner and admin included, and rules there are ignored (the admin API refuses them; a moved folder or a
    // restored backup could still bring one in).
    if (segs[0] === 'users' && segs.length >= 2) {
      const own = segs[1] === p.id
      if (why) why.kind = own ? 'own-personal' : 'other-personal'
      return own ? 'write' : 'none'
    }
    // users/ itself only holds the personal folders: nobody writes there directly (no files beside the folders, no
    // folder for a person who does not exist yet, no renaming or trashing the whole tree)
    if (segs.length === 1 && segs[0] === 'users') { if (why) why.kind = 'users-root'; return 'read' }
    if (p.role === 'owner' || p.role === 'admin') { if (why) why.kind = 'owner-admin'; return 'write' } // everything else
    // the deepest folder with a rule that applies to the person decides; the key of each level is the joined path cut
    // after its first `len` names (by their lengths), not joined again per level: the same string as
    // segs.slice(0, len).join('/')
    const full = segs.join('/')
    let end = full.length
    for (let len = segs.length; len >= 0; len--) {
      if (len < segs.length) end -= segs[len]!.length + (len > 0 ? 1 : 0)
      const rules = this.byPath.get(end === full.length ? full : full.slice(0, end))
      if (!rules) continue
      const d = decideIn(rules, p)
      if (d < 0) continue
      if (why) { why.kind = 'rule'; why.folderLen = len; why.tier = d >> 2; why.rules = rules }
      return BY_RANK[d & 3]!
    }
    if (why) why.kind = 'no-rule'
    return 'none'
  }

  /** true when something strictly below `segs` is readable (so the folder may be listed for navigation) */
  hasVisibleDescendant(p: Principal, segs: readonly string[]): boolean {
    if (segs.length && segs[0] === PRODUCT.systemDir) return false
    if (segs[0] === 'users') {
      if (segs.length === 1) return true // own personal folder below
      return segs[1] === p.id
    }
    if (p.role === 'owner' || p.role === 'admin') return true
    const cands = [...this.ruleFolders().map((f) => (f === '' ? [] : f.split('/'))).filter((c) => c[0] !== 'users'), ['users', p.id]]
    for (const c of cands) {
      if (c.length > segs.length && segs.every((s, i) => s === c[i]) && atLeast(this.access(p, c), 'read')) return true
    }
    return false
  }
  canList(p: Principal, segs: readonly string[]) { return atLeast(this.access(p, segs), 'read') || this.hasVisibleDescendant(p, segs) }

  /**
   * canList() of one person for many paths at once (admin answers): the folders hasVisibleDescendant() looks at (rule
   * folders outside users/, and the person's own users/<id>) are tried once, strictly below `within`; each path at or
   * below `within` then looks up the readable ones below it instead of trying them all again. `listable(segs)` equals
   * canList(p, segs) (tests/unit/access-explain-equivalence.test.ts). `via(segs, max, shown)`: the readable folders
   * strictly below segs that no other readable one below segs contains (why a folder without access shows in the
   * tree), by path, at most `max`, and whether there are more. `shown` only decides which of them may be named (the
   * person's own users/<id> always may): listable() does not look at it.
   */
  listing(p: Principal, within: readonly string[] = []): Listing {
    const readable = new Set<string>()
    const below = new Map<string, string[][]>()
    const cands = this.candidatesBelow(within)
    const own = ['users', p.id]
    for (const c of own.length > within.length && within.every((s, i) => s === own[i]) ? [...cands, own] : cands) {
      if (!atLeast(this.access(p, c), 'read')) continue
      readable.add(c.join('/'))
      for (let k = within.length; k < c.length; k++) {
        const key = c.slice(0, k).join('/')
        const list = below.get(key)
        if (list) list.push(c)
        else below.set(key, [c])
      }
    }
    const listable = (segs: readonly string[]): boolean => {
      if (atLeast(this.access(p, segs), 'read')) return true
      if (segs.length && segs[0] === PRODUCT.systemDir) return false
      if (segs[0] === 'users') return segs.length === 1 || segs[1] === p.id
      if (p.role === 'owner' || p.role === 'admin') return true
      return below.has(segs.join('/'))
    }
    const ownPath = own.join('/')
    const via = (segs: readonly string[], max: number, shown: (path: string) => boolean = () => true) => {
      const top = (below.get(segs.join('/')) ?? []).filter((c) => {
        for (let k = segs.length + 1; k < c.length; k++) if (readable.has(c.slice(0, k).join('/'))) return false
        return true
      }).map((c) => c.join('/')).filter((f) => f === ownPath || shown(f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return { folders: top.slice(0, max), more: top.length > max }
    }
    return { listable, via, at: (segs, max, shown) => { const ok = listable(segs); const v = ok ? via(segs, max, shown) : { folders: [], more: false }; return { listable: ok, via: v.folders, more: v.more } } }
  }

  /**
   * listing().at(within, max) for one folder and many people (the admin folder answer), without trying every folder
   * below it for every person: the rule folders below are taken in path order with their rule chains, a folder below
   * a readable one is not tried (it cannot be the topmost readable, and the folder is listable already), the scan
   * stops after max + 1, and people no rule can tell apart (same role and groups, named by no person rule) share one
   * scan. The decision on each folder is decideIn(), as in access(). Same answer as listing() and canList()
   * (tests/unit/access-explain-equivalence.test.ts). `shown`: as for listing().via (a readable folder it refuses still
   * makes the folder listable and still covers what is below it, but is not named).
   */
  navigator(within: readonly string[], max: number, shown: (path: string) => boolean = () => true): (p: Principal) => Navigation {
    const items = this.candidatesBelow(within).map((segs) => ({ segs, path: segs.join('/') })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const index = new Map(items.map((it, i) => [it.path, i]))
    // the nearest candidate above each one, still below `within` (-1: none)
    const parent = items.map((it) => {
      for (let k = it.segs.length - 1; k > within.length; k--) { const j = index.get(it.segs.slice(0, k).join('/')); if (j !== undefined) return j }
      return -1
    })
    // the rule lists from the folder up to the root (null: .system/ or a temp name, readable by nobody)
    const chains = items.map((it) => {
      if (it.segs[0] === PRODUCT.systemDir || it.segs.some((s) => s.startsWith(PRODUCT.tmpPrefix))) return null
      const out: Rule[][] = []
      for (let len = it.segs.length; len >= 0; len--) { const r = this.byPath.get(it.segs.slice(0, len).join('/')); if (r) out.push(r) }
      return out
    })
    const named = new Set<string>()
    for (const list of this.byPath.values()) for (const r of list) if (r.subject_type === 'user' && r.subject_id !== null) named.add(r.subject_id)
    const shown_ = items.map((it) => shown(it.path))
    const shared = new Map<string, { any: boolean; top: string[] }>()
    const scan = (p: Principal) => {
      const key = `${p.role}\u0000${[...new Set(p.groups)].sort().join('\u0001')}${named.has(p.id) ? `\u0000${p.id}` : ''}`
      const known = shared.get(key)
      if (known) return known
      const top: string[] = []
      let any = false
      const readable = new Uint8Array(items.length)
      for (let i = 0; i < items.length && top.length <= max; i++) {
        let a = parent[i]!, covered = false
        while (a >= 0) { if (readable[a]) { covered = true; break } a = parent[a]! }
        if (covered) continue
        const chain = chains[i]
        if (!chain) continue
        let rank = 0
        for (const rules of chain) { const d = decideIn(rules, p); if (d >= 0) { rank = d & 3; break } }
        if (rank >= RANK.read) { readable[i] = 1; any = true; if (shown_[i]) top.push(items[i]!.path) }
      }
      const r = { any, top }
      shared.set(key, r)
      return r
    }
    return (p) => {
      if (atLeast(this.access(p, within), 'read')) return { listable: true, via: [], more: false }
      if (within.length && within[0] === PRODUCT.systemDir) return { listable: false, via: [], more: false }
      if (within[0] === 'users') return within.length === 1 ? { listable: true, via: [`users/${p.id}`], more: false } : { listable: within[1] === p.id, via: [], more: false }
      if (p.role === 'owner' || p.role === 'admin') return { listable: true, via: [], more: false }
      const found = scan(p)
      const top = [...found.top]
      // the person's own users/<id> is below the team root, readable and topmost (nothing above it is a candidate)
      if (within.length === 0) {
        const own = `users/${p.id}`
        let i = 0
        while (i < top.length && top[i]! < own) i++
        top.splice(i, 0, own)
      }
      return { listable: found.any || within.length === 0, via: top.slice(0, max), more: top.length > max }
    }
  }
  /** rule folders outside users/ strictly below `within`, as segments (kept per `within` for the next person) */
  private candidatesBelow(within: readonly string[]): string[][] {
    const key = within.join('/')
    let c = this.candidates.get(key)
    if (!c) {
      c = [...this.byPath.keys()].map((f) => (f === '' ? [] : f.split('/')))
        .filter((s) => s[0] !== 'users' && s.length > within.length && within.every((w, i) => w === s[i]))
      this.candidates.set(key, c)
    }
    return c
  }
  private candidates = new Map<string, string[][]>()
}

export interface Navigation { listable: boolean; via: string[]; more: boolean }
export interface Listing {
  listable(segs: readonly string[]): boolean
  via(segs: readonly string[], max: number, shown?: (path: string) => boolean): { folders: string[]; more: boolean }
  /** listable(segs), and via(segs, max, shown) when it is */
  at(segs: readonly string[], max: number, shown?: (path: string) => boolean): Navigation
}

/** One folder's rules for a person: -1 when none applies, else (step << 2) | rank of the widest access in the first
 * step that has one (personal > group (widest) > role > everyone), in one pass. decide() and navigator() both use it. */
function decideIn(rules: readonly Rule[], p: Principal): number {
  let tier: number = NO_TIER, best = 0
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!
    if (!applies(r, p)) continue
    const t = TIER[r.subject_type]
    if (t < tier) { tier = t; best = 0 }
    if (t === tier && RANK[r.access] > best) best = RANK[r.access]
  }
  return tier === NO_TIER ? -1 : (tier << 2) | best
}

function applies(r: Rule, p: Principal): boolean {
  switch (r.subject_type) {
    case 'everyone': return true
    case 'role': return r.subject_id === p.role
    case 'group': return r.subject_id !== null && p.groups.includes(r.subject_id)
    case 'user': return r.subject_id === p.id
  }
}
