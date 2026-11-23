// The produce tools and the chat's places (plan docs/AGENTS/plan/20261121-0652-places-outputs.md, P3 of
// 20261121-0615-chat-places-as-paths.md): make_file, edit_office, the PDF tools, stamp_pdf, comment_docx, resize_images
// and make_zip take `output: chat:files/<name>` (the file is attached to this answer, for exactly the chat's people), and
// make_file reads its `source`, `template` and the pictures of a document through the place they are in.
//   - Who may: the resolver alone (files/places.ts mayAttachChatFile): the main AI of a chat shared with people, in an
//     answer with no k group. A project chat keeps its project folder (owner, 2026-11-21); every other kind is refused in
//     plain words before any work. `chat:work/` outputs wait for P2's in-sandbox writer (refused here).
//   - The attach is #200's entry (chat/chat-files.ts createFromAi through ToolCtx.places.attach, then the answer's
//     attachments): 1 GB (CHAT_FILE_AI_MAX), the turn's write limits, the storage check, the quarantine hash. A name that
//     is taken in this chat gets "name (2).ext": nothing is overwritten before P4's versions.
//   - Reads: a work-folder file only through devenv/work-files.ts copyWorkFile (one checked descriptor), a chat file only
//     through ChatFiles.open (ToolCtx.places.open); both into a server-only copy that everything after works on.
import fs from 'node:fs'
import path from 'node:path'
import { CHAT_FILE_AI_MAX, fileShareUrl, type Attachment } from '@mycel/shared/api'
import { chatFilePath, isReservedPlace, parsePlace } from '@mycel/shared/places'
import type { AppContext } from '../context'
import { copyWorkFile, noWorkText } from '../devenv/work-files'
import { authorize, type Authorized, type FsCtx } from '../policy/authorize'
import { ToolError } from '../policy/errors'
import { badSegment } from '../policy/names'
import { writeLimitText } from '../policy/refusal'
import type { RuleSet } from '../policy/access'
import { assertStorageRoomForAI } from '../system/storage'
import { checkRegular, hashFile } from '../team-files/place'
import { mayAttachChatFile, PLACE_WORDS, resolvePlace, type ResolveCtx } from './places'
import type { ToolCtx, TurnFiles } from './service'
import type { VersionSource } from '../chat/chat-files'
import { turnWriteLimits } from './turn-write-limits'

/** The chat's places for one tool call (chat/place-ctx.ts builds it from the turn; absent outside a chat turn) */
export interface ChatPlaces {
  /** the resolver's view of this turn (who, which chat, what kind, k, the work folder) */
  ctx: ResolveCtx
  /** attach a produced file (a server-only temp file, moved) to this answer as a chat file named `name`; `sha256` of the
   * bytes kept (a picture's metadata is cut out first) */
  attach(name: string, src: string, sha256: string): Promise<Attachment & { sha256: string }>
  /** a chat file of this chat for the person (ChatFiles.open: sent, or their own unsent upload), by id or newest of a name */
  open(id: string | null, name: string): { abs: string; name: string; quarantined: boolean; sha256: string; id: string }
  /** names of this chat's files now (a new attach never takes one) */
  names(): Set<string>
  /** the chat file a new version would replace (P4): who may change it here (files/places.ts mayWriteChatVersion, the
   * person continuing the chat), the chain by any of its ids or its exact name (an older answer's id: its newest
   * version), never one a hidden answer alone or a k answer carries; its head as the person may open it now. Throws a
   * ToolError in plain words. */
  head(id: string | null, name: string): ChatHead
  /** save `src` as the newest version of the chain `id` (ChatFiles.putVersion, origin 'ai', the turn's write limits and
   * the storage check), every rule of head() checked again first; `read`: the sha256 the AI read it with (another head
   * since then makes the result `beside`: nothing is lost) */
  version(id: string, src: VersionSource, read: string, files: Pick<TurnFiles, 'bytesWritten' | 'filesWritten' | 'readHashes' | 'chatVersionsMade'>): Promise<ChatVersionMade>
  /** version `n` of the chain `id` brought back as its newest version (ChatFiles.restore, origin 'ai'), with head()'s
   * rules checked again at the insert; nothing is overwritten (QA TC-r2u-10) */
  restore(id: string, n: number, files: Pick<TurnFiles, 'bytesWritten' | 'filesWritten' | 'readHashes' | 'chatVersionsMade'>): Promise<ChatVersionMade>
}

