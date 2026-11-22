// A chat's own files, shared with the chat (docs/decisions/20261121-share-chat-files.md; plan
// docs/AGENTS/plan/20261121-0249-share-chat-files.md). A personal chat writes its files in its creator's own folder
// (users/<id>/), which nobody else opens. When the chat is shared with people, the creator is asked "Share the files
// from this chat too?" and, by their own press, each such file is COPIED into the chat as a chat file
// (chat/chat-files.ts), attached to the answer that made it. Nothing is ever written into anyone's own folder, no folder
// rule or grant changes, and the original stays where it was.
//
//   madeFilesOf  the files a chat made in its creator's own folder, from the server's own records only (file_events,
//                madeInChat; never links in answer text): in users/<creator>/ (no dot folder, no skill or instruction
//                file), a plain file of at most CHAT_COPY_MAX, not on the download-only list, its newest event's sha256
//                and size those of the file now, made by an answer that is still there, and not in the chat yet as a
//                copy of the same path and sha256 (sharing again makes no second copy)
//   readVerified the press: the list again, each file streamed from one descriptor that follows no link into a
//                server-only temp file, the bytes read hashed as they go and compared with the sha256 the creator saw
//                (the confirm key). Anything different: nothing
//   copyMade     each verified file kept as a chat file (a picture's metadata cut out, as an upload here) and attached
//                to its answer: `origin: 'shared-copy'` (the one provenance mark, shared with session e6's 'ai'), and
//                for the server's own re-check `from` (the path) and `fromSha256`. A client never gets `fromSha256`, and
//                `from` only the chat's creator, whose own path it is (copyForViewer; review L2). An attached chat file
//                counts as sent, so the sweep of unsent uploads (migration 400) leaves it and everyone in the chat opens it
//
// The asks of the side panel (chat/access-requests.ts) run the same madeFilesOf for one path.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Attachment } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { authorize } from '../policy/authorize'
import { loadPrincipal } from '../policy/access'
import { openChecked } from '../team-files/place'
import { assertStorageRoom } from '../system/storage'
import { instructionLike } from '../tools/rename-pattern'
import { attachmentKind } from '../uploads/attachments'
import { CHAT_FILE_MAX, chatFileAttachment, chatFilesOf, cleanPicture } from './chat-files'

/** At most this big a copy of a chat's own file (within the team's storage). People's uploads keep CHAT_FILE_MAX
 * (50 MB); a copy, like the AI's attached output, has its own cap. TODO: one constant with session e6's PR2 (the AI's
 * attached files), exported from there once it merges. */
export const CHAT_COPY_MAX = 1024 * 1024 * 1024

/** A copy as the messages table stores it: `fromSha256` is the server's alone (never in the API's Attachment). */
export type StoredAttachment = Attachment & { fromSha256?: string }

/** (the client's view of a copy: chat/store.ts copyForViewer) */
export { copyForViewer } from './store'
import { handedOverInChat, madeInChat } from './shared-actions'
import { isPeopleRow, peopleAudience } from './chat-audience'
import { answerRecords, chatNodes, withheldAmong, withheldFrom } from './shared-answers'

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

/** Copies already in the chat, as `${from}\0${fromSha256}`, with the answer that carries each. */
function copiesIn(ctx: AppContext, chatId: string): Map<string, { att: StoredAttachment; messageId: string }> {
  const out = new Map<string, { att: StoredAttachment; messageId: string }>()
  const rows = ctx.db.query("SELECT id, attachments FROM messages WHERE chat_id = ? AND role = 'assistant' AND attachments LIKE '%shared-copy%' ORDER BY created_at, id").all(chatId) as { id: string; attachments: string }[]
  for (const r of rows) {
    try {
      for (const a of JSON.parse(r.attachments) as StoredAttachment[]) if (a.source === 'chat' && a.origin === 'shared-copy' && a.from) out.set(`${a.from}\0${a.fromSha256 ?? ''}`, { att: a, messageId: r.id })
    } catch { /* none */ }
  }
  return out
}

/** The newest copy in this chat of the team path `rel` (any sha256) that `viewer` may see: one on an answer hidden from
 * them (chat/shared-answers.ts) is not theirs to open (review M1). null: none. */
export function copyOf(ctx: AppContext, chatId: string, rel: string, viewer: string): Attachment | null {
  let found: { att: Attachment; messageId: string } | null = null
  for (const [k, c] of copiesIn(ctx, chatId)) if (k.slice(0, k.indexOf('\0')) === rel) found = c
  if (!found) return null
  return withheldFrom(ctx.db, ctx.files.rules(), chatId, viewer).has(found.messageId) ? null : found.att
}

