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
import { atLeast, isManagedMarker, isProjectsName, isZoneTop, RuleSet, SYSTEM_PRINCIPAL, type Principal } from '../policy/access'
import { projectJoins } from '../chat/project-joins'
import { insideProject, inZone } from '../policy/zone'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { parseInput, walk } from '../policy/resolve'
import { msg } from '../auth/messages'
import { userRef } from '../auth/users'
import { audit } from './audit'
import { teamDefaultLocale } from './settings'
import { failOnePlace, guestPlace, guestsAmong, projectFolder } from '../auth/guests'
import { folderKeep, isParkedRow, type FolderKeep } from './folder-keep'
import { shownSegs } from './access-rows'
import { rulesHash, rulesHashV1 } from './access-edit'
import { resetEngineSessions as resetChatSessions, stopTurnsIn } from '../chat/runtime'
import { sharedChatsHidden } from '../chat/shared'
import { peopleChatsLost } from '../chat/chat-audience'
import { syncRoomsNow } from '../rooms/service'
import { recheckHistories } from '../rooms/history'
import { checkDriveShareOwners } from '../integrations/google-drive/shares'

export interface FolderRow { id: string; path: string; created_at: string; limited?: number }
interface RuleRow { id: string; folder_id: string; subject_type: FolderRule['subjectType']; subject_id: string | null; access: Access; updated_by: string | null; updated_at: string; origin?: string | null }

const isUsersPath = (p: string) => p === 'users' || p.startsWith('users/')

/**
 * Resolve an admin-typed folder path to the actual on-disk names (case / Unicode form as stored on disk) and make
 * sure it may carry rules: not inside users/ (tab 2 rule 3), not .system, only allowed names, no symbolic links.
 * With `create`, missing folders are created (same name and near-duplicate checks as the file tools).
 */
export function resolveFolderPath(ctx: AppContext, rel: string, o: { create: boolean; locale: Locale }): { path: string; created: boolean } {
  if (isUsersPath(rel)) fail('validation', msg('rulesInUsers', o.locale), { fields: { 'body.path': 'users/ cannot carry rules' } })
  const owner = SYSTEM_PRINCIPAL
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
  return db.query('SELECT id, path, created_at, limited FROM folders WHERE id = ?').get(id) as FolderRow | null
}
export function getFolderByPath(db: Database, p: string): FolderRow | null {
  return db.query('SELECT id, path, created_at, limited FROM folders WHERE path = ?').get(p) as FolderRow | null
}
/** The folder cuts what comes from the folders above (Limit access). */
export const isLimited = (db: Database, folderId: string): boolean => !!db.query('SELECT 1 FROM folders WHERE id = ? AND limited = 1').get(folderId)
/**
 * The folder row carries access settings: rules (the managed marker included) or a limit. Such a row is never dropped
 * as an empty one, and keeps the folder admin-only to move, rename or trash (team-files managedRows).
 */
export const hasAccessSettings = (db: Database, folderId: string): boolean =>
  !!db.query('SELECT 1 FROM folders WHERE id = ? AND limited = 1').get(folderId) || !!db.query('SELECT 1 FROM folder_rules WHERE folder_id = ? LIMIT 1').get(folderId)
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
  if (hasAccessSettings(db, f.id)) return
  if (db.query('SELECT 1 FROM groups WHERE folder_id = ? LIMIT 1').get(f.id)) return
  if (db.query('SELECT 1 FROM projects WHERE folder_path = ? LIMIT 1').get(p)) return
  dropFolderRow(db, f.id)
}

/**
 * Admin › Folder permissions never writes, previews or answers about a folder at or under projects/<name> (docs/
 * DECISIONS.md "Project contents only for members"): a project's members are changed on its page, where they show and
 * are told. Checked first, on the path as typed (letter case and Unicode form folded), before anything is looked up on
 * disk, with one answer whether the path is there or not (security review M3, M6).
 */
export function assertNotInProject(rel: unknown, locale: Locale, field = 'body.path'): void {
  if (typeof rel !== 'string') return
  if (inZone(rel.replace(/\\/g, '/').trim())) fail('conflict', msg('projectMembersOnly', locale), { fields: { [field]: 'project_members_only' }, params: { reason: 'project_members_only' } })
}

