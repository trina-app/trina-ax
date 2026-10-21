// Project folders go through the permission function like every other path (tab 2).
import fs from 'node:fs'
import path from 'node:path'
import type { FileService } from '../files/service'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
import { badSegment, foldKey } from '../policy/names'
import { fail } from '../http/errors'
import { tr } from './i18n'
import type { Locale } from '@mycel/shared/api'

export function folderAccess(files: FileService, user: Principal, folderPath: string) {
  return files.rules().access(user, folderPath === '' ? [] : folderPath.split('/'))
}
export const canRead = (files: FileService, user: Principal, p: string) => atLeast(folderAccess(files, user, p), 'read')
export const canWrite = (files: FileService, user: Principal, p: string) => atLeast(folderAccess(files, user, p), 'write')

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
