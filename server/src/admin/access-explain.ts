// Folder access, explained (Admin > Folder permissions): for one team folder, every active person's access and the
// folder and rule it comes from; for one person (or someone about to be invited), their access to every team folder
// and why. Read only. Every answer is RuleSet.explain (server/src/policy/access.ts), the same computation as
// access(), so what the screen says is what the permission function does.
//
// Hidden on purpose: nothing under users/ is read from disk (the names of someone's files, personal projects or
// personal skills would show). A person's own users/<id>/ is one row made from the member list. .system/ (trash
// parked rules included) and server temp names never appear.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import type { AccessFolderKind, FolderAccessResponse, Locale, PersonAccessResponse, PersonFolderAccess, Role, UserStatus } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { RuleSet, type AccessReason, type Explained, type Principal } from '../policy/access'
import { badSegment, foldKey, hiddenEntry } from '../policy/names'
import { parseInput, walk } from '../policy/resolve'
import { captureState } from './folders'

/** Response caps (rows; the summary still counts everyone). Measured in tests/perf/access-explain.ts: 300 people and
 * 500 rule folders answer in a few milliseconds, so these only bound the response size. */
export const MAX_PEOPLE_ROWS = 2000
export const MAX_FOLDER_ROWS = 2000

const USERS = foldKey('users')
const SYSTEM = foldKey(PRODUCT.systemDir)
const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

/** Segments of a team path that may be shown, or null: anything under users/ or .system/ (any case or width), a
 * server temp name, a name the team folder does not accept. */
function shownSegs(p: string): string[] | null {
  const segs = segsOf(p)
  if (segs.length && (foldKey(segs[0]!) === USERS || foldKey(segs[0]!) === SYSTEM)) return null
  if (segs.some((s, i) => badSegment(s) !== null || hiddenEntry(s, i))) return null
  return segs
}

/** The nearest folder at or above `segs` that carries rules ('' when only the root does, null when none does). Below
 * it, nothing carries rules, so every person's answer at `segs` is their answer there: callers compute once per
 * such folder. */
function ruleFolderOf(ruleFolders: ReadonlySet<string>, segs: readonly string[]): string | null {
  for (let len = segs.length; len >= 0; len--) {
    const k = segs.slice(0, len).join('/')
    if (ruleFolders.has(k)) return k
  }
  return null
}

/** A real folder at `segs`, every step lstat'ed (a link anywhere on the way counts as not there, never followed).
 * `memo`: prefixes already looked at in this answer. */
function isDir(root: string, segs: readonly string[], memo: Map<string, boolean>): boolean {
  let cur = root
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]!)
    let ok = memo.get(cur)
    if (ok === undefined) {
      try { ok = fs.lstatSync(cur).isDirectory() } catch { ok = false }
      memo.set(cur, ok)
    }
    if (!ok) return false
  }
  return true
}

// ---------------- one folder ----------------

export function explainFolder(ctx: AppContext, rel: string | undefined, locale: Locale): FolderAccessResponse {
  const refuse = (why: string): never => fail('validation', msg('rulesInUsers', locale), { fields: { 'query.path': why } })
  let typed: string[]
  try { typed = parseInput(rel ?? '') } catch (e) { return fail('validation', undefined, { fields: { 'query.path': (e as Error).message } }) }
  // personal folders are their owner's alone: never walked (the walk would read the folder's names)
  if (typed.length && foldKey(typed[0]!) === USERS) refuse('users/ is only its owner\'s')
  const w = walk(ctx.files.fx.root, typed, ctx.files.fx.caseInsensitive)
  const segs = [...w.actual, ...w.missing]
  if (!shownSegs(segs.join('/'))) refuse('not a team folder')
  const p = segs.join('/')

  const state = captureState(ctx.db)
  const ruleFolder = ruleFolderOf(new Set(state.rules.ruleFolders()), segs)
  const at = ruleFolder === null ? segs : segsOf(ruleFolder)
  const people: FolderAccessResponse['people'] = []
  const count = { none: 0, read: 0, write: 0 }
  const sources = new Map<string, { reason: AccessReason['kind']; folder: string | null; count: number }>()
  for (const u of state.principals) {
    const e = state.rules.explain(u, at)
    count[e.access]++
    const folder = e.reason.kind === 'rule' ? e.reason.folder : null
    const k = `${e.reason.kind}\u0000${folder ?? ''}`
    const s = sources.get(k)
    if (s) s.count++
    else sources.set(k, { reason: e.reason.kind, folder, count: 1 })
    if (people.length < MAX_PEOPLE_ROWS) people.push({ user: { id: u.id, name: u.name }, role: u.role, access: e.access, reason: e.reason })
  }

  // person rules on the way up that name someone switched off (left out of the people above)
  const status = new Map((ctx.db.query('SELECT id, name, status, deleted_at FROM users').all() as { id: string; name: string; status: string; deleted_at: string | null }[]).map((u) => [u.id, u]))
  const inactive: FolderAccessResponse['inactive'] = []
  for (let len = segs.length; len >= 0; len--) {
    const f = segs.slice(0, len).join('/')
    for (const r of state.rules.rulesAt(f)) {
      if (r.subjectType !== 'user' || r.subjectId === null) continue
      const u = status.get(r.subjectId)
      if (u && u.status === 'active' && !u.deleted_at) continue
      inactive.push({ user: { id: r.subjectId, name: u?.name ?? r.subjectId }, folder: f, access: r.access })
    }
  }

  return {
    path: p, exists: w.missing.length === 0 && !w.problem, ruleFolder, people, truncated: state.principals.length > people.length,
    summary: { access: count, sources: [...sources.values()].sort((a, b) => b.count - a.count || String(a.folder ?? '').localeCompare(String(b.folder ?? ''))) },
    inactive,
  }
}