/** projects/<name>: a team project folder whose participants its edit screen manages (one name below projects/, as the
 * members-only zone compares it: policy/access.ts isProjectsName; chat/project-access.ts). */
export const isProjectsFolder = (p: string): boolean => { const s = p.split('/'); return s.length === 2 && isProjectsName(s[0]) && !!s[1] }

/** The folders that hold a rule of this subject (for keepProjectFloors). */
export const foldersWithRuleOf = (db: Database, subjectType: 'user' | 'group', id: string): string[] =>
  (db.query('SELECT DISTINCT folder_id FROM folder_rules WHERE subject_type = ? AND subject_id = ?').all(subjectType, id) as { folder_id: string }[]).map((r) => r.folder_id)

/**
 * Deleting a person or a group takes their rules away: a project folder in projects/ is always limited (invariant 5),
 * so it never opens to whoever reads the folder above (docs/DECISIONS.md "Projects live only in projects/"). Call inside
 * the transaction, after the delete, with foldersWithRuleOf() from before it: each that a project uses and is not
 * limited (an older build's) is limited now, so the project fails closed to the owner and admins.
 */
export function keepProjectFloors(db: Database, folderIds: readonly string[], actor: string | null): void {
  for (const id of folderIds) {
    const f = getFolder(db, id)
    if (!f || !isProjectsFolder(f.path) || f.limited === 1) continue
    if (!db.query('SELECT 1 FROM projects WHERE folder_path = ? LIMIT 1').get(f.path)) continue
    writeFolderAccess(db, id, { rules: rulesOf(db, id).filter((r) => r.access !== 'none'), limited: true }, actor)
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

/**
 * THE way folder access is written (call inside a transaction; docs/DECISIONS.md "Folder access adds up like Google
 * Drive (P2)"). `rules`: the folder's rules as the API has them: people, groups and everyone with view or edit. A "no
 * access" or a role rule here is a bug, not input (the API answers 400 before): it throws, and the database triggers
 * refuse it anyway. `limited`: omitted keeps the folder's current value (a new row: not limited); only true or false
 * changes it. The markers follow: the legacy marker everyone: none on a limited folder without an everyone rule (what
 * an older reader reads as the cut), the managed marker role: admin: write kept unless `managed` is false (true writes
 * one). A project exception (a person's own none on projects/<name>) stays unless `rules` names that person (added back
 * by name). A person rule saved with the same access keeps its origin (C1-A: an unrelated edit never strips it).
 */
export function writeFolderAccess(db: Database, folderId: string, next: { rules: readonly FolderRuleInput[]; limited?: boolean; managed?: boolean }, actor: string | null): void {
  for (const r of next.rules) {
    if (r.access === 'none') throw new Error('writeFolderAccess: a "no access" rule (only the project exception, through setProjectException)')
    if ((r.subjectType as string) === 'role') throw new Error('writeFolderAccess: a role rule (only the managed marker, through `managed`)')
  }
  const f = getFolder(db, folderId)
  if (!f) throw new Error('writeFolderAccess: no such folder row')
  guestRulesInPlace(db, f.path, folderId, next.rules)
  const limited = next.limited ?? f.limited === 1
  if ((f.limited === 1) !== limited) db.query('UPDATE folders SET limited = ? WHERE id = ?').run(limited ? 1 : 0, folderId)
  const existing = db.query('SELECT id, subject_type, subject_id, access, origin FROM folder_rules WHERE folder_id = ?').all(folderId) as { id: string; subject_type: string; subject_id: string | null; access: Access; origin: string | null }[]
  const key = (t: string, id: string | null) => `${t}\u0000${id ?? ''}`
  const want = new Map<string, { subject_type: string; subject_id: string | null; access: Access; origin: string | null }>()
  for (const r of next.rules) {
    const was = existing.find((e) => e.subject_type === r.subjectType && e.subject_id === r.subjectId)
    want.set(key(r.subjectType, r.subjectId), { subject_type: r.subjectType, subject_id: r.subjectId, access: r.access, origin: was && was.access === r.access ? was.origin : null })
  }
  for (const e of existing) {
    if (e.subject_type === 'user' && e.access === 'none' && e.subject_id && isZoneTop(f.path) && !want.has(key('user', e.subject_id))) want.set(key('user', e.subject_id), { ...e })
    if (isManagedMarker({ subjectType: e.subject_type, subjectId: e.subject_id, access: e.access }) && next.managed !== false) want.set(key('role', 'admin'), { ...e })
  }
  if (next.managed === true) want.set(key('role', 'admin'), { subject_type: 'role', subject_id: 'admin', access: 'write', origin: null })
  if (limited && !next.rules.some((r) => r.subjectType === 'everyone')) want.set(key('everyone', null), { subject_type: 'everyone', subject_id: null, access: 'none', origin: null })
  const now = new Date().toISOString()
  for (const e of existing) {
    const w = want.get(key(e.subject_type, e.subject_id))
    if (!w) { db.query('DELETE FROM folder_rules WHERE id = ?').run(e.id); continue }
    if (w.access !== e.access || (w.origin ?? null) !== (e.origin ?? null)) db.query('UPDATE folder_rules SET access = ?, origin = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(w.access, w.origin ?? null, actor, now, e.id)
    want.delete(key(e.subject_type, e.subject_id))
  }
  const ins = db.query('INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const w of want.values()) ins.run(newId(), folderId, w.subject_type, w.subject_id, w.access, actor, now, w.origin ?? null)
}

/**
 * One place per guest (docs/DECISIONS.md "Guests: only what they were invited to"): a person rule that gives a guest
 * access is written only at or below their own project's folder. A new one anywhere else (the members panel, the AI's
 * change_project_members, Admin › Folder permissions, a new project's people) is refused in the same write with 409
 * guest_one_place; a rule they already have there may be kept or changed.
 */
function guestRulesInPlace(db: Database, folderPath: string, folderId: string, rules: readonly FolderRuleInput[]): void {
  const named = rules.filter((r) => r.subjectType === 'user' && r.subjectId && r.access !== 'none').map((r) => r.subjectId!)
  for (const id of guestsAmong(db, named)) {
    if (db.query("SELECT 1 FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ? AND access <> 'none'").get(folderId, id)) continue
    const place = guestPlace(db, id)
    const own = place?.kind === 'project' ? projectFolder(db, place.id) : null
    if (!own || !(folderPath === own || folderPath.startsWith(own + '/'))) failOnePlace(teamDefaultLocale(db))
  }
}

/**
 * The project exception (docs/DECISIONS.md "Leaving a project"): a person's own "no access" on projects/<name>, which
 * keeps them out of that folder and everything in it whatever else applies (a group, everyone). `on` false takes it
 * away. Only on a depth-2 zone folder; call inside a transaction.
 */
export function setProjectException(db: Database, folderId: string, userId: string, on: boolean, actor: string | null): void {
  const f = getFolder(db, folderId)
  if (!f || !isZoneTop(f.path)) throw new Error('setProjectException: not a projects/<name> folder')
  const was = db.query("SELECT id, access FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ?").get(folderId, userId) as { id: string; access: Access } | null
  const now = new Date().toISOString()
  if (on) {
    if (was) db.query("UPDATE folder_rules SET access = 'none', origin = NULL, updated_by = ?, updated_at = ? WHERE id = ?").run(actor, now, was.id)
    else db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access, updated_by, updated_at) VALUES (?, ?, 'user', ?, 'none', ?, ?)").run(newId(), folderId, userId, actor, now)
  } else if (was?.access === 'none') db.query('DELETE FROM folder_rules WHERE id = ?').run(was.id)
}

/** A folder's rules as stored, without the two markers (the legacy marker everyone: none, the managed marker role:
 * admin: write). A project's exceptions (a person's own none on projects/<name>) are in it. */
export function rulesOf(db: Database, folderId: string): FolderRuleInput[] {
  return (db.query('SELECT subject_type, subject_id, access FROM folder_rules WHERE folder_id = ? ORDER BY subject_type, subject_id').all(folderId) as RuleRow[])
    .filter((r) => !(r.subject_type === 'everyone' && r.access === 'none') && !isManagedMarker({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
    .map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }) as FolderRuleInput)
}

export function toFolder(ctx: AppContext, f: FolderRow): Folder {
  // the rules as the API shows them: without the markers and the project exceptions (policy/access.ts rulesAt)
  const rows = (ctx.db.query('SELECT id, folder_id, subject_type, subject_id, access, updated_by, updated_at, origin FROM folder_rules WHERE folder_id = ? ORDER BY subject_type, subject_id').all(f.id) as RuleRow[])
    .filter((r) => r.access !== 'none' && !isManagedMarker({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access }))
  const limited = isLimited(ctx.db, f.id)
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
    rules: rows.map((r) => ({ id: r.id, folderId: r.folder_id, subjectType: r.subject_type, subjectId: r.subject_id, access: r.access, updatedBy: userRef(ctx.db, r.updated_by), updatedAt: r.updated_at, ...(r.origin ? { byConversion: true } : {}) })),
    limited,
    groupId,
    keep: folderKeep(f.path, groupId, ctx.files.fx.caseInsensitive),
    // the folder answers never show it (access-rows.ts): the tree lists such a row apart
    hidden: shownSegs(f.path) === null,
    // a save sends it back (expectedHash): another admin's change in between is refused, not undone unseen
    rulesHash: rulesHash(rows.map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access })), limited),
  }
}

