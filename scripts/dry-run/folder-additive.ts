// Dry run of the one-time folder access conversion on a COPY of a team database (docs/DECISIONS.md "Folder access adds
// up like Google Drive (P2)", spec §15). It never writes the file it is given: the copy is loaded into memory
// (deserialize) and converted there. Counts only on stdout; with --json, the detail (paths, people ids) goes to that
// file, which stays with whoever ran it (it may hold a team's folder names).
//
//   bun scripts/dry-run/folder-additive.ts <copy.db> [--json out.json] [--tmp <dir for the restore check>]
//
// Exit code 1 when anyone would get more than before (widened > 0) or an invariant fails.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { migrate } from '../../server/src/db'
import { RuleSet, type Access, type Principal, type Role } from '../../server/src/policy/access'
import { LegacyRuleSet, type LegacyRow } from '../../server/src/policy/legacy-deepest'
import { folderAccessProblems } from '../../server/src/policy/invariants'
import { groupSubsets, parkedViews } from '../../server/src/policy/convert-additive'
import { keepFolderAccess } from '../../server/src/system/backup'

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 }
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))
const isSystem = (p: string) => p === '.system' || p.startsWith('.system/')
const isUsers = (p: string) => p === 'users' || p.startsWith('users/')

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json' && args[args.indexOf(a) - 1] !== '--tmp')
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const tmpBase = args.includes('--tmp') ? args[args.indexOf('--tmp') + 1]! : os.tmpdir()
if (!file || !fs.existsSync(file)) { console.error('usage: bun scripts/dry-run/folder-additive.ts <copy.db> [--json out.json] [--tmp dir]'); process.exit(2) }

const bytes = new Uint8Array(fs.readFileSync(file))
// a copy of a database in WAL mode says so in its header (bytes 18-19 = 2): in memory it must read as a rollback-journal
// file (1), or SQLite cannot open it
if (bytes[18] === 2) bytes[18] = 1
if (bytes[19] === 2) bytes[19] = 1
const load = () => { const d = Database.deserialize(bytes, { strict: true } as never) as Database; d.exec('PRAGMA foreign_keys = ON'); return d }
const db = load()

