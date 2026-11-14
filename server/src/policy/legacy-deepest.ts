// The permission function as it was before folder access added up (server/src/policy/access.ts at origin/dev
// df9086aee): the deepest folder with a rule that applies to the person decides, and inside it person > group (widest) >
// role > everyone. FROZEN: the one-time conversion (policy/convert-additive.ts), its dry run
// (scripts/dry-run/folder-additive.ts) and the roll-back tests compare the new resolver against it. Never edit what it
// answers; it is the definition of "access before P2".
import { PRODUCT } from '@mycel/shared'
import { inProjectZone, type Access, type Principal, type SubjectType } from './access'

export interface LegacyRule { subject_type: SubjectType; subject_id: string | null; access: Access }
export interface LegacyRow extends LegacyRule { path: string }

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const BY_RANK: readonly Access[] = ['none', 'read', 'write']
const TIER: Record<SubjectType, number> = { user: 0, group: 1, role: 2, everyone: 3 }
const NO_TIER = 4
const ZONE_FLOOR = 2
const zoneSubject = (p: Principal): Principal => ({ id: p.id, name: p.name, role: 'member', groups: p.groups })
const atLeast = (a: Access, b: Access) => RANK[a] >= RANK[b]

export class LegacyRuleSet {
  private byPath = new Map<string, LegacyRule[]>()
  constructor(rows: readonly LegacyRow[]) {
    for (const r of rows) {
      const list = this.byPath.get(r.path) ?? []
      list.push({ subject_type: r.subject_type, subject_id: r.subject_id, access: r.access })
      this.byPath.set(r.path, list)
    }
  }
  /** folder paths that carry at least one rule */
  ruleFolders(): string[] { return [...this.byPath.keys()] }
  rulesAt(folder: string): readonly LegacyRule[] { return this.byPath.get(folder) ?? [] }

  access(p: Principal, segs: readonly string[]): Access {
    if (segs.length && segs[0] === PRODUCT.systemDir) return 'none'
    for (let i = 0; i < segs.length; i++) if (segs[i]!.startsWith(PRODUCT.tmpPrefix)) return 'none'
    if (segs[0] === 'users' && segs.length >= 2) return segs[1] === p.id ? 'write' : 'none'
    if (segs.length === 1 && segs[0] === 'users') return 'read'
    if (p.system) return 'write'
    const staff = p.role === 'owner' || p.role === 'admin'
    if (staff && !inProjectZone(segs)) return 'write'
    if (staff && segs.length > ZONE_FLOOR && !atLeast(this.access(p, segs.slice(0, ZONE_FLOOR)), 'read')) return 'none'
    const q = staff ? zoneSubject(p) : p
    const floor = staff ? ZONE_FLOOR : 0
    for (let len = segs.length; len >= floor; len--) {
      const rules = this.byPath.get(segs.slice(0, len).join('/'))
      if (!rules) continue
      const d = legacyDecideIn(rules, q)
      if (d < 0) continue
      return BY_RANK[d & 3]!
    }
    return 'none'
  }
}

/** One folder's rules for a person, as today's tiers decide: -1 when none applies, else (tier << 2) | rank of the
 * widest access in the first tier that has one. */
export function legacyDecideIn(rules: readonly LegacyRule[], p: Pick<Principal, 'id' | 'role' | 'groups'>): number {
  let tier: number = NO_TIER, best = 0
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!
    if (!legacyApplies(r, p)) continue
    const t = TIER[r.subject_type]
    if (t < tier) { tier = t; best = 0 }
    if (t === tier && RANK[r.access] > best) best = RANK[r.access]
  }
  return tier === NO_TIER ? -1 : (tier << 2) | best
}

export function legacyApplies(r: Pick<LegacyRule, 'subject_type' | 'subject_id'>, p: Pick<Principal, 'id' | 'role' | 'groups'>): boolean {
  switch (r.subject_type) {
    case 'everyone': return true
    case 'role': return r.subject_id === p.role
    case 'group': return r.subject_id !== null && p.groups.includes(r.subject_id)
    case 'user': return r.subject_id === p.id
  }
}