/** The hash of a folder's rules now, by path (no row or no rules: the hash of none), as `Folder.rulesHash` says it. */
export function rulesHashAt(db: Database, p: string): string {
  const f = getFolderByPath(db, p)
  return rulesHash(f ? rulesOf(db, f.id).filter((r) => r.access !== 'none') : [], f?.limited === 1)
}
/** The hash a page from before the limit (rules-v1) sends for this folder now. */
export function rulesHashV1At(db: Database, p: string): string {
  const f = getFolderByPath(db, p)
  return rulesHashV1(f ? (db.query('SELECT subject_type, subject_id, access FROM folder_rules WHERE folder_id = ?').all(f.id) as RuleRow[]).map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, access: r.access })) : [])
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
  // nothing inside a team project: its folder is one row (docs/DECISIONS.md "Project contents only for members")
  return (ctx.db.query('SELECT id, path, created_at, limited FROM folders ORDER BY path').all() as FolderRow[]).filter((f) => !isParkedRow(f.path) && !insideProject(f.path)).map((f) => toFolder(ctx, f))
}

// ---------------- effective access: snapshots, diffs, preview ----------------

export interface AccessState {
  principals: Principal[]
  rules: RuleSet
}

/** Active people (with groups) and the current rules. */
export function captureState(db: Database): AccessState {
  const users = db.query("SELECT id, name, CASE WHEN guest = 1 THEN 'guest' ELSE role END AS role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY name, id").all() as { id: string; name: string; role: Role }[]
  const mem = db.query('SELECT group_id, user_id FROM group_members').all() as { group_id: string; user_id: string }[]
  const groups = new Map<string, string[]>()
  for (const m of mem) groups.set(m.user_id, [...(groups.get(m.user_id) ?? []), m.group_id])
  return { principals: users.map((u) => ({ ...u, groups: groups.get(u.id) ?? [] })), rules: RuleSet.load(db) }
}