// ---------------- one person ----------------

interface Candidate { segs: string[]; kinds: Set<AccessFolderKind>; group?: { id: string; name: string }; projects?: { id: string; name: string }[]; connected?: { id: string; name: string } }

/** The team folders an admin sees in a person's list: folders with rules, top-level folders, group, project and
 * connected folders (outside users/ and .system/), by path. */
function teamFolders(ctx: AppContext, rules: RuleSet): Map<string, Candidate> {
  const out = new Map<string, Candidate>()
  const add = (p: string, kind: AccessFolderKind): Candidate | null => {
    const segs = shownSegs(p)
    if (!segs) return null
    let c = out.get(p)
    if (!c) out.set(p, (c = { segs, kinds: new Set() }))
    c.kinds.add(kind)
    return c
  }
  for (const f of rules.ruleFolders()) add(f, 'rules')
  try {
    for (const d of fs.readdirSync(ctx.files.fx.root, { withFileTypes: true })) if (d.isDirectory()) add(d.name, 'top')
  } catch { /* no team folder yet */ }
  for (const g of ctx.db.query('SELECT g.id, g.name, f.path FROM groups g JOIN folders f ON f.id = g.folder_id ORDER BY g.name').all() as { id: string; name: string; path: string }[]) {
    const c = add(g.path, 'group')
    if (c) c.group = { id: g.id, name: g.name }
  }
  // personal projects (users/<id>/…) are dropped by add(): their names are their owner's
  for (const pr of ctx.db.query('SELECT id, name, folder_path FROM projects ORDER BY name, id').all() as { id: string; name: string; folder_path: string }[]) {
    const c = add(pr.folder_path, 'project')
    if (c) (c.projects ??= []).push({ id: pr.id, name: pr.name })
  }
  for (const cf of ctx.db.query('SELECT id, name FROM connected_folders ORDER BY name').all() as { id: string; name: string }[]) {
    const c = add(`connected/${cf.name}`, 'connected')
    if (c) c.connected = { id: cf.id, name: cf.name }
  }
  return out
}

function personAccess(ctx: AppContext, p: Principal, who: { user: { id: string; name: string } | null; status: UserStatus | null }): PersonAccessResponse {
  const rules = RuleSet.load(ctx.db)
  const ruleFolders = new Set(rules.ruleFolders())
  const memo = new Map<string, Explained>()
  const root = ctx.files.fx.root
  const dirs = new Map<string, boolean>()
  const rows: PersonFolderAccess[] = []
  // the person's own folder, from the member list only (nothing below it is looked at)
  if (who.user) {
    const e = rules.explain(p, ['users', p.id])
    rows.push({ path: `users/${p.id}`, kinds: ['personal'], exists: null, access: e.access, reason: e.reason })
  }
  const cands = [...teamFolders(ctx, rules).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [p0, c] of cands) {
    if (rows.length >= MAX_FOLDER_ROWS) break
    // one computation per deciding folder: a folder without rules answers like the nearest folder with rules above it
    const key = ruleFolderOf(ruleFolders, c.segs) ?? ''
    let e = memo.get(key)
    if (!e) memo.set(key, (e = rules.explain(p, segsOf(key))))
    rows.push({
      path: p0, kinds: [...c.kinds], ...(c.group ? { group: c.group } : {}), ...(c.projects ? { projects: c.projects } : {}), ...(c.connected ? { connected: c.connected } : {}),
      exists: isDir(root, c.segs, dirs), access: e.access, reason: e.reason,
    })
  }
  const names = new Map((ctx.db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]))
  return {
    user: who.user, role: p.role, status: who.status,
    groups: p.groups.map((id) => ({ id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name)),
    folders: rows, truncated: rows.length < cands.length + (who.user ? 1 : 0),
  }
}

export function explainPerson(ctx: AppContext, id: string): PersonAccessResponse {
  const u = ctx.db.query('SELECT id, name, role, status FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; name: string; role: Role; status: UserStatus } | null
  if (!u) return fail('not_found')
  const groups = (ctx.db.query('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id').all(id) as { group_id: string }[]).map((r) => r.group_id)
  // a person who is switched off is shown as they would be when switched back on (status says so)
  return personAccess(ctx, { id: u.id, name: u.name, role: u.role, groups }, { user: { id: u.id, name: u.name }, status: u.status })
}

/** Someone about to be invited: no id yet, so no person rule can name them and there is no personal folder row. */
export function explainNewPerson(ctx: AppContext, body: { role: Exclude<Role, 'owner'>; groupIds: string[] }, locale: Locale): PersonAccessResponse {
  const groups = [...new Set(body.groupIds)]
  const known = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
  if (groups.some((g) => !known.has(g))) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  return personAccess(ctx, { id: '\u0000new-person', name: '', role: body.role, groups }, { user: null, status: null })
}

