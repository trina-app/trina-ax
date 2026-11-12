// RuleSet.access() now comes out of the same computation as RuleSet.explain() (server/src/policy/access.ts). Not one
// answer may change: the permission function before this change is copied as it was (origin/main 3b1b7068) into
// tests/lib/access-before-explain.ts, and random rule sets, people and paths are run through the old access(), the
// new access() and explain().access. The reason is checked against the old function too: the folder it names decides
// exactly as the old pick() did, and no deeper folder had a rule for the person.
// Since "Project contents only for members" (docs/DECISIONS.md) the old function is the reference with one rule added,
// written out again here (ZonedOld): at or below projects/<name> the owner and admins are judged as a member with the
// same groups, by the rules at or below projects/<name> only; the system principal keeps write.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import { makeEnv } from '../lib/env'
import { RuleSet, SYSTEM_PRINCIPAL, type Access, type AccessReason, type Principal } from '../../server/src/policy/access'
import { OldRuleSet, type OldRule } from '../lib/access-before-explain'
import { shownPath } from '../../server/src/admin/access-rows'

// ---------------- the reference: the old function and the members-only zone ----------------
/** at or below projects/<name>: `projects` compared after NFC and lower-casing; projects/ itself is outside */
const inZone = (segs: readonly string[]) => segs.length >= 2 && segs[0]!.normalize('NFC').toLowerCase() === 'projects'
/** the owner or an admin (never the system principal) inside the zone */
const staffInZone = (p: Principal, segs: readonly string[]) => !p.system && (p.role === 'owner' || p.role === 'admin') && inZone(segs)
const depth = (folder: string) => (folder === '' ? 0 : folder.split('/').length)
/**
 * The old permission function (tests/lib/access-before-explain.ts, unchanged) with the zone rule: the owner and admins
 * inside the zone are a member with the same groups (a role rule for admins or the owner never applies there, one for
 * members does), and only the rules of folders at or below projects/<name> count for them (rules on projects/ or the
 * root never reach in). Everyone else, and anyone outside the zone, is judged by the old function as it was.
 */
class ZonedOld {
  private old: OldRuleSet
  private floor: OldRuleSet
  constructor(rows: World['rows']) {
    this.old = new OldRuleSet(rows)
    this.floor = new OldRuleSet(rows.filter((r) => depth(r.path) >= 2))
  }
  /** who is judged at segs */
  subject(p: Principal, segs: readonly string[]): Principal { return staffInZone(p, segs) ? { id: p.id, name: p.name, role: 'member', groups: p.groups } : p }
  /** the owner or an admin below projects/<name> who does not read projects/<name> itself (is no member): nothing inside
   * is theirs, whatever a folder inside says (security review M2: nobody reads part of a project without showing in its
   * members); the project folder's own decision is the reason */
  gated(p: Principal, segs: readonly string[]): boolean { return staffInZone(p, segs) && segs.length > 2 && this.floor.access(this.subject(p, segs), segs.slice(0, 2)) === 'none' }
  access(p: Principal, segs: readonly string[]): Access {
    if (!staffInZone(p, segs)) return this.old.access(p, segs)
    return this.gated(p, segs) ? 'none' : this.floor.access(this.subject(p, segs), segs)
  }
  /** what the rules at or below projects/<name> alone would give them there (the answer without the membership gate) */
  ungated(p: Principal, segs: readonly string[]): Access { return this.floor.access(this.subject(p, segs), segs) }
  /** the answer of one folder's rules alone for p deciding at segs (null: none applies, or a folder above the floor) */
  at(p: Principal, segs: readonly string[], folder: string): Access | null { return staffInZone(p, segs) ? this.floor.at(this.subject(p, segs), folder) : this.old.at(p, folder) }
  /** canList() written out: read here, or read on a rule folder strictly below (outside users/), or the own folder below */
  canList(p: Principal, segs: readonly string[], folders: readonly string[]): boolean {
    if (this.access(p, segs) !== 'none') return true
    const own = ['users', p.id]
    if (own.length > segs.length && segs.every((s, i) => s === own[i])) return true
    return folders.some((f) => {
      const c = f === '' ? [] : f.split('/')
      return c[0] !== 'users' && c.length > segs.length && segs.every((s, i) => s === c[i]) && this.access(p, c) !== 'none'
    })
  }
}