/** A chat file's newest version as a writer of a new one sees it */
export interface ChatHead { id: string; name: string; path: string; abs: string; sha256: string; size: number; quarantined: boolean; version: number }
/** A version the AI saved: the chain's id and path (unchanged), its number, and `beside` when someone saved after the read */
/** `everyone`: the chat is seen by other people now (shared with people); false in a chat only the person sees, whose
 * texts then say nothing of "everyone" (QA TC-6778) */
export interface ChatVersionMade { id: string; name: string; path: string; version: number; size: number; sha256: string; beside: boolean; link: string; everyone: boolean }

/** The produce tools whose output may be chat:files/<name> (attached to the answer); only their results get the chat
 * file link (chatLinksInText): another tool's text (a web page, a mail, a Drive file) is never rewritten into one */
export const PLACE_PRODUCE_TOOLS: ReadonlySet<string> = new Set(['make_file', 'edit_office', 'edit_hwp', 'edit_pdf', 'merge_pdfs', 'split_pdf', 'stamp_pdf', 'comment_docx', 'resize_images', 'make_zip'])

/** What the AI is told after a new version: where it is, that the old one stays, and a save beside someone else's */
export function versionText(m: ChatVersionMade, how: string): string {
  const link = `[${m.name}](${m.link})`
  const beside = m.beside
    ? ` Someone saved a version of it after you read it: yours is saved as the newest version, theirs stays as the one before it (nothing was lost). Tell the user, and read it again before a next change.`
    : ''
  // how people undo it: Restore in the file's Versions list, offered in a chat shared with people (QA TC-7039, TC-7040)
  const undo = m.everyone ? ' If it is not what was asked for, say exactly what changed: anyone here can restore an earlier version from the file\'s Versions list.' : ''
  return `${how} ${m.path}: saved as version ${m.version} (${m.size} bytes). The earlier versions stay (read it with versions: true to list them, version: n to read one). ${m.everyone ? 'Everyone in this chat opens the new version' : 'The new version opens'} from the same file under its message. Link for the user: ${link}${beside}${undo}`
}

/** The made file as a chat file: its id, name and the link the app opens (/c/<chat>?file=<id>) */
export interface ChatMade { chatId: string; id: string; name: string; link: string }

/** The chat-file link of the app: the chat page, which opens that file's viewer (the bytes stay behind the file route) */
export const chatFileLink = (chatId: string, id: string) => `/c/${encodeURIComponent(chatId)}?file=${encodeURIComponent(id)}`

/** What `output: chat:…` may become now: the chat file's name, or a ToolError in plain words. null: a team path. */
export function chatOutput(c: ToolCtx, raw: string): { name: string; id?: string } | null {
  if (!isReservedPlace(raw)) return null
  const place = parsePlace(raw)!
  if (place.kind === 'reserved') throw new ToolError(`${place.why}.`, 'bad_place')
  const p = c.places
  if (!p) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
  // TODO(P2, feat/work-safe-write): `chat:work/<path>` goes through writeIntoWork (the in-sandbox copy); until then the
  // resolver's own words (tests/unit/places-produce.test.ts pins this refusal)
  if (place.kind === 'work') {
    const r = resolvePlace(raw, p.ctx, 'write')
    throw new ToolError(r.refused ?? (r.writable === true ? PLACE_WORDS.workWrite : r.writable), 'work_write')
  }
  // an existing chat file by its own path (chat:files/<id>/<name>): the result is a new version of it (QA TC-7044,
  // TC-7267: "다시 만들어줘" made a "(2)" copy); who may and the file itself are ChatPlaces.head's, in attachProduced.
  // A name alone is a new file here
  if (place.id) {
    if (!place.name) throw new ToolError('name the file: chat:files/<file_id>/<name>, with the name it has now', 'bad_place')
    return { name: place.name, id: place.id }
  }
  if (!place.name) throw new ToolError('name the new file: chat:files/<name>, for example chat:files/proposal.pptx', 'bad_place')
  const may = mayAttachChatFile(p.ctx)
  if (may !== true) throw new ToolError(may, 'not_here')
  // the person still sees the chat's files (the resolver checks again: seesChatFiles)
  const seen = resolvePlace('chat:files/', p.ctx, 'list')
  if (seen.refused) throw new ToolError(seen.refused, 'not_here')
  const bad = badSegment(place.name)
  if (bad) throw new ToolError(`'${place.name}' cannot be a file name here: ${bad}`, 'bad_name')
  return { name: place.name }
}

