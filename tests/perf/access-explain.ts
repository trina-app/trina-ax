// Folder access explained: what it costs.
//  1. The hot path. RuleSet.access() runs for every file a listing, search or tool call touches. It now comes out of
//     the same function as explain(); this measures it against the function before (tests/lib/access-before-explain.ts)
//     on a large team: 300 people, 500 folders with rules, file paths 2-7 deep. explain() is measured too.
//  2. The admin answers at that size (server/src/admin/access-explain.ts): one folder for 300 people, for each of the
//     500 rule folders, and the root and top folders (where "shown in the tree" tries the most folders); every page of
//     one person's team folders, for each of the 300 people, and one part of the tree; a new person. Each includes the
//     response check the server runs in dev (validateResponses) and JSON.
// Run: bun tests/perf/access-explain.ts   (exit 1 when access() got more than 25% slower, or any answer took over 750 ms,
// whatever the size: PEOPLE=2000 RULE_FOLDERS=2500 is the size it is meant for; the slowest there, the root folder with
// all 1999 people on one page, took 200-249 ms on a Mac and 273-458 ms in Linux Docker on a busy machine)
import fs from 'node:fs'
import path from 'node:path'
import { FolderAccessResponse, PersonAccessResponse } from '@mycel/shared/api'
import type { AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { RuleSet, type Access, type Principal } from '../../server/src/policy/access'
import { explainFolder, explainNewPerson, explainPerson } from '../../server/src/admin/access-explain'
import { OldRuleSet } from '../lib/access-before-explain'
import { WORK } from '../lib/env'

// sizes: PEOPLE=… RULE_FOLDERS=… bun tests/perf/access-explain.ts for another team size
const PEOPLE = Number(process.env.PEOPLE ?? 300), GROUPS = 50, PROJECTS = 300, RULE_FOLDERS = Number(process.env.RULE_FOLDERS ?? 500)
let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!

// ---------------- a large team ----------------
const base = path.join(WORK, 'perf-access-explain')
fs.rmSync(base, { recursive: true, force: true })
const team = path.join(base, 'team')
const db = openDb(path.join(base, 'data', 'app.db'))
const OFF = `u${PEOPLE - 1}` // switched off
const users = Array.from({ length: PEOPLE }, (_, i) => ({ id: `u${i}`, role: i === 0 ? 'owner' : i < 4 ? 'admin' : 'member' }))
const groups = Array.from({ length: GROUPS }, (_, i) => `g${i}`)
const folderId = new Map<string, string>()
const rows: { path: string; subject_type: 'everyone' | 'role' | 'group' | 'user'; subject_id: string | null; access: Access }[] = []
db.transaction(() => {
  for (const u of users) db.query("INSERT INTO users (id, username, name, role, status) VALUES (?, ?, ?, ?, ?)").run(u.id, u.id, `Person ${u.id}`, u.role, u.id === OFF ? 'disabled' : 'active')
  const folder = (p: string) => {
    let id = folderId.get(p)
    if (!id) { id = crypto.randomUUID(); folderId.set(p, id); db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(id, p); fs.mkdirSync(path.join(team, p), { recursive: true }) }
    return id
  }
  const rule = (p: string, t: 'everyone' | 'role' | 'group' | 'user', s: string | null, a: Access) => {
    db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), folder(p), t, s, a)
    rows.push({ path: p, subject_type: t, subject_id: s, access: a })
  }
  for (const g of groups) {
    db.query('INSERT INTO groups (id, name, folder_id) VALUES (?, ?, ?)').run(g, `Group ${g}`, folder(`groups/${g}`))
    rule(`groups/${g}`, 'group', g, 'write')
  }
  for (const u of users.slice(4)) for (const g of groups) if (rand() < 0.04) db.query('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(g, u.id)
  rule('shared', 'everyone', null, 'write')
  rule('skills', 'everyone', null, 'read'); rule('skills', 'role', 'admin', 'write')
  // the rest of the 500 rule folders: restricted subfolders, projects with people and groups, skills subfolders
  let n = rows.length
  for (let i = 0; folderId.size < RULE_FOLDERS; i++, n++) {
    const kind = i % 4
    if (kind === 0) { const g = pick(groups); rule(`groups/${g}/private-${i}`, 'group', g, 'none'); rule(`groups/${g}/private-${i}`, 'user', `u${4 + Math.floor(rand() * (PEOPLE - 10))}`, 'read') }
    else if (kind === 1) { const p = `projects/p${i}`; rule(p, 'user', `u${4 + Math.floor(rand() * (PEOPLE - 10))}`, 'write'); rule(p, 'group', pick(groups), 'read'); rule(p, 'everyone', null, 'none') }
    else if (kind === 2) { rule(`skills/s${i}`, 'everyone', null, 'none'); rule(`skills/s${i}`, 'group', pick(groups), 'read') }
    else rule(`shared/area${i}/inner`, 'role', 'member', 'read')
  }
  rule('projects/p1', 'user', OFF, 'write') // a rule naming the person who is switched off
  for (let i = 0; i < PROJECTS; i++) {
    const own = i % 10 === 0 ? `users/u${5 + i}/projects/mine-${i}` : `projects/p${(i * 4 + 1) % (RULE_FOLDERS * 2)}`
    db.query('INSERT INTO projects (id, name, folder_path) VALUES (?, ?, ?)').run(crypto.randomUUID(), `Project ${i}`, own)
  }
  for (let i = 0; i < 5; i++) { db.query('INSERT INTO connected_folders (id, name, source) VALUES (?, ?, ?)').run(crypto.randomUUID(), `nas${i}`, `/Volumes/nas${i}`); fs.mkdirSync(path.join(team, 'connected', `nas${i}`), { recursive: true }) }
})()
fs.mkdirSync(path.join(team, 'users'), { recursive: true })
const ctx = { db, files: { fx: { root: team, caseInsensitive: false } } } as unknown as AppContext

