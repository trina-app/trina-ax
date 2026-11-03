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
    // the deepest folder with a rule that applies to the person decides; the folder keys are prefixes of one joined
    // path (a name never holds '/'), cut at the end of each shorter prefix instead of joined again per level
    const full = segs.join('/')
    let end = full.length
    for (let len = segs.length; len >= 0; len--) {
      if (len < segs.length) end -= segs[len]!.length + (len > 0 ? 1 : 0)
      const rules = this.byPath.get(end === full.length ? full : full.slice(0, end))
      if (!rules) continue
      // personal > group (widest) > role > everyone, in one pass over the folder's rules
      let tier: number = NO_TIER, best = 0
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i]!
        if (!applies(r, p)) continue
        const t = TIER[r.subject_type]
        if (t < tier) { tier = t; best = 0 }
        if (t === tier && RANK[r.access] > best) best = RANK[r.access]
      }
      if (tier === NO_TIER) continue
      if (why) { why.kind = 'rule'; why.folderLen = len; why.tier = tier; why.rules = rules }
      return BY_RANK[best]!
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
}

function applies(r: Rule, p: Principal): boolean {
  switch (r.subject_type) {
    case 'everyone': return true
    case 'role': return r.subject_id === p.role
    case 'group': return r.subject_id !== null && p.groups.includes(r.subject_id)
    case 'user': return r.subject_id === p.id
  }
}
