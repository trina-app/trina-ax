// An older build must never read a converted database (owner decision M6-A: reader level 7; docs/DECISIONS.md "Folder
// access adds up like Google Drive (P2)"). And if one ever did, the legacy marker makes its deepest-wins answer at most
// the new one, for every principal and path (the only exception: a project exception with a deeper rule, 7.5-2, where
// it gives exactly today's answer).
import { expect, test } from 'bun:test'
import { SchemaTooNewError, migrate, openDb } from '../../server/src/db'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { LegacyRuleSet, type LegacyRow } from '../../server/src/policy/legacy-deepest'
import { legacyDb } from '../lib/legacy-db'

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }

test('M6-A: a build of reader level 6 refuses the converted database', () => {
  const db = openDb(':memory:')
  expect(() => migrate(db, { readerLevel: 6 })).toThrow(SchemaTooNewError)
})

let seed = 777
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!

test('random converted worlds: the old reader on the converted rows gives at most the new answer', () => {
  for (let world = 0; world < 60; world++) {
    const w = legacyDb()
    const groups = ['g0', 'g1']
    for (const g of groups) w.group(g)
    const people: Principal[] = []
    for (let i = 0; i < 6; i++) { const gs = groups.filter(() => rand() < 0.5); const role = i === 0 ? 'admin' : 'member'; w.user(`p${i}`, role, { groups: gs }); people.push({ id: `p${i}`, name: '', role, groups: gs }) }
    for (const f of ['', 'a', 'a/b', 'a/b/c', 'projects/x', 'projects/x/y']) {
      if (rand() < 0.4) continue
      const seen = new Set<string>()
      for (let k = 0; k < 3; k++) {
        const t = pick(['everyone', 'group', 'user'] as const)
        const s = t === 'everyone' ? null : t === 'group' ? pick(groups) : pick(people).id
        if (seen.has(`${t}${s}`)) continue
        seen.add(`${t}${s}`)
        w.rule(f, t, s, pick(['none', 'read', 'write'] as const))
      }
    }
    w.convert()
    const now = RuleSet.load(w.db)
    const old = new LegacyRuleSet(w.db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as LegacyRow[])
    const exc = new Set((w.db.query("SELECT r.subject_id FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.access = 'none' AND r.subject_type = 'user'").all() as { subject_id: string }[]).map((r) => r.subject_id))
    for (const x of ['', 'a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/e', 'projects/x', 'projects/x/y', 'projects/x/y/z']) {
      const s = x === '' ? [] : x.split('/')
      for (const gs of [[], ['g0'], ['g1'], ['g0', 'g1']]) for (const p of [...people.map((q) => ({ ...q, groups: gs })), { id: 'fresh', name: '', role: 'member' as const, groups: gs }]) {
        if (exc.has(p.id) && x.startsWith('projects/x/')) continue
        expect(RANK[old.access(p, s)], `world ${world} ${p.id} ${gs} ${x}`).toBeLessThanOrEqual(RANK[now.access(p, s)])
      }
    }
  }
}, 120_000)
