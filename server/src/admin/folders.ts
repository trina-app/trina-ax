// Folders and folder rules (tab 1 `folders` / `folder_rules`, tab 2 "폴더와 권한 규칙"). Rules hang on a folder id;
// folders.path is the actual on-disk name path (no trailing slash, '' = team root). Resolution itself is the
// stage-1 permission function (server/src/policy/access.ts); this file stores rules, previews changes ("who sees
// what") and, when someone loses read access, starts their chats on a fresh engine session (H7, tab 2 "권한 회수").
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Access, Folder, FolderRule, FolderRuleInput, Locale, PreviewResponse, Role } from '@mycel/shared/api'
import { PRODUCT, TEMPLATES_FOLDER } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { parseInput, walk } from '../policy/resolve'
import { msg } from '../auth/messages'
import { userRef } from '../auth/users'
import { audit } from './audit'
import { teamDefaultLocale } from './settings'
import { folderKeep, isParkedRow, type FolderKeep } from './folder-keep'
import { shownSegs } from './access-rows'
import { rulesHash } from './access-edit'
import { resetEngineSessions as resetChatSessions } from '../chat/runtime'
import { sharedChatsHidden } from '../chat/shared'
import { syncRoomsNow } from '../rooms/service'
import { recheckHistories } from '../rooms/history'
import { checkDriveShareOwners } from '../integrations/google-drive/shares'

export interface FolderRow { id: string; path: string; created_at: string }
interface RuleRow { id: string; folder_id: string; subject_type: FolderRule['subjectType']; subject_id: string | null; access: Access; updated_by: string | null; updated_at: string }
export interface RuleRowWithPath { path: string; subject_type: FolderRule['subjectType']; subject_id: string | null; access: Access }

const isUsersPath = (p: string) => p === 'users' || p.startsWith('users/')

/**
 * Resolve an admin-typed folder path to the actual on-disk names (case / Unicode form as stored on disk) and make
 * sure it may carry rules: not inside users/ (tab 2 rule 3), not .system, only allowed names, no symbolic links.
 * With `create`, missing folders are created (same name and near-duplicate checks as the file tools).
 */
export function resolveFolderPath(ctx: AppContext, rel: string, o: { create: boolean; locale: Locale }): { path: string; created: boolean } {
  if (isUsersPath(rel)) fail('validation', msg('rulesInUsers', o.locale), { fields: { 'body.path': 'users/ cannot carry rules' } })
  const owner: Principal = { id: '\u0000system', name: 'system', role: 'owner', groups: [] }
  let r
  try {
    r = authorize(ctx.files.fx, ctx.files.rules(), owner, rel, 'write', { mustExist: !o.create, createDirs: true })
  } catch (e) {
    if (e instanceof ToolError && e.code === 'not_found') fail('not_found', msg('folderMissing', o.locale))
    if (e instanceof Denied || e instanceof ToolError) fail('validation', undefined, { fields: { 'body.path': e.message } })
    throw e
  }
  if (isUsersPath(r.rel)) fail('validation', msg('rulesInUsers', o.locale), { fields: { 'body.path': 'users/ cannot carry rules' } })
  if (r.exists) {
    if (!r.st!.isDirectory()) fail('validation', undefined, { fields: { 'body.path': 'not a folder' } })
    return { path: r.rel, created: false }
  }
  fs.mkdirSync(r.abs, { recursive: true, mode: 0o700 })
  return { path: r.rel, created: true }
}

/** Best-effort actual-name path for previews (no creation, missing tail kept as typed). */
function previewPath(ctx: AppContext, rel: string, locale: Locale): string {
  if (isUsersPath(rel)) fail('validation', msg('rulesInUsers', locale), { fields: { 'body.changes': 'users/ cannot carry rules' } })
  let segs: string[]
  try { segs = parseInput(rel) } catch (e) { return fail('validation', undefined, { fields: { 'body.changes': (e as Error).message } }) }
  const w = walk(ctx.files.fx.root, segs, ctx.files.fx.caseInsensitive)
  const p = [...w.actual, ...w.missing].join('/')
  if (isUsersPath(p)) fail('validation', msg('rulesInUsers', locale), { fields: { 'body.changes': 'users/ cannot carry rules' } })
  return p
}

