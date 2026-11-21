// A chat's own files, shared with the chat (docs/decisions/20261121-share-chat-files.md; plan
// docs/AGENTS/plan/20261121-0249-share-chat-files.md). A personal chat writes its files in its creator's own folder
// (users/<id>/), which nobody else opens. When the chat is shared with people, the creator is asked "Share the files
// from this chat too?" and, by their own press, each such file is COPIED into the chat as a chat file
// (chat/chat-files.ts), attached to the answer that made it. Nothing is ever written into anyone's own folder, no folder
// rule or grant changes, and the original stays where it was.
//
//   madeFilesOf  the files a chat made in its creator's own folder, from the server's own records only (file_events,
//                madeInChat; never links in answer text): in users/<creator>/ (no dot folder, no skill or instruction
//                file), a plain file of at most CHAT_FILE_MAX, not on the download-only list, its newest event's sha256
//                and size those of the file now, made by an answer that is still there, and not in the chat yet as a
//                copy of the same path and sha256 (sharing again makes no second copy)
//   readVerified the press: the list again, each file read from one descriptor that follows no link, the bytes read
//                hashed and compared with the sha256 the creator saw (the confirm key). Anything different: nothing
//   copyMade     each verified file kept as a chat file (a picture's metadata cut out, as an upload here) and attached
//                to its answer: `origin: 'shared-copy'`, `from` (the path), `fromSha256`. An attached chat file counts as
//                sent, so the sweep of unsent uploads (migration 400) leaves it and everyone in the chat opens it
//
// The asks of the side panel (chat/access-requests.ts) run the same madeFilesOf for one path.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { Attachment } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { authorize } from '../policy/authorize'
import { loadPrincipal } from '../policy/access'
import { openChecked } from '../team-files/place'
import { assertStorageRoom } from '../system/storage'
import { instructionLike } from '../tools/rename-pattern'
import { CHAT_FILE_MAX, chatFileAttachment, chatFilesOf, cleanPicture } from './chat-files'
import { madeInChat } from './shared-actions'

/** A file the chat made in its creator's own folder that can be copied into the chat now. */
export interface MadeFile {
  /** the team path (users/<creator>/…) */
  path: string
  /** its name as the chat recorded it (the made path's last part: nothing relocated it since, madeInChat) */
  name: string
  size: number
  /** of the newest file event at the path, which the bytes on disk must match */
  sha256: string
  /** the answer that made it (the 'create' event's turn) */
  messageId: string
}

/** Files whose bytes on disk were not those of their newest file event at a press (changed outside the file layer), by
 * `${path}\0${sha256}`: not listed again, so the step asked again does not offer the same file forever. */
const badBytes = new WeakMap<AppContext, Set<string>>()
const badOf = (ctx: AppContext) => badBytes.get(ctx) ?? badBytes.set(ctx, new Set()).get(ctx)!

/** At most this many paths a chat's turns made are looked at (the newest first). */
const MADE_SCAN_MAX = 200

/** Copies already in the chat, as `${from}\0${fromSha256}`. */
function copiesIn(ctx: AppContext, chatId: string): Map<string, Attachment> {
  const out = new Map<string, Attachment>()
  const rows = ctx.db.query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'assistant' AND attachments LIKE '%shared-copy%' ORDER BY created_at, id").all(chatId) as { attachments: string }[]
  for (const r of rows) {
    try {
      for (const a of JSON.parse(r.attachments) as Attachment[]) if (a.source === 'chat' && a.origin === 'shared-copy' && a.from) out.set(`${a.from}\0${a.fromSha256 ?? ''}`, a)
    } catch { /* none */ }
  }
  return out
}

/** The newest copy in this chat of the team path `rel` (any sha256), or null. */
export function copyOf(ctx: AppContext, chatId: string, rel: string): Attachment | null {
  let found: Attachment | null = null
  for (const [k, a] of copiesIn(ctx, chatId)) if (k.slice(0, k.indexOf('\0')) === rel) found = a
  return found
}

/**
 * The files the chat `chat` made in its creator's own folder that are not in the chat yet (see the head of this file).
 * `only`: that one path (the side panel's ask). Fails closed: a file that cannot be checked is not listed.
 */
