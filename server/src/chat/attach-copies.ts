// A "My files" attachment in a chat shared with people (docs/decisions/20261121-share-chat-files.md Rule 2, QA TC-7286):
// a file of the sender's own folder (users/<sender>/…) that some people in the chat cannot open goes in as a copy kept
// with the chat (chat/chat-files.ts keepCopy), so everyone in it, people added later and guests included, opens it and
// can ask for a new version; the original stays where it is. Only the sender's own files: a file leaves its owner's
// folder only by its owner's press (Rule 2), and the press of Send is it (the box says so before sending: web
// SharedUploadLine). Any other team file (a group folder the sender reads) stays a reference behind the read card, as
// before. A file of the sender's own folder that cannot be copied (too big, download-only, gone, not a plain file)
// refuses the send: it would otherwise go as a reference the others cannot open.
import fs from 'node:fs'
import path from 'node:path'
import type { Attachment } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { newId } from '../db'
import { audit } from '../admin/audit'
import { atLeast, loadPrincipal, type Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { assertStorageRoom } from '../system/storage'
import { peopleAudience } from './chat-audience'
import { CHAT_FILE_MAX, chatFileAttachment, chatFilesOf } from './chat-files'

/** The attachments of a message in the people-shared chat `chat`, with each team file not everyone in it may open
 * replaced by a copy kept with the chat (sent by `userId`, who may read it). Order kept. */
export async function copyTeamAttachments(ctx: AppContext, chat: { id: string; user_id: string; people_shared_at: string | null; project_id: string | null }, userId: string, atts: readonly Attachment[]): Promise<Attachment[]> {
  if (!atts.some((a) => a.source === 'team' && a.path)) return atts as Attachment[]
  const db = ctx.db
  const rules = ctx.files.rules()
  const people = [...new Set([chat.user_id, ...peopleAudience(db, chat)])].map((id) => loadPrincipal(db, id)).filter((p): p is Principal => !!p)
  const me = loadPrincipal(db, userId)
  if (!me) return atts as Attachment[]
  const out: Attachment[] = []
  let copied = 0
  for (const a of atts) {
    if (a.source !== 'team' || !a.path) { out.push(a); continue }
    const segs = a.path.split('/').filter(Boolean)
    const fold = (x: string) => (ctx.files.fx.caseInsensitive ? x.toLowerCase() : x)
    const own = segs.length >= 3 && fold(segs[0]!) === 'users' && fold(segs[1]!) === fold(userId)
    if (!own || people.every((p) => atLeast(rules.access(p, segs), 'read'))) { out.push(a); continue }
    const tmp = path.join(ctx.config.dataDir, `attach-copy-${newId()}`)
    try {
      const src = authorize(ctx.files.fx, rules, me, a.path, 'read')
      if (!src.exists || !src.st?.isFile() || src.st.nlink > 1) throw new AttachCopyError('gone')
      if (src.st.size > CHAT_FILE_MAX) throw new AttachCopyError('too_big')
      assertStorageRoom(src.st.size)
      await fs.promises.copyFile(src.abs, tmp, fs.constants.COPYFILE_EXCL)
      const st = await fs.promises.stat(tmp)
      if (st.size !== src.st.size) throw new AttachCopyError('gone')
      // the bytes as copied: a download-only one never becomes a chat file the AI is handed
      if (ctx.files.quarantine.hasHash(await sha256Of(tmp))) throw new AttachCopyError('download_only')
      const row = await chatFilesOf(ctx).keepCopy(userId, chat.id, a.name, { file: tmp }, a.kind)
      out.push(chatFileAttachment(row))
      copied++
    } catch (e) {
      if (e instanceof AttachCopyError) throw e
      ctx.log.warn('a My files attachment was not copied to the chat', { err: e })
      throw new AttachCopyError('failed')
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => {})
    }
  }
  if (!copied) return atts as Attachment[]
  audit(db, { actor: userId, action: 'chat.files_copied', target: chat.id, detail: { files: copied, attach: true } })
  return out
}

/** Why a file of the sender's own folder could not go into the chat (the send is refused with it). */
export class AttachCopyError extends Error {
  constructor(readonly why: 'gone' | 'too_big' | 'download_only' | 'failed') { super(`attachment not copied: ${why}`) }
}

async function sha256Of(file: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const h = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** The copies `copyTeamAttachments` made for a send that then did not go (refused, or the same message sent twice):
 * removed, so no chat file is left without its message. */
export function discardCopies(ctx: AppContext, userId: string, before: readonly Attachment[], after: readonly Attachment[]): void {
  const had = new Set(before.map((a) => a.id))
  for (const a of after) if (a.source === 'chat' && !had.has(a.id)) { try { chatFilesOf(ctx).discard(userId, a.id) } catch { /* swept later */ } }
}