export function getFolder(db: Database, id: string): FolderRow | null {
  return db.query('SELECT id, path, created_at FROM folders WHERE id = ?').get(id) as FolderRow | null
}
export function getFolderByPath(db: Database, p: string): FolderRow | null {
  return db.query('SELECT id, path, created_at FROM folders WHERE path = ?').get(p) as FolderRow | null
}
export function ensureFolderRow(db: Database, p: string): FolderRow {
  const f = getFolderByPath(db, p)
  if (f) return f
  const row = { id: newId(), path: p, created_at: new Date().toISOString() }
  db.query('INSERT INTO folders (id, path, created_at) VALUES (?, ?, ?)').run(row.id, row.path, row.created_at)
  return row
}

/**
 * Remove a folders row (its rules go with it). Call inside a transaction. Trash items and versions stamped with it
 * (migration 301: the nearest folders row when they were made) are stamped with the nearest row above it instead, so
 * they keep following the folder they really sit in. For a row parked with a trashed folder (.system/trash/<m>/<id>/…)
 * only a row parked in the same trashed folder counts: with none, trash items keep the stamp of a row that no longer
 * exists and stay hidden (TeamFiles.trashHome), so they cannot fall through to whatever folder took the old name.
 */
export function dropFolderRow(db: Database, id: string): void {
  const f = getFolder(db, id)
  if (!f) return
  const segs = f.path === '' ? [] : f.path.split('/')
  const parked = segs[0] === PRODUCT.systemDir
  const floor = parked ? Math.min(4, segs.length) : 0 // .system/trash/<month>/<id> is the parked folder's own root
  let above: string | null = null
  for (let len = segs.length - 1; len >= floor && f.path !== ''; len--) {
    const row = getFolderByPath(db, segs.slice(0, len).join('/'))
    if (row) { above = row.id; break }
  }
  if (above !== null || !parked) {
    db.query('UPDATE trash_items SET folder_id = ? WHERE folder_id = ?').run(above, id)
    db.query('UPDATE file_versions SET folder_id = ? WHERE folder_id = ?').run(above, id)
  }
  db.query('UPDATE groups SET folder_id = NULL WHERE folder_id = ?').run(id)
  db.query('DELETE FROM folders WHERE id = ?').run(id)
}

/**
 * A rule-less folders row that only marked a project folder (createProject on an existing folder, a shared project
 * copy) once no project uses that path any more: dropped, so the folder stops being admin-only to move, rename or
 * trash. Kept when it carries rules, is a group's folder, is shared/ or skills/, or another project still uses it.
 * Call inside the transaction that deleted or repointed the project.
 */
export function dropProjectMarker(db: Database, p: string): void {
  if (p === '' || p === 'shared' || p === 'skills' || isUsersPath(p)) return
  const f = getFolderByPath(db, p)
  if (!f) return
  if (db.query('SELECT 1 FROM folder_rules WHERE folder_id = ? LIMIT 1').get(f.id)) return
  if (db.query('SELECT 1 FROM groups WHERE folder_id = ? LIMIT 1').get(f.id)) return
  if (db.query('SELECT 1 FROM projects WHERE folder_path = ? LIMIT 1').get(p)) return
  dropFolderRow(db, f.id)
}

/** projects/<name>: a team project folder whose participants its edit screen manages (one name below projects/;
 * chat/project-access.ts). */
export const isProjectsFolder = (p: string): boolean => { const s = p.split('/'); return s.length === 2 && s[0] === 'projects' && !!s[1] }

/** The folders that hold a rule of this subject (for keepProjectFloors). */
export const foldersWithRuleOf = (db: Database, subjectType: 'user' | 'group', id: string): string[] =>
  (db.query('SELECT DISTINCT folder_id FROM folder_rules WHERE subject_type = ? AND subject_id = ?').all(subjectType, id) as { folder_id: string }[]).map((r) => r.folder_id)