const segsOf = (p: string) => (p === '' ? [] : p.split('/'))

/**
 * Paths whose access decides access everywhere: the team root plus every folder that carries rules in either state.
 * Outside users/, access at any path equals the access at its deepest rule folder, or at the root when no rule
 * folder is above it (owner / admin: write everywhere). The root matters when someone loses the admin role: the
 * folders without rules they could read are only covered by it.
 */
function decidingPaths(before: AccessState, after: AccessState, extraPaths: readonly string[] = []): string[] {
  return [...new Set(['', ...before.rules.boundaryFolders(), ...after.rules.boundaryFolders(), ...extraPaths])].filter((p) => !isUsersPath(p)).sort()
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
export interface SeenStates { before?: AccessState; after?: AccessState; originKept?: OriginKept[] }

/**
 * A person rule the one-time conversion wrote (C1-A, `folder_rules.origin`) that stays after a group change of that
 * person: Drive keeps access given by name, so it is said instead (docs/DECISIONS.md "Folder access adds up like Google
 * Drive (P2)"): Admin › Groups and the person's page warn before saving, the connector's group tools say it, the audit
 * row records it. `path` is the folder, `groupId` the group whose membership changed.
 */
export interface OriginKept { userId: string; name: string; path: string; access: Access; groupId: string }
/** The person rules with an origin naming one of `changes`' groups for that person (each change: the person joins or
 * leaves the group, or the group goes). */
export function originKeepers(db: Database, changes: readonly { userId: string; groupId: string }[]): OriginKept[] {
  if (!changes.length) return []
  const out: OriginKept[] = []
  const byUser = new Map<string, Set<string>>()
  for (const c of changes) byUser.set(c.userId, (byUser.get(c.userId) ?? new Set()).add(c.groupId))
  const q = db.query("SELECT f.path, r.subject_id, r.access, r.origin, u.name FROM folder_rules r JOIN folders f ON f.id = r.folder_id JOIN users u ON u.id = r.subject_id WHERE r.subject_type = 'user' AND r.subject_id = ? AND r.origin IS NOT NULL")
  for (const [userId, groups] of byUser) {
    for (const r of q.all(userId) as { path: string; subject_id: string; access: Access; origin: string; name: string }[]) {
      if (isParkedRow(r.path)) continue
      let named: { id: string }[] = []
      try { named = (JSON.parse(r.origin) as { groups?: { id: string }[] }).groups ?? [] } catch { continue }
      const hit = named.find((g) => groups.has(g.id))
      if (hit) out.push({ userId, name: r.name, path: r.path, access: r.access, groupId: hit.id })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
/**
 * The one-time Admin notice after the conversion: the folders it listed people on by name (its audit row), those still
 * there and not in the trash, until an owner or admin dismisses it (one setting for the team).
 */
export const FOLDER_ACCESS_NOTICE_DISMISSED = 'folder_access_notice_dismissed'
export function folderAccessNotice(db: Database): { at: string; folders: { path: string; count: number }[] } | null {
  const row = db.query("SELECT detail, at FROM audit_log WHERE action = 'folders.additive_conversion' ORDER BY id DESC LIMIT 1").get() as { detail: string | null; at: string } | null
  if (!row?.detail) return null
  const dismissed = db.query('SELECT value FROM settings WHERE key = ?').get(FOLDER_ACCESS_NOTICE_DISMISSED) as { value: string } | null
  if (dismissed) return null
  let byName: { path: string; count: number }[] = []
  try { byName = (JSON.parse(row.detail) as { byName?: { path: string; count: number }[] }).byName ?? [] } catch { return null }
  const folders = byName.filter((b) => b.count > 0 && !isParkedRow(b.path) && !insideProject(b.path) && !!getFolderByPath(db, b.path)).map((b) => ({ path: b.path, count: b.count }))
  return folders.length ? { at: new Date(row.at.endsWith('Z') ? row.at : row.at + 'Z').toISOString(), folders } : null
}

/** What one line says about them (the connector's group tools; English, as the tools answer). */
export function originKeptText(kept: readonly OriginKept[]): string {
  if (!kept.length) return ''
  const shown = kept.slice(0, 10).map((k) => `${k.name} can still ${k.access === 'write' ? 'edit' : 'open'} "${k.path}"`)
  return `Kept by name (added when folders changed, so a group change does not take it away): ${shown.join('; ')}${kept.length > 10 ? `; and ${kept.length - 10} more` : ''}. An admin can remove such a rule in Folder permissions.`
}

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
  // who started to see a team project: audited and told to its members (chat/project-joins.ts)
  projectJoins(ctx, before, after, { actor: by.actor, via: by.via ?? 'access' })
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
    for (const [userId, chats] of sharedChatsHidden(ctx.db, before, after, who)) {
      // their own turn there stops first: it ran with access they no longer have, and its live text would go on
      // reaching them (QA TC-961)
      stopTurnsIn(ctx, userId, chats)
      for (const chatId of chats) ctx.services.realtime.publish(userId, { type: 'chat.updated', data: { chatId, change: 'deleted', chat: null } })
    }
  } catch (e) { ctx.log.warn('shared chat removals failed', { err: e }) }
  // chats shared with people and groups follow the groups and the accounts (chat/chat-audience.ts): whoever left a listed
  // group, or whose account is gone or disabled, loses them the same way (their turn there stops first, their windows
  // drop them by id). Group membership is compared directly: a group with no folder rule changes no folder access
  try {
    const groupsOf = (s: AccessState) => new Map(s.principals.map((p) => [p.id, p.groups] as const))
    for (const [userId, chats] of peopleChatsLost(ctx.db, groupsOf(before), groupsOf(after))) {
      stopTurnsIn(ctx, userId, chats)
      for (const chatId of chats) {
        ctx.db.query('DELETE FROM chat_list_hidden WHERE user_id = ? AND chat_id = ?').run(userId, chatId)
        ctx.services.realtime.publish(userId, { type: 'chat.updated', data: { chatId, change: 'deleted', chat: null } })
      }
    }
  } catch (e) { ctx.log.warn('people-shared chat removals failed', { err: e }) }
  // every narrowing is audited, whatever caused it (rules, group membership, role, group deletion); admins only read it
  if (out.length) audit(ctx.db, { actor: by.actor, action: 'folder.access_lost', target: by.target, detail: { losing: out, ...(by.via ? { via: by.via } : {}) } })
  // team rooms and the everyone room follow groups and accounts (rooms/service.ts sync; it never throws)
  recheckHistories(ctx, accessChanged)
  syncRoomsNow(ctx)
  // a Drive shared with the team stops when its admin is disabled, deleted or no longer an admin
  checkDriveShareOwners(ctx)
  // the hooks of other areas (admin/guests.ts: a guest no longer in their one place is switched off)
  for (const h of accessHooks) { try { h(ctx, by.actor) } catch (e) { ctx.log.warn('access change hook failed', { err: e }) } }
  return out
}

type AccessHook = (ctx: AppContext, actor: string | null) => void
const accessHooks: AccessHook[] = []
/** Run `h` after every afterAccessChange (registered once, at module load of the area that needs it). */
export function onAccessChange(h: AccessHook): void { if (!accessHooks.includes(h)) accessHooks.push(h) }

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

/** "Who sees what" for proposed rule sets, before saving. Each change replaces a folder's rules; `limited` omitted
 * keeps its limit. */
export function previewRules(ctx: AppContext, changes: readonly { path: string; rules: FolderRuleInput[]; limited?: boolean }[], locale: Locale): PreviewResponse {
  const before = captureState(ctx.db)
  const proposed = new Map<string, { rules: FolderRuleInput[]; limited?: boolean }>()
  for (const [i, ch] of changes.entries()) {
    validateRules(ctx.db, ch.rules, locale, `body.changes.${i}.rules`)
    proposed.set(previewPath(ctx, ch.path, locale), { rules: ch.rules, limited: ch.limited })
  }
  let rules = before.rules
  for (const [p, ch] of proposed) rules = rules.replacing(p, ch)
  const after: AccessState = { principals: before.principals, rules }

  const folders: PreviewResponse['folders'] = []
  const listed = new Set<string>()
  const row = (p: string) => ({
    path: p,
    users: before.principals.map((u) => ({ user: { id: u.id, name: u.name }, role: u.role, before: before.rules.access(u, segsOf(p)), after: after.rules.access(u, segsOf(p)) })),
  })
  for (const p of proposed.keys()) { folders.push(row(p)); listed.add(p) }
  // boundary folders below a changed folder whose effective access changes for someone (inherited rules)
  // (never one inside a team project: its names are its members' to know)
  const below = [...new Set([...before.rules.boundaryFolders(), ...after.rules.boundaryFolders()])].filter((q) => !listed.has(q) && !isUsersPath(q) && !insideProject(q) && [...proposed.keys()].some((p) => p === '' || q.startsWith(p + '/'))).sort()
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
  // (a row that has access settings already is left as it is: the conversion may have limited it)
  const shared = ensureFolderRow(ctx.db, 'shared')
  if (!hasAccessSettings(ctx.db, shared.id)) writeFolderAccess(ctx.db, shared.id, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }] }, null)
  // skills/: everyone views; the managed marker keeps it admin-only to move (only the owner and admins write there)
  const skills = ensureFolderRow(ctx.db, 'skills')
  if (!hasAccessSettings(ctx.db, skills.id)) writeFolderAccess(ctx.db, skills.id, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'read' }], managed: true }, null)
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