/** A team path as a link or a tool argument writes it, in the form a copy's `from` keeps (copyMade: the made path):
 * trimmed, NFC, no "/" or "./" in front, no "/" at the end. */
export const copyKey = (p: string): string => p.trim().normalize('NFC').replace(/^(?:\.?\/)+/, '').replace(/\/+$/, '')

/**
 * Every copy of a chat shared with people by the path it was copied from (docs/AGENTS/plan/
 * 20261122-0503-shared-chat-copy-paths.md): the newest copy of each path, as copyOf finds one, and none on an answer
 * hidden from `viewer` (review M1). A path in it means the chat's copy for everyone in the chat, the AI too: its tool
 * calls (chat/tools.ts mapPaths) and its transcript (chat/shared.ts labelledTranscript). The callers ask only in a chat
 * shared with people now: a chat made private again keeps its copies, and its creator's paths are their own again.
 */
export function sharedCopyMap(ctx: AppContext, chatId: string, viewer: string): Map<string, Attachment> {
  const out = new Map<string, Attachment>()
  const copies = copiesIn(ctx, chatId)
  if (!copies.size) return out
  const hidden = withheldFrom(ctx.db, ctx.files.rules(), chatId, viewer)
  // copiesIn is oldest first: a later copy of the same path (shared again after a change) wins, as in copyOf
  for (const [k, c] of copies) {
    const from = copyKey(k.slice(0, k.indexOf('\0')))
    if (from && !hidden.has(c.messageId)) out.set(from, c.att)
    else if (from) out.delete(from)
  }
  return out
}

/** The answers of a chat that are hidden from anyone among its people now (a chat shared with people) or `extra` (people
 * about to be added): a file such an answer made is never offered or copied, or the copy would show what the answer
 * hides (review M1). An answer with no record yet is recorded for exactly the people a share adds, so it hides nothing
 * from them; but a chat shared before and made private again keeps its records (chat/people-share.ts), and those still
 * count for the people a new share adds (re-review). */
function hiddenAnswers(ctx: AppContext, chatId: string, extra: readonly string[]): Set<string> {
  const db = ctx.db
  const row = db.query('SELECT id, user_id, people_shared_at, project_id FROM chats WHERE id = ?').get(chatId) as { id: string; user_id: string; people_shared_at: string | null; project_id: string | null } | null
  const out = new Set<string>()
  if (!row) return out
  const shared = isPeopleRow(row)
  const recorded = shared ? null : answerRecords(db, chatId)
  // not shared with people now and no record from before: nothing is hidden from anyone it adds
  if (recorded && !recorded.size) return out
  const nodes = chatNodes(db, chatId)
  const rules = ctx.files.rules()
  const people = shared ? new Set([...peopleAudience(db, row), ...extra]) : new Set(extra)
  for (const p of people) for (const id of withheldAmong(db, rules, nodes, p)) if (!recorded || recorded.has(id)) out.add(id)
  return out
}

/**
 * The files the chat `chat` made in its creator's own folder that are not in the chat yet (see the head of this file).
 * `only`: that one path (the side panel's ask). Fails closed: a file that cannot be checked is not listed.
 */