/**
 * Deleting a person or a group takes their rules away: a project folder in projects/ is never left with none (that
 * would open it to whoever reads the folder above; docs/DECISIONS.md "Projects live only in projects/"). Call inside the
 * transaction, after the delete, with foldersWithRuleOf() from before it: each that a project uses and that has no rule
 * left gets "everyone: none", so the project fails closed to the owner and admins.
 */
export function keepProjectFloors(db: Database, folderIds: readonly string[], actor: string | null): void {
  const now = new Date().toISOString()
  for (const id of folderIds) {
    const f = getFolder(db, id)
    if (!f || !isProjectsFolder(f.path)) continue
    if (db.query('SELECT 1 FROM folder_rules WHERE folder_id = ? LIMIT 1').get(id)) continue
    if (!db.query('SELECT 1 FROM projects WHERE folder_path = ? LIMIT 1').get(f.path)) continue
    db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, 'everyone', NULL, 'none', ?, ?)").run(newId(), id, actor, now)
  }
}

/** Rules must name existing subjects, at most once each. */
export function validateRules(db: Database, rules: readonly FolderRuleInput[], locale: Locale, field = 'body.rules'): void {
  const seen = new Set<string>()
  for (const [i, r] of rules.entries()) {
    const k = `${r.subjectType}:${r.subjectId ?? ''}`
    if (seen.has(k)) fail('validation', msg('duplicateRule', locale), { fields: { [`${field}.${i}`]: 'duplicate subject' } })
    seen.add(k)
    if (r.subjectType === 'group' && !db.query('SELECT 1 FROM groups WHERE id = ?').get(r.subjectId))
      fail('validation', msg('unknownGroups', locale), { fields: { [`${field}.${i}.subjectId`]: 'unknown group' } })
    if (r.subjectType === 'user' && !db.query('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(r.subjectId))
      fail('validation', msg('unknownUsers', locale), { fields: { [`${field}.${i}.subjectId`]: 'unknown person' } })
  }
}

/** Replace all rules of a folder (call inside a transaction). */
export function replaceRules(db: Database, folderId: string, rules: readonly FolderRuleInput[], actor: string | null): void {
  db.query('DELETE FROM folder_rules WHERE folder_id = ?').run(folderId)
  const now = new Date().toISOString()
  const ins = db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const r of rules) ins.run(newId(), folderId, r.subjectType, r.subjectId, r.access, actor, now)
}

export function rulesOf(db: Database, folderId: string): FolderRuleInput[] {
  return (db.query('SELECT subject_type, subject_id, access FROM folder_rules WHERE folder_id = ? ORDER BY subject_type, subject_id').all(folderId) as RuleRow[])
    .map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }) as FolderRuleInput)
}

export function toFolder(ctx: AppContext, f: FolderRow): Folder {
  const rows = ctx.db.query('SELECT id, folder_id, subject_type, subject_id, access, updated_by, updated_at FROM folder_rules WHERE folder_id = ? ORDER BY subject_type, subject_id').all(f.id) as RuleRow[]
  // a real folder at every step, as the tree lists them (a link anywhere on the way is not there): a row under a
  // folder that became a link is listed with the folders not in the tree, not taken for one in it
  let exists = true
  let cur = ctx.files.fx.root
  for (const seg of f.path ? f.path.split('/') : []) {
    cur = path.join(cur, seg)
    try { if (!fs.lstatSync(cur).isDirectory()) { exists = false; break } } catch { exists = false; break }
  }
  const groupId = groupOfFolder(ctx.db, f.id)
  return {
    id: f.id,
    path: f.path,
    exists,
    createdAt: f.created_at,
    rules: rows.map((r) => ({ id: r.id, folderId: r.folder_id, subjectType: r.subject_type, subjectId: r.subject_id, access: r.access, updatedBy: userRef(ctx.db, r.updated_by), updatedAt: r.updated_at })),
    groupId,
    keep: folderKeep(f.path, groupId, ctx.files.fx.caseInsensitive),
    // the folder answers never show it (access-rows.ts): the tree lists such a row apart
    hidden: shownSegs(f.path) === null,
    // a save sends it back (expectedHash): another admin's change in between is refused, not undone unseen
    rulesHash: rulesHash(rows.map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))),
  }
}

