// The additive permission function (server/src/policy/access.ts; docs/DECISIONS.md "Folder access adds up like Google
// Drive (P2)") against a plain reference written from the rule's words, on random worlds: limited folders with and
// without rules, project exceptions, origin rows, the members-only zone, the owner and admins, temp names, users/ and
// .system/. explain(), canList(), listing() and navigator() agree with access().
import { expect, test } from 'bun:test'
import { PRODUCT } from '@mycel/shared'
import { RuleSet, isProjectsName, type Access, type Principal, type RuleRow } from '../../server/src/policy/access'

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const BY: Access[] = ['none', 'read', 'write']

/** The rule in words: users/ and .system/ and temp names first; the owner and admins everywhere outside projects/<name>
 * (inside: as a member, by rules at or below it, and only once they read it); otherwise the widest rule that applies on
 * the way up to and including the nearest limited folder; a person's own "no access" on projects/<name> keeps them out
 * of it and all in it. */
function reference(rows: readonly RuleRow[], limited: ReadonlySet<string>, p: Principal, segs: string[]): Access {
  if (segs[0] === PRODUCT.systemDir) return 'none'
  if (segs.some((s) => s.startsWith(PRODUCT.tmpPrefix))) return 'none'
  if (segs[0] === 'users' && segs.length >= 2) return segs[1] === p.id ? 'write' : 'none'
  if (segs.length === 1 && segs[0] === 'users') return 'read'
  const zone = segs.length >= 2 && isProjectsName(segs[0]!)
  const staff = p.role === 'owner' || p.role === 'admin'
  if (staff && !zone) return 'write'
  if (staff && segs.length > 2 && RANK[reference(rows, limited, p, segs.slice(0, 2))] < 1) return 'none'
  const q = staff ? { ...p, role: 'member' as const } : p
  if (zone && rows.some((r) => r.path === segs.slice(0, 2).join('/') && r.subject_type === 'user' && r.subject_id === q.id && r.access === 'none')) return 'none'
  const applies = (r: RuleRow) => r.subject_type === 'everyone' || (r.subject_type === 'role' && r.subject_id === q.role) || (r.subject_type === 'group' && !!r.subject_id && q.groups.includes(r.subject_id)) || (r.subject_type === 'user' && r.subject_id === q.id)
  let best = 0
  for (let len = segs.length; len >= (staff ? 2 : 0); len--) {
    const at = segs.slice(0, len).join('/')
    for (const r of rows) if (r.path === at && r.access !== 'none' && applies(r)) best = Math.max(best, RANK[r.access])
    if (limited.has(at)) break
  }
  return BY[best]!
}

let seed = 4242
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!