// ---------------- 1. the hot path ----------------
const principals: Principal[] = users.map((u) => ({ id: u.id, name: u.id, role: u.role as Principal['role'],
  groups: (db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(u.id) as { group_id: string }[]).map((r) => r.group_id) }))
const members = principals.filter((p) => p.role === 'member').slice(0, 60)
const folders = [...folderId.keys()]
const paths: string[][] = Array.from({ length: 3000 }, () => {
  const f = pick(folders).split('/')
  const extra = Math.floor(rand() * 4)
  return [...f, ...Array.from({ length: extra }, (_, k) => (k === extra - 1 ? `file-${Math.floor(rand() * 100)}.md` : `sub${k}`))]
}).concat(Array.from({ length: 300 }, (_, i) => ['users', `u${i}`, 'notes.md']))
const now = new RuleSet(rows), old = new OldRuleSet(rows)
for (const p of members) for (const s of paths) if (now.access(p, s) !== old.access(p, s)) throw new Error(`answers differ: ${p.id} ${s.join('/')}`)
const calls = members.length * paths.length
function time(fn: (p: Principal, s: string[]) => unknown): number {
  const t = performance.now()
  for (const p of members) for (const s of paths) fn(p, s)
  return ((performance.now() - t) * 1e6) / calls // ns per call
}
const runs: Record<'old' | 'access' | 'explain', number[]> = { old: [], access: [], explain: [] }
for (let r = 0; r < 7; r++) {
  runs.old.push(time((p, s) => old.access(p, s)))
  runs.access.push(time((p, s) => now.access(p, s)))
  runs.explain.push(time((p, s) => now.explain(p, s)))
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const hot = { calls: calls * 7, oldNs: Math.round(med(runs.old)), accessNs: Math.round(med(runs.access)), explainNs: Math.round(med(runs.explain)) }
console.log('hot path (ns per call, median of 7 runs of', calls, 'calls):', JSON.stringify(hot))

// ---------------- 2. the admin answers ----------------
// each call is timed with the response check the server runs in dev (validateResponses) and JSON; "all pages" walks
// nextCursor to the end (limit 2000) and checks that every row came once
function measure(label: string, items: readonly string[], fn: (x: string) => { rows: number; bytes: number }) {
  const ms: number[] = []
  let bytes = 0, rows = 0
  for (const x of items) {
    const t = performance.now()
    const r = fn(x)
    ms.push(performance.now() - t)
    bytes = Math.max(bytes, r.bytes)
    rows = Math.max(rows, r.rows)
  }
  const s = [...ms].sort((a, b) => a - b)
  const row = { label, calls: items.length, medianMs: +s[Math.floor(s.length / 2)]!.toFixed(2), p95Ms: +s[Math.floor(s.length * 0.95)]!.toFixed(2), maxMs: +s[s.length - 1]!.toFixed(2), maxRows: rows, maxKB: Math.round(bytes / 1024) }
  console.log(JSON.stringify(row))
  return row
}
function checked<T>(schema: { parse(v: unknown): unknown }, out: T): { out: T; bytes: number } { schema.parse(out); return { out, bytes: JSON.stringify(out).length } }
function personPages(get: (cursor?: string) => ReturnType<typeof explainPerson>) {
  let cursor: string | undefined, rows = 0, bytes = 0, total = -1
  const seen = new Set<string>()
  for (;;) {
    const { out, bytes: b } = checked(PersonAccessResponse, get(cursor))
    bytes += b; rows += out.folders.length; total = out.total
    for (const f of out.folders) { if (seen.has(f.path)) throw new Error(`row twice: ${f.path}`); seen.add(f.path) }
    if (!out.nextCursor) break
    cursor = out.nextCursor
  }
  if (rows !== total) throw new Error(`pages gave ${rows} rows of ${total}`)
  return { rows, bytes }
}
const ruleFolderPaths = folders.filter((f) => !f.startsWith('users'))
const answers = [
  measure(`folder: each rule folder, ${PEOPLE - 1} active people (first page, 500)`, ruleFolderPaths, (f) => { const { out, bytes } = checked(FolderAccessResponse, explainFolder(ctx, { path: f }, 'en')); return { rows: out.people.length, bytes } }),
  measure(`folder: team root and top folders, all ${PEOPLE - 1} people (limit 2000)`, ['', 'groups', 'projects', 'skills', 'shared'], (f) => { const { out, bytes } = checked(FolderAccessResponse, explainFolder(ctx, { path: f, limit: 2000 }, 'en')); if (out.people.length !== out.total) throw new Error('cut'); return { rows: out.people.length, bytes } }),
  measure(`person: each of ${PEOPLE} people, every team folder (all pages, limit 2000)`, users.map((u) => u.id), (id) => personPages((cursor) => explainPerson(ctx, id, { cursor, limit: 2000 }))),
  measure('person: one part of the tree (prefix skills)', users.slice(0, 50).map((u) => u.id), (id) => personPages((cursor) => explainPerson(ctx, id, { prefix: 'skills', cursor, limit: 2000 }))),
  measure('new person: member in 3 groups (all pages)', ['x', 'y', 'z'], () => personPages((cursor) => explainNewPerson(ctx, { role: 'member', groupIds: groups.slice(0, 3), cursor, limit: 2000 }, 'en'))),
]
const sample = personPages((cursor) => explainPerson(ctx, 'u10', { cursor, limit: 2000 }))
const nav = explainPerson(ctx, 'u10', { prefix: 'groups', limit: 2000 }).folders.find((f) => f.path === 'groups')
console.log(`person u10: ${sample.rows} folders over all pages; groups: access ${nav?.access}, listable ${nav?.listable}, via ${nav?.via.length}${nav?.viaMore ? '+' : ''}; folder projects/p1 inactive:`,
  JSON.stringify(explainFolder(ctx, { path: 'projects/p1' }, 'en').inactive.map((x) => ({ user: x.user.id, access: x.access, reason: x.reason.kind }))))
db.close()
fs.rmSync(base, { recursive: true, force: true })

const slower = hot.accessNs > hot.oldNs * 1.25
const LIMIT_MS = 750
const slow = answers.filter((a) => a.maxMs > LIMIT_MS)
if (slower) console.log(`FAIL: access() ${hot.accessNs} ns vs ${hot.oldNs} ns before`)
for (const a of slow) console.log(`FAIL: ${a.label} took ${a.maxMs} ms (at most ${LIMIT_MS})`)
process.exit(slower || slow.length ? 1 : 0)