export function madeFilesOf(ctx: AppContext, chat: { id: string; user_id: string }, o: { only?: string; audience?: readonly string[] } = {}): MadeFile[] {
  const db = ctx.db
  const creator = loadPrincipal(db, chat.user_id)
  if (!creator || creator.role === 'guest') return []
  const own = `users/${creator.id}/`
  const paths = o.only !== undefined ? [o.only]
    : (db.query(`SELECT e.path, MAX(e.id) AS last FROM file_events e WHERE e.user_id = ? AND e.action = 'create'
        AND e.turn_id IN (SELECT id FROM turns WHERE chat_id = ? AND user_id = ?) GROUP BY e.path ORDER BY last DESC LIMIT ${MADE_SCAN_MAX}`).all(creator.id, chat.id, creator.id) as { path: string }[]).map((r) => r.path)
  const copies = copiesIn(ctx, chat.id)
  const rules = ctx.files.rules()
  // a helper file (QA TC-7269: the .md or .html a later make_file of this chat turned into the PDF) is not a result of
  // the chat: it is left out when the file made from it is offered too (file_events detail.from of that create)
  const madeFrom = new Map<string, string[]>()
  for (const r of db.query(`SELECT path, json_extract(detail, '$.from') AS src FROM file_events WHERE user_id = ? AND action = 'create'
      AND json_extract(detail, '$.from') IS NOT NULL AND turn_id IN (SELECT id FROM turns WHERE chat_id = ? AND user_id = ?)`).all(creator.id, chat.id, creator.id) as { path: string; src: string }[]) {
    if (typeof r.src === 'string' && r.src !== r.path) madeFrom.set(r.src, [...(madeFrom.get(r.src) ?? []), r.path])
  }
  const listed = new Set(paths)
  const helper = (rel: string) => (madeFrom.get(rel) ?? []).some((p) => listed.has(p))
  // made by an answer hidden from anyone who sees the chat (or is being added): never offered
  const hidden = hiddenAnswers(ctx, chat.id, o.audience ?? [])
  const out: MadeFile[] = []
  for (const rel of paths) {
    try {
      if (!rel.startsWith(own) || rel.split('/').some((s) => !s || s.startsWith('.') || s === '..')) continue
      if (instructionLike(rel)) continue
      if (o.only === undefined && helper(rel)) continue
      // written by the chat, or handed over from its work folder (a box_shell video: QA TC-7261)
      if (!madeInChat(db, chat.id, creator.id, rel) && !handedOverInChat(db, chat.id, creator.id, rel)) continue
      const last = db.query("SELECT sha256, size FROM file_events WHERE path = ? AND action IN ('create', 'update') ORDER BY id DESC LIMIT 1").get(rel) as { sha256: string | null; size: number | null } | null
      if (!last?.sha256 || !/^[0-9a-f]{64}$/.test(last.sha256)) continue
      const made = db.query("SELECT id, turn_id FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(rel) as { id: number; turn_id: string | null } | null
      const answerOf = (turnId: string | null) => turnId ? db.query(`SELECT m.id FROM turns t JOIN messages m ON m.id = t.message_id
        WHERE t.id = ? AND t.chat_id = ? AND m.chat_id = ? AND m.role = 'assistant'`).get(turnId, chat.id, chat.id) as { id: string } | null : null
      const msg = answerOf(made?.turn_id ?? null)
      if (!msg || hidden.has(msg.id)) continue
      // the bytes now are the last writer's: every answer that wrote the path since its create (madeInChat counts the
      // chat's own later updates) must be one nobody here is kept from, or its content would ride on the visible
      // creating answer (S2 review M1). An update whose answer cannot be found: not offered
      const writers = db.query("SELECT turn_id FROM file_events WHERE path = ? AND id > ? AND action = 'update'").all(rel, made!.id) as { turn_id: string | null }[]
      if (writers.some((w) => { const m = answerOf(w.turn_id); return !m || hidden.has(m.id) })) continue
      const src = authorize(ctx.files.fx, rules, creator, rel, 'read')
      if (!src.exists || !src.st?.isFile() || src.st.nlink > 1) continue
      if (src.st.size > CHAT_COPY_MAX || (last.size !== null && last.size !== src.st.size)) continue
      if (ctx.files.quarantine.hasHash(last.sha256)) continue
      if (copies.has(`${rel}\0${last.sha256}`) || badOf(ctx).has(`${rel}\0${last.sha256}`)) continue
      // copied before and changed since: it goes in as a new version of that copy (copyMade), and a version is at most
      // CHAT_FILE_MAX (ChatFiles.putVersion), so a larger one stays its creator's alone (S2 review L2)
      if (src.st.size > CHAT_FILE_MAX && [...copies.keys()].some((k) => k.slice(0, k.indexOf('\0')) === rel)) continue
      out.push({ path: rel, name: rel.slice(rel.lastIndexOf('/') + 1), size: src.st.size, sha256: last.sha256, messageId: msg.id })
    } catch { /* not listed */ }
  }
  return out
}

/** What a confirm key binds of a list: every (path, sha256), in order. */
export const madeState = (files: readonly MadeFile[]): string[][] => files.map((f) => [f.path, f.sha256]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
const sameState = (a: readonly MadeFile[], b: readonly MadeFile[]) => JSON.stringify(madeState(a)) === JSON.stringify(madeState(b))

/** A file read and checked at the press: its bytes in a server-only temp file (or, a picture, its cleaned bytes), and its
 * kind. discardVerified removes the temp files of a press that does not go on. */
export interface VerifiedFile { file: MadeFile; tmp: string | null; bytes: Uint8Array | null; kind: Attachment['kind'] }

/** The temp files of a press that does not go on. */
export function discardVerified(v: { files: readonly VerifiedFile[] } | null): void {
  for (const f of v?.files ?? []) if (f.tmp) fs.rmSync(f.tmp, { force: true })
}

/** Stream `fd` (`size` bytes) into a new 0600 temp file, hashing as it goes. null: it ended early. */
async function streamCopy(fd: number, size: number, dst: string): Promise<string | null> {
  const hash = createHash('sha256')
  const out = await fs.promises.open(dst, 'wx', 0o600)
  try {
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024) || 1)
    let off = 0
    while (off < size) {
      const n = await new Promise<number>((res, rej) => fs.read(fd, buf, 0, Math.min(buf.length, size - off), off, (err, k) => (err ? rej(err) : res(k))))
      if (!n) return null
      hash.update(buf.subarray(0, n))
      await out.write(buf, 0, n)
      off += n
    }
  } finally { await out.close() }
  return hash.digest('hex')
}

