// The one-time conversion of folder rules from "the deepest folder decides" to "access adds up like Google Drive"
// (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"). It runs as the post-migration step
// folderAccessAdditive (server/src/db-steps.ts), inside the migration transaction: a throw rolls everything back and the
// server does not start. The rule over all of it: after the conversion nobody has more access than before (the
// frozen resolver policy/legacy-deepest.ts is "before"), with one owner-accepted exception (C1-A): a person the
// conversion named keeps that access after a later group change, as Drive keeps access given by name.
//
// Per folder F, top-down (its ancestors converted first), with R = F's rules (role admin/owner rows and the project
// exception rows set aside), tier user 0 < group 1 < role member 2 < everyone 3, and mayCoApply(a, b) false only for
// two person rules of different people:
//   - r in R is tier-safe iff every r' in R with a lower tier that may apply together with r gives at least as much;
//   - A = the converted rules on the way up to and including the nearest limited folder (inside a project's zone up to
//     projects/<name>);
//   - F is additive-safe iff (S1) every r in R is tier-safe, (S2) every r in R gives at least every a in A it may apply
//     together with, and (S3) F is not projects/<name>.
// Safe: not limited, R without its "no access" rows. Otherwise limited, with keep (the tier-safe rules that give
// access), copy (the rules of A that no rule of F lowers; none for projects/<name>, whose members-only zone the owner
// and admins must not read by rules above it), and for each existing person who would then get less than before, a
// person rule with their access before (`origin` says where it came from: C1-A). The legacy marker everyone: none goes
// on a limited folder without an everyone rule, the managed marker role: admin: write on a folder the conversion would
// otherwise leave without rules.
//
// Proof that nobody the conversion did not name gets more (also in DECISIONS):
// - F safe, p has no rule at F: new(F) = new(parent) <= old(parent) = old(F), by induction on depth.
// - F safe, p has a rule at F: old(F) is the widest of p's top tier at F; by S1 that is >= every rule of p's at F, by
//   S2 >= every rule above that applies to p. So new(F) <= old(F).
// - F limited: a kept rule r applies to p => p's top tier at F gives >= r (tier-safe) => old >= r. A copied rule a, p
//   with no rule at F: old(F) = old(parent) >= new(parent) >= a. A copied rule a, p with a rule at F: every rule of F
//   that may apply with a gives >= a, so p's top tier gives >= a.
// - Below F, inheritance is the same in both models down to the next boundary.
// The final assertion (assertNoWidening) checks it again on the database itself, for every person and for synthetic
// principals in any combination of the groups that matter; a violation rewrites the folder the strictest way, and
// a second violation throws.
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
const newId = (): string => uuidv7()

/**
 * Statements of the conversion are prepared and finalized here, never taken from the connection's statement cache:
 * the conversion runs once, with many statements, inside migrate(), and a cached statement the cache let go unfinalized
 * keeps the connection open after close() (Bun 1.3: the database file then cannot be moved and opened again in the same
 * process, as a restore does).
 */
function q(db: Database, sql: string) {
  const st = db.prepare(sql)
  return {
    all: (...a: unknown[]) => { try { return st.all(...(a as never[])) } finally { st.finalize() } },
    get: (...a: unknown[]) => { try { return st.get(...(a as never[])) } finally { st.finalize() } },
    run: (...a: unknown[]) => { try { return st.run(...(a as never[])) } finally { st.finalize() } },
  }
}
/** a statement run many times, finalized by the caller (done()) */
function many(db: Database, sql: string) {
  const st = db.prepare(sql)
  return { run: (...a: unknown[]) => st.run(...(a as never[])), done: () => st.finalize() }
}
import { FOLDER_ACCESS_MODEL, FOLDER_ACCESS_MODEL_KEY, inProjectZone, isProjectsName, isZoneTop, RuleSet, type Access, type Principal, type Role, type SubjectType } from './access'
import { LegacyRuleSet, type LegacyRow } from './legacy-deepest'
import { legacyRuleFingerprint, ruleFingerprint } from './fingerprint'

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const BY_RANK: readonly Access[] = ['none', 'read', 'write']
const TIER: Record<SubjectType, number> = { user: 0, group: 1, role: 2, everyone: 3 }
const segsOf = (p: string): string[] => (p === '' ? [] : p.split('/'))
const isUsers = (p: string) => p === 'users' || p.startsWith('users/')
const isSystem = (p: string) => p === '.system' || p.startsWith('.system/')
const under = (p: string, base: string) => base === '' || p === base || p.startsWith(base + '/')

