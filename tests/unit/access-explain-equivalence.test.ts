// RuleSet.access() now comes out of the same computation as RuleSet.explain() (server/src/policy/access.ts). Not one
// answer may change: the permission function before this change is copied as it was (origin/main 3b1b7068) into
// tests/lib/access-before-explain.ts, and random rule sets, people and paths are run through the old access(), the
// new access() and explain().access. The reason is checked against the old function too: the folder it names decides
// exactly as the old pick() did, and no deeper folder had a rule for the person.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { makeEnv } from '../lib/env'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { OldRuleSet, type OldRule } from '../lib/access-before-explain'

// ---------------- random worlds (seeded: a failure prints its seed and repeats) ----------------
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
// names that hit every branch: users/, .system, temp names (and the temp prefix inside a name, which is not one), a
// person id used as a folder name, case and NFC/NFD variants (compared exactly, never folded), names that contain each
// other as text
const NAMES = ['shared', 'skills', 'groups', 'projects', 'users', 'connected', PRODUCT.systemDir, `${PRODUCT.tmpPrefix}x`, `a${PRODUCT.tmpPrefix}x`, 'a', 'b', 'ab', 'a b', 'A', 'mia', 'leo',
  '재무', '재무'.normalize('NFD'), 'finance', 'Finance', 'trash', 'x.md', 'admin', 'member', 'everyone']
const USERS = ['mia', 'leo', 'ola', 'olga', 'adam', 'users', 'a']
// display names: never compared by the function, so some are other people's ids, roles or group names
const PERSON_NAMES = ['x', 'Mia Kim', 'leo', 'admin', 'sales', 'users', '']
const GROUPS = ['sales', 'ops', 'finance', 'g-4', 'a']
const ROLES = ['owner', 'admin', 'member'] as const
const ACCESS: Access[] = ['none', 'read', 'write']

interface World { rows: { path: string; subject_type: OldRule['subject_type']; subject_id: string | null; access: Access }[]; people: Principal[]; paths: string[][] }
function world(seed: number): World {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const randPath = (max: number) => Array.from({ length: Math.floor(r() * (max + 1)) }, () => pick(NAMES))
  const folders = Array.from({ length: 1 + Math.floor(r() * 14) }, () => randPath(4))
  if (r() < 0.4) folders.push([]) // a rule on the team root
  const rows: World['rows'] = []
  for (const f of folders) {
    const n = 1 + Math.floor(r() * 5)
    for (let i = 0; i < n; i++) {
      const t = pick(['everyone', 'role', 'group', 'user'] as const)
      // duplicates of one subject in one folder too (the database refuses them; the function must not care)
      const id = t === 'everyone' ? (r() < 0.1 ? 'stray' : null) : t === 'role' ? pick(ROLES) : t === 'group' ? (r() < 0.05 ? null : pick(GROUPS)) : pick(USERS)
      rows.push({ path: f.join('/'), subject_type: t, subject_id: id, access: pick(ACCESS) })
    }
  }
  const people: Principal[] = Array.from({ length: 4 + Math.floor(r() * 10) }, () => ({
    id: pick(USERS), name: pick(PERSON_NAMES), role: r() < 0.7 ? 'member' : pick(ROLES), groups: GROUPS.filter(() => r() < 0.35),
  }))
  const paths: string[][] = []
  for (let i = 0; i < 40; i++) {
    // half the paths go through a rule folder (so the deepest-folder walk and the tiers are exercised), half are random
    const base = r() < 0.5 ? [...pick(folders)] : []
    paths.push([...base, ...randPath(base.length ? 3 : 6)])
  }
  paths.push([], ['users'], ['users', 'mia'], [PRODUCT.systemDir], ['shared', `${PRODUCT.tmpPrefix}1`, 'x'])
  return { rows, people, paths }
}