/** The hash of a folder's rules now, by path (no row or no rules: the hash of none), as `Folder.rulesHash` says it. */
export function rulesHashAt(db: Database, p: string): string {
  const f = getFolderByPath(db, p)
  return rulesHash(f ? rulesOf(db, f.id) : [])
}

/** Why the admin API keeps this row (folder-keep.ts): 'team' for shared/ and skills/ (in any case on a case-insensitive
 * volume, exactly elsewhere), 'group' for a group's folder, null when it may go. */
export function keepOfRow(ctx: AppContext, f: FolderRow): FolderKeep | null {
  return folderKeep(f.path, groupOfFolder(ctx.db, f.id), ctx.files.fx.caseInsensitive)
}

/**
 * The actual-name path an admin-typed path stands for, as resolveFolderPath would store it, without creating anything
 * (a missing tail stays as typed). null: not a valid path (resolveFolderPath then says why).
 */
export function actualFolderPath(ctx: AppContext, rel: string): string | null {
  try {
    const w = walk(ctx.files.fx.root, parseInput(rel), ctx.files.fx.caseInsensitive)
    return [...w.actual, ...w.missing].join('/')
  } catch {
    return null
  }
}

export function groupOfFolder(db: Database, folderId: string): string | null {
  return (db.query('SELECT id FROM groups WHERE folder_id = ? ORDER BY id LIMIT 1').get(folderId) as { id: string } | null)?.id ?? null
}

/** Folders that carry rules (and folders rows without rules, e.g. after all rules were removed by a group delete). */
export function listFolders(ctx: AppContext): Folder[] {
  return (ctx.db.query('SELECT id, path, created_at FROM folders ORDER BY path').all() as FolderRow[]).filter((f) => !isParkedRow(f.path)).map((f) => toFolder(ctx, f))
}

// ---------------- effective access: snapshots, diffs, preview ----------------

export interface AccessState {
  principals: Principal[]
  rules: RuleSet
}

/** Active people (with groups) and the current rules. */
export function captureState(db: Database): AccessState {
  const users = db.query("SELECT id, name, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY name, id").all() as { id: string; name: string; role: Role }[]
  const mem = db.query('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[]
  const groups = new Map<string, string[]>()
  for (const m of mem) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return { principals: users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] })), rules: RuleSet.load(db) }
}

export function ruleRows(db: Database): RuleRowWithPath[] {
  return db.query('SELECT f.path, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id').all() as RuleRowWithPath[]
}

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

/**
 * Paths whose access decides access everywhere: the team root plus every folder that carries rules in either state.
 * Outside users/, access at any path equals the access at its deepest rule folder, or at the root when no rule
 * folder is above it (owner / admin: write everywhere). The root matters when someone loses the admin role: the
 * folders without rules they could read are only covered by it.
 */
function decidingPaths(before: AccessState, after: AccessState, extraPaths: readonly string[] = []): string[] {
  return [...new Set(['', ...before.rules.ruleFolders(), ...after.rules.ruleFolders(), ...extraPaths])].filter((p) => !isUsersPath(p)).sort()
}

/** For every person present in both states, the top-most folders where they could read before and cannot now. */
export function readLosses(before: AccessState, after: AccessState, extraPaths: readonly string[] = []): Map<string, string[]> {
  const paths = decidingPaths(before, after, extraPaths)
  const afterBy = new Map(after.principals.map((p) => [p.id, p]))
  const out = new Map<string, string[]>()
  for (const pb of before.principals) {
    const pa = afterBy.get(pb.id)
    if (!pa) continue
    const lost: string[] = []
    for (const p of paths) {
      const s = segsOf(p)
      if (atLeast(before.rules.access(pb, s), 'read') && !atLeast(after.rules.access(pa, s), 'read')) lost.push(p)
    }
    // report only the top-most lost folders (a lost subtree is one entry)
    const top = lost.filter((p) => !lost.some((q) => q !== p && (q === '' || p.startsWith(q + '/'))))
    if (top.length) out.set(pb.id, top)
  }
  return out
}

