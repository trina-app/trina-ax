// The folder tree's "who" (server/src/admin/access-tree.ts) runs RuleSet.explain once per class of people that no rule
// on the way up can tell apart. It must be the same as explaining every person on their own and grouping, and its
// counts the same as RuleSet.access for every person, on random worlds: groups beyond 30 (the bit mask's limit), people
// in many groups, person rules, role rules, a root rule.
import { expect, test } from 'bun:test'
import type { AccessTreeWho } from '@mycel/shared/api'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { treeContext, type TreeSource } from '../../server/src/admin/access-tree'

let seed = 11
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const ACCESS: Access[] = ['none', 'read', 'write']
const RANK = { none: 0, read: 1, write: 2 }

/** the grouping as it was first written: every person explained on their own */
function naive(rules: RuleSet, people: Principal[], at: string[], name: (t: string, id: string) => string | null): AccessTreeWho[] {
  const out = new Map<string, AccessTreeWho>()
  for (const p of people) {
    const e = rules.explain(p, at)
    const d = e.reason.kind === 'rule' ? e.reason.rules[0] : undefined
    const row: AccessTreeWho = e.reason.kind === 'rule'
      ? { reason: 'rule', folder: e.reason.folder, subject: d ? { type: d.subjectType, id: d.subjectId, name: d.subjectId === null ? null : name(d.subjectType, d.subjectId) } : null, access: e.access, count: 0 }
      : { reason: e.reason.kind === 'owner-admin' ? 'owner-admin' : 'no-rule', folder: null, subject: null, access: e.access, count: 0 }
    const k = JSON.stringify([row.reason, row.folder, row.subject?.type, row.subject?.id, row.access])
    const g = out.get(k) ?? row
    g.count++
    out.set(k, g)
  }
  return [...out.values()]
}
const norm = (w: AccessTreeWho[]) => [...w].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)

test('who per class equals every person explained on their own, and the counts equal access()', () => {
  let nodes = 0
  for (let world = 0; world < 300; world++) {
    const nGroups = pick([3, 8, 31, 45])
    const groups = Array.from({ length: nGroups }, (_, i) => `g${i}`)
    const people: Principal[] = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, role: i === 0 ? 'owner' : i < 3 ? 'admin' : 'member',
      // with many groups, most people are in one each: the 1st and 33rd group a rule names must not look alike
      groups: nGroups > 30 && i % 4 ? [groups[i % nGroups]!] : groups.filter(() => rand() < 0.25),
    }))
    const folders = ['', 'a', 'a/b', 'a/b/c', 'a/d', 'e', 'e/f', 'skills', 'skills/x', 'shared']
    const rows: ConstructorParameters<typeof RuleSet>[0] = []
    for (const f of folders) {
      if (rand() < 0.45) continue
      for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) {
        const t = pick(['everyone', 'role', 'group', 'group', 'user'] as const)
        rows.push({ path: f, subject_type: t, subject_id: t === 'everyone' ? null : t === 'role' ? pick(['member', 'admin']) : t === 'group' ? pick(groups) : pick(people).id, access: pick(ACCESS) })
      }
    }
    // more groups on one way up than a bit mask holds
    if (nGroups > 30 && rand() < 0.7) for (const g of groups) rows.push({ path: pick(['', 'a', 'a/b']), subject_type: 'group', subject_id: g, access: pick(ACCESS) })
    const rules = new RuleSet(rows)
    const name = (t: string, id: string) => (t === 'group' ? `G ${id}` : t === 'user' ? `U ${id}` : null)
    const src: TreeSource = {
      rules, people, groupName: (id) => name('group', id), personName: (id) => name('user', id),
      children: () => [], hasFolders: () => false, marks: new Map(), personal: people.length,
    }
    const tc = treeContext(src)
    for (const f of [...folders, 'a/b/c/deep', 'e/none']) {
      const segs = f === '' ? [] : f.split('/')
      const who = tc.node(segs).who
      // the same groups as explaining each person at the folder itself (below its nearest rule folder nothing changes)
      expect(norm(who), `world ${world} ${f}`).toEqual(norm(naive(rules, people, segs, name)))
      // most access first
      for (let i = 1; i < who.length; i++) expect(RANK[who[i - 1]!.access]).toBeGreaterThanOrEqual(RANK[who[i]!.access])
      const want = { none: 0, read: 0, write: 0 }
      for (const p of people) want[rules.access(p, segs)]++
      const got = { none: 0, read: 0, write: 0 }
      for (const w of who) got[w.access] += w.count
      expect(got, `world ${world} ${f}`).toEqual(want)
      nodes++
    }
  }
  expect(nodes).toBe(300 * 12)
})
