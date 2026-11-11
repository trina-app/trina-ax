// Folder access, explained (Admin > Folder permissions): for one team folder, every active person's access and the
// folder and rule it comes from; for one person (or someone about to be invited), their access to every team folder
// and why. Read only. Every answer is RuleSet.explain (server/src/policy/access.ts), the same computation as
// access(), and "shown in the tree" is RuleSet.listing, the same answer as canList(), so what the screen says is what
// the permission function does. Rows, order, pages and counts: ./access-rows.ts (shared with the web mock server).
//
// Hidden on purpose: nothing under users/ is read from disk (the names of someone's files, personal projects or
// personal skills would show). A person's own users/<id>/ is one row made from the member list. .system/ (trash
// parked rules included) and server temp names never appear.
import fs from 'node:fs'
import path from 'node:path'
import type { AccessFolderKind, AccessTreeResponse, FolderAccessResponse, FolderEditPreview, FolderRuleInput, Locale, PersonAccessResponse, PersonFolderAccess, Role, UserStatus } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { msg } from '../auth/messages'
import { RuleSet, type Explained, type Listing, type Principal } from '../policy/access'
import { walk } from '../policy/resolve'
import { captureState, chatsWithEngineSession, getFolderByPath, validateRules } from './folders'
import { byPerson, folderInput, MAX_VIA, navigation, pageByPath, pageByPerson, ruleFolderOf, segsOf, shownPath, shownSegs, summarize, withoutOwnFolder } from './access-rows'
import { ruledAnswer, treeAnswer, type TreeMark, type TreeSource } from './access-tree'
import { editPreview } from './access-edit'
import { isParkedRow, isTeamDefaultFolder } from './folder-keep'
import { MAX_PATH_CHARS } from '../policy/names'

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

function groupsOf(ctx: AppContext, userId: string): string[] {
  return (ctx.db.query('SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id').all(userId) as { group_id: string }[]).map((r) => r.group_id)
}

// ---------------- one folder ----------------

export function explainFolder(ctx: AppContext, q: { path?: string; cursor?: string; limit?: number }, locale: Locale): FolderAccessResponse {
  const input = folderInput(q.path)
  if ('refuse' in input) return fail('validation', msg(input.refuse === 'personal' ? 'accessPersonalFolder' : 'accessNotTeamFolder', locale), { fields: { 'query.path': input.detail } })
  // personal folders and .system/ were refused above, before this walk reads anything
  const w = walk(ctx.files.fx.root, input.segs, ctx.files.fx.caseInsensitive)
  const segs = [...w.actual, ...w.missing]
  if (!shownSegs(segs.join('/'))) fail('validation', msg('accessNotTeamFolder', locale), { fields: { 'query.path': 'not a team folder' } })

  const state = captureState(ctx.db) // active people (by name, then id) and the rules
  const ruleFolder = ruleFolderOf(new Set(state.rules.ruleFolders()), segs)
  // below the nearest rule folder nothing carries rules: every answer here is the answer there
  const at = ruleFolder === null ? segs : segsOf(ruleFolder)
  const all = [...state.principals].sort(byPerson).map((u) => ({ u, ...state.rules.explain(u, at) }))
  const pg = pageByPerson(all, (r) => r.u, q)
  if (!pg) return fail('validation', undefined, { fields: { 'query.cursor': 'not a cursor of this answer' } })
  // "shown in the tree for navigation", for the rows of this page that have no access here
  const nav = state.rules.navigator(segs, MAX_VIA, shownPath)
  const people = pg.items.map(({ u, access, reason }) => ({ user: { id: u.id, name: u.name }, role: u.role, access, reason, ...navigation(() => nav(u), access) }))

  // person rules on the way up that name someone switched off: what they would get here if switched back on
  const off = new Map<string, { folder: string; access: FolderAccessResponse['inactive'][number]['access'] }[]>()
  for (let len = segs.length; len >= 0; len--) {
    const f = segs.slice(0, len).join('/')
    for (const r of state.rules.rulesAt(f)) if (r.subjectType === 'user' && r.subjectId !== null && !state.principals.some((u) => u.id === r.subjectId)) {
      off.set(r.subjectId, [...(off.get(r.subjectId) ?? []), { folder: f, access: r.access }])
    }
  }
  const inactive: FolderAccessResponse['inactive'] = []
  for (const [id, rules] of off) {
    const u = ctx.db.query('SELECT id, name, role FROM users WHERE id = ?').get(id) as { id: string; name: string; role: Role } | null
    const p: Principal = { id, name: u?.name ?? id, role: u?.role ?? 'member', groups: u ? groupsOf(ctx, id) : [] }
    const e = state.rules.explain(p, at)
    inactive.push({ user: { id, name: p.name }, role: p.role, access: e.access, reason: e.reason, rules })
  }
  inactive.sort((a, b) => byPerson(a.user, b.user))

  return {
    path: segs.join('/'), exists: w.missing.length === 0 && !w.problem && w.st.isDirectory(), ruleFolder,
    people, total: pg.total, nextCursor: pg.nextCursor, summary: summarize(all), inactive,
  }
}