// ---------------- before ----------------
const tableExists = (d: Database, t: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
const hasCol = (d: Database, t: string, c: string) => tableExists(d, t) && (d.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c)
if (hasCol(db, 'folders', 'limited')) { console.error('this copy is converted already (folders.limited exists)'); process.exit(2) }
const people = (() => {
  const users = db.query(`SELECT id, name, role FROM users${hasCol(db, 'users', 'deleted_at') ? ' WHERE deleted_at IS NULL' : ''}`).all() as { id: string; name: string; role: Role }[]
  const mem = db.query('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[]
  return users.map((u) => ({ id: u.id, name: u.name, role: u.role, groups: mem.filter((m) => m.user_id === u.id).map((m) => m.group_id) }))
})()
const rowsBefore = db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as LegacyRow[]
const ruleCounts = {
  rules: rowsBefore.length,
  noneRows: rowsBefore.filter((r) => r.access === 'none').length,
  roleRows: rowsBefore.filter((r) => r.subject_type === 'role').length,
  folders: (db.query('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n,
  groups: (db.query('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n,
  people: people.length,
}
type View = { name: string; map: (p: string) => string | null; scope: (p: string) => boolean }
const views: View[] = [{ name: 'live', map: (p) => (isSystem(p) ? null : p), scope: (p) => !isSystem(p) }]
// (each trashed folder with its chain, as the conversion and the trash judge it)
for (const t of parkedViews(db)) views.push({ name: 'parked', map: t.map, scope: t.scope })
const boundariesOf = (v: View, rows: readonly { path: string }[]) => {
  const out = new Set<string>()
  for (const f of db.query('SELECT path FROM folders').all() as { path: string }[]) if (v.scope(f.path)) { const at = v.map(f.path); if (at !== null && !isUsers(at)) out.add(at) }
  for (const r of rows) if (v.scope(r.path)) { const at = v.map(r.path); if (at !== null && !isUsers(at)) out.add(at) }
  if (v.name === 'live') out.add('')
  // a path below each boundary too (inherits; a check that the walk up is right)
  for (const b of [...out]) out.add(b === '' ? '~dryrun' : `${b}/~dryrun`)
  return [...out]
}
const legacyOf = (v: View, rows: readonly LegacyRow[]) => new LegacyRuleSet(rows.flatMap((r) => { const at = v.map(r.path); return at === null ? [] : [{ ...r, path: at }] }))
const snap = views.map((v) => ({ v, legacy: legacyOf(v, rowsBefore), paths: boundariesOf(v, rowsBefore) }))

// ---------------- convert ----------------
const t0 = Date.now()
migrate(db, {})
const ms = Date.now() - t0
const audit = JSON.parse((db.query("SELECT detail FROM audit_log WHERE action = 'folders.additive_conversion' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail)
const problems = folderAccessProblems(db)

// ---------------- after: existing people, synthetic principals, the old reader ----------------
let widened = 0, narrowedExisting = 0, checked = 0, oldReaderOver = 0
const widenedList: unknown[] = [], narrowedList: unknown[] = []
const rowsAfter = db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as LegacyRow[]
const originRows = db.query("SELECT f.path, r.subject_id, r.access, r.origin FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.origin IS NOT NULL").all() as { path: string; subject_id: string; access: Access; origin: string }[]
const exceptions = new Set((db.query("SELECT r.subject_id || char(0) || f.path AS k FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE r.subject_type = 'user' AND r.access = 'none'").all() as { k: string }[]).map((r) => r.k))
for (const { v, legacy, paths } of snap) {
  const now = RuleSet.fromDb(db, { mapPath: v.map })
  const w = now.world()
  const noOrigin = RuleSet.fromWorld({ rows: w.rows.filter((r) => !r.origin), limited: w.limited })
  const oldReader = legacyOf(v, rowsAfter)
  for (const x of paths) {
    const s = segsOf(x)
    const G = new Set<string>(), U = new Set<string>()
    for (let len = s.length; len >= 0; len--) {
      const up = s.slice(0, len).join('/')
      for (const r of [...legacy.rulesAt(up), ...oldReader.rulesAt(up)]) { if (r.subject_type === 'group' && r.subject_id) G.add(r.subject_id); if (r.subject_type === 'user' && r.subject_id) U.add(r.subject_id) }
    }
    for (const p of people) {
      for (const role of p.role === 'member' ? ['member', 'admin'] as Role[] : [p.role, 'member'] as Role[]) {
        const pr: Principal = { ...p, role }
        const b = legacy.access(pr, s), a = now.access(pr, s)
        checked++
        if (RANK[a] > RANK[b]) { widened++; widenedList.push({ view: v.name, path: x, userId: p.id, role, before: b, after: a }) }
        else if (role === p.role && RANK[a] < RANK[b]) { narrowedExisting++; narrowedList.push({ view: v.name, path: x, userId: p.id, before: b, after: a }) }
      }
    }
    for (const gs of groupSubsets([...G], x)) {
      const fresh: Principal = { id: '\u0000fresh', name: '', role: 'member', groups: gs }
      checked++
      if (RANK[now.access(fresh, s)] > RANK[legacy.access(fresh, s)]) { widened++; widenedList.push({ view: v.name, path: x, synthetic: 'fresh', groups: gs.length }) }
      if (RANK[oldReader.access(fresh, s)] > RANK[now.access(fresh, s)]) oldReaderOver++
      for (const u of U) {
        const pr: Principal = { id: u, name: '', role: 'member', groups: gs }
        checked++
        if (RANK[noOrigin.access(pr, s)] > RANK[legacy.access(pr, s)]) { widened++; widenedList.push({ view: v.name, path: x, synthetic: 'named', userId: u, groups: gs.length }) }
        if (RANK[oldReader.access(pr, s)] > RANK[now.access(pr, s)] && !s.some((_, i) => exceptions.has(`${u}\u0000${s.slice(0, i + 1).join('/')}`))) oldReaderOver++
      }
    }
  }
}

// ---------------- C1: group changes for the people the conversion named ----------------
const legacyLive = legacyOf(views[0]!, rowsBefore)
const nowLive = RuleSet.load(db)
let c1Changes = 0, c1KeepMore = 0
const c1List: unknown[] = []
for (const r of originRows) {
  const p = people.find((x) => x.id === r.subject_id)
  if (!p) continue
  const o = JSON.parse(r.origin) as { groups: { id: string; member: boolean }[] }
  for (const g of o.groups) {
    const groups = g.member ? p.groups.filter((x) => x !== g.id) : [...p.groups, g.id]
    const pr: Principal = { ...p, groups }
    const today = legacyLive.access(pr, segsOf(r.path)), c1a = nowLive.access(pr, segsOf(r.path))
    c1Changes++
    if (RANK[c1a] > RANK[today]) { c1KeepMore++; c1List.push({ path: r.path, userId: p.id, group: g.id, change: g.member ? 'leaves' : 'joins', today, c1a }) }
  }
}

// ---------------- restore check (H4): an old backup over the converted live, and over an unconverted live ----------------
const restore: Record<string, string> = {}
{
  const dir = fs.mkdtempSync(path.join(tmpBase, 'dryrun-restore-'))
  try {
    const pre = path.join(dir, 'pre.db')
    fs.writeFileSync(pre, bytes)
    // the live database converted (a copy of this one), the staged backup = the copy before
    const liveConv = path.join(dir, 'live.db')
    const conv = new Database(pre, { readonly: true }); conv.query('VACUUM INTO ?').run(liveConv); conv.close()
    const lc = new Database(liveConv, { strict: true }); migrate(lc, {}); lc.close()
    const staged = path.join(dir, 'staged.db')
    fs.copyFileSync(pre, staged)
    const ms2 = new Database(staged, { strict: true }); migrate(ms2, {}); ms2.close()
    restore.oldBackupConvertedLive = keepFolderAccess(liveConv, staged) ? 'kept' : 'backup'
    const a = RuleSet.load(new Database(staged, { readonly: true })), b = RuleSet.load(new Database(liveConv, { readonly: true }))
    let diff = 0
    for (const x of views[0] ? snap[0]!.paths : []) for (const p of people) if (a.access(p, segsOf(x)) !== b.access(p, segsOf(x))) diff++
    restore.sameAccessAsLive = diff === 0 ? 'yes' : `no (${diff})`
    // the live database not converted yet (a restore staged on the old build)
    const staged2 = path.join(dir, 'staged2.db'), live2 = path.join(dir, 'live2.db')
    fs.copyFileSync(pre, staged2); fs.copyFileSync(pre, live2)
    const s2 = new Database(staged2, { strict: true }); migrate(s2, {}); s2.close()
    restore.oldBackupUnconvertedLive = keepFolderAccess(live2, staged2) ? 'kept' : 'backup'
    const c = RuleSet.load(new Database(staged2, { readonly: true }))
    let diff2 = 0
    for (const x of snap[0]!.paths) for (const p of people) if (c.access(p, segsOf(x)) !== b.access(p, segsOf(x))) diff2++
    restore.unconvertedSameAccess = diff2 === 0 ? 'yes' : `no (${diff2})`
    restore.copyLeftBehind = fs.existsSync(path.join(dir, 'restore-live-converted.db')) ? 'yes' : 'no'
    restore.problemsAfter = String(folderAccessProblems(new Database(staged, { readonly: true })).length)
  } catch (e) { restore.error = (e as Error).message } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// ---------------- fresh database ----------------
const fresh = new Database(':memory:', { strict: true })
migrate(fresh, {})
const freshProblems = folderAccessProblems(fresh).length

const summary = {
  before: ruleCounts,
  convertMs: ms,
  widened, checked,
  narrowedExisting,
  narrowedListed: (audit.narrowed as unknown[]).length,
  narrowedByCase: (audit.narrowed as { case: string }[]).reduce((m, n) => ({ ...m, [n.case]: ((m as Record<string, number>)[n.case] ?? 0) + 1 }), {}),
  limitedFolders: (audit.limited as unknown[]).length,
  namedByConversion: { folders: (audit.byName as unknown[]).length, rows: originRows.length, people: new Set(originRows.map((r) => r.subject_id)).size },
  managedMarkers: (audit.managedMarkers as unknown[]).length,
  legacyMarkers: rowsAfter.filter((r) => r.subject_type === 'everyone' && r.access === 'none').length,
  noneRowsAfter: rowsAfter.filter((r) => r.access === 'none').length,
  roleRowsAfter: rowsAfter.filter((r) => r.subject_type === 'role').length,
  exceptionsKept: [...exceptions].length,
  parked: audit.parked, parkedFailedClosed: audit.parkedFailedClosed,
  schedulesKept: audit.schedulesKept, schedulesLapsed: audit.schedulesLapsed,
  strictRewrites: (audit.strict as unknown[]).length,
  c1: { changesSimulated: c1Changes, keepMoreThanToday: c1KeepMore },
  oldReaderAboveNew: oldReaderOver,
  invariants: problems.length ? problems : 'ok',
  restore, freshDbProblems: freshProblems,
}
console.log(JSON.stringify(summary, null, 2))
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, widened: widenedList, narrowed: narrowedList, conversion: audit, c1: c1List }, null, 2), { mode: 0o600 })
process.exit(widened > 0 || problems.length || freshProblems ? 1 : 0)
