// The fingerprint of the folder rules on the way to a folder (a scheduled task's save folder and the places on its card:
// chat/schedule-scope.ts). Subjects and accesses only, never who is in a group. Here, beside the resolver, so the
// one-time conversion (policy/convert-additive.ts) can recompute the stored ones without the chat module.
import crypto from 'node:crypto'
import type { RuleSet } from './access'
import type { LegacyRow } from './legacy-deepest'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** The rules of every boundary folder from the team root down to `segs` (actual names), and whether each is limited, as
 * one hash (`levels-v2`): a rule added, changed or removed on the way, or Limit access turned on or off, changes it. */
export function ruleFingerprint(rules: RuleSet, segs: readonly string[]): string {
  const levels: [string, number, string[]][] = []
  for (let n = 0; n <= segs.length; n++) {
    const p = segs.slice(0, n).join('/')
    const at = rules.rulesAt(p)
    const limited = rules.limitedAt(p)
    if (at.length || limited) levels.push([p, limited ? 1 : 0, at.map((r) => `${r.subjectType}\u0000${r.subjectId ?? ''}\u0000${r.access}`).sort()])
  }
  return sha(JSON.stringify(['levels-v2', levels]))
}

/** The fingerprint as builds before P2 computed it, from the stored rows (FROZEN: the conversion compares stored
 * fingerprints with it before recomputing them). */
export function legacyRuleFingerprint(rows: readonly LegacyRow[], segs: readonly string[]): string {
  const by = new Map<string, string[]>()
  for (const r of rows) by.set(r.path, [...(by.get(r.path) ?? []), `${r.subject_type}\u0000${r.subject_id ?? ''}\u0000${r.access}`])
  const levels: [string, string[]][] = []
  for (let n = 0; n <= segs.length; n++) {
    const p = segs.slice(0, n).join('/')
    const at = by.get(p)
    if (at?.length) levels.push([p, [...at].sort()])
  }
  return sha(JSON.stringify(levels))
}