/**
 * The press of "Share with files" or [Add to the chat]: the list again (madeFilesOf), which must be exactly `seen` (what
 * the creator was shown), and each file streamed from one descriptor that follows no link into a server-only temp file,
 * the bytes read hashed and compared with the sha256 in `seen`. null: anything changed (a file changed, moved, gone, a
 * new one): nothing is copied and the caller asks again. `notCopied`: pictures whose metadata cannot be cut out, or a
 * picture over CHAT_FILE_MAX (cleaned in memory): they stay the creator's alone.
 */
export async function readVerified(ctx: AppContext, chat: { id: string; user_id: string }, seen: readonly MadeFile[], o: { only?: string; audience?: readonly string[] } = {}): Promise<{ files: VerifiedFile[]; notCopied: number } | null> {
  const now = madeFilesOf(ctx, chat, o)
  if (!sameState(now, seen)) return null
  const creator = loadPrincipal(ctx.db, chat.user_id)
  if (!creator) return null
  const rules = ctx.files.rules()
  const work = path.join(ctx.config.dataDir, 'work')
  await fs.promises.mkdir(work, { recursive: true, mode: 0o700 })
  const files: VerifiedFile[] = []
  let notCopied = 0
  let total = 0
  const fail = () => { discardVerified({ files }); return null }
  // the storage check first, before anything is written (review L1)
  assertStorageRoom(now.reduce((n, f) => n + f.size, 0))
  // anything thrown on the way (a file gone, a read error): the temp files written so far go too (review L2)
  let current: string | null = null
  try {
  for (const f of now) {
    const src = authorize(ctx.files.fx, rules, creator, f.path, 'read')
    if (!src.st?.isFile() || src.st.nlink > 1) return fail()
    const tmp = path.join(work, `chat-copy-${randomUUID()}`)
    current = tmp
    const { fd, st } = openChecked(src.abs, src.st)
    let sha: string | null = null
    try {
      if (st.size > CHAT_COPY_MAX) { fs.rmSync(tmp, { force: true }); return fail() }
      sha = await streamCopy(fd, st.size, tmp)
    } catch { sha = null } finally { fs.closeSync(fd) }
    // the bytes actually read, never the record alone
    if (sha !== f.sha256) {
      fs.rmSync(tmp, { force: true })
      if (sha) {
        const bad = badOf(ctx)
        if (bad.size > 1000) bad.clear()
        bad.add(`${f.path}\0${f.sha256}`)
      }
      return fail()
    }
    total += st.size
    // a picture: its place and camera cut out, as an upload here (in memory, so at most CHAT_FILE_MAX)
    const named = attachmentKind(f.name)
    if (named === 'image') {
      if (st.size > CHAT_FILE_MAX) { fs.rmSync(tmp, { force: true }); notCopied++; continue }
      const pic = cleanPicture(f.name, new Uint8Array(await fs.promises.readFile(tmp)), ctx.files.quarantine.hasHash(f.sha256))
      fs.rmSync(tmp, { force: true })
      if (!pic) { notCopied++; continue }
      files.push({ file: f, tmp: null, bytes: pic.bytes, kind: pic.kind })
      continue
    }
    files.push({ file: f, tmp, bytes: null, kind: named })
  }
  } catch (e) { if (current) fs.rmSync(current, { force: true }); discardVerified({ files }); throw e }
  try { assertStorageRoom(total) } catch (e) { discardVerified({ files }); throw e }
  return { files, notCopied }
}

/**
 * Keep each verified file as a chat file of `chat` (sent by its creator) and attach it to the answer that made it.
 * Audited (chat.files_added: how many, and via the share or an ask). Returns how many were added. The temp files go.
 */
