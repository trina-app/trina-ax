// The one-time conversion to additive folder access (server/src/policy/convert-additive.ts; docs/DECISIONS.md "Folder
// access adds up like Google Drive (P2)"). Nobody gets more than before (policy/legacy-deepest.ts), on fixed worlds that
// name each case of the spec and on random worlds; existing people get exactly what they had, except the listed
// fail-closed cases; people the conversion names keep that access after a group change (C1-A, the owner's accepted
// exception), and the group screens can name them.
import { describe, expect, test } from 'bun:test'
import { legacyDb, type LegacyDb } from '../lib/legacy-db'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { LegacyRuleSet } from '../../server/src/policy/legacy-deepest'
import { folderAccessProblems } from '../../server/src/policy/invariants'
import { originKeepers } from '../../server/src/admin/folders'

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const segs = (p: string) => (p === '' ? [] : p.split('/'))
const P = (id: string, groups: string[] = [], role: Principal['role'] = 'member'): Principal => ({ id, name: id, role, groups })
const rowsOf = (w: LegacyDb, p: string) => w.db.query('SELECT r.subject_type AS t, r.subject_id AS s, r.access AS a, r.origin AS o FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? ORDER BY r.subject_type, r.subject_id').all(p) as { t: string; s: string | null; a: string; o: string | null }[]
const limitedAt = (w: LegacyDb, p: string) => (w.db.query('SELECT limited FROM folders WHERE path = ?').get(p) as { limited: number } | null)?.limited === 1
const report = (w: LegacyDb) => JSON.parse((w.db.query("SELECT detail FROM audit_log WHERE action = 'folders.additive_conversion'").get() as { detail: string }).detail)

/** Convert, then: invariants hold; every existing person gets at most what they had at every path asked. */
function convertAndCheck(w: LegacyDb, people: Principal[], paths: string[]): { before: LegacyRuleSet; after: RuleSet } {
  const before = w.legacy()
  w.convert()
  expect(folderAccessProblems(w.db)).toEqual([])
  const after = RuleSet.load(w.db)
  for (const p of people) for (const x of paths) expect(RANK[after.access(p, segs(x))], `${p.id} ${JSON.stringify(p.groups)} ${x}`).toBeLessThanOrEqual(RANK[before.access(p, segs(x))])
  return { before, after }
}