interface CRule { subject_type: SubjectType; subject_id: string | null; access: Access; origin?: string | null }
interface Target { limited: boolean; rules: CRule[] }
type Origin = { v: 1; by: 'conversion'; groups: { id: string; member: boolean }[]; base: Access | null }

/** What the conversion did, for the audit row, the dry run and the tests. Counts and paths only. */
export interface ConversionReport {
  limited: string[]
  /** per folder, the groups whose access was frozen into person rules there, and how many origin rows were written */
  byName: { path: string; groups: string[]; count: number }[]
  managedMarkers: string[]
  legacyMarkers: number
  roleRowsNormalised: number
  noneRowsRemoved: number
  exceptionsKept: number
  exceptionsWithoutProject: number
  /** existing people who get less than before (the fail-closed cases 7.5) */
  narrowed: { path: string; userId: string; case: string }[]
  parked: number
  parkedFailedClosed: number
  schedulesKept: number
  schedulesLapsed: number
  /** folders rewritten the strictest way after the assertion found a widening (should stay empty) */
  strict: string[]
  /** principals checked by the final assertion */
  checked: number
}

const tableExists = (db: Database, name: string) => !!q(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
const columnExists = (db: Database, table: string, col: string) => tableExists(db, table) && (q(db, `PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)

const mayCoApply = (a: Pick<CRule, 'subject_type' | 'subject_id'>, b: Pick<CRule, 'subject_type' | 'subject_id'>) => !(a.subject_type === 'user' && b.subject_type === 'user' && a.subject_id !== b.subject_id)
const appliesTo = (r: Pick<CRule, 'subject_type' | 'subject_id'>, p: Pick<Principal, 'id' | 'role' | 'groups'>) =>
  r.subject_type === 'everyone' || (r.subject_type === 'role' ? r.subject_id === p.role : r.subject_type === 'group' ? r.subject_id !== null && p.groups.includes(r.subject_id) : r.subject_id === p.id)
const keyOf = (r: Pick<CRule, 'subject_type' | 'subject_id'>) => `${r.subject_type}\u0000${r.subject_id ?? ''}`

/** role: member applies to exactly whom everyone applies to (people who consult rules): it becomes everyone with its own
 * value, and an everyone row of the same folder goes (the role step decided before the everyone step). */
function mergeMember(rules: readonly CRule[]): CRule[] {
  const member = rules.find((r) => r.subject_type === 'role' && r.subject_id === 'member')
  if (!member) return [...rules]
  const out = rules.filter((r) => !(r.subject_type === 'role') && r.subject_type !== 'everyone')
  if (member.access !== 'none') out.push({ subject_type: 'everyone', subject_id: null, access: member.access })
  return out
}
/** the same subject twice: the widest */
function widest(rules: readonly CRule[]): CRule[] {
  const by = new Map<string, CRule>()
  for (const r of rules) {
    const k = keyOf(r), was = by.get(k)
    if (!was || RANK[r.access] > RANK[was.access]) by.set(k, { ...r })
    else if (was && RANK[r.access] === RANK[was.access] && !was.origin && r.origin) by.set(k, { ...r })
  }
  return [...by.values()]
}

interface PersonRow { id: string; name: string; role: Role; groups: string[] }

/** The people the conversion keeps (active and switched off, not deleted), with their groups. */
function peopleOf(db: Database): PersonRow[] {
  if (!tableExists(db, 'users')) return []
  const del = columnExists(db, 'users', 'deleted_at') ? ' WHERE deleted_at IS NULL' : ''
  const users = q(db, `SELECT id, name, role FROM users${del} ORDER BY id`).all() as { id: string; name: string; role: Role }[]
  const groups = new Map<string, string[]>()
  if (tableExists(db, 'group_members')) for (const m of q(db, 'SELECT group_id, user_id FROM group_members ORDER BY group_id').all() as { group_id: string; user_id: string }[]) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] }))
}

interface FolderRow { id: string; path: string }
interface RuleRowDb { id: string; folder_id: string; subject_type: SubjectType; subject_id: string | null; access: Access; origin: string | null }

/**
 * One view of the folders: the live tree, or a trashed folder put back at its old path (its parked rows mapped there,
 * live rows at or under that path left out). `map`: stored path -> path in the view (null: not in it).
 */
interface View { name: string; map: (p: string) => string | null; strictAll: boolean }

/**
 * Convert the folder rules of this database. Call inside the migration transaction, once (the caller checks the marker).
 * Throws when the final assertion still finds a widening after the strictest rewrite: nothing is then changed.
 */
export function convertToAdditive(db: Database, o: { now?: string } = {}): ConversionReport {
  const now = o.now ?? new Date().toISOString()
  if (!beforeRows.has(db)) captureBefore(db)
  const strict = new Set<string>()
  for (let pass = 0; ; pass++) {
    db.exec('SAVEPOINT folder_access_convert')
    let report: ConversionReport
    let violations: Set<string>
    try {
      report = convertOnce(db, now, strict)
      violations = assertNoWidening(db, report)
    } catch (e) {
      db.exec('ROLLBACK TO folder_access_convert'); db.exec('RELEASE folder_access_convert')
      throw e
    }
    if (!violations.size) {
      db.exec('RELEASE folder_access_convert')
      report.strict = [...strict].sort()
      return report
    }
    db.exec('ROLLBACK TO folder_access_convert'); db.exec('RELEASE folder_access_convert')
    const fresh = [...violations].filter((v) => !strict.has(v))
    if (pass >= 1 || !fresh.length) throw new Error(`folder access conversion: access would widen at ${[...violations].slice(0, 5).join(', ')} even when rewritten the strictest way; nothing was changed`)
    for (const v of fresh) strict.add(v)
  }
}

/**
 * Each trashed folder put back at its old path, as team-files/service.ts parkedView builds it: the trash items trashed
 * after it whose old path holds its own (the chain, latest last) are put back too, and live rows at or under those old
 * paths are left out. The latest trashed first: a folder trashed inside another later is part of that one's view, which
 * is converted first. The conversion and its final assertion use the same views (review: a one-level view in the
 * assertion saw the chain's own rules as a widening and the server did not start). `broken`: the chain is longer than 64.
 */
export function parkedViews(db: Database): { id: string; map: (p: string) => string | null; scope: (p: string) => boolean; broken: boolean }[] {
  if (!tableExists(db, 'trash_items') || !columnExists(db, 'trash_items', 'kind')) return []
  type Held = { id: string; original_path: string; storage_path: string }
  const held = q(db, "SELECT id, original_path, storage_path FROM trash_items WHERE kind = 'folder' AND restored_at IS NULL ORDER BY id DESC").all() as Held[]
  return held.map((own) => {
    const chain: Held[] = [own]
    let broken = false
    for (let cur = own; ;) {
      const up = held.filter((h) => h.id > cur.id && (h.original_path === '' || cur.original_path.startsWith(h.original_path + '/'))).sort((a, b) => (a.id < b.id ? -1 : 1))[0]
      if (!up) break
      chain.push(up)
      cur = up
      if (chain.length >= 64) { broken = true; break }
    }
    const map = (p: string): string | null => {
      const c = chain.find((h) => under(p, h.storage_path))
      if (c) return c.original_path + p.slice(c.storage_path.length)
      if (isSystem(p)) return null
      if (chain.some((h) => under(p, h.original_path))) return null
      return p
    }
    return { id: own.id, map, scope: (p: string) => under(p, own.storage_path), broken }
  })
}

function convertOnce(db: Database, now: string, strict: ReadonlySet<string>): ConversionReport {
  const report: ConversionReport = { limited: [], byName: [], managedMarkers: [], legacyMarkers: 0, roleRowsNormalised: 0, noneRowsRemoved: 0, exceptionsKept: 0, exceptionsWithoutProject: 0, narrowed: [], parked: 0, parkedFailedClosed: 0, schedulesKept: 0, schedulesLapsed: 0, strict: [], checked: 0 }
  const folders = q(db, 'SELECT id, path FROM folders ORDER BY path').all() as FolderRow[]
  const rules = q(db, 'SELECT id, folder_id, subject_type, subject_id, access, origin FROM folder_rules').all() as RuleRowDb[]
  const pathOf = new Map(folders.map((f) => [f.id, f.path]))
  const idOf = new Map(folders.map((f) => [f.path, f.id]))
  const rowsOf = new Map<string, RuleRowDb[]>()
  for (const r of rules) rowsOf.set(r.folder_id, [...(rowsOf.get(r.folder_id) ?? []), r])
  const people = peopleOf(db)
  const hasProjects = tableExists(db, 'projects')
  const projectPaths = new Set<string>(hasProjects ? (q(db, 'SELECT folder_path FROM projects').all() as { folder_path: string }[]).map((r) => r.folder_path) : [])
  // the converted folders by id: what is written at the end
  const done = new Map<string, Target>()
  // legacy rows of the whole database (stored paths), for the in-place views
  const legacyAll: (LegacyRow & { folder_id: string })[] = rules.map((r) => ({ path: pathOf.get(r.folder_id) ?? '', subject_type: r.subject_type, subject_id: r.subject_id, access: r.access, folder_id: r.folder_id }))

  const convertView = (view: View, scope: (stored: string) => boolean) => {
    // the folders of this view: stored path -> view path
    const inView: { id: string; stored: string; at: string }[] = []
    for (const f of folders) { const at = view.map(f.path); if (at !== null) inView.push({ id: f.id, stored: f.path, at }) }
    const byAt = new Map(inView.map((x) => [x.at, x]))
    const legacy = new LegacyRuleSet(legacyAll.flatMap((r) => { const at = view.map(r.path); return at === null ? [] : [{ ...r, path: at }] }))
    // the converted rules at a view path (done or, for a folder of the view not converted, its rows as they are)
    const convAt = (at: string): Target | null => {
      const x = byAt.get(at)
      if (!x) return null
      return done.get(x.id) ?? null
    }
    const todo = inView.filter((x) => scope(x.stored) && !isUsers(x.at) && !isSystem(x.at)).sort((a, b) => segsOf(a.at).length - segsOf(b.at).length || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    for (const x of todo) {
      const orig = rowsOf.get(x.id) ?? []
      const zoneTop = isZoneTop(x.at)
      const usedByProject = zoneTop && (projectPaths.has(x.at) || projectPaths.has(x.stored))
      if (!orig.length && !usedByProject) continue
      const t = convertFolder(x.at, orig, convAt, legacy, people, view.strictAll || strict.has(x.at) || strict.has(x.stored), report)
      done.set(x.id, t)
    }
  }

  // 1. the live tree
  convertView({ name: 'live', map: (p) => (isSystem(p) ? null : p), strictAll: false }, (p) => !isSystem(p))
  // a live projects/<name> that a project uses gets a limited row even with no rules (invariant 5)
  for (const p of projectPaths) {
    if (!isZoneTop(p) || isSystem(p)) continue
    if (!idOf.has(p)) {
      const id = newId()
      q(db, 'INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)').run(id, p, now)
      folders.push({ id, path: p }); pathOf.set(id, p); idOf.set(p, id)
      done.set(id, { limited: true, rules: [{ subject_type: 'everyone', subject_id: null, access: 'none' }] })
      report.legacyMarkers++
    }
  }
  // 2. trashed folders, put back at their old path (the latest trashed first: a folder trashed inside it later is part
  // of its view; parkedView in team-files/service.ts builds the same chain)
  for (const t of parkedViews(db)) {
    report.parked++
    if (t.broken) report.parkedFailedClosed++
    convertView({ name: `parked:${t.id}`, map: t.map, strictAll: t.broken }, t.scope)
  }

  // 3. write: limits first (the trigger lets the legacy marker in only on a limited folder), then the rows in place
  const setLimited = many(db, 'UPDATE folders SET limited = ? WHERE id = ?')
  const del = many(db, 'DELETE FROM folder_rules WHERE id = ?')
  const upd = many(db, 'UPDATE folder_rules SET access = ?, origin = ? WHERE id = ?')
  const ins = many(db, 'INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at, origin) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
  for (const [id, t] of done) {
    if (t.limited) setLimited.run(1, id)
    const path = pathOf.get(id)!
    if (t.limited && !isSystem(path)) report.limited.push(path)
  }
  for (const [id, t] of done) {
    const existing = rowsOf.get(id) ?? []
    const want = new Map(t.rules.map((r) => [keyOf(r), r]))
    for (const e of existing) {
      const w = want.get(keyOf(e))
      if (!w) { del.run(e.id); continue }
      if (w.access !== e.access || (w.origin ?? null) !== (e.origin ?? null)) upd.run(w.access, w.origin ?? null, e.id)
      want.delete(keyOf(e))
    }
    for (const w of want.values()) ins.run(newId(), id, w.subject_type, w.subject_id, w.access, now, w.origin ?? null)
  }
  for (const st of [setLimited, del, upd, ins]) st.done()
  report.limited.sort()
  return report
}

/** Convert one folder (path `at` in its view). Fills the report; returns what to store. */
function convertFolder(at: string, orig: readonly RuleRowDb[], convAt: (p: string) => Target | null, legacy: LegacyRuleSet, people: readonly PersonRow[], strict: boolean, report: ConversionReport): Target {
  const segs = segsOf(at)
  const zoneTop = isZoneTop(at)
  const inZone = inProjectZone(segs)
  const roleStaff = orig.filter((r) => r.subject_type === 'role' && (r.subject_id === 'admin' || r.subject_id === 'owner'))
  const exceptions = zoneTop ? orig.filter((r) => r.subject_type === 'user' && r.access === 'none' && r.subject_id) : []
  const R: CRule[] = orig.filter((r) => !roleStaff.includes(r) && !exceptions.includes(r)).map((r) => ({ subject_type: r.subject_type, subject_id: r.subject_id, access: r.access, origin: r.origin }))
  report.roleRowsNormalised += roleStaff.length + R.filter((r) => r.subject_type === 'role').length
  report.exceptionsKept += exceptions.length
  // A: the converted rules on the way up, to and including the nearest limited folder (inside the zone: projects/<name>)
  const A: CRule[] = []
  const chainGroups = new Set<string>()
  for (const r of R) if (r.subject_type === 'group' && r.subject_id) chainGroups.add(r.subject_id)
  for (let len = segs.length - 1; len >= 0; len--) for (const r of legacy.rulesAt(segs.slice(0, len).join('/'))) if (r.subject_type === 'group' && r.subject_id) chainGroups.add(r.subject_id)
  for (let len = segs.length - 1; len >= 0; len--) {
    const up = segs.slice(0, len).join('/')
    const t = convAt(up)
    if (t) for (const r of t.rules) if (r.access !== 'none' && !(r.subject_type === 'role')) A.push(r)
    if (t?.limited) break
    if (inZone && len <= 2) break
  }
  const tierSafe = (r: CRule) => R.every((x) => !(TIER[x.subject_type] < TIER[r.subject_type] && mayCoApply(x, r)) || RANK[x.access] >= RANK[r.access])
  const S1 = R.every(tierSafe)
  const S2 = R.every((r) => A.every((a) => !mayCoApply(r, a) || RANK[r.access] >= RANK[a.access]))
  const safe = !strict && S1 && S2 && !zoneTop
  report.noneRowsRemoved += R.filter((r) => r.access === 'none').length
  let rules: CRule[]
  let limited: boolean
  if (safe) {
    limited = false
    rules = widest(mergeMember(R.filter((r) => r.access !== 'none')))
  } else {
    limited = true
    const keep = mergeMember(R.filter((r) => tierSafe(r) && r.access !== 'none'))
    // (for projects/<name>, or the strictest rewrite: nothing from above)
    const copy = zoneTop || strict ? [] : A.filter((a) => R.every((r) => !mayCoApply(r, a) || RANK[r.access] >= RANK[a.access]))
    rules = widest([...keep, ...copy.map((a) => ({ ...a }))])
    // the people who would get less with only keep + copy: named, with their access before (C1-A: origin recorded)
    const exceptedIds = new Set(exceptions.map((e) => e.subject_id!))
    const zoneTopPath = inZone ? segs.slice(0, 2).join('/') : null
    const zoneExcepted = (id: string) => zoneTopPath !== null && legacy.rulesAt(zoneTopPath).some((r) => r.subject_type === 'user' && r.subject_id === id && r.access === 'none')
    const frozen = new Set<string>()
    let count = 0
    for (const p of people) {
      const staff = p.role === 'owner' || p.role === 'admin'
      if (staff && !inZone) continue
      const q: Principal = staff ? { id: p.id, name: p.name, role: 'member', groups: p.groups } : { id: p.id, name: p.name, role: p.role, groups: p.groups }
      // inside a project's zone only what the rules at or below projects/<name> gave (as the owner and admins are judged
      // there): access a member had through a rule above it (projects/, the root) is not named (7.5-1, narrower), or
      // promoting them to admin later would let them in by that name
      const full = legacy.access({ id: p.id, name: p.name, role: p.role, groups: p.groups }, segs)
      if (full === 'none') continue
      if (exceptedIds.has(p.id) || zoneExcepted(p.id)) { report.narrowed.push({ path: at, userId: p.id, case: '7.5-2' }); continue }
      const old = inZone ? legacy.access({ id: p.id, name: p.name, role: 'admin', groups: p.groups }, segs) : full
      if (RANK[old] < RANK[full]) report.narrowed.push({ path: at, userId: p.id, case: '7.5-1' })
      if (old === 'none') continue
      let now = -1
      for (const r of rules) if (appliesTo(r, q) && RANK[r.access] > now) now = RANK[r.access]
      if (now >= RANK[old]) continue
      const own = rules.find((r) => r.subject_type === 'user' && r.subject_id === p.id)
      const origin: Origin = { v: 1, by: 'conversion', groups: [...chainGroups].sort().map((g) => ({ id: g, member: p.groups.includes(g) })), base: own ? own.access : null }
      rules = rules.filter((r) => r !== own)
      rules.push({ subject_type: 'user', subject_id: p.id, access: BY_RANK[Math.max(RANK[old], own ? RANK[own.access] : 0)]!, origin: JSON.stringify(origin) })
      for (const g of chainGroups) if (p.groups.includes(g)) frozen.add(g)
      count++
    }
    if (count) report.byName.push({ path: at, groups: [...frozen].sort(), count })
  }
  // the project exceptions stay as they are (rule only: docs/DECISIONS.md "Leaving a project")
  for (const e of exceptions) rules.push({ subject_type: 'user', subject_id: e.subject_id, access: 'none', origin: e.origin })
  if (limited && !rules.some((r) => r.subject_type === 'everyone' && r.access !== 'none')) { rules.push({ subject_type: 'everyone', subject_id: null, access: 'none' }); report.legacyMarkers++ }
  // the managed marker: a folder that had role admin/owner rows, or had rules and would have none
  const shown = rules.filter((r) => !(r.subject_type === 'everyone' && r.access === 'none') && !(r.subject_type === 'user' && r.access === 'none'))
  if (roleStaff.length || (orig.length && !shown.length && !limited)) {
    rules.push({ subject_type: 'role', subject_id: 'admin', access: 'write' })
    if (!roleStaff.length) report.managedMarkers.push(at)
  }
  return { limited, rules }
}

// ---------------- the final assertion (7.7) ----------------

/** A small deterministic random number generator (a seed per folder: the same subsets on every run). */
function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000 }
}
/** S(G): every subset of up to 8 groups; more: none, each one, each pair and 256 drawn with the folder's seed. */
export function groupSubsets(groups: readonly string[], seed: string): string[][] {
  const g = [...groups].sort()
  if (g.length <= 8) {
    const out: string[][] = []
    for (let m = 0; m < 1 << g.length; m++) out.push(g.filter((_, i) => m & (1 << i)))
    return out
  }
  const out: string[][] = [[]]
  for (const a of g) out.push([a])
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) out.push([g[i]!, g[j]!])
  const r = rng(seed)
  for (let k = 0; k < 256; k++) out.push(g.filter(() => r() < 0.5))
  return out
}

/**
 * The views to check: the live tree, and each trashed folder put back at its old path, with the legacy rows (from the
 * audit of what was there before: the rows captured before writing) and the converted ones.
 */
function assertNoWidening(db: Database, report: ConversionReport): Set<string> {
  // (the converted database is read with the marker set inside this savepoint: the loader needs it)
  q(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FOLDER_ACCESS_MODEL_KEY, FOLDER_ACCESS_MODEL)
  const violations = new Set<string>()
  // (the same views the conversion used: the live tree, and each trashed folder with its chain)
  const views: { map: (p: string) => string | null; scope: (p: string) => boolean }[] = [{ map: (p) => (isSystem(p) ? null : p), scope: (p) => !isSystem(p) }, ...parkedViews(db)]
  const people = peopleOf(db)
  const before = beforeRows.get(db)
  if (!before) return violations
  for (const v of views) {
    const legacy = new LegacyRuleSet(before.flatMap((r) => { const at = v.map(r.path); return at === null ? [] : [{ ...r, path: at }] }))
    const now = RuleSet.fromDb(db, { mapPath: v.map })
    const w = now.world()
    const noOrigin = RuleSet.fromWorld({ rows: w.rows.filter((r) => !r.origin), limited: w.limited })
    const storedPaths = (q(db, 'SELECT path FROM folders').all() as { path: string }[]).map((r) => r.path).filter(v.scope)
    const boundaries = new Set<string>()
    for (const p of storedPaths) { const at = v.map(p); if (at !== null && !isUsers(at) && !isSystem(at)) boundaries.add(at) }
    for (const r of before) { if (!v.scope(r.path)) continue; const at = v.map(r.path); if (at !== null && !isUsers(at) && !isSystem(at)) boundaries.add(at) }
    if (v.scope('')) boundaries.add('')
    for (const F of boundaries) {
      const segs = segsOf(F)
      // the groups and people named on F's chain, before and after
      const G = new Set<string>(), U = new Set<string>()
      for (let len = segs.length; len >= 0; len--) {
        const up = segs.slice(0, len).join('/')
        for (const r of legacy.rulesAt(up)) { if (r.subject_type === 'group' && r.subject_id) G.add(r.subject_id); if (r.subject_type === 'user' && r.subject_id) U.add(r.subject_id) }
        for (const r of now.storedAt(up)) { if (r.subjectType === 'group' && r.subjectId) G.add(r.subjectId); if (r.subjectType === 'user' && r.subjectId) U.add(r.subjectId) }
      }
      const subsets = groupSubsets([...G], F)
      const wider = (p: Principal, set: RuleSet) => { report.checked++; return RANK[set.access(p, segs)] > RANK[legacy.access(p, segs)] }
      // existing people with their own groups: never more (and less only in the listed cases)
      for (const p of people) {
        const pr: Principal = { id: p.id, name: p.name, role: p.role, groups: p.groups }
        if (wider(pr, now)) violations.add(F)
        // as if promoted to admin, or an owner or admin as if made a member (with their own groups)
        if (p.role === 'member' && wider({ ...pr, role: 'admin' }, now)) violations.add(F)
        if (p.role !== 'member' && wider({ ...pr, role: 'member' }, now)) violations.add(F)
      }
      // a fresh person, and each person named here, in any combination of the groups that matter (C1-A: without the
      // person rules the conversion wrote, which are the accepted exception)
      for (const gs of subsets) {
        if (wider({ id: '\u0000fresh', name: '', role: 'member', groups: gs }, now)) violations.add(F)
        for (const u of U) {
          const actual = people.find((p) => p.id === u)
          if (actual && actual.groups.length === gs.length && actual.groups.every((g) => gs.includes(g))) continue
          if (wider({ id: u, name: '', role: 'member', groups: gs }, noOrigin)) violations.add(F)
        }
      }
    }
  }
  return violations
}

/** The rows before the conversion, by database (captureBefore fills it; assertNoWidening reads it). */
const beforeRows = new WeakMap<Database, LegacyRow[]>()
/** Keep the rows as they are before converting (stored paths), for the final assertion. */
export function captureBefore(db: Database): void {
  beforeRows.set(db, q(db, 'SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as LegacyRow[])
}

// ---------------- the step: conversion, bookkeeping, marker ----------------

/**
 * The post-migration step folderAccessAdditive: convert, keep the scheduled tasks' save folders whose readers did not
 * change (their stored fingerprints recomputed), write the audit row and the marker. Call inside the migration
 * transaction when folders.limited exists and the marker is missing.
 */
export function runFolderAccessConversion(db: Database, o: { now?: string } = {}): ConversionReport {
  const fp = { fingerprint: ruleFingerprint, legacyFingerprint: legacyRuleFingerprint }
  const now = o.now ?? new Date().toISOString()
  captureBefore(db)
  const before = beforeRows.get(db)!
  const people = peopleOf(db)
  const report = convertToAdditive(db, { now })
  q(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FOLDER_ACCESS_MODEL_KEY, FOLDER_ACCESS_MODEL)
  // scheduled tasks' save folders: the stored fingerprint was of the rules before; recompute it where the folder's
  // readers are the same (by the assertion, all but the narrowed cases), else let it lapse as a rules change would
  if (columnExists(db, 'schedules', 'save_rule') && columnExists(db, 'schedules', 'save_lapse_reason')) {
    const after = RuleSet.fromDb(db)
    const legacy = new LegacyRuleSet(before)
    const readers = (f: (p: Principal) => Access, segs: string[]) => people.filter((p) => RANK[f({ id: p.id, name: p.name, role: p.role, groups: p.groups })] >= 1).map((p) => p.id).join(',')
    const sameReaders = (segs: string[]) => readers((p) => legacy.access(p, segs), segs) === readers((p) => after.access(p, segs), segs)
    const upd = many(db, 'UPDATE schedules SET save_rule = ?, save_sources = ? WHERE id = ?')
    const lapse = many(db, "UPDATE schedules SET save_lapsed_at = ?, save_lapse_reason = 'rules' WHERE id = ?")
    for (const s of q(db, 'SELECT id, save_folder, save_rule, save_sources, save_lapsed_at FROM schedules WHERE save_folder IS NOT NULL').all() as { id: string; save_folder: string; save_rule: string | null; save_sources: string | null; save_lapsed_at: string | null }[]) {
      if (s.save_lapsed_at) continue
      const segs = segsOf(s.save_folder)
      if (s.save_rule !== fp.legacyFingerprint(before, segs)) continue
      let ok = sameReaders(segs)
      let sources = s.save_sources
      if (ok && s.save_sources) {
        try {
          const list = JSON.parse(s.save_sources) as { type: string; id?: string; rule?: string }[]
          for (const x of list) {
            if (x.type !== 'folder' && x.type !== 'root') continue
            const p = x.type === 'root' ? '' : (q(db, 'SELECT path FROM folders WHERE id = ?').get(x.id ?? '') as { path: string } | null)?.path
            if (p === undefined || p === null) continue
            const ss = segsOf(p)
            if (x.rule !== undefined && x.rule !== fp.legacyFingerprint(before, ss)) continue
            if (!sameReaders(ss)) { ok = false; break }
            x.rule = fp.fingerprint(after, ss)
          }
          sources = JSON.stringify(list)
        } catch { ok = false }
      }
      if (ok) { upd.run(fp.fingerprint(after, segs), sources, s.id); report.schedulesKept++ }
      else { lapse.run(now, s.id); report.schedulesLapsed++ }
    }
    upd.done(); lapse.done()
  }
  if (tableExists(db, 'projects')) {
    const used = new Set((q(db, 'SELECT folder_path FROM projects').all() as { folder_path: string }[]).map((r) => r.folder_path))
    for (const r of before) if (r.subject_type === 'user' && r.access === 'none' && isZoneTop(r.path) && !used.has(r.path)) report.exceptionsWithoutProject++
  }
  if (tableExists(db, 'audit_log')) {
    q(db, 'INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES (NULL, ?, NULL, ?, ?)').run('folders.additive_conversion', JSON.stringify({
      limited: report.limited, byName: report.byName.map((b) => ({ path: b.path, groups: b.groups, count: b.count })), managedMarkers: report.managedMarkers,
      narrowed: report.narrowed, parked: report.parked, parkedFailedClosed: report.parkedFailedClosed, schedulesKept: report.schedulesKept, schedulesLapsed: report.schedulesLapsed, strict: report.strict,
    }), now)
  }
  beforeRows.delete(db)
  return report
}

export { isProjectsName }
