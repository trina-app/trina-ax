// Folder permission resolution (design tab 2 "폴더와 권한 규칙"). Paths are arrays of ACTUAL on-disk names
// (see resolve.ts) and are compared exactly — never case-folded.
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'

export type Access = 'none' | 'read' | 'write'
export type Role = 'owner' | 'admin' | 'member'
export interface Principal { id: string; name: string; role: Role; groups: string[] }

interface Rule { subject_type: 'everyone' | 'role' | 'group' | 'user'; subject_id: string | null; access: Access }
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
export const atLeast = (a: Access, b: Access) => RANK[a] >= RANK[b]

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

  access(p: Principal, segs: readonly string[]): Access {
    if (segs.length && segs[0] === PRODUCT.systemDir) return 'none'
    if (segs.some((s) => s.startsWith(PRODUCT.tmpPrefix))) return 'none'
    // users/<id>/ (tab 2 rules 2-3): the person's own folder is always write; anyone else's is none for every role,
    // owner and admin included, and rules there are ignored (the admin API refuses them; a moved folder or a
    // restored backup could still bring one in).
    if (segs[0] === 'users' && segs.length >= 2) return segs[1] === p.id ? 'write' : 'none'
    // users/ itself only holds the personal folders: nobody writes there directly (no files beside the folders, no
    // folder for a person who does not exist yet, no renaming or trashing the whole tree)
    if (segs.length === 1 && segs[0] === 'users') return 'read'
    if (p.role === 'owner' || p.role === 'admin') return 'write' // everything else
    for (let len = segs.length; len >= 0; len--) {
      const rules = this.byPath.get(segs.slice(0, len).join('/'))
      if (!rules) continue
      const mine = rules.filter((r) => applies(r, p))
      if (mine.length) return pick(mine)
    }
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
// personal > group (widest) > role > everyone
function pick(rules: Rule[]): Access {
  for (const t of ['user', 'group', 'role', 'everyone'] as const) {
    const xs = rules.filter((r) => r.subject_type === t)
    if (xs.length) return xs.reduce<Access>((a, r) => (RANK[r.access] > RANK[a] ? r.access : a), 'none')
  }
  return 'none'
}