// ---------------- one person ----------------

interface Candidate { path: string; segs: string[]; kinds: Set<AccessFolderKind>; group?: { id: string; name: string }; projects?: { id: string; name: string }[]; connected?: { id: string; name: string } }

/** The team folders an admin sees in a person's list: folders with rules, top-level folders, group, project and
 * connected folders (outside users/ and .system/). */
function teamFolders(ctx: AppContext, rules: RuleSet): Candidate[] {
  const out = new Map<string, Candidate>()
  const add = (p: string, kind: AccessFolderKind): Candidate | null => {
    const segs = shownSegs(p)
    if (!segs) return null
    let c = out.get(p)
    if (!c) out.set(p, (c = { path: p, segs, kinds: new Set() }))
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
  // personal projects (users/<id>/…) are dropped by add(): their names are their owner's. A project whose folder is in
  // the trash is not there: its path may be another folder's, and members do not see the project (canSeeProject)
  for (const pr of ctx.db.query('SELECT id, name, folder_path FROM projects WHERE trashed_with IS NULL ORDER BY name, id').all() as { id: string; name: string; folder_path: string }[]) {
    const c = add(pr.folder_path, 'project')
    if (c) (c.projects ??= []).push({ id: pr.id, name: pr.name })
  }
  for (const cf of ctx.db.query('SELECT id, name FROM connected_folders ORDER BY name').all() as { id: string; name: string }[]) {
    const c = add(`connected/${cf.name}`, 'connected')
    if (c) c.connected = { id: cf.id, name: cf.name }
  }
  return [...out.values()]
}

type PageQ = { prefix?: string; cursor?: string; limit?: number }

function personAccess(ctx: AppContext, p: Principal, who: { user: { id: string; name: string } | null; status: UserStatus | null }, q: PageQ): PersonAccessResponse {
  const rules = RuleSet.load(ctx.db)
  const cands = teamFolders(ctx, rules)
  // the person's own folder, from the member list only (nothing below it is looked at)
  if (who.user) cands.push({ path: `users/${p.id}`, segs: ['users', p.id], kinds: new Set(['personal']) })
  const pg = pageByPath(cands, q)
  const ruleFolders = new Set(rules.ruleFolders())
  const memo = new Map<string, Explained>()
  const dirs = new Map<string, boolean>()
  let listing: Listing | undefined // the readable folders, found once for every row (when a row needs them)
  const folders: PersonFolderAccess[] = pg.items.map((c) => {
    const personal = c.kinds.has('personal')
    // one computation per deciding folder: a folder without rules answers like the nearest folder with rules above it
    const key = personal ? c.path : ruleFolderOf(ruleFolders, c.segs) ?? ''
    let e = memo.get(key)
    if (!e) memo.set(key, (e = rules.explain(p, personal ? c.segs : segsOf(key))))
    return {
      path: c.path, kinds: [...c.kinds], ...(c.group ? { group: c.group } : {}), ...(c.projects ? { projects: c.projects } : {}), ...(c.connected ? { connected: c.connected } : {}),
      exists: personal ? null : isDir(ctx.files.fx.root, c.segs, dirs), access: e.access, reason: e.reason,
      ...navigation(() => {
        const l = (listing ??= rules.listing(p))
        // someone new has no users/<id> yet: it is not named (access-rows.ts withoutOwnFolder)
        return who.user ? l.at(c.segs, MAX_VIA, shownPath) : withoutOwnFolder(l.at(c.segs, MAX_VIA + 1, shownPath), `users/${p.id}`, MAX_VIA)
      }, e.access),
    }
  })
  const names = new Map((ctx.db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]))
  return {
    user: who.user, role: p.role, status: who.status,
    groups: p.groups.map((id) => ({ id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name)),
    folders, total: pg.total, nextCursor: pg.nextCursor,
  }
}

export function explainPerson(ctx: AppContext, id: string, q: PageQ): PersonAccessResponse {
  const u = ctx.db.query('SELECT id, name, role, status FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as { id: string; name: string; role: Role; status: UserStatus } | null
  if (!u) return fail('not_found')
  // a person who is switched off is shown as they would be when switched back on (status says so)
  return personAccess(ctx, { id: u.id, name: u.name, role: u.role, groups: groupsOf(ctx, id) }, { user: { id: u.id, name: u.name }, status: u.status }, q)
}

// ---------------- the tree (one level at a time) ----------------

/** "Is there a folder inside?" looks at no more entries than this (a folder with 10,000 files and no folder must not
 * hold the server for each row of a page): past it the answer is yes, and opening it says what is there. */
const HAS_FOLDERS_SCAN = 2000

/** The folders inside a team folder, as the tree may show them: real folders only, by their names on disk; only when
 * every step down to it is a real folder (`realDir`: a link anywhere counts as not there, never followed). `first`: stop
 * at the first one, and after HAS_FOLDERS_SCAN entries (is there any?). */
function subfolders(root: string, segs: readonly string[], realDir: (segs: readonly string[]) => boolean, first = false): string[] {
  const out: string[] = []
  if (!realDir(segs)) return out
  const base = segs.join('/')
  let dir: fs.Dir | undefined
  try {
    dir = fs.opendirSync(path.join(root, ...segs))
    let seen = 0
    for (let d = dir.readSync(); d; d = dir.readSync()) {
      if (first && ++seen > HAS_FOLDERS_SCAN) { out.push(''); break }
      if (!d.isDirectory()) continue
      const p = base ? `${base}/${d.name}` : d.name
      // the same names the answers may show (users/ and .system/ at the root are the caller's to handle)
      if (segs.length > 0 && (p.length > MAX_PATH_CHARS || !shownSegs(p))) continue
      out.push(d.name)
      if (first) break
    }
  } catch { /* not there, or not a folder */ } finally {
    try { dir?.closeSync() } catch { /* closed */ }
  }
  return out
}

export function explainTree(ctx: AppContext, q: { path?: string; cursor?: string; limit?: number; open?: boolean; rules?: boolean }, locale: Locale): AccessTreeResponse {
  const input = folderInput(q.path)
  if ('refuse' in input) return fail('validation', msg(input.refuse === 'personal' ? 'accessPersonalFolder' : 'accessNotTeamFolder', locale), { fields: { 'query.path': input.detail } })
  // personal folders and .system/ were refused above, before anything is read
  const root = ctx.files.fx.root
  const w = walk(root, input.segs, ctx.files.fx.caseInsensitive)
  const segs = [...w.actual, ...w.missing]
  if (!shownSegs(segs.join('/'))) fail('validation', msg('accessNotTeamFolder', locale), { fields: { 'query.path': 'not a team folder' } })
  const exists = w.missing.length === 0 && !w.problem && w.st.isDirectory()

  const state = captureState(ctx.db) // active people and the rules
  const groupNames = new Map((ctx.db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]))
  const userNames = new Map((ctx.db.query('SELECT id, name FROM users WHERE deleted_at IS NULL').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]))
  const marks = new Map<string, TreeMark>()
  const mark = (p: string, kind: AccessFolderKind) => {
    let m = marks.get(p)
    if (!m) marks.set(p, (m = { kinds: new Set() }))
    m.kinds.add(kind)
    return m
  }
  for (const g of ctx.db.query('SELECT g.id, g.name, f.path FROM groups g JOIN folders f ON f.id = g.folder_id ORDER BY g.name').all() as { id: string; name: string; path: string }[]) mark(g.path, 'group').group = { id: g.id, name: g.name }
  // personal projects (users/<id>/…) are left out by the tree (their names are their owner's); so is a project whose
  // folder is in the trash (members do not see it, and its path may be another folder's)
  for (const pr of ctx.db.query('SELECT id, name, folder_path FROM projects WHERE trashed_with IS NULL ORDER BY name, id').all() as { id: string; name: string; folder_path: string }[]) {
    const m = mark(pr.folder_path, 'project')
    ;(m.projects ??= []).push({ id: pr.id, name: pr.name })
  }
  for (const cf of ctx.db.query('SELECT id, name FROM connected_folders ORDER BY name').all() as { id: string; name: string }[]) mark(`connected/${cf.name}`, 'connected').connected = { id: cf.id, name: cf.name }

  const dirs = new Map<string, boolean>()
  const realDir = (s: readonly string[]) => isDir(root, s, dirs)
  const src: TreeSource = {
    rules: state.rules, people: state.principals,
    groupName: (id) => groupNames.get(id) ?? null,
    personName: (id) => userNames.get(id) ?? null,
    children: (s) => subfolders(root, s, realDir),
    hasFolders: (s) => subfolders(root, s, realDir, true).length > 0,
    isFolder: realDir,
    marks,
    personal: state.principals.length,
  }
  return q.rules ? ruledAnswer(src, segs, exists, q) : treeAnswer(src, segs, exists, q)
}

