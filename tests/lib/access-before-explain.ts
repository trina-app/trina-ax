// The permission function as it was before RuleSet.explain() (server/src/policy/access.ts at origin/main 3b1b7068),
// copied line for line (only the names carry "old"): tests/unit/access-explain-equivalence.test.ts compares the
// current one against it and tests/perf/access-explain.ts measures both. Do not "fix" it: it is the reference.
import { PRODUCT } from '@mycel/shared'
import type { Access, Principal } from '../../server/src/policy/access'

export interface OldRule { subject_type: 'everyone' | 'role' | 'group' | 'user'; subject_id: string | null; access: Access }
const OLD_RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
export class OldRuleSet {
  private byPath = new Map<string, OldRule[]>()
  constructor(rows: { path: string; subject_type: OldRule['subject_type']; subject_id: string | null; access: Access }[]) {
    for (const r of rows) {
      const list = this.byPath.get(r.path) ?? []
      list.push({ subject_type: r.subject_type, subject_id: r.subject_id, access: r.access })
      this.byPath.set(r.path, list)
    }
  }
  access(p: Principal, segs: readonly string[]): Access {
    if (segs.length && segs[0] === PRODUCT.systemDir) return 'none'
    if (segs.some((s) => s.startsWith(PRODUCT.tmpPrefix))) return 'none'
    if (segs[0] === 'users' && segs.length >= 2) return segs[1] === p.id ? 'write' : 'none'
    if (segs.length === 1 && segs[0] === 'users') return 'read'
    if (p.role === 'owner' || p.role === 'admin') return 'write' // everything else
    for (let len = segs.length; len >= 0; len--) {
      const rules = this.byPath.get(segs.slice(0, len).join('/'))
      if (!rules) continue
      const mine = rules.filter((r) => oldApplies(r, p))
      if (mine.length) return oldPick(mine)
    }
    return 'none'
  }
  /** the old answer of one folder's rules alone (null: none applies), to check explain()'s folder */
  at(p: Principal, folder: string): Access | null {
    const mine = (this.byPath.get(folder) ?? []).filter((r) => oldApplies(r, p))
    return mine.length ? oldPick(mine) : null
  }
}
function oldApplies(r: OldRule, p: Principal): boolean {
  switch (r.subject_type) {
    case 'everyone': return true
    case 'role': return r.subject_id === p.role
    case 'group': return r.subject_id !== null && p.groups.includes(r.subject_id)
    case 'user': return r.subject_id === p.id
  }
}
function oldPick(rules: OldRule[]): Access {
  for (const t of ['user', 'group', 'role', 'everyone'] as const) {
    const xs = rules.filter((r) => r.subject_type === t)
    if (xs.length) return xs.reduce<Access>((a, r) => (OLD_RANK[r.access] > OLD_RANK[a] ? r.access : a), 'none')
  }
  return 'none'
}