export interface AccessChange { path: string; before: Access; after: Access }
/** The states afterAccessChange compared, filled in for a caller that asks (`by.seen`). */
export interface SeenStates { before?: AccessState; after?: AccessState }

/**
 * readLosses() in both directions: for every person present in both states, each deciding folder where their access
 * is not what it was (gained, lost, read <-> write), top-most only (a folder below one with the same change is left
 * out). The same deciding folders and the same permission function as readLosses(); nothing is saved. The connector's
 * group tools say this in words after a change.
 */
export function accessChanges(before: AccessState, after: AccessState): Map<string, AccessChange[]> {
  const paths = decidingPaths(before, after)
  const afterBy = new Map(after.principals.map((p) => [p.id, p]))
  const out = new Map<string, AccessChange[]>()
  for (const pb of before.principals) {
    const pa = afterBy.get(pb.id)
    if (!pa) continue
    const changed: AccessChange[] = []
    for (const p of paths) {
      const s = segsOf(p), b = before.rules.access(pb, s), a = after.rules.access(pa, s)
      if (a !== b) changed.push({ path: p, before: b, after: a })
    }
    const top = changed.filter((c) => !changed.some((d) => d !== c && d.before === c.before && d.after === c.after && (d.path === '' || c.path.startsWith(d.path + '/'))))
    if (top.length) out.set(pb.id, top)
  }
  return out
}

/**
 * H7: the person's chats start a fresh engine session at the next turn (the stashed session may hold file contents
 * they can no longer read; the conversation continues from the DB history). Returns how many chats were reset.
 */
export function resetEngineSessions(ctx: AppContext, userId: string): number {
  // one implementation (chat runtime): it also keeps turns running right now from storing their session at the end
  return resetChatSessions(ctx, userId)
}

export function chatsWithEngineSession(db: Database, userId: string): number {
  // as chat/runtime.ts resetEngineSessions resets them: their own chats and the shared chats whose session they wrote
  return (db.query(`SELECT COUNT(*) AS n FROM (SELECT id FROM chats WHERE user_id = ? AND engine_session_id IS NOT NULL
    UNION SELECT c.id FROM chats c JOIN messages m ON m.id = c.engine_session_leaf_id JOIN turns t ON t.id = m.turn_id
    WHERE t.user_id = ? AND c.engine_session_id IS NOT NULL)`).get(userId, userId) as { n: number }).n
}

/**
 * After any change that can narrow access (rules, group membership, role): reset the engine sessions of people who
 * lost read access somewhere, tell their open windows, and return who lost what (for the audit record).
 * `created`: folders made on disk by this same request (a new rule folder): nobody knew them before the change.
 * `via`: where the change came from when not the web screens (the audit line says so). `seen`: the caller wants the
 * two states (the connector's group tools say what changed from them instead of taking them again).
 */
