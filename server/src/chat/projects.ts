// Project folders go through the permission function like every other path (tab 2).
import fs from 'node:fs'
import path from 'node:path'
import type { FileService } from '../files/service'
import { atLeast, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { Denied, ToolError } from '../policy/errors'
import { verifyChain } from '../policy/resolve'
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
    return r.rel
  }
  let cur = files.fx.root
  for (let i = 0; i < r.segs.length; i++) {
    cur = path.join(cur, r.segs[i]!)
    if (i >= r.existing) {
      verifyChain(files.fx.root, r.segs.slice(0, i + 1), true)
      try { fs.mkdirSync(cur, { mode: 0o700 }) } catch (e: any) { if (e.code !== 'EEXIST') throw e }
    }
  }
  verifyChain(files.fx.root, r.segs)
  return r.rel
}
