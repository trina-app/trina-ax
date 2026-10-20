// Folders and folder rules (tab 1 `folders` / `folder_rules`, tab 2 "폴더와 권한 규칙"). Rules hang on a folder id;
// folders.path is the actual on-disk name path (no trailing slash, '' = team root). Resolution itself is the
// stage-1 permission function (server/src/policy/access.ts); this file stores rules, previews changes ("who sees
// what") and, when someone loses read access, starts their chats on a fresh engine session (H7, tab 2 "권한 회수").
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { Access, Folder, FolderRule, FolderRuleInput, Locale, PreviewResponse, Role } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { atLeast, RuleSet, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { parseInput, walk } from '../policy/resolve'
import { msg } from '../auth/messages'
import { userRef } from '../auth/users'

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
  let exists = false
  try { exists = fs.lstatSync(path.join(ctx.files.fx.root, ...(f.path ? f.path.split('/') : []))).isDirectory() } catch {}
  return {
    id: f.id,
    path: f.path,
    exists,
    createdAt: f.created_at,
    rules: rows.map((r) => ({ id: r.id, folderId: r.folder_id, subjectType: r.subject_type, subjectId: r.subject_id, access: r.access, updatedBy: userRef(ctx.db, r.updated_by), updatedAt: r.updated_at })),
  }
}

/** Folders that carry rules (and folders rows without rules, e.g. after all rules were removed by a group delete). */
export function listFolders(ctx: AppContext): Folder[] {
  return (ctx.db.query('SELECT id, path, created_at FROM folders ORDER BY path').all() as FolderRow[]).map((f) => toFolder(ctx, f))
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
 * For every person present in both states, the folders (with rules in either state) where they could read before
 * and cannot now. Access anywhere in the tree equals the access at its deepest rule folder, so checking the rule
 * folders covers every path.
 */
export function readLosses(before: AccessState, after: AccessState, extraPaths: readonly string[] = []): Map<string, string[]> {
  const paths = [...new Set([...before.rules.ruleFolders(), ...after.rules.ruleFolders(), ...extraPaths])].filter((p) => !isUsersPath(p)).sort()
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

/**
 * H7: the person's chats start a fresh engine session at the next turn (the stashed session may hold file contents
 * they can no longer read; the conversation continues from the DB history). Returns how many chats were reset.
 */
export function resetEngineSessions(ctx: AppContext, userId: string): number {
  const chats = ctx.db.query('SELECT id FROM chats WHERE user_id = ? AND engine_session_id IS NOT NULL').all(userId) as { id: string }[]
  if (!chats.length) return 0
  ctx.db.query('UPDATE chats SET engine_session_id = NULL WHERE user_id = ? AND engine_session_id IS NOT NULL').run(userId)
  for (const c of chats) {
    if (!/^[A-Za-z0-9_-]+$/.test(c.id)) continue
    fs.rmSync(path.join(ctx.config.dataDir, 'sessions', c.id), { recursive: true, force: true })
  }
  return chats.length
}

export function chatsWithEngineSession(db: Database, userId: string): number {
  return (db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ? AND engine_session_id IS NOT NULL').get(userId) as { n: number }).n
}

/**
 * After any change that can narrow access (rules, group membership, role): reset the engine sessions of people who
 * lost read access somewhere, tell their open windows, and return who lost what (for the audit record).
 */
export function afterAccessChange(ctx: AppContext, before: AccessState): { userId: string; paths: string[]; chatsReset: number }[] {
  const after = captureState(ctx.db)
  const losses = readLosses(before, after)
  const out: { userId: string; paths: string[]; chatsReset: number }[] = []
  for (const [userId, paths] of losses) {
    const chatsReset = resetEngineSessions(ctx, userId)
    out.push({ userId, paths, chatsReset })
  }
  // every person whose access changed in any way re-reads open folders (tab 5 "권한 회수")
  for (const pb of before.principals) {
    const pa = after.principals.find((p) => p.id === pb.id)
    if (!pa) continue
    const paths = [...new Set([...before.rules.ruleFolders(), ...after.rules.ruleFolders()])].filter((p) => !isUsersPath(p))
    const changed = paths.filter((p) => before.rules.access(pb, segsOf(p)) !== after.rules.access(pa, segsOf(p)))
    if (changed.length) ctx.services.realtime.publish(pb.id, { type: 'notice', data: { level: 'info', code: 'access_changed', message: changed.join(', ') } })
  }
  return out
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

/** Default folders of a new team (tab 2 "폴더 만들기와 기본 규칙"). */
export function createDefaultFolders(ctx: AppContext): void {
  const root = ctx.files.fx.root
  for (const d of ['shared', 'skills', 'groups', 'projects', 'users']) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 })
  const shared = ensureFolderRow(ctx.db, 'shared')
  if (!rulesOf(ctx.db, shared.id).length) replaceRules(ctx.db, shared.id, [{ subjectType: 'everyone', subjectId: null, access: 'write' }], null)
  const skills = ensureFolderRow(ctx.db, 'skills')
  if (!rulesOf(ctx.db, skills.id).length) replaceRules(ctx.db, skills.id, [{ subjectType: 'everyone', subjectId: null, access: 'read' }, { subjectType: 'role', subjectId: 'admin', access: 'write' }], null)
}