export async function copyMade(ctx: AppContext, chat: { id: string; user_id: string }, files: readonly VerifiedFile[], via: 'share' | 'request'): Promise<number> {
  const db = ctx.db
  const store = chatFilesOf(ctx)
  const kept: { file: MadeFile; att: StoredAttachment }[] = []
  // a file copied before whose original changed since (re-share): a new version of that copy's chain (putVersion, as
  // its creator; "Updated by" them), never a second copy. Its stored fromSha256 then names the new bytes, so it is not
  // offered again (docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md)
  const versioned: { file: MadeFile; rootId: string; messageId: string }[] = []
  const earlier = copiesIn(ctx, chat.id)
  const copyOfPath = (rel: string) => {
    let found: { att: StoredAttachment; messageId: string } | null = null
    for (const [k, c] of earlier) if (k.slice(0, k.indexOf('\0')) === rel && store.row(c.att.id)) found = c
    return found
  }
  let notVersioned = 0
  let lastError: unknown = null
  try {
    for (const v of files) {
      const before = copyOfPath(v.file.path)
      if (before) {
        // a version is at most CHAT_FILE_MAX (a copy may be up to CHAT_COPY_MAX): a larger one is left out, never a
        // second copy (madeFilesOf does not offer it either). One that fails is left out too; the others go on, so
        // every copy kept here is attached below (nothing is left unattached for the sweep)
        const size = v.tmp ? fs.statSync(v.tmp).size : v.bytes!.byteLength
        if (size > CHAT_FILE_MAX) { notVersioned++; ctx.log.info('a changed file of a shared chat is too large for a new version', { chat: chat.id }); continue }
        try {
          if (v.tmp) {
            const fd = fs.openSync(v.tmp, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
            try { await store.putVersion(chat.user_id, chat.id, before.att.id, { fd, st: { size: fs.fstatSync(fd).size } }, { action: 'chat.file_version' }) } finally { fs.closeSync(fd) }
          } else await store.putVersion(chat.user_id, chat.id, before.att.id, { bytes: v.bytes! }, { action: 'chat.file_version' })
        } catch (e) { notVersioned++; ctx.log.warn('a changed file of a shared chat was not added as a new version', { err: e, chat: chat.id }); continue }
        versioned.push({ file: v.file, rootId: before.att.id, messageId: before.messageId })
        continue
      }
      // one that fails (storage, a read error) is left out and the rest go on: every copy kept is attached below
      try {
        const row = await store.keepCopy(chat.user_id, chat.id, v.file.name, v.tmp ? { file: v.tmp } : { bytes: v.bytes! }, v.kind)
        kept.push({ file: v.file, att: { ...chatFileAttachment(row), origin: 'shared-copy', from: v.file.path, fromSha256: v.file.sha256 } })
      } catch (e) { lastError = e; ctx.log.warn('a file of a shared chat was not added', { err: e, chat: chat.id }) }
    }
  } finally { discardVerified({ files }) }
  if (versioned.length) {
    db.transaction(() => {
      for (const k of versioned) {
        const m = db.query("SELECT attachments FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(k.messageId, chat.id) as { attachments: string } | null
        if (!m) continue
        let atts: StoredAttachment[] = []
        try { const v = JSON.parse(m.attachments); if (Array.isArray(v)) atts = v } catch { continue }
        db.query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(atts.map((a) => (a.id === k.rootId && a.origin === 'shared-copy' && a.from === k.file.path ? { ...a, fromSha256: k.file.sha256 } : a))), k.messageId)
      }
    })()
  }
  if (versioned.length || notVersioned) audit(db, { actor: chat.user_id, action: 'chat.files_updated', target: chat.id, detail: { count: versioned.length, via, files: versioned.map((k) => k.rootId), ...(notVersioned ? { notVersioned } : {}) } })
  // nothing went at all because of an error: the caller counts the files as not added, as before
  if (!kept.length && !versioned.length && lastError) throw lastError
  if (!kept.length) return versioned.length
  db.transaction(() => {
    for (const k of kept) {
      const m = db.query("SELECT attachments FROM messages WHERE id = ? AND chat_id = ? AND role = 'assistant'").get(k.file.messageId, chat.id) as { attachments: string } | null
      if (!m) continue
      let atts: StoredAttachment[] = []
      try { const v = JSON.parse(m.attachments); if (Array.isArray(v)) atts = v } catch { /* none */ }
      // (a press twice at once: the same file and bytes are attached once)
      if (atts.some((a) => a.origin === 'shared-copy' && a.from === k.file.path && a.fromSha256 === k.file.sha256)) continue
      atts.push(k.att)
      db.query('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(atts), k.file.messageId)
    }
  })()
  // a copy whose answer went meanwhile, or one attached by the other press: not sent, so the sweep takes it
  audit(db, { actor: chat.user_id, action: 'chat.files_added', target: chat.id, detail: { count: kept.length, via, files: kept.map((k) => k.att.id) } })
  return kept.length + versioned.length
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