// ---------------- random worlds (seeded: a failure prints its seed and repeats) ----------------
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
// names that hit every branch: users/, .system, temp names (and the temp prefix inside a name, which is not one), a
// person id used as a folder name, case and NFC/NFD variants (compared exactly, never folded), names that contain each
// other as text; and forgotten rule rows the answers must not name (Users, .SYSTEM, a temp name in capitals: the
// permission function compares them exactly, as before)
const NAMES = ['shared', 'skills', 'groups', 'projects', 'users', 'connected', PRODUCT.systemDir, `${PRODUCT.tmpPrefix}x`, `a${PRODUCT.tmpPrefix}x`, 'a', 'b', 'ab', 'a b', 'A', 'mia', 'leo',
  '재무', '재무'.normalize('NFD'), 'finance', 'Finance', 'trash', 'x.md', 'admin', 'member', 'everyone', 'Users', PRODUCT.systemDir.toUpperCase(), `${PRODUCT.tmpPrefix.toUpperCase()}y`]
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
  // most worlds have the members-only zone (below); they give 8 of their 40 paths to it
  const withZone = r() < 0.7
  for (let i = 0; i < (withZone ? 32 : 40); i++) {
    // half the paths go through a rule folder (so the deepest-folder walk and the tiers are exercised), half are random
    const base = r() < 0.5 ? [...pick(folders)] : []
    paths.push([...base, ...randPath(base.length ? 3 : 6)])
  }
  paths.push([], ['users'], ['users', 'mia'], [PRODUCT.systemDir], ['shared', `${PRODUCT.tmpPrefix}1`, 'x'])
  // the members-only zone (in most worlds): project folders under projects/ in any letter case, folders inside them with
  // rules, role rules for admins and the owner inside (they never apply there), and rules on projects/ and on the root
  // that name the owner and admins (they never reach in for them)
  if (withZone) {
    const tops = ['projects', 'Projects', 'PROJECTS']
    const zone = Array.from({ length: 1 + Math.floor(r() * 3) }, () => [pick(tops), pick(NAMES), ...randPath(2)])
    const add = (f: string[], subject_type: OldRule['subject_type'], subject_id: string | null, access: Access) => rows.push({ path: f.join('/'), subject_type, subject_id, access })
    for (const f of zone) {
      for (let i = 0, n = Math.floor(r() * 4); i < n; i++) {
        const t = pick(['everyone', 'role', 'group', 'user'] as const)
        add(f, t, t === 'everyone' ? null : t === 'role' ? pick(ROLES) : t === 'group' ? pick(GROUPS) : pick(USERS), pick(ACCESS))
      }
      if (r() < 0.5) add(f, 'role', pick(['admin', 'owner']), pick(['read', 'write'] as const))
      if (r() < 0.3) add(f.slice(0, 2), 'everyone', null, pick(ACCESS)) // the project folder itself
    }
    for (const above of [[pick(tops)], []]) {
      if (r() < 0.6) add(above, 'user', pick(USERS), pick(['read', 'write'] as const))
      if (r() < 0.4) add(above, 'role', pick(['admin', 'owner', 'member']), pick(['read', 'write'] as const))
      if (r() < 0.4) { const t = pick(['everyone', 'group'] as const); add(above, t, t === 'group' ? pick(GROUPS) : null, 'read') }
    }
    for (let i = 0; i < 6; i++) {
      const f = pick(zone)
      paths.push(r() < 0.3 ? f.slice(0, 2) : [...f.slice(0, 2 + Math.floor(r() * (f.length - 1))), ...randPath(2)])
    }
    paths.push([pick(tops)], [pick(tops), pick(NAMES)])
    // the owner or an admin among the people, with groups the rules there name
    people.push({ id: pick(USERS), name: pick(PERSON_NAMES), role: pick(['owner', 'admin'] as const), groups: GROUPS.filter(() => r() < 0.5) })
  }
  // the server's own principal (admin/folders.ts): write everywhere outside users/ and .system/, the zone included
  if (r() < 0.3) people.push({ ...SYSTEM_PRINCIPAL, groups: [] })
  return { rows, people, paths }
}

