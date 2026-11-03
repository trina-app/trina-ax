// Project folders go through the permission function like every other path (tab 2).
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { FileService } from '../files/service'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
import { badSegment, foldKey, volumeKey } from '../policy/names'
import { fail } from '../http/errors'
import { tr } from './i18n'
import type { Locale } from '@mycel/shared/api'

export function folderAccess(files: FileService, user: Principal, folderPath: string) {
  return files.rules().access(user, folderPath === '' ? [] : folderPath.split('/'))
}
export const canRead = (files: FileService, user: Principal, p: string) => atLeast(folderAccess(files, user, p), 'read')
export const canWrite = (files: FileService, user: Principal, p: string) => atLeast(folderAccess(files, user, p), 'write')

/** The folder a path is in ('' for a top-level folder: the team root). */
export const parentFolder = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

const isAdminRole = (p: Principal) => p.role === 'owner' || p.role === 'admin'

/** What canSeeProject reads of a projects row. */
export interface ProjectSight { folder_path: string; trashed_with: string | null }

/**
 * Who sees a project (its name, instructions, chats in it, its instructions in their AI, its dev environment): whoever
 * can read its folder, while the folder is in place. While the folder (or a folder above it) is in the trash, or was
 * purged from there (`projects.trashed_with`, set by TeamFiles.remove()), only admins and the owner, who alone can
 * restore it (docs/DECISIONS.md "휴지통에 간 그룹·프로젝트·규칙 폴더"): the folder's rules went to the trash with it, so
 * its path falls back to the rules above, and may be another folder's by now. Decided by the project's own state,
 * never by looking up paths in the trash.
 */
export function canSeeProject(files: FileService, user: Principal, p: ProjectSight): boolean {
  if (p.trashed_with !== null && !isAdminRole(user)) return false
  return canRead(files, user, p.folder_path)
}

/**
 * One project per folder (docs/DECISIONS.md "Projects: a folder with instructions"): the project, other than
 * `except`, that already uses `folder`, compared the way the volume compares names. Rows from before the rule may
 * share a folder; they are left as they are, and only a new or repointed project is refused.
 */
export function projectOnFolder(db: Database, caseInsensitive: boolean, folder: string, except?: string): { id: string; name: string; folderPath: string } | null {
  const k = volumeKey(folder, caseInsensitive)
  // a project whose folder is in the trash does not hold the path: it follows its folder when that comes back
  for (const r of db.query('SELECT id, name, folder_path FROM projects WHERE trashed_with IS NULL ORDER BY created_at, id').all() as { id: string; name: string; folder_path: string }[])
    if (r.id !== except && volumeKey(r.folder_path, caseInsensitive) === k) return { id: r.id, name: r.name, folderPath: r.folder_path }
  return null
}

/**
 * 409 when another project uses `folder`. Call inside the transaction that writes the projects row. It names that
 * project only when `mayName` says the caller can see it (that project's folder is in place, so: can they read it).
 */
export function assertFolderFree(db: Database, caseInsensitive: boolean, folder: string, locale: Locale, o: { except?: string; mayName: (folderPath: string) => boolean }): void {
  const other = projectOnFolder(db, caseInsensitive, folder, o.except)
  if (!other) return
  if (o.mayName(other.folderPath)) fail('conflict', tr('projectFolderHasProject', locale, { name: other.name }), { fields: { 'body.folderPath': 'project_folder_taken' }, params: { reason: 'project_folder_taken', projectId: other.id } })
  fail('conflict', tr('projectFolderHasOtherProject', locale), { fields: { 'body.folderPath': 'project_folder_taken' }, params: { reason: 'project_folder_taken' } })
}

/** Every folder a project uses: a new project folder's automatic name steps around them, as around folders rows. */
export const projectPaths = (db: Database) => (db.query('SELECT folder_path FROM projects').all() as { folder_path: string }[]).map((r) => r.folder_path)

/** Make sure the project folder exists (creating missing folders) and the person may write it. Returns the actual path. */
export function ensureProjectFolder(files: FileService, user: Principal, folderPath: string, locale: Locale): string {
  return ensureProjectFolderEx(files, user, folderPath, locale).path
}

/** The actual path of a folder as typed (case / Unicode form on disk), and whether it exists; nothing is created. */
export function lookupFolder(files: FileService, user: Principal, folderPath: string, locale: Locale): { path: string; exists: boolean } {
  try {
    const r = authorize(files.fx, files.rules(), user, folderPath, 'write', { mustExist: false, createDirs: true })
    if (r.exists && r.st && !r.st.isDirectory()) fail('validation', tr('projectFolderFile', locale), { fields: { 'body.folderPath': 'not a folder' } })
    return { path: r.rel, exists: r.exists }
  } catch (e) {
    if (e instanceof Denied) fail('forbidden', tr('projectFolderNoWrite', locale))
    if (e instanceof ToolError) fail('validation', e.message, { fields: { 'body.folderPath': e.message } })
    throw e
  }
}

/**
 * ensureProjectFolder, also telling which folder (the top-most one) it had to create, so a caller whose next step
 * fails can take it away again. null: the folder was already there.
 */
export function ensureProjectFolderEx(files: FileService, user: Principal, folderPath: string, locale: Locale): { path: string; createdTop: string | null } {
  let r
  try {
    r = authorize(files.fx, files.rules(), user, folderPath, 'write', { createDirs: true })
  } catch (e) {
    if (e instanceof Denied) fail('forbidden', tr('projectFolderNoWrite', locale))
    if (e instanceof ToolError) fail('validation', e.message, { fields: { 'body.folderPath': e.message } })
    throw e
  }
  if (r.exists) {
    if (r.st && !r.st.isDirectory()) fail('validation', tr('projectFolderFile', locale), { fields: { 'body.folderPath': 'not a folder' } })
    return { path: r.rel, createdTop: null }
  }
  let cur = files.fx.root
  let createdTop: string | null = null
  for (let i = 0; i < r.segs.length; i++) {
    cur = path.join(cur, r.segs[i]!)
    if (i >= r.existing) {
      verifyChain(files.fx.root, r.segs.slice(0, i + 1), true)
      try { fs.mkdirSync(cur, { mode: 0o700 }); createdTop ??= cur } catch (e: any) { if (e.code !== 'EEXIST') throw e }
    }
  }
  verifyChain(files.fx.root, r.segs)
  return { path: r.rel, createdTop }
}

/**
 * Folder name for a new project folder in `parentAbs` (design tab 5: same rule as group folders, tab 1): the name
 * itself when it is a valid name, else "project-<short id>"; never a name already there or kept in `folders`
 * (compared like the file tools compare names), so a new project never inherits an old folder's files or rules.
 */
export function projectFolderName(parentAbs: string, parentRel: string, taken: readonly string[], name: string, id: string): string {
  const n = name.normalize('NFC').trim()
  const base = n && !badSegment(n) && !n.includes('/') ? n : `project-${id.slice(-8)}`
  const used = new Set<string>()
  try { for (const e of fs.readdirSync(parentAbs)) used.add(foldKey(e)) } catch {}
  for (const p of taken) if (p.startsWith(parentRel + '/')) used.add(foldKey(p.slice(parentRel.length + 1).split('/')[0] ?? ''))
  let out = base
  for (let i = 2; used.has(foldKey(out)); i++) out = `${base}-${i}`
  return out
}