/**
 * The output check of a produce tool: a team path as `authorize(…, 'write', o)` gives it, or for `chat:files/<name>` a
 * stand-in with `rel` = the place path and `segs` = ['chat:files', name] (never on disk: placeProduced attaches it).
 * A tool that changes a file in place (o.mustExist) cannot take a chat place yet (P4).
 */
export function authorizeOutput(fx: FsCtx, rules: RuleSet, c: ToolCtx, rel: string, o: { mustExist?: boolean; createDirs?: boolean; download?: boolean } = {}): Authorized {
  // a tool that changes a file in place (o.mustExist) cannot take a chat place yet (P4: ChatFiles.putVersion)
  if (o.mustExist && isReservedPlace(rel)) throw new ToolError(PLACE_WORDS.inPlace, 'in_place')
  const chat = chatOutput(c, rel)
  if (!chat) return authorize(fx, rules, c.user, rel, 'write', o)
  // a new version of an existing chat file: its path; the version is checked and saved when placed (attachProduced)
  if (chat.id) return { rel: chatFilePath(chat.id, chat.name), segs: ['chat:files', chat.id, chat.name], abs: '', exists: false, existing: 0 }
  const p = `chat:files/${chat.name}`
  return { rel: p, segs: ['chat:files', chat.name], abs: '', exists: false, existing: 0 }
}

/** Is this produced target a chat place (segs from authorizeOutput)? */
export const isChatTarget = (segs: readonly string[]) => isReservedPlace(segs.join('/'))