describe('fixed worlds', () => {
  test('a person and a group kept out under "everyone can edit": limited, everyone else named (C1-A origin)', () => {
    const w = legacyDb()
    w.group('contractors')
    w.user('ann'); w.user('bo', 'member', { groups: ['contractors'] }); w.user('cy'); w.user('adm', 'admin')
    w.rule('shared', 'everyone', null, 'write')
    w.rule('shared/HR', 'group', 'contractors', 'none')
    w.rule('shared/HR', 'user', 'cy', 'none')
    const people = [P('ann'), P('bo', ['contractors']), P('cy'), P('adm', [], 'admin')]
    const { before, after } = convertAndCheck(w, people, ['shared', 'shared/HR', 'shared/HR/x'])
    expect(limitedAt(w, 'shared/HR')).toBe(true)
    for (const p of people) expect(after.access(p, ['shared', 'HR'])).toBe(before.access(p, ['shared', 'HR']))
    // ann is named, with where it came from; nobody else
    const rows = rowsOf(w, 'shared/HR')
    expect(rows.filter((r) => r.t === 'user').map((r) => [r.s, r.a])).toEqual([['ann', 'write']])
    expect(JSON.parse(rows.find((r) => r.s === 'ann')!.o!)).toEqual({ v: 1, by: 'conversion', groups: [{ id: 'contractors', member: false }], base: null })
    // a new member gets nothing there (fail closed: the "new hire" case 7.5-3)
    expect(after.access(P('new'), ['shared', 'HR'])).toBe('none')
    expect(before.access(P('new'), ['shared', 'HR'])).toBe('write')
  })

  test('review 2 counterexample 1: Kim moves from Design to Sales and keeps edit by name (C1-A), and is named for the warning', () => {
    const w = legacyDb()
    w.group('design'); w.group('sales')
    w.user('kim', 'member', { groups: ['design'] }); w.user('x', 'member', { groups: ['design'] })
    w.rule('shared', 'everyone', null, 'read')
    w.rule('shared/Design', 'group', 'design', 'write')
    w.rule('shared/Design', 'user', 'x', 'read')
    const { after } = convertAndCheck(w, [P('kim', ['design']), P('x', ['design'])], ['shared/Design'])
    expect(limitedAt(w, 'shared/Design')).toBe(true)
    expect(after.access(P('kim', ['design']), ['shared', 'Design'])).toBe('write')
    expect(after.access(P('x', ['design']), ['shared', 'Design'])).toBe('read')
    // Kim leaves Design: today's model gives read, the conversion's name keeps write (C1-A), and it is said
    expect(after.access(P('kim', ['sales']), ['shared', 'Design'])).toBe('write')
    expect(new LegacyRuleSet([{ path: 'shared', subject_type: 'everyone', subject_id: null, access: 'read' }, { path: 'shared/Design', subject_type: 'group', subject_id: 'design', access: 'write' }, { path: 'shared/Design', subject_type: 'user', subject_id: 'x', access: 'read' }]).access(P('kim', ['sales']), ['shared', 'Design'])).toBe('read')
    expect(originKeepers(w.db, [{ userId: 'kim', groupId: 'design' }]).map((k) => [k.userId, k.path, k.access])).toEqual([['kim', 'shared/Design', 'write']])
    expect(originKeepers(w.db, [{ userId: 'kim', groupId: 'sales' }])).toEqual([])
    // a new member of Design: what the structure gives (everyone: read), not more
    expect(after.access(P('new', ['design']), ['shared', 'Design'])).toBe('read')
  })

  test('review 2 counterexample 2: an existing employee joins Contractors and keeps edit by name (C1-A), named for the warning', () => {
    const w = legacyDb()
    w.group('contractors')
    w.user('emp')
    w.rule('shared', 'everyone', null, 'write')
    w.rule('shared/HR', 'group', 'contractors', 'none')
    const { after } = convertAndCheck(w, [P('emp')], ['shared/HR'])
    expect(after.access(P('emp', ['contractors']), ['shared', 'HR'])).toBe('write')
    expect(originKeepers(w.db, [{ userId: 'emp', groupId: 'contractors' }]).map((k) => k.path)).toEqual(['shared/HR'])
    // a new contractor: none, as today
    expect(after.access(P('new', ['contractors']), ['shared', 'HR'])).toBe('none')
  })

  test('the Reports case (item 12-A): "everyone can view" under "everyone can edit" becomes limited + everyone view, nobody named', () => {
    const w = legacyDb()
    w.user('m1'); w.user('m2')
    w.rule('shared', 'everyone', null, 'write')
    w.rule('shared/Reports', 'everyone', null, 'read')
    const { after } = convertAndCheck(w, [P('m1'), P('m2')], ['shared', 'shared/Reports'])
    expect(limitedAt(w, 'shared/Reports')).toBe(true)
    expect(rowsOf(w, 'shared/Reports').map((r) => [r.t, r.a])).toEqual([['everyone', 'read']])
    expect(after.access(P('new'), ['shared', 'Reports'])).toBe('read')
    expect(report(w).byName).toEqual([])
  })

  test('a downgrade group under everyone write; person < group in one folder; group < everyone in one folder', () => {
    const w = legacyDb()
    w.group('g'); w.group('h')
    w.user('a', 'member', { groups: ['g'] }); w.user('b', 'member', { groups: ['g', 'h'] }); w.user('c', 'member', { groups: ['h'] }); w.user('d')
    w.rule('shared', 'everyone', null, 'write')
    w.rule('shared/down', 'group', 'g', 'read')
    w.rule('shared/pg', 'group', 'h', 'write'); w.rule('shared/pg', 'user', 'b', 'read')
    w.rule('top', 'everyone', null, 'write'); w.rule('top', 'group', 'h', 'read')
    const people = [P('a', ['g']), P('b', ['g', 'h']), P('c', ['h']), P('d')]
    const paths = ['shared', 'shared/down', 'shared/pg', 'top', 'top/x']
    const { before, after } = convertAndCheck(w, people, paths)
    for (const p of people) for (const x of paths) expect(after.access(p, segs(x)), `${p.id} ${x}`).toBe(before.access(p, segs(x)))
  })

  test('role member vs everyone, both orders; role admin and owner rows become one managed marker', () => {
    const w = legacyDb()
    w.user('m')
    w.rule('a', 'role', 'member', 'read'); w.rule('a', 'everyone', null, 'write')
    w.rule('b', 'role', 'member', 'write'); w.rule('b', 'everyone', null, 'read')
    w.rule('c', 'role', 'admin', 'read'); w.rule('c', 'role', 'owner', 'write'); w.rule('c', 'everyone', null, 'read')
    const { before, after } = convertAndCheck(w, [P('m')], ['a', 'b', 'c'])
    for (const x of ['a', 'b', 'c']) expect(after.access(P('m'), [x])).toBe(before.access(P('m'), [x]))
    expect(rowsOf(w, 'b').map((r) => [r.t, r.s, r.a])).toEqual([['everyone', null, 'write']])
    expect(rowsOf(w, 'c').filter((r) => r.t === 'role').map((r) => [r.s, r.a])).toEqual([['admin', 'write']])
  })

  test('a folder whose only rules go keeps the managed marker (M2): members still cannot move it', () => {
    const w = legacyDb()
    w.user('m')
    w.rule('shared', 'everyone', null, 'read')
    w.rule('shared/odd', 'everyone', null, 'read') // the same as above: kept
    w.rule('plain', 'role', 'admin', 'write')
    convertAndCheck(w, [P('m')], ['plain', 'shared/odd'])
    expect(rowsOf(w, 'plain').map((r) => [r.t, r.s, r.a])).toEqual([['role', 'admin', 'write']])
  })

  test('projects: always limited; only everyone: none; no everyone rule; a root rule they relied on (7.5-1, counted)', () => {
    const w = legacyDb()
    w.group('mk')
    w.user('a', 'member', { groups: ['mk'] }); w.user('b'); w.user('adm', 'admin', { groups: ['mk'] })
    w.rule('', 'user', 'b', 'read')
    w.rule('projects/one', 'everyone', null, 'none'); w.rule('projects/one', 'group', 'mk', 'write')
    w.rule('projects/two', 'group', 'mk', 'write')
    w.folder('projects/three')
    w.project('one', 'projects/one'); w.project('two', 'projects/two'); w.project('three', 'projects/three')
    const people = [P('a', ['mk']), P('b'), P('adm', ['mk'], 'admin')]
    const { before, after } = convertAndCheck(w, people, ['projects/one', 'projects/two', 'projects/three', 'projects/two/x'])
    for (const p of ['projects/one', 'projects/two', 'projects/three']) expect(limitedAt(w, p), p).toBe(true)
    // b read projects/two and three through the root rule only: not any more, and listed (7.5-1, fail closed: naming
    // them would let them in as an admin later, where the owner and admins never read rules above a project)
    expect(before.access(P('b'), ['projects', 'two'])).toBe('read')
    expect(after.access(P('b'), ['projects', 'two'])).toBe('none')
    expect(report(w).narrowed).toContainEqual({ path: 'projects/two', userId: 'b', case: '7.5-1' })
    // an admin in the group reads them as a member, as before; not by a rule above the project
    expect(after.access(P('adm', ['mk'], 'admin'), ['projects', 'two'])).toBe('write')
    expect(after.access(P('newadmin', [], 'admin'), ['projects', 'two'])).toBe('none')
  })

  test('project exceptions: via a group; plus a subfolder rule (7.5-2, narrower); on a folder no project uses (C2)', () => {
    const w = legacyDb()
    w.group('mk')
    w.user('kim', 'member', { groups: ['mk'] }); w.user('lee', 'member', { groups: ['mk'] })
    w.rule('projects/p', 'everyone', null, 'none'); w.rule('projects/p', 'group', 'mk', 'write'); w.rule('projects/p', 'user', 'kim', 'none')
    w.rule('projects/p/open', 'user', 'kim', 'read')
    w.rule('projects/orphan', 'group', 'mk', 'write'); w.rule('projects/orphan', 'user', 'lee', 'none')
    w.project('p', 'projects/p')
    const { before, after } = convertAndCheck(w, [P('kim', ['mk']), P('lee', ['mk'])], ['projects/p', 'projects/p/open', 'projects/orphan'])
    expect(after.access(P('kim', ['mk']), ['projects', 'p'])).toBe('none')
    expect(after.access(P('lee', ['mk']), ['projects', 'p'])).toBe('write')
    // 7.5-2: kim read the subfolder by a deeper rule; the exception covers the whole project now
    expect(before.access(P('kim', ['mk']), ['projects', 'p', 'open'])).toBe('read')
    expect(after.access(P('kim', ['mk']), ['projects', 'p', 'open'])).toBe('none')
    expect(report(w).narrowed).toContainEqual({ path: 'projects/p/open', userId: 'kim', case: '7.5-2' })
    // an exception row on a folder no project uses keeps holding
    expect(after.access(P('lee', ['mk']), ['projects', 'orphan'])).toBe('none')
    expect(rowsOf(w, 'projects/orphan').some((r) => r.t === 'user' && r.s === 'lee' && r.a === 'none')).toBe(true)
  })

  test('the demo payroll: groups/재무/급여 "재무: none" becomes limited with nobody named but the group', () => {
    const w = legacyDb()
    w.group('fin')
    w.user('bob', 'member', { groups: ['fin'] }); w.user('alice')
    w.rule('groups/재무', 'group', 'fin', 'write')
    w.rule('groups/재무/급여', 'group', 'fin', 'none')
    const { after } = convertAndCheck(w, [P('bob', ['fin']), P('alice')], ['groups/재무', 'groups/재무/급여'])
    expect(limitedAt(w, 'groups/재무/급여')).toBe(true)
    expect(after.access(P('bob', ['fin']), ['groups', '재무', '급여'])).toBe('none')
    expect(after.access(P('x', ['fin']), ['groups', '재무', '급여'])).toBe('none')
    expect(after.access(P('o', [], 'owner'), ['groups', '재무', '급여'])).toBe('write')
  })

  test('skills defaults, a connected folder, a limited top folder (shared/ with everyone write + Interns read: M3)', () => {
    const w = legacyDb()
    w.group('interns')
    w.user('i', 'member', { groups: ['interns'] }); w.user('m')
    w.rule('skills', 'everyone', null, 'read'); w.rule('skills', 'role', 'admin', 'write')
    w.rule('connected/nas', 'everyone', null, 'read')
    w.rule('shared', 'everyone', null, 'write'); w.rule('shared', 'group', 'interns', 'read')
    const people = [P('i', ['interns']), P('m')]
    const { before, after } = convertAndCheck(w, people, ['skills', 'connected/nas', 'shared', 'shared/x'])
    for (const p of people) for (const x of ['skills', 'connected/nas', 'shared']) expect(after.access(p, segs(x))).toBe(before.access(p, segs(x)))
    expect(limitedAt(w, 'skills')).toBe(false)
    expect(limitedAt(w, 'shared')).toBe(true)
    expect(after.access(P('new', ['interns']), ['shared'])).toBe('read')
  })

  test('parked folders: a deny at the original path, an original path taken since, nested trashed folders', () => {
    const w = legacyDb()
    w.group('g')
    w.user('a', 'member', { groups: ['g'] }); w.user('b')
    w.rule('shared', 'everyone', null, 'write')
    // shared/secret was trashed with "g: none" on it; a new shared/secret was made since with its own rule
    w.rule('.system/trash/2026-11/t1', 'group', 'g', 'none')
    w.rule('.system/trash/2026-11/t1/inner', 'user', 'b', 'read')
    w.rule('shared/secret', 'everyone', null, 'read')
    w.db.query("INSERT INTO trash_items (id, original_path, storage_path, size, deleted_by, purge_at, kind) VALUES ('t1', 'shared/secret', '.system/trash/2026-11/t1', 0, 'a', '2099-01-01', 'folder')").run()
    const people = [P('a', ['g']), P('b')]
    const before = w.legacy()
    w.convert()
    expect(folderAccessProblems(w.db)).toEqual([])
    // in place, as the trash judges it: the parked rules at the old path, the new folder's left out
    const map = (p: string) => (p === '.system/trash/2026-11/t1' || p.startsWith('.system/trash/2026-11/t1/') ? 'shared/secret' + p.slice('.system/trash/2026-11/t1'.length) : p === 'shared/secret' || p.startsWith('shared/secret/') ? null : p)
    const now = RuleSet.fromDb(w.db, { mapPath: map })
    const was = new LegacyRuleSet(before.ruleFolders().flatMap((f) => before.rulesAt(f).map((r) => ({ ...r, path: f }))).flatMap((r) => { const m = map(r.path); return m === null ? [] : [{ ...r, path: m }] }))
    for (const p of people) for (const x of ['shared/secret', 'shared/secret/inner']) expect(RANK[now.access(p, segs(x))], `${p.id} ${x}`).toBeLessThanOrEqual(RANK[was.access(p, segs(x))])
    expect(now.access(P('a', ['g']), ['shared', 'secret'])).toBe('none')
    expect(now.access(P('b'), ['shared', 'secret'])).toBe('write')
    // the live folder is converted on its own
    expect(RuleSet.load(w.db).access(P('a', ['g']), ['shared', 'secret'])).toBe('read')
  })

  test('a fresh database only gets the marker', () => {
    const w = legacyDb()
    w.convert()
    expect(folderAccessProblems(w.db)).toEqual([])
    expect(report(w).limited).toEqual([])
  })

  test('converting twice does nothing the second time (the marker gates it)', () => {
    const w = legacyDb()
    w.user('m'); w.group('g')
    w.rule('shared', 'everyone', null, 'write'); w.rule('shared/x', 'group', 'g', 'none')
    w.convert()
    const once = JSON.stringify(w.db.query('SELECT * FROM folder_rules ORDER BY id').all())
    w.convert()
    expect(JSON.stringify(w.db.query('SELECT * FROM folder_rules ORDER BY id').all())).toBe(once)
    expect((w.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'folders.additive_conversion'").get() as { n: number }).n).toBe(1)
  })
})

// ---------------- random worlds ----------------

let seed = 97
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const subsets = <T,>(xs: readonly T[]): T[][] => { const out: T[][] = []; for (let m = 0; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => m & (1 << i))); return out }

test('random worlds: existing people never more (equal but for the listed cases); anyone in any groups never more but those named', () => {
  let named = 0, limited = 0
  for (let world = 0; world < 80; world++) {
    const w = legacyDb()
    const groups = ['g0', 'g1', 'g2']
    for (const g of groups) w.group(g)
    const people: Principal[] = []
    for (let i = 0; i < 7; i++) {
      const role = i === 0 ? 'owner' : i === 1 ? 'admin' : 'member'
      const gs = groups.filter(() => rand() < 0.4)
      w.user(`p${i}`, role, { groups: gs, status: rand() < 0.15 ? 'disabled' : 'active' })
      people.push(P(`p${i}`, gs, role))
    }
    const folders = ['', 'a', 'a/b', 'a/b/c', 'a/d', 'projects', 'projects/x', 'projects/x/y', 'projects/z', 'users/p3']
    for (const f of folders) {
      if (rand() < 0.45) continue
      const seen = new Set<string>()
      for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) {
        const t = pick(['everyone', 'role', 'group', 'group', 'user', 'user'] as const)
        const s = t === 'everyone' ? null : t === 'role' ? pick(['member', 'admin', 'owner']) : t === 'group' ? pick(groups) : pick(people).id
        if (seen.has(`${t}:${s}`)) continue
        seen.add(`${t}:${s}`)
        w.rule(f, t, s, pick(['none', 'read', 'write'] as const))
      }
    }
    if (rand() < 0.5) w.project('px', 'projects/x')
    const paths = ['', 'a', 'a/b', 'a/b/c', 'a/b/c/deep', 'a/d', 'a/e', 'projects', 'projects/x', 'projects/x/y', 'projects/x/y/z', 'projects/z']
    const before = w.legacy()
    w.convert()
    expect(folderAccessProblems(w.db), `world ${world} ${JSON.stringify(w.db.query('SELECT f.path, f.limited, r.subject_type, r.subject_id, r.access FROM folders f LEFT JOIN folder_rules r ON r.folder_id = f.id').all())}`).toEqual([])
    const after = RuleSet.load(w.db)
    const rep = report(w)
    const narrowed = new Set((rep.narrowed as { path: string; userId: string }[]).map((n) => `${n.userId}\u0000${n.path}`))
    const origin = new Set((w.db.query("SELECT subject_id FROM folder_rules WHERE origin IS NOT NULL").all() as { subject_id: string }[]).map((r) => r.subject_id))
    named += origin.size
    limited += (rep.limited as string[]).length
    const w2 = after.world()
    const noOrigin = RuleSet.fromWorld({ rows: w2.rows.filter((r) => !r.origin), limited: w2.limited })
    for (const x of paths) {
      const s = segs(x)
      for (const p of people) {
        const b = before.access(p, s), a = after.access(p, s)
        expect(RANK[a], `world ${world} ${p.id} ${x}`).toBeLessThanOrEqual(RANK[b])
        // as if promoted to admin
        if (p.role === 'member') expect(RANK[after.access({ ...p, role: 'admin' }, s)], `world ${world} ${p.id}+admin ${x}`).toBeLessThanOrEqual(RANK[before.access({ ...p, role: 'admin' }, s)])
        // equal, unless a listed narrowing at the boundary that decides here (or a project's zone: 7.5-1)
        if (a !== b && !x.startsWith('projects/')) {
          let listed = false
          for (let len = s.length; len >= 0 && !listed; len--) listed = narrowed.has(`${p.id}\u0000${s.slice(0, len).join('/')}`)
          expect(listed, `world ${world} ${p.id} ${x}: ${b} -> ${a}`).toBe(true)
        }
      }
      // anyone, in any combination of the groups: never more; a person the conversion named, without those rules
      for (const gs of subsets(groups)) {
        expect(RANK[after.access(P('fresh', gs), s)], `world ${world} fresh ${gs} ${x}`).toBeLessThanOrEqual(RANK[before.access(P('fresh', gs), s)])
        for (const p of people) expect(RANK[noOrigin.access({ ...p, groups: gs }, s)], `world ${world} ${p.id} in ${gs} ${x}`).toBeLessThanOrEqual(RANK[before.access({ ...p, groups: gs }, s)])
      }
    }
  }
  // the worlds did reach both kinds of folder
  expect(limited).toBeGreaterThan(50)
  expect(named).toBeGreaterThan(5)
}, 120_000)