test('random worlds: access, explain, canList and the navigator against the reference', () => {
  const FOLDERS = ['', 'a', 'a/b', 'a/b/c', 'a/d', 'e', 'projects', 'projects/x', 'projects/x/y', 'projects/z', 'users', 'users/u1', '.system', '.system/trash/m/t', `a/${PRODUCT.tmpPrefix}1`]
  const PATHS = [...FOLDERS, 'a/b/c/d', 'a/d/f', 'e/f/g', 'projects/x/y/z', 'projects/w', 'users/u2/x']
  let limitedSeen = 0, exceptionsSeen = 0
  for (let world = 0; world < 300; world++) {
    const groups = ['g0', 'g1', 'g2']
    const people: Principal[] = Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, name: `U${i}`, role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member', groups: groups.filter(() => rand() < 0.4) }))
    const rows: RuleRow[] = []
    const limited = new Set<string>()
    for (const f of FOLDERS) {
      if (rand() < 0.25) { limited.add(f); limitedSeen++ }
      if (rand() < 0.45) continue
      const seen = new Set<string>()
      for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) {
        const t = pick(['everyone', 'group', 'group', 'user', 'user'] as const)
        const s = t === 'everyone' ? null : t === 'group' ? pick(groups) : pick(people).id
        if (seen.has(`${t}:${s}`)) continue
        seen.add(`${t}:${s}`)
        rows.push({ path: f, subject_type: t, subject_id: s, access: pick(['read', 'write'] as const), origin: t === 'user' && rand() < 0.3 ? '{"v":1}' : null })
      }
    }
    // the markers: inert
    for (const f of limited) if (!rows.some((r) => r.path === f && r.subject_type === 'everyone')) rows.push({ path: f, subject_type: 'everyone', subject_id: null, access: 'none' })
    if (rand() < 0.5) rows.push({ path: pick(FOLDERS), subject_type: 'role', subject_id: 'admin', access: 'write' })
    // project exceptions on projects/x (sometimes with no project behind them: they hold anyway)
    for (const p of people) if (rand() < 0.15 && !rows.some((r) => r.path === 'projects/x' && r.subject_type === 'user' && r.subject_id === p.id)) { rows.push({ path: 'projects/x', subject_type: 'user', subject_id: p.id, access: 'none' }); exceptionsSeen++ }
    const rs = RuleSet.fromWorld({ rows, limited })
    for (const path of PATHS) {
      const segs = path === '' ? [] : path.split('/')
      for (const p of [...people, { id: 'fresh', name: '', role: 'member' as const, groups: [] }]) {
        const want = reference(rows, limited, p, segs)
        expect(rs.access(p, segs), `world ${world} ${p.id} ${path}`).toBe(want)
        const e = rs.explain(p, segs)
        expect(e.access).toBe(want)
        if (e.reason.kind === 'rule') {
          expect(e.reason.rules.length).toBeGreaterThan(0)
          for (const r of e.reason.rules) expect(r.access).toBe(want)
        }
        if (e.reason.kind === 'left') expect(want).toBe('none')
        if (e.reason.kind === 'no-rule' && e.reason.cutAt !== undefined) expect(limited.has(e.reason.cutAt)).toBe(true)
        // canList: readable, or something readable below it
        const below = PATHS.some((q) => q.startsWith(path === '' ? '' : path + '/') && q !== path && RANK[reference(rows, limited, p, q === '' ? [] : q.split('/'))] >= 1)
        if (!path.startsWith('users') && !path.startsWith('.system') && !(p.role !== 'member' && !path.startsWith('projects/')) && RANK[want] < 1 && !below) expect(rs.canList(p, segs), `world ${world} ${p.id} canList ${path}`).toBe(false)
        if (RANK[want] >= 1) expect(rs.canList(p, segs)).toBe(true)
      }
      // the navigator gives what listing() gives, for everyone
      const nav = rs.navigator(segs, 5)
      // (when the folder itself is readable the navigator does not look below: via is empty)
      for (const p of people) {
        const l = rs.listing(p, segs).at(segs, 5)
        expect(nav(p), `world ${world} ${p.id} navigator ${path}`).toEqual(RANK[rs.access(p, segs)] >= 1 ? { listable: true, via: [], more: false } : l)
      }
    }
  }
  expect(limitedSeen).toBeGreaterThan(300)
  expect(exceptionsSeen).toBeGreaterThan(50)
}, 60_000)

test('people named the same way at the same folders share one navigator scan, and get the same answer as alone', () => {
  // the company-by-name folder (review 2 M5): 200 people named at one limited folder
  const people: Principal[] = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: 'member', groups: [] }))
  const rows: RuleRow[] = [{ path: 'shared', subject_type: 'everyone', subject_id: null, access: 'write' }]
  for (const p of people) rows.push({ path: 'shared/hr', subject_type: 'user', subject_id: p.id, access: 'write', origin: '{"v":1}' })
  rows.push({ path: 'shared/hr/x', subject_type: 'everyone', subject_id: null, access: 'read' })
  const rs = RuleSet.fromWorld({ rows, limited: ['shared/hr'] })
  const nav = rs.navigator([], 20)
  const nav2 = rs.navigator(['shared', 'hr'], 20)
  for (const p of people.slice(0, 20)) expect(nav2(p)).toEqual({ listable: true, via: [], more: false })
  const fresh: Principal = { id: 'new', name: '', role: 'member', groups: [] }
  expect(rs.access(fresh, ['shared', 'hr'])).toBe('none')
  expect(nav2(fresh)).toEqual(rs.listing(fresh, ['shared', 'hr']).at(['shared', 'hr'], 20))
  expect(nav2(fresh).via).toEqual(['shared/hr/x'])
  for (const p of people.slice(0, 5)) expect(nav(p).listable).toBe(true)
})