describe('access() and explain() answer exactly as the permission function did before', () => {
  const SEEDS = 3000
  test(`${SEEDS} random worlds: old access() = new access() = explain().access, the reason is the old decision, listing() = navigator() = canList()`, () => {
    let checked = 0, listed = 0
    const kinds = new Map<string, number>()
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed)
      const old = new OldRuleSet(w.rows)
      const now = new RuleSet(w.rows)
      const listings = new Map<Principal, ReturnType<RuleSet['listing']>>()
      const navs = new Map<string, ReturnType<RuleSet['navigator']>>()
      for (const p of w.people) {
        for (const segs of w.paths) {
          const want = old.access(p, segs)
          const got = now.access(p, segs)
          const e = now.explain(p, segs)
          if (got !== want || e.access !== want) throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: old ${want}, access ${got}, explain ${e.access}`)
          kinds.set(e.reason.kind, (kinds.get(e.reason.kind) ?? 0) + 1)
          if (e.reason.kind === 'rule') {
            const { folder, tier, rules } = e.reason
            const fsegs = folder === '' ? [] : folder.split('/')
            // the folder is on the way up, its rules decide as the old pick() did, and no deeper folder had a rule for p
            expect(fsegs.length <= segs.length && fsegs.every((s, i) => s === segs[i])).toBe(true)
            expect(old.at(p, folder)).toBe(want)
            for (let len = segs.length; len > fsegs.length; len--) expect(old.at(p, segs.slice(0, len).join('/'))).toBeNull()
            // the rules shown are the person's rules of the deciding step; the widest of them is the answer
            expect(rules.length).toBeGreaterThan(0)
            expect(rules.every((x) => x.subjectType === tier)).toBe(true)
            expect(rules[0]!.access).toBe(want)
          } else if (e.reason.kind === 'no-rule') {
            expect(want).toBe('none')
          }
          // "shown in the tree": listing() (once per person, the admin answers) is canList(), from the root and from
          // any folder on the way; via is not empty exactly when something below is readable for a member
          const list = (listings.get(p) ?? listings.set(p, now.listing(p)).get(p))!
          const can = now.canList(p, segs)
          const k = Math.floor((seed * 7 + checked) % (segs.length + 1))
          if (list.listable(segs) !== can || now.listing(p, segs.slice(0, k)).listable(segs) !== can)
            throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: canList ${can}, listing ${list.listable(segs)}, within ${k} ${now.listing(p, segs.slice(0, k)).listable(segs)}`)
          if (p.role === 'member' && segs[0] !== 'users' && segs[0] !== PRODUCT.systemDir) {
            const v = list.via(segs, 3)
            expect(v.folders.length > 0).toBe(now.hasVisibleDescendant(p, segs))
            for (const f of v.folders) expect(now.canList(p, f.split('/')) && f.startsWith(segs.length ? segs.join('/') + '/' : '')).toBe(true)
          }
          // the folder answer's navigator (one folder, many people, shared scans) answers as listing() does
          const navKey = segs.join('\u0001')
          const nav = (navs.get(navKey) ?? navs.set(navKey, now.navigator(segs, 3)).get(navKey))!(p)
          const at = list.at(segs, 3)
          if (nav.listable !== can || (want === 'none' && JSON.stringify(nav) !== JSON.stringify(at)))
            throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: canList ${can}, navigator ${JSON.stringify(nav)}, listing ${JSON.stringify(at)}`)
          listed += can ? 1 : 0
          checked++
        }
      }
    }
    // every branch was reached
    for (const k of ['system', 'temp', 'own-personal', 'other-personal', 'users-root', 'owner-admin', 'rule', 'no-rule']) expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0)
    console.log(`access-explain equivalence: ${checked} answers compared over ${SEEDS} worlds (listing = navigator = canList too, ${listed} listable); reasons ${JSON.stringify(Object.fromEntries(kinds))}`)
    expect(checked).toBeGreaterThan(1_000_000)
  }, 120_000)

  test('the test team (tests/lib/fixtures.ts): every path on disk and every rule folder, for every person', () => {
    const env = makeEnv('unit-access-explain')
    try {
      const rows = env.db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as World['rows']
      const old = new OldRuleSet(rows)
      const now = RuleSet.load(env.db)
      const paths: string[][] = [[]]
      const walkTree = (dir: string, segs: string[]) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const s = [...segs, e.name]
          paths.push(s, [...s, 'not-there.md'])
          if (e.isDirectory()) walkTree(path.join(dir, e.name), s)
        }
      }
      walkTree(env.fx.team, [])
      for (const f of now.ruleFolders()) paths.push(f === '' ? [] : f.split('/'))
      const people = (env.db.query('SELECT id FROM users').all() as { id: string }[]).map((u) => env.files.principal(u.id))
      let n = 0
      for (const p of people) for (const segs of paths) {
        const want = old.access(p, segs)
        expect(now.access(p, segs), `${p.id} ${segs.join('/')}`).toBe(want)
        expect(now.explain(p, segs).access, `${p.id} ${segs.join('/')}`).toBe(want)
        n++
      }
      expect(n).toBeGreaterThan(200)
    } finally { env.db.close() }
  })

  test('reasons of a fixed table', () => {
    const rules = new RuleSet([
      { path: 'shared', subject_type: 'everyone', subject_id: null, access: 'write' },
      { path: 'projects/x', subject_type: 'group', subject_id: 'sales', access: 'read' },
      { path: 'projects/x', subject_type: 'group', subject_id: 'ops', access: 'write' },
      { path: 'projects/x', subject_type: 'everyone', subject_id: null, access: 'none' },
      { path: 'projects/x/drafts', subject_type: 'user', subject_id: 'leo', access: 'write' },
    ])
    const mia: Principal = { id: 'mia', name: 'Mia', role: 'member', groups: ['sales', 'ops'] }
    const leo: Principal = { id: 'leo', name: 'Leo', role: 'member', groups: [] }
    const adam: Principal = { id: 'adam', name: 'Adam', role: 'admin', groups: [] }
    expect(rules.explain(mia, ['projects', 'x', 'drafts', 'a.md'])).toEqual({ access: 'write', reason: { kind: 'rule', folder: 'projects/x', tier: 'group', rules: [
      { subjectType: 'group', subjectId: 'ops', access: 'write' }, { subjectType: 'group', subjectId: 'sales', access: 'read' }] } })
    expect(rules.explain(leo, ['projects', 'x', 'drafts'])).toEqual({ access: 'write', reason: { kind: 'rule', folder: 'projects/x/drafts', tier: 'user', rules: [{ subjectType: 'user', subjectId: 'leo', access: 'write' }] } })
    expect(rules.explain(leo, ['projects', 'x'])).toEqual({ access: 'none', reason: { kind: 'rule', folder: 'projects/x', tier: 'everyone', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] } })
    expect(rules.explain(leo, ['projects'])).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    expect(rules.explain(adam, ['projects', 'x'])).toEqual({ access: 'write', reason: { kind: 'owner-admin' } })
    expect(rules.explain(adam, ['users', 'leo'])).toEqual({ access: 'none', reason: { kind: 'other-personal' } })
    expect(rules.explain(leo, ['users', 'leo', 'a'])).toEqual({ access: 'write', reason: { kind: 'own-personal' } })
    expect(rules.explain(leo, ['users'])).toEqual({ access: 'read', reason: { kind: 'users-root' } })
    expect(rules.explain(adam, [PRODUCT.systemDir, 'trash'])).toEqual({ access: 'none', reason: { kind: 'system' } })
    expect(rules.explain(adam, ['shared', `${PRODUCT.tmpPrefix}1`])).toEqual({ access: 'none', reason: { kind: 'temp' } })
  })
})