// ---------------- the edit panel: what saving would change (access-edit.ts) ----------------

/** The team's shared/ or skills/ as the admin API keeps them (folder-keep.ts: compared the way the volume compares). */
export function teamFolderOf(p: string, caseInsensitive: boolean): 'shared' | 'skills' | null {
  if (!isTeamDefaultFolder(p, caseInsensitive)) return null
  return p.normalize('NFC').toLowerCase() === 'shared' ? 'shared' : 'skills'
}

/**
 * POST /api/admin/access/edit-preview: what saving `rules` on one folder would change. A folder with a rule row is taken
 * as stored (also one gone from disk, or with a name the tree never shows: the admin edits that row); any other path as
 * the tree takes it (personal folders, .system/, temp names refused before anything is read), with its names on disk.
 * Nothing is saved; the rules are checked as a save checks them.
 */
export function explainEdit(ctx: AppContext, body: { path: string; rules: FolderRuleInput[] }, locale: Locale): FolderEditPreview {
  const db = ctx.db
  let p: string
  const row = getFolderByPath(db, body.path)
  if (row && !isParkedRow(row.path)) p = row.path
  else {
    const input = folderInput(body.path)
    if ('refuse' in input) return fail('validation', msg(input.refuse === 'personal' ? 'rulesInUsers' : 'accessNotTeamFolder', locale), { fields: { 'body.path': input.detail } })
    const w = walk(ctx.files.fx.root, input.segs, ctx.files.fx.caseInsensitive)
    // its names on disk (on a case-insensitive volume `Shared` typed as `shared` is that row's folder)
    p = [...w.actual, ...w.missing].join('/')
  }
  // rules inside users/ never apply (access.ts), and the admin API refuses them
  if (p === 'users' || p.startsWith('users/')) return fail('validation', msg('rulesInUsers', locale), { fields: { 'body.path': 'users/ cannot carry rules' } })
  validateRules(db, body.rules, locale)
  const state = captureState(db)
  const groupNames = new Map((db.query('SELECT id, name FROM groups').all() as { id: string; name: string }[]).map((g) => [g.id, g.name]))
  const userNames = new Map((db.query('SELECT id, name FROM users WHERE deleted_at IS NULL').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]))
  const segs = segsOf(p)
  const connected = segs.length >= 2 && segs[0] === 'connected' && !!db.query('SELECT 1 FROM connected_folders WHERE name = ?').get(segs[1]!)
  // people switched off: not counted, but what they would get when switched back on is (latentMore)
  const uncounted = (db.query("SELECT id, name, role FROM users WHERE status != 'active' AND deleted_at IS NULL").all() as { id: string; name: string; role: Role }[])
    .map((u) => ({ ...u, groups: groupsOf(ctx, u.id) }))
  const out = editPreview(
    { rules: state.rules, people: state.principals, uncounted, groupName: (id) => groupNames.get(id) ?? null, personName: (id) => userNames.get(id) ?? null },
    p, body.rules, { team: teamFolderOf(p, ctx.files.fx.caseInsensitive), chats: (id) => chatsWithEngineSession(db, id) },
  )
  return { path: p, exists: isDir(ctx.files.fx.root, segs, new Map()), connected, ...out }
}

/** Someone about to be invited: no id yet, so no person rule can name them and there is no personal folder row. */
export function explainNewPerson(ctx: AppContext, body: { role: Exclude<Role, 'owner'>; groupIds: string[] } & PageQ, locale: Locale): PersonAccessResponse {
  const groups = [...new Set(body.groupIds)]
  const known = new Set((ctx.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
  if (groups.some((g) => !known.has(g))) fail('validation', msg('unknownGroups', locale), { fields: { 'body.groupIds': 'unknown group' } })
  return personAccess(ctx, { id: '\u0000new-person', name: '', role: body.role, groups }, { user: null, status: null }, body)
}
