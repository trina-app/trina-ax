// A file from the computer in a shared project chat (docs/DECISIONS.md "Shared project chats": "A file from the
// computer in a shared chat"). The chat is seen by whoever can read its project folder, and an upload normally lands in
// the person's own attachments folder, which nobody else can read: so this one goes into the project folder instead, in
// one step. Its place is the project's chat attachments folder (CHAT_FILES_FOLDER, named in the team's language; one
// already there under any language's name is used again, as the templates folder is), made when missing. The person
// puts it there as a Files-screen upload of theirs (the file layer's checks, its upload event, the live file list), and
// it is attached as a team file (a reference: uploads/team-refs.ts), which the chat's people can read.
//   - Writing there is the person's own right: write access to the folder, or to the project folder to make it. Without
//     it, the refusal says why and what they can do instead (naming nobody).
//   - Never an overwrite: a taken name gets the next free one ("견적 (2).pdf"), and an instruction file's name (CLAUDE.md,
//     AGENTS.md, GEMINI.md, SKILL.md) counts as taken, so it is saved as "CLAUDE (2).md" and no AI follows it. The folder
//     is never a skill folder.
//   - A project folder that is not there (in the trash) is never made again by an upload; while safe operations are on,
//     shared chats are read-only, so nothing is put there.
import fs from 'node:fs'
import type { Database } from 'bun:sqlite'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { teamDefaultLocale } from '../admin/settings'
import type { ChatRow } from '../chat/store'
import type { Principal, RuleSet } from '../policy/access'
import { authorize, type FsCtx } from '../policy/authorize'
import { Denied } from '../policy/errors'
import { safeOpsEnabled } from '../safe-ops/runner'
import { inSkills } from '../skills/guard'
import { fileError } from '../team-files/errors'

/** What the check reads of the files layer (the team files service or the file service: the same rules and paths). */
export interface UploadFiles { fx: FsCtx; rules(): RuleSet; principal(userId: string): Principal }

/** Where a computer upload into a shared chat goes. */
export interface SharedUploadPlace {
  /** the chat attachments folder, team-relative */
  folder: string
  /** it is there (else the upload makes it, as the person's "new folder") */
  exists: boolean
}

const fold = (n: string) => n.normalize('NFC').toLowerCase()
const KNOWN = new Set(Object.values(CHAT_FILES_FOLDER).map(fold))

/**
 * The folder a computer upload into this shared chat goes to, checked for `userId` (who sees the chat), or the refusal:
 * 409 safe_ops while safe operations are on, 404 when its project or project folder is not there, 403
 * shared_upload_read_only when they may not write there. Read-only: nothing is made.
 */
export function sharedUploadPlace(db: Database, files: UploadFiles, userId: string, chat: Pick<ChatRow, 'project_id'>): SharedUploadPlace {
  if (safeOpsEnabled()) fileError('conflict', 'sharedChatSafeOps', undefined, { reason: 'safe_ops' })
  const p = chat.project_id ? db.query('SELECT folder_path, trashed_with FROM projects WHERE id = ?').get(chat.project_id) as { folder_path: string; trashed_with: string | null } | null : null
  if (!p || p.trashed_with !== null || !p.folder_path) fileError('not_found', 'notChat')
  const user = files.principal(userId)
  const rules = files.rules()
  // the project folder itself must be there (one in the trash is never made again here); the person reads it, or they
  // would not see the chat
  let base: { rel: string; abs: string }
  try {
    const r = authorize(files.fx, rules, user, p.folder_path, 'read')
    if (!r.st?.isDirectory()) throw new Error('not a folder')
    base = r
  } catch { return fileError('not_found', 'notChat') }
  // the one already there (several under different languages' names: the team's language first), else a new one
  const own = CHAT_FILES_FOLDER[teamDefaultLocale(db)] ?? CHAT_FILES_FOLDER.en
  let found: string[] = []
  try { found = fs.readdirSync(base.abs, { withFileTypes: true }).filter((e) => e.isDirectory() && KNOWN.has(fold(e.name))).map((e) => e.name).sort() } catch { /* the write check decides */ }
  const folder = `${base.rel}/${found.find((n) => fold(n) === fold(own)) ?? found[0] ?? own}`
  let exists = false
  try {
    if (inSkills(folder)) throw new Denied('a skill folder')
    const r = authorize(files.fx, rules, user, folder, 'write', { mustExist: false })
    // a file (not a folder) by that name: nothing is put in its place
    if (r.exists && !r.st?.isDirectory()) fileError('conflict', 'exists', { path: r.rel })
    exists = r.exists
  } catch (e) {
    if (e instanceof Denied) fileError('forbidden', 'sharedUploadReadOnly', undefined, { reason: 'shared_upload_read_only' })
    throw e
  }
  return { folder, exists }
}

/** May `userId` send a file from the computer into a shared chat of this project now: sharedUploadPlace as a yes or no
 * (Project.chatUploads, Chat.shared.canUpload: the box offers the computer only then). The upload checks again. */
export function mayUploadShared(db: Database, files: UploadFiles, userId: string, projectId: string): boolean {
  try { sharedUploadPlace(db, files, userId, { project_id: projectId }); return true } catch { return false }
}