export function afterAccessChange(ctx: AppContext, before: AccessState, by: { actor: string | null; target: string | null; created?: readonly string[]; via?: string; seen?: SeenStates }): { userId: string; paths: string[]; chatsReset: number }[] {
  const after = captureState(ctx.db)
  if (by.seen) { by.seen.before = before; by.seen.after = after }
  const losses = readLosses(before, after)
  const out: { userId: string; paths: string[]; chatsReset: number }[] = []
  for (const [userId, paths] of losses) {
    const chatsReset = resetEngineSessions(ctx, userId)
    out.push({ userId, paths, chatsReset })
  }
  // every person whose access changed in a way they can tell re-reads open folders (tab 5 "권한 회수")
  const paths = decidingPaths(before, after)
  const created = new Set(by.created ?? [])
  const onDisk = (p: string) => { try { return fs.lstatSync(path.join(ctx.files.fx.root, ...segsOf(p))).isDirectory() } catch { return false } }
  // Replay buffers: events in a person's buffer were filtered by the access they had when each was published. Whoever's
  // access changed (or who appeared / disappeared: enabled, disabled, deleted) loses that history BEFORE the notice
  // below, so a window resuming from before this point is told to reload over REST and never gets the names of files
  // in a folder they were just removed from (security round 2, realtime #1).
  const beforeIds = new Set(before.principals.map((p) => p.id))
  for (const pa of after.principals) if (!beforeIds.has(pa.id)) ctx.services.realtime.forgetReplay(pa.id)
  // whose access changed: the old answers hidden from them in team rooms and the everyone room are checked again on
  // the rooms' next pass (rooms/history.ts: only fewer, never more)
  const accessChanged: string[] = []
  for (const pb of before.principals) {
    const pa = after.principals.find((p) => p.id === pb.id)
    if (!pa) { ctx.services.realtime.forgetReplay(pb.id); continue }
    const changed = paths.filter((p) => before.rules.access(pb, segsOf(p)) !== after.rules.access(pa, segsOf(p)))
    if (changed.length) { ctx.services.realtime.forgetReplay(pb.id); accessChanged.push(pb.id) }
    const named = changed.filter((p) => noticeMayName(p, pb, pa, before, after, created, onDisk))
    if (named.length) ctx.services.realtime.publish(pb.id, { type: 'notice', data: { level: 'info', code: 'access_changed', message: named.map((p) => p || '/').join(', ') } })
  }
  // shared project chats follow their project's audience (chat/shared.ts): whoever no longer sees one has it dropped from
  // their lists and project pages, by its id alone (the chat's details never go to someone who cannot see it). After
  // the replay buffers above were emptied, so a window resuming gets these too. Never throws: the change is saved
  try {
    const afterIds = new Set(after.principals.map((p) => p.id))
    const who = new Set([...accessChanged, ...before.principals.filter((p) => !afterIds.has(p.id)).map((p) => p.id)])
    for (const [userId, chats] of sharedChatsHidden(ctx.db, before, after, who)) for (const chatId of chats) ctx.services.realtime.publish(userId, { type: 'chat.updated', data: { chatId, change: 'deleted', chat: null } })
  } catch (e) { ctx.log.warn('shared chat removals failed', { err: e }) }
  // every narrowing is audited, whatever caused it (rules, group membership, role, group deletion); admins only read it
  if (out.length) audit(ctx.db, { actor: by.actor, action: 'folder.access_lost', target: by.target, detail: { losing: out, ...(by.via ? { via: by.via } : {}) } })
  // team rooms and the everyone room follow groups and accounts (rooms/service.ts sync; it never throws)
  recheckHistories(ctx, accessChanged)
  syncRoomsNow(ctx)
  // a Drive shared with the team stops when its admin is disabled, deleted or no longer an admin
  checkDriveShareOwners(ctx)
  return out
}

/**
 * The access_changed notice goes to one person and names folders: only folders that person can see now, or could see
 * before the change. A restricted folder created in this request (or a rule folder that is not on disk) changes the
 * INHERITED access of everyone it is hidden from (shared/ everyone write -> none at that path), but they never saw it:
 * naming it would tell every member what the folder they may not see is called.
 */
export function noticeMayName(p: string, pb: Principal, pa: Principal, before: AccessState, after: AccessState, created: ReadonlySet<string>, onDisk: (p: string) => boolean): boolean {
  if (p === '') return true
  if (!onDisk(p)) return false
  if (atLeast(after.rules.access(pa, segsOf(p)), 'read')) return true
  return !created.has(p) && atLeast(before.rules.access(pb, segsOf(p)), 'read')
}