describe('access() and explain() answer exactly as the permission function did before', () => {
  const SEEDS = 3000
  test(`${SEEDS} random worlds: old access() (with the members-only zone) = new access() = explain().access, the reason is the old decision, listing() = navigator() = canList()`, () => {
    let checked = 0, listed = 0
    const kinds = new Map<string, number>()
    // the reasons the owner and admins got inside the zone (never owner-admin)
    const zoneKinds = new Map<string, number>()
    // answers where a folder inside a project would have let a non-member owner or admin in, and the gate did not
    let gatedCut = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed)
      const old = new ZonedOld(w.rows)
      const now = new RuleSet(w.rows)
      const ruleFolders = [...new Set(w.rows.map((r) => r.path))]
      const listings = new Map<Principal, ReturnType<RuleSet['listing']>>()
      const navs = new Map<string, ReturnType<RuleSet['navigator']>>()
      for (const p of w.people) {
        for (const segs of w.paths) {
          const want = old.access(p, segs)
          const got = now.access(p, segs)
          const e = now.explain(p, segs)
          if (got !== want || e.access !== want) throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: old ${want}, access ${got}, explain ${e.access}`)
          kinds.set(e.reason.kind, (kinds.get(e.reason.kind) ?? 0) + 1)
          const zone = staffInZone(p, segs)
          if (zone) {
            zoneKinds.set(e.reason.kind, (zoneKinds.get(e.reason.kind) ?? 0) + 1)
            if (old.gated(p, segs) && old.ungated(p, segs) !== 'none') gatedCut++
            if (e.reason.kind === 'owner-admin') throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: owner-admin inside the zone`)
            // canList() written out: rules above projects/<name> do not list anything inside it for them either
            if (now.canList(p, segs) !== old.canList(p, segs, ruleFolders)) throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)}: canList ${now.canList(p, segs)}, reference ${old.canList(p, segs, ruleFolders)}`)
          }
          if (e.reason.kind === 'rule') {
            const { folder, tier, rules } = e.reason
            const fsegs = folder === '' ? [] : folder.split('/')
            // the folder is on the way up, its rules decide as the old pick() did, and no deeper folder had a rule for p
            expect(fsegs.length <= segs.length && fsegs.every((s, i) => s === segs[i])).toBe(true)
            // inside the zone the owner's and admins' deciding folder is projects/<name> or below, never projects/ or the root;
            // below a project they are no member of it is projects/<name> itself, whatever a deeper folder says
            if (zone) expect(fsegs.length).toBeGreaterThanOrEqual(2)
            const gated = old.gated(p, segs)
            if (gated) expect(fsegs.length).toBe(2)
            expect(old.at(p, segs, folder)).toBe(want)
            if (!gated) for (let len = segs.length; len > fsegs.length; len--) expect(old.at(p, segs, segs.slice(0, len).join('/'))).toBeNull()
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
          // (the owner and admins inside the zone are listed like a member, so this holds for them too)
          if ((p.role === 'member' || zone) && segs[0] !== 'users' && segs[0] !== PRODUCT.systemDir) {
            const v = list.via(segs, 3)
            expect(v.folders.length > 0).toBe(now.hasVisibleDescendant(p, segs))
            for (const f of v.folders) expect(now.canList(p, f.split('/')) && f.startsWith(segs.length ? segs.join('/') + '/' : '')).toBe(true)
          }
          // the folder answer's navigator (one folder, many people, shared scans) answers as listing() does, at a cap
          // of 1 and 3, with and without the display filter of the answers
          for (const [max, shown] of [[3, undefined], [1, shownPath], [3, shownPath]] as const) {
            const navKey = `${max}${shown ? 's' : ''}\u0002${segs.join('\u0001')}`
            const nav = (navs.get(navKey) ?? navs.set(navKey, now.navigator(segs, max, shown)).get(navKey))!(p)
            const at = list.at(segs, max, shown)
            if (nav.listable !== can || (want === 'none' && JSON.stringify(nav) !== JSON.stringify(at)))
              throw new Error(`seed ${seed}: ${JSON.stringify(p)} ${JSON.stringify(segs)} max ${max}${shown ? ' shown' : ''}: canList ${can}, navigator ${JSON.stringify(nav)}, listing ${JSON.stringify(at)}`)
            if (shown) for (const f of nav.via) expect(f === `users/${p.id}` || shownPath(f)).toBe(true)
          }
          listed += can ? 1 : 0
          checked++
        }
      }
    }
    // every branch was reached
    for (const k of ['system', 'temp', 'own-personal', 'other-personal', 'users-root', 'owner-admin', 'rule', 'no-rule']) expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0)
    // and inside the zone the owner and admins were decided by a rule, by no rule, and by a temp name; never by their role
    for (const k of ['rule', 'no-rule', 'temp']) expect(zoneKinds.get(k) ?? 0, `zone ${k}`).toBeGreaterThan(0)
    expect(zoneKinds.get('owner-admin') ?? 0).toBe(0)
    expect(gatedCut).toBeGreaterThan(0)
    console.log(`access-explain equivalence: ${checked} answers compared over ${SEEDS} worlds (listing = navigator = canList too, ${listed} listable); reasons ${JSON.stringify(Object.fromEntries(kinds))}; owner/admin in the zone ${JSON.stringify(Object.fromEntries(zoneKinds))}, ${gatedCut} kept out by a project they are not in`)
    expect(checked).toBeGreaterThan(1_000_000)
  }, 120_000)

  test('navigation in fixed worlds: more readable folders than the cap, a hole in the middle, forgotten rule rows', () => {
    const row = (path: string, access: Access) => ({ path, subject_type: 'everyone' as const, subject_id: null, access })
    const worlds = [
      // five readable top folders: at a cap of 3, `more` needs the scan to find a fourth
      [row('x1', 'read'), row('x2', 'read'), row('x3', 'write'), row('x4', 'read'), row('x5', 'read'), row('y', 'none'), row('y/1', 'read'), row('y/2', 'read'), row('y/3', 'read'), row('y/4', 'read')],
      // a readable, a/b not, a/b/c readable again: a/b/c is below a readable folder (a), not topmost from the root,
      // topmost from a/b; and three levels of it
      [row('a', 'read'), row('a/b', 'none'), row('a/b/c', 'read'), row('a/b/c/d', 'none'), row('a/b/c/d/e', 'read'), row('z', 'none'), row('z/q', 'none'), row('z/q/r', 'read')],
      // forgotten rows: listable through them, as canList() says, but never named
      [row('', 'none'), row('Users/alice/x', 'read'), row('ｕｓｅｒｓ/alice/x', 'read'), row(`${PRODUCT.systemDir.toUpperCase()}/x`, 'read'), row(`k/${PRODUCT.tmpPrefix.toUpperCase()}y`, 'read'), row('k', 'none'), row('k/ok', 'read')],
    ]
    const people: Principal[] = [{ id: 'mia', name: 'Mia', role: 'member', groups: [] }, { id: 'leo', name: 'Leo', role: 'member', groups: ['g'] }]
    const paths = [[], ['x1'], ['y'], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['z'], ['z', 'q'], ['k'], ['Users'], ['Users', 'alice'], [PRODUCT.systemDir.toUpperCase()]]
    let n = 0
    for (const rows of worlds) {
      const old = new OldRuleSet(rows)
      const now = new RuleSet(rows)
      for (const p of people) {
        const list = now.listing(p)
        for (const segs of paths) {
          expect(now.access(p, segs)).toBe(old.access(p, segs))
          for (const max of [1, 2, 3, 20]) for (const shown of [undefined, shownPath]) {
            const nav = now.navigator(segs, max, shown)(p)
            expect(nav.listable, `${segs.join('/')}`).toBe(now.canList(p, segs))
            if (now.access(p, segs) === 'none') expect(nav, `${segs.join('/')} max ${max}`).toEqual(list.at(segs, max, shown))
            n++
          }
        }
      }
    }
    // what the answers show in those worlds
    const [five, hole, ghosts] = worlds.map((w) => new RuleSet(w!))
    const mia = people[0]!
    expect(five!.navigator([], 3, shownPath)(mia)).toEqual({ listable: true, via: ['users/mia', 'x1', 'x2'], more: true })
    expect(five!.navigator(['y'], 3, shownPath)(mia)).toEqual({ listable: true, via: ['y/1', 'y/2', 'y/3'], more: true })
    expect(five!.navigator(['y'], 4, shownPath)(mia)).toEqual({ listable: true, via: ['y/1', 'y/2', 'y/3', 'y/4'], more: false })
    expect(hole!.navigator(['a', 'b'], 3, shownPath)(mia)).toEqual({ listable: true, via: ['a/b/c'], more: false })
    expect(hole!.navigator(['z'], 3, shownPath)(mia)).toEqual({ listable: true, via: ['z/q/r'], more: false })
    expect(hole!.navigator([], 20, shownPath)(mia)).toEqual({ listable: true, via: ['a', 'users/mia', 'z/q/r'], more: false })
    expect(ghosts!.navigator([], 20, shownPath)(mia)).toEqual({ listable: true, via: ['k/ok', 'users/mia'], more: false })
    expect(ghosts!.navigator([], 20)(mia).via).toContain('Users/alice/x')
    expect(ghosts!.navigator(['k'], 20, shownPath)(mia)).toEqual({ listable: true, via: ['k/ok'], more: false })
    expect(n).toBeGreaterThan(500)
  })

  test('the test team (tests/lib/fixtures.ts): every path on disk and every rule folder, for every person', () => {
    const env = makeEnv('unit-access-explain')
    try {
      const rows = env.db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as World['rows']
      const old = new ZonedOld(rows)
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
      let n = 0, zone = 0
      for (const p of people) for (const segs of paths) {
        const want = old.access(p, segs)
        expect(now.access(p, segs), `${p.id} ${segs.join('/')}`).toBe(want)
        expect(now.explain(p, segs).access, `${p.id} ${segs.join('/')}`).toBe(want)
        if (staffInZone(p, segs)) { zone++; expect(now.explain(p, segs).reason.kind, `${p.id} ${segs.join('/')}`).not.toBe('owner-admin') }
        n++
      }
      expect(n).toBeGreaterThan(200)
      // the fixture's projects (falcon, atlas) were compared for its owner and admin too
      expect(zone).toBeGreaterThan(10)
      const dana = people.find((p) => p.role === 'owner')!
      expect(now.access(dana, ['projects', 'falcon', 'plan.md'])).toBe('none')
      // falcon/public is everyone:read, but dana is no member of falcon: nothing inside it is hers (erin, a member of the
      // team who is not in falcon either, still reads it)
      expect(now.access(dana, ['projects', 'falcon', 'public', 'announcement.md'])).toBe('none')
      expect(now.access(env.files.principal('erin'), ['projects', 'falcon', 'public', 'announcement.md'])).toBe('read')
      expect(now.access(dana, ['projects'])).toBe('write')
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
    // inside projects/<name> an admin is a member with the same groups: no group here, so everyone:none decides
    expect(rules.explain(adam, ['projects', 'x'])).toEqual({ access: 'none', reason: { kind: 'rule', folder: 'projects/x', tier: 'everyone', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] } })
    expect(rules.explain({ ...adam, groups: ['ops'] }, ['projects', 'x', 'a.md'])).toEqual({ access: 'write', reason: { kind: 'rule', folder: 'projects/x', tier: 'group', rules: [{ subjectType: 'group', subjectId: 'ops', access: 'write' }] } })
    expect(rules.explain(adam, ['projects'])).toEqual({ access: 'write', reason: { kind: 'owner-admin' } })
    expect(rules.explain(adam, ['projects', 'y'])).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    expect(rules.explain(SYSTEM_PRINCIPAL, ['projects', 'x'])).toEqual({ access: 'write', reason: { kind: 'owner-admin' } })
    expect(rules.explain(adam, ['users', 'leo'])).toEqual({ access: 'none', reason: { kind: 'other-personal' } })
    expect(rules.explain(leo, ['users', 'leo', 'a'])).toEqual({ access: 'write', reason: { kind: 'own-personal' } })
    expect(rules.explain(leo, ['users'])).toEqual({ access: 'read', reason: { kind: 'users-root' } })
    expect(rules.explain(adam, [PRODUCT.systemDir, 'trash'])).toEqual({ access: 'none', reason: { kind: 'system' } })
    expect(rules.explain(adam, ['shared', `${PRODUCT.tmpPrefix}1`])).toEqual({ access: 'none', reason: { kind: 'temp' } })
  })

  test('the members-only zone in a fixed world: rules above never reach in for the owner and admins, role rules for them never apply inside, nothing inside a project they are not in is theirs, members keep theirs', () => {
    const row = (path: string, subject_type: OldRule['subject_type'], subject_id: string | null, access: Access) => ({ path, subject_type, subject_id, access })
    const rows = [
      // an admin's own rules up there (security review M1), and everyone on projects/
      row('', 'user', 'adam', 'write'), row('projects', 'user', 'adam', 'read'), row('projects', 'role', 'admin', 'write'), row('projects', 'everyone', null, 'read'),
      // apollo: a group, role rules for admins and the owner (never apply to them there), members shut out (applies to
      // them too: they are judged as one); inside it a folder for everyone and one for members
      row('projects/apollo', 'group', 'ops', 'write'), row('projects/apollo', 'role', 'admin', 'write'), row('projects/apollo', 'role', 'owner', 'write'), row('projects/apollo', 'role', 'member', 'none'),
      row('projects/apollo/pub', 'everyone', null, 'read'), row('projects/apollo/memo', 'role', 'member', 'read'),
      // zeus: no rules of its own (an older build made it)
    ]
    const rules = new RuleSet(rows)
    const old = new ZonedOld(rows)
    const adam: Principal = { id: 'adam', name: 'Adam', role: 'admin', groups: [] }
    const olga: Principal = { id: 'olga', name: 'Olga', role: 'owner', groups: ['ops'] }
    const mia: Principal = { id: 'mia', name: 'Mia', role: 'member', groups: [] }
    const shut: AccessReason = { kind: 'rule', folder: 'projects/apollo', tier: 'role', rules: [{ subjectType: 'role', subjectId: 'member', access: 'none' }] }
    // outside the zone, as before: the admin writes projects/ and everything else
    expect(rules.explain(adam, ['projects'])).toEqual({ access: 'write', reason: { kind: 'owner-admin' } })
    expect(rules.explain(adam, ['shared', 'a.md'])).toEqual({ access: 'write', reason: { kind: 'owner-admin' } })
    // inside: none of the rules up there, nor `role: admin`, opens apollo or zeus to adam; he is judged as a member
    expect(rules.explain(adam, ['projects', 'apollo'])).toEqual({ access: 'none', reason: shut })
    expect(rules.explain(adam, ['projects', 'apollo', 'plan.md'])).toEqual({ access: 'none', reason: shut })
    for (const top of ['projects', 'Projects', 'PROJECTS']) expect(rules.explain(adam, [top, 'zeus', 'plan.md']), top).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    for (const top of ['Projects', 'PROJECTS']) expect(rules.explain(adam, [top, 'apollo', 'plan.md']), top).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    // …and what is open inside apollo to everyone or to members is not his while he is no member of apollo: the reason is
    // apollo's own (security review M2: nobody reads part of a project without showing in its members)
    expect(rules.explain(adam, ['projects', 'apollo', 'pub', 'x.md'])).toEqual({ access: 'none', reason: shut })
    expect(rules.explain(adam, ['projects', 'apollo', 'memo'])).toEqual({ access: 'none', reason: shut })
    // the owner in the project's group is a member: the group rule (not `role: owner`), and below it the folders inside
    // decide for her as for any member
    expect(rules.explain(olga, ['projects', 'apollo', 'plan.md'])).toEqual({ access: 'write', reason: { kind: 'rule', folder: 'projects/apollo', tier: 'group', rules: [{ subjectType: 'group', subjectId: 'ops', access: 'write' }] } })
    expect(rules.explain(olga, ['projects', 'apollo', 'pub', 'x.md'])).toEqual({ access: 'read', reason: { kind: 'rule', folder: 'projects/apollo/pub', tier: 'everyone', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] } })
    expect(rules.explain(olga, ['projects', 'apollo', 'memo'])).toEqual({ access: 'read', reason: { kind: 'rule', folder: 'projects/apollo/memo', tier: 'role', rules: [{ subjectType: 'role', subjectId: 'member', access: 'read' }] } })
    expect(rules.explain(olga, ['projects', 'zeus'])).toEqual({ access: 'none', reason: { kind: 'no-rule' } })
    // a member of the team keeps the rules above (projects/ everyone:read reaches zeus for her) and the parts of apollo
    // open to her, though apollo itself is shut for members
    expect(rules.explain(mia, ['projects', 'zeus', 'plan.md'])).toEqual({ access: 'read', reason: { kind: 'rule', folder: 'projects', tier: 'everyone', rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }] } })
    expect(rules.access(mia, ['projects', 'apollo', 'plan.md'])).toBe('none')
    expect(rules.access(mia, ['projects', 'apollo', 'pub', 'x.md'])).toBe('read')
    expect(rules.access(mia, ['projects', 'apollo', 'memo'])).toBe('read')
    // the system principal writes everywhere in the zone, never under users/ or .system/
    expect(rules.access(SYSTEM_PRINCIPAL, ['projects', 'zeus', 'plan.md'])).toBe('write')
    expect(rules.access(SYSTEM_PRINCIPAL, ['projects', 'apollo', 'pub', 'x.md'])).toBe('write')
    expect(rules.access(SYSTEM_PRINCIPAL, ['users', 'mia'])).toBe('none')
    expect(rules.access(SYSTEM_PRINCIPAL, [PRODUCT.systemDir, 'trash'])).toBe('none')
    // listing: adam cannot pass through apollo to pub or memo, nor list zeus; mia lists apollo through them (never named
    // in the admin answers: shownPath, nothing inside a project); olga reads apollo
    expect(rules.canList(adam, ['projects', 'apollo'])).toBe(false)
    expect(rules.hasVisibleDescendant(adam, ['projects', 'apollo'])).toBe(false)
    expect(rules.canList(adam, ['projects', 'zeus'])).toBe(false)
    expect(rules.listing(adam).listable(['projects', 'apollo'])).toBe(false)
    expect(rules.listing(adam).via(['projects', 'apollo'], 3)).toEqual({ folders: [], more: false })
    expect(rules.navigator(['projects', 'apollo'], 3)(adam)).toEqual({ listable: false, via: [], more: false })
    expect(rules.navigator(['projects', 'apollo', 'pub'], 3)(adam)).toEqual({ listable: false, via: [], more: false })
    expect(rules.navigator(['projects', 'apollo'], 3)(mia)).toEqual({ listable: true, via: ['projects/apollo/memo', 'projects/apollo/pub'], more: false })
    expect(rules.navigator(['projects', 'apollo'], 3, shownPath)(mia)).toEqual({ listable: true, via: [], more: false })
    expect(rules.navigator(['projects', 'apollo'], 3)(olga)).toEqual({ listable: true, via: [], more: false })
    expect(rules.navigator(['projects', 'zeus'], 3)(adam)).toEqual({ listable: false, via: [], more: false })
    expect(rules.navigator(['projects', 'zeus'], 3)(mia)).toEqual({ listable: true, via: [], more: false })
    expect(rules.navigator(['projects'], 3)(adam)).toEqual({ listable: true, via: [], more: false })
    // and the reference agrees on every path here, for each of them
    const paths = [['projects'], ['projects', 'apollo'], ['projects', 'apollo', 'pub'], ['projects', 'apollo', 'memo', 'x'], ['projects', 'zeus'], ['Projects', 'zeus', 'y'], ['Projects', 'apollo', 'pub'], ['shared']]
    for (const p of [adam, olga, mia, SYSTEM_PRINCIPAL]) for (const segs of paths) {
      expect(rules.access(p, segs), `${p.id} ${segs.join('/')}`).toBe(old.access(p, segs))
      if (staffInZone(p, segs)) expect(rules.canList(p, segs), `${p.id} ${segs.join('/')}`).toBe(old.canList(p, segs, rows.map((r) => r.path)))
    }
  })
})