export function madeFilesOf(ctx: AppContext, chat: { id: string; user_id: string }, o: { only?: string } = {}): MadeFile[] {
  const db = ctx.db
  const creator = loadPrincipal(db, chat.user_id)
  if (!creator || creator.role === 'guest') return []
  const own = `users/${creator.id}/`
  const paths = o.only !== undefined ? [o.only]
    : (db.query(`SELECT e.path, MAX(e.id) AS last FROM file_events e WHERE e.user_id = ? AND e.action = 'create'
        AND e.turn_id IN (SELECT id FROM turns WHERE chat_id = ? AND user_id = ?) GROUP BY e.path ORDER BY last DESC LIMIT ${MADE_SCAN_MAX}`).all(creator.id, chat.id, creator.id) as { path: string }[]).map((r) => r.path)
  const copies = copiesIn(ctx, chat.id)
  const rules = ctx.files.rules()
  const out: MadeFile[] = []
  for (const rel of paths) {
    try {
      if (!rel.startsWith(own) || rel.split('/').some((s) => !s || s.startsWith('.') || s === '..')) continue
      if (instructionLike(rel)) continue
      if (!madeInChat(db, chat.id, creator.id, rel)) continue
      const last = db.query("SELECT sha256, size FROM file_events WHERE path = ? AND action IN ('create', 'update') ORDER BY id DESC LIMIT 1").get(rel) as { sha256: string | null; size: number | null } | null
      if (!last?.sha256 || !/^[0-9a-f]{64}$/.test(last.sha256)) continue
      const made = db.query("SELECT turn_id FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(rel) as { turn_id: string | null } | null
      const msg = made?.turn_id ? db.query(`SELECT m.id FROM turns t JOIN messages m ON m.id = t.message_id
        WHERE t.id = ? AND t.chat_id = ? AND m.chat_id = ? AND m.role = 'assistant'`).get(made.turn_id, chat.id, chat.id) as { id: string } | null : null
      if (!msg) continue
      const src = authorize(ctx.files.fx, rules, creator, rel, 'read')
      if (!src.exists || !src.st?.isFile() || src.st.nlink > 1) continue
      if (src.st.size > CHAT_FILE_MAX || (last.size !== null && last.size !== src.st.size)) continue
      if (ctx.files.quarantine.hasHash(last.sha256)) continue
      if (copies.has(`${rel}\0${last.sha256}`) || badOf(ctx).has(`${rel}\0${last.sha256}`)) continue
      out.push({ path: rel, name: rel.slice(rel.lastIndexOf('/') + 1), size: src.st.size, sha256: last.sha256, messageId: msg.id })
    } catch { /* not listed */ }
  }
  return out
}

/** What a confirm key binds of a list: every (path, sha256), in order. */
export const madeState = (files: readonly MadeFile[]): string[][] => files.map((f) => [f.path, f.sha256]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
const sameState = (a: readonly MadeFile[], b: readonly MadeFile[]) => JSON.stringify(madeState(a)) === JSON.stringify(madeState(b))

/** A file read and checked at the press: the bytes to keep (a picture's metadata cut out) and its kind. */
export interface VerifiedFile { file: MadeFile; bytes: Uint8Array; kind: Attachment['kind'] }

/**
 * The press of "Share with files" or [Add to the chat]: the list again (madeFilesOf), which must be exactly `seen` (what
 * the creator was shown), and each file read from one descriptor that follows no link, its bytes hashed and compared
 * with the sha256 in `seen`. null: anything changed (a file changed, moved, gone, a new one): nothing is copied and the
 * caller asks again. `notCopied`: pictures whose metadata cannot be cut out (they stay the creator's alone).
 */
export async function readVerified(ctx: AppContext, chat: { id: string; user_id: string }, seen: readonly MadeFile[], o: { only?: string } = {}): Promise<{ files: VerifiedFile[]; notCopied: number } | null> {
  const now = madeFilesOf(ctx, chat, o)
  if (!sameState(now, seen)) return null
  const creator = loadPrincipal(ctx.db, chat.user_id)
  if (!creator) return null
  const rules = ctx.files.rules()
  const files: VerifiedFile[] = []
  let notCopied = 0
  let total = 0
  for (const f of now) {
    const src = authorize(ctx.files.fx, rules, creator, f.path, 'read')
    if (!src.st?.isFile() || src.st.nlink > 1) return null
    let bytes: Uint8Array
    const { fd, st } = openChecked(src.abs, src.st)
    try {
      if (st.size > CHAT_FILE_MAX) return null
      const buf = Buffer.alloc(st.size)
      let off = 0
      while (off < buf.length) {
        const n = await new Promise<number>((res, rej) => fs.read(fd, buf, off, buf.length - off, off, (err, k) => (err ? rej(err) : res(k))))
        if (!n) break
        off += n
      }
      if (off !== st.size) return null
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } finally { fs.closeSync(fd) }
    // the bytes actually read, never the record alone
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
      const bad = badOf(ctx)
      if (bad.size > 1000) bad.clear()
      bad.add(`${f.path}\0${f.sha256}`)
      return null
    }
    const pic = cleanPicture(f.name, bytes, ctx.files.quarantine.hasHash(f.sha256))
    if (!pic) { notCopied++; continue }
    total += pic.bytes.byteLength
    files.push({ file: f, bytes: pic.bytes, kind: pic.kind })
  }
  assertStorageRoom(total)
  return { files, notCopied }
}

/**
 * Keep each verified file as a chat file of `chat` (sent by its creator) and attach it to the answer that made it.
 * Audited (chat.files_added: how many, and via the share or an ask). Returns how many were added.
 */
export async function copyMade(ctx: AppContext, chat: { id: string; user_id: string }, files: readonly VerifiedFile[], via: 'share' | 'request'): Promise<number> {
  const db = ctx.db
  const store = chatFilesOf(ctx)
  const kept: { file: MadeFile; att: Attachment }[] = []
  for (const v of files) {
    const row = await store.keepCopy(chat.user_id, chat.id, v.file.name, v.bytes, v.kind)
    kept.push({ file: v.file, att: { ...chatFileAttachment(row), origin: 'shared-copy', from: v.file.path, fromSha256: v.file.sha256 } })
  }
  if (!kept.length) return 0
  db.transaction(() => {
    for (const k of kept) {
      const m = db.query("SELECT attachments FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(k.file.messageId, chat.id) as { attachments: string } | null
      if (!m) continue
      let atts: Attachment[] = []
      try { const v = JSON.parse(m.attachments); if (Array.isArray(v)) atts = v } catch { /* none */ }
      // (a press twice at once: the same file and bytes are attached once)
      if (atts.some((a) => a.origin === 'shared-copy' && a.from === k.file.path && a.fromSha256 === k.file.sha256)) continue
      atts.push(k.att)
      db.query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(atts), k.file.messageId)
    }
  })()
  // a copy whose answer went meanwhile, or one attached by the other press: not sent, so the sweep takes it
  audit(db, { actor: chat.user_id, action: 'chat.files_added', target: chat.id, detail: { count: kept.length, via } })
  return kept.length
}

/** The target of an ask to add one file of a chat (chat/access-requests.ts: access_requests kind 'chat'): the chat id,
 * '/', and 32 hex of the path's sha256 (a chat id never holds '/', so a link's ask never looks like one). */
export const fileAskTarget = (chatId: string, rel: string) => `${chatId}/${createHash('sha256').update(rel).digest('hex').slice(0, 32)}`
/** The chat of a file ask's target, or null for a chat link's own ask. */
export const fileAskChat = (target: string): string | null => { const i = target.indexOf('/'); return i > 0 ? target.slice(0, i) : null }

/** Someone left the chat (taken out, or it became its creator's alone: `who` null): their waiting asks to add one of its
 * files close (nobody answers them any more). */
export function closeFileAsks(db: AppContext['db'], chatId: string, who: readonly string[] | null): void {
  if (who && !who.length) return
  const at = new Date().toISOString()
  const q = db.query(`UPDATE access_requests SET state = 'closed', decided_at = ? WHERE kind = 'chat' AND substr(target_id, 1, ?) = ? AND state = 'pending'${who ? ' AND requester_id = ?' : ''}`)
  if (!who) q.run(at, chatId.length + 1, `${chatId}/`)
  else for (const id of who) q.run(at, chatId.length + 1, `${chatId}/`, id)
}

/** The answers' shared copies of a chat, for its transcript (chat/shared.ts): by answer id. */
export function sharedCopiesOf(atts: readonly Attachment[]): Attachment[] {
  return atts.filter((a) => a.source === 'chat' && a.origin === 'shared-copy' && !a.unavailable)
}