/** "Who sees what" for proposed rule sets, before saving. */
export function previewRules(ctx: AppContext, changes: readonly { path: string; rules: FolderRuleInput[] }[], locale: Locale): PreviewResponse {
  const before = captureState(ctx.db)
  const proposed = new Map<string, FolderRuleInput[]>()
  for (const [i, ch] of changes.entries()) {
    validateRules(ctx.db, ch.rules, locale, `body.changes.${i}.rules`)
    proposed.set(previewPath(ctx, ch.path, locale), ch.rules)
  }
  const rows = ruleRows(ctx.db).filter((r) => !proposed.has(r.path))
  for (const [p, rules] of proposed) for (const r of rules) rows.push({ path: p, subject_type: r.subjectType, subject_id: r.subjectId, access: r.access })
  const after: AccessState = { principals: before.principals, rules: new RuleSet(rows) }

  const folders: PreviewResponse['folders'] = []
  const listed = new Set<string>()
  const row = (p: string) => ({
    path: p,
    users: before.principals.map((u) => ({ user: { id: u.id, name: u.name }, role: u.role, before: before.rules.access(u, segsOf(p)), after: after.rules.access(u, segsOf(p)) })),
  })
  for (const p of proposed.keys()) { folders.push(row(p)); listed.add(p) }
  // rule folders below a changed folder whose effective access changes for someone (inherited rules)
  const below = [...new Set([...before.rules.ruleFolders(), ...after.rules.ruleFolders()])].filter((q) => !listed.has(q) && !isUsersPath(q) && [...proposed.keys()].some((p) => p === '' || q.startsWith(p + '/'))).sort()
  for (const q of below) {
    const r = row(q)
    if (r.users.some((u) => u.before !== u.after)) folders.push(r)
  }
  const losses = readLosses(before, after, [...proposed.keys()])
  const losing = [...losses].map(([userId, paths]) => {
    const p = before.principals.find((x) => x.id === userId)!
    return { user: { id: p.id, name: p.name }, paths, chatsReset: chatsWithEngineSession(ctx.db, userId) }
  })
  return { folders, losing }
}

/** Default folders of a new team (tab 2 "폴더 만들기와 기본 규칙"), and shared/양식/ for forms and templates
 * (docs/DECISIONS.md "Team folder basics"). Safe to run again: nothing that is there is changed. */
export function createDefaultFolders(ctx: AppContext): void {
  const root = ctx.files.fx.root
  for (const d of ['shared', 'skills', 'groups', 'projects', 'users']) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 })
  ensureTemplatesFolder(root, teamDefaultLocale(ctx.db))
  const shared = ensureFolderRow(ctx.db, 'shared')
  if (!rulesOf(ctx.db, shared.id).length) replaceRules(ctx.db, shared.id, [{ subjectType: 'everyone', subjectId: null, access: 'write' }], null)
  const skills = ensureFolderRow(ctx.db, 'skills')
  if (!rulesOf(ctx.db, skills.id).length) replaceRules(ctx.db, skills.id, [{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'role', subjectId: 'admin', access: 'write' }], null)
}

/**
 * shared/양식/ (TEMPLATES_FOLDER, named in the team's language): the place the AI's instructions point to for forms and
 * templates (chat/prompt.ts templatesFolder). Made only when shared/ holds no templates folder under any language's name
 * (NFC, any letter case: "templates" counts), so a team that has one never gets a second. It inherits shared/'s rule (no folder row). Returns the folder made, or null.
 */
export function ensureTemplatesFolder(root: string, locale: Locale): string | null {
  const shared = path.join(root, 'shared')
  let names: string[]
  try { names = fs.readdirSync(shared) } catch { return null }
  const fold = (n: string) => n.normalize('NFC').toLowerCase()
  const known = new Set(Object.values(TEMPLATES_FOLDER).map(fold))
  if (names.some((n) => known.has(fold(n)))) return null
  const name = TEMPLATES_FOLDER[locale] ?? TEMPLATES_FOLDER.en
  fs.mkdirSync(path.join(shared, name), { mode: 0o700 })
  return `shared/${name}`
}