/** "name (2).ext" when `name` is taken in this chat (no overwrite before P4) */
function freeChatName(taken: Set<string>, name: string): string {
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  const used = new Set([...taken].map(fold))
  if (!used.has(fold(name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const x = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) { const n = `${stem} (${i})${x}`; if (!used.has(fold(n))) return n }
  throw new ToolError('too many files of this name in this chat; pick another name', 'bad_name')
}

/**
 * placeProduced's chat branch: the produced temp file attached to this answer as `chat:files/<name>`. The same limits
 * as a team save (the turn's bytes and files, the storage check) plus the chat file's own 1 GB; the k rule and the
 * person's sight of the chat checked again right before (the conversion may have taken a while).
 */
export async function attachProduced(ctx: AppContext, c: ToolCtx, segs: string[], produced: string, o: { turnBytes?: boolean; turnFiles?: boolean } = {}): Promise<{ path: string; size: number; sha256: string; chatFile: ChatMade }> {
  const out = chatOutput(c, segs.join('/'))
  if (!out) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
  if (out.id) return versionProduced(ctx, c, out as { name: string; id: string }, produced)
  const p = c.places!
  const size = checkRegular(produced).size
  const max = turnWriteLimits(ctx.engineConfig, ctx.db, c.user.id)
  const shown = `chat:files/${out.name}`
  if (size > CHAT_FILE_AI_MAX) throw new ToolError(`the file is ${(size / 1024 ** 2).toFixed(0)} MB; a file attached to an answer may be at most ${CHAT_FILE_AI_MAX / 1024 ** 3} GB`, 'too_large')
  if (o.turnBytes !== false && c.files.bytesWritten + size > max.bytes) throw new ToolError(writeLimitText('bytes', max.bytes, shown))
  if (o.turnFiles !== false && c.files.filesWritten.size >= max.files) throw new ToolError(writeLimitText('files', max.files, shown))
  assertStorageRoomForAI(size)
  const sha = await hashFile(produced)
  c.signal?.throwIfAborted()
  if (ctx.files.quarantine.hasHash(sha)) throw new ToolError('the team\'s safety check holds this file, so it was not attached', 'held')
  // the person as they are now (a disabled account throws), and the place's rules again (k, the chat's kind)
  c.user = ctx.files.principal(c.user.id)
  chatOutput(c, segs.join('/'))
  c.beforePlace?.()
  const name = freeChatName(p.names(), out.name)
  // the chat store moves the file in (createFromAi); the tool's work folder is cleaned after either way
  const att = await p.attach(name, produced, sha)
  if (o.turnBytes !== false) c.files.bytesWritten += att.size
  if (o.turnFiles !== false) c.files.filesWritten.add(`chat-file:${att.id}`)
  const at = chatFilePath(att.id, att.name)
  // the file as this answer made it: P4's edit/write of it reads it from here (read-before-write by the head's hash)
  c.files.readHashes.set(at, att.sha256)
  return { path: at, size: att.size, sha256: att.sha256, chatFile: { chatId: p.ctx.chatId!, id: att.id, name: att.name, link: chatFileLink(p.ctx.chatId!, att.id) } }
}

/**
 * attachProduced's new version: a produce tool's output named an existing chat file by its own path (chat:files/<id>/
 * <name>), so the made file becomes its newest version (QA TC-7044, TC-7267), with edit_office's rules: ChatPlaces.head
 * (who may change it here: a chat shared with people or personal, not a project chat, not an answer with a k group, the
 * person continuing the chat; never a file a hidden answer carries), the same format, read in this chat first (the
 * head's hash), and ChatPlaces.version checking every rule again at the insert. The earlier versions stay.
 */
async function versionProduced(ctx: AppContext, c: ToolCtx, out: { name: string; id: string }, produced: string): Promise<{ path: string; size: number; sha256: string; chatFile: ChatMade; chatVersion: ChatVersionMade }> {
  const p = c.places!
  const head = p.head(out.id, '')
  const fold = (n: string) => n.normalize('NFC').toLowerCase()
  if (fold(head.name) !== fold(out.name)) throw new ToolError(`'${head.name}' keeps its name and format in a new version; give output "${head.path}", or a new name (chat:files/<new name>) for a separate file`, 'bad_name')
  if (head.quarantined) throw new ToolError(`'${head.name}' is held by the team's safety check, so it is not changed`, 'held')
  const seen = c.files.readHashes.get(head.path)
  if (!seen) throw new ToolError(`read '${head.path}' first (with read) before saving a new version of it`, 'not_read')
  if (seen !== head.sha256) throw new ToolError(`'${head.path}' was changed after you read it; read it again first`, 'conflict')
  const st = checkRegular(produced)
  if (st.size > CHAT_FILE_AI_MAX) throw new ToolError(`the file is ${(st.size / 1024 ** 2).toFixed(0)} MB; a chat file may be at most ${CHAT_FILE_AI_MAX / 1024 ** 3} GB`, 'too_large')
  const sha = await hashFile(produced)
  c.signal?.throwIfAborted()
  if (ctx.files.quarantine.hasHash(sha)) throw new ToolError('the team\'s safety check holds this file, so it was not saved', 'held')
  c.user = ctx.files.principal(c.user.id)
  c.beforePlace?.()
  const fd = fs.openSync(produced, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let v: ChatVersionMade
  try { v = await p.version(head.id, { fd, st: { size: fs.fstatSync(fd).size } }, seen, c.files) } finally { fs.closeSync(fd) }
  c.chatVersionMade = { path: v.path, version: v.version }
  return { path: v.path, size: v.size, sha256: v.sha256, chatFile: { chatId: p.ctx.chatId!, id: v.id, name: v.name, link: v.link }, chatVersion: v }
}

/** The link a tool gives for a file it made: a chat file's /c/<chat>?file=<id>, else the team file's preview link */
export function placeLink(p: string, c: Pick<ToolCtx, 'places'>, mode: 'preview' | 'download' = 'preview'): string {
  const place = parsePlace(p)
  if (place?.kind === 'chatFiles' && place.id && c.places?.ctx.chatId) return chatFileLink(c.places.ctx.chatId, place.id)
  return fileShareUrl(p, mode)
}

/** A Markdown link to a made file, named by its file name */
export const madeLink = (p: string, c: Pick<ToolCtx, 'places'>) => `[${p.split('/').pop()}](${placeLink(p, c)})`

/** Where a document's relative references resolve: a team folder, a folder of the work folder, or the chat's files */
export type PlaceBase = { kind: 'team'; dir: string[] } | { kind: 'work'; dir: string[] } | { kind: 'chatFiles' }

/** A file read out of a chat place into a server-only copy */
export interface PlaceFile { local: string; name: string; size: number; sha256: string; place: string; base: PlaceBase }

/**
 * Read `input` (chat:work/… or chat:files/…) into a new file in `work` (at most `max` bytes), through the resolver and
 * the place's one safe open; a file the team's safety check holds is never read. ToolError in plain words.
 */
export async function readPlaceFile(ctx: AppContext, c: ToolCtx, input: string, max: number, work: string): Promise<PlaceFile> {
  const p = c.places
  if (!p) throw new ToolError(PLACE_WORDS.noChat, 'no_chat')
  const r = resolvePlace(input, p.ctx, 'read')
  if (r.refused || !r.storage) throw new ToolError(r.refused ?? PLACE_WORDS.noChat, 'not_here')
  const s = r.storage
  const dest = path.join(work, `place-${fs.readdirSync(work).length}-${Math.random().toString(36).slice(2, 8)}`)
  if (s.kind === 'work') {
    // a read resolves only an existing work folder (files/places.ts: null is a copy in's, P2)
    if (!s.folder) throw new ToolError(noWorkText(p.ctx.workWhy?.()), 'not_found')
    const got = await copyWorkFile(s.folder, s.rel, dest, max, c.signal)
    if (ctx.files.quarantine.hasHash(got.sha256)) { fs.rmSync(dest, { force: true }); throw new ToolError(`'${got.name}' is held by the team's safety check, so it is not read`, 'held') }
    const segs = s.rel.split('/')
    return { local: dest, name: got.name, size: got.size, sha256: got.sha256, place: `chat:work/${s.rel}`, base: { kind: 'work', dir: segs.slice(0, -1) } }
  }
  if (s.kind !== 'chatFile') throw new ToolError('this is the list of the chat\'s files; name a file in it (chat:files/<name>)', 'is_folder')
  // the name and id go root → head through ChatFiles.visibleTo (chat/place-ctx.ts open)
  let f: ReturnType<ChatPlaces['open']>
  try { f = p.open(s.id, s.name) } catch { throw new ToolError(`'${input}' was not found in this chat's files`, 'not_found') }
  if (f.quarantined) throw new ToolError(`'${f.name}' is held by the team's safety check, so it is not read`, 'held')
  const st = checkRegular(f.abs)
  if (st.size > max) throw new ToolError(`'${f.name}' is too large (${(st.size / 1024 ** 2).toFixed(0)} MB; at most ${(max / 1024 ** 2).toFixed(0)} MB here)`, 'too_large')
  fs.copyFileSync(f.abs, dest, fs.constants.COPYFILE_EXCL)
  return { local: dest, name: f.name, size: st.size, sha256: f.sha256, place: chatFilePath(f.id, f.name), base: { kind: 'chatFiles' } }
}

/** The place path a relative reference inside a document of `base` names, or null when it leaves the place. A team base
 * gives null too: its references stay team paths (copyImages' own candidates). */
export function placeRef(base: PlaceBase, ref: string): string | null {
  if (base.kind === 'team') return null
  if (base.kind === 'chatFiles') return ref.includes('/') || ref === '' || ref === '.' || ref === '..' ? null : `chat:files/${ref}`
  const rel = path.posix.normalize([...base.dir, ref].join('/'))
  if (rel.startsWith('..') || rel.startsWith('/') || rel === '.') return null
  return `chat:work/${rel}`
}

const CHAT_FILE_LINK = /(?:\/files\/view|\/api\/files\/download)\?path=chat%3Afiles%2F([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:%2F[^\s)&#"]*)?(?:&[a-z]+=[^\s)&#"]*)*/gi

/**
 * A produce tool's result in a chat turn: its file links name the team preview route (fileShareUrl of the path it
 * returned); a file it attached to this answer (`chat:files/<id>/<name>`) gets the chat-file link /c/<chat>?file=<id>
 * instead, the one the app opens and the API engine's link guard keeps (engine/api-links.ts), and one line says where
 * the file is (`everyone`: the chat is seen by other people now; else that line names no one). Text without such a link
 * is returned unchanged.
 */
export function chatLinksInText(text: string, chatId: string, everyone: boolean, version = false): string {
  let n = 0
  const out = text.replace(CHAT_FILE_LINK, (_all, id: string) => { n++; return chatFileLink(chatId, id) })
  if (!n) return text
  // a new version of an existing chat file (QA TC-7267): it was not attached anew
  if (version || /saved as version \d+/.test(text)) return out
  return `${out}\nThe file is attached to your answer as a file of this chat (not a team folder): ${everyone ? 'everyone in this chat opens it' : 'it opens'} under your answer. Say that it is attached; link it only with the link above.`
}
