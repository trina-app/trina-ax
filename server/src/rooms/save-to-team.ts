// "Save to team folder" on a file sent in a room, a DM or a thread (docs/decisions/20261117-room-file-save-btn.md). The
// person, not the AI, copies the file into a team folder they may write, from the file's own action. Three parts:
//   savedFiles  where this room's files were saved and are still there for this viewer: the tracked place
//               (room_file_saves), the file still there with the same bytes, and the viewer able to open it. Anything
//               else (moved, changed, deleted, a folder they can't open) simply does not count.
//   savePlan    what the sheet shows: the files of one message (each: already saved, looks personal, the same bytes as
//               an earlier one), one folder to pre-select for the files that look ordinary (suggested by name when it
//               fits every one of them, else a folder the person recently saved to; none when every file looks
//               personal: rooms/sensitive.ts), and for the chosen folder how many people outside the conversation can
//               see it.
//   saveToTeam  the copy: save_room_file's checks for each file (a room the person is in now, the message visible to
//               them and not deleted, not on the safety check's download-only list, at most 50 MB, never under skills/
//               or as an instruction file), then the AI's byte save (tools/make-file.ts placeProduced: write access
//               checked again, the storage check, never an overwrite: a different file of that name keeps its place and
//               the copy goes next to it). The same bytes already in that folder (any room file's tracked copy, an
//               identical file of the same save included) count as saved, no second copy.
// Guests cannot save (their AI has no save_room_file either: chat/guest-tools.ts); the endpoints are not in
// auth/guest-endpoints.ts, and each function checks again.
// No AI call: the suggestion is the Move picker's name matching (team-files/move-suggest.ts), so it costs nothing,
// answers fast and works with the AI off.
import fs from 'node:fs'
import path from 'node:path'
import { SMALL_UPLOAD_MAX, type RoomSavePlan, type RoomSaveResult, type RoomSavedFile } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { HttpError, fail } from '../http/errors'
import { isGuest } from '../auth/guests'
import { authorize } from '../policy/authorize'
import { atLeast, type Principal, type RuleSet } from '../policy/access'
import { Denied, ToolError } from '../policy/errors'
import { badSegment, hiddenEntry } from '../policy/names'
import { inSkills } from '../skills/guard'
import { instructionLike } from '../chat/turn'
import { componentC } from '../team-files/component'
import { activePeople, type TeamFiles } from '../team-files/service'
import { checkRegular, freeName, hashFile } from '../team-files/place'
import { readRegular } from '../files/store'
import { readerCheck } from '../files/share-readers'
import { TurnFiles, type ToolCtx } from '../files/service'
import { placeProduced } from '../tools/make-file'
import { admitSuggest, suggestForNames } from '../team-files/move-suggest'
import { findRoomFile } from './reader'
import { recordRoomFileSave, statKey } from './file-saves'
import { roomFilesOf } from './files'
import { memberRow, messageRow, roomRow, type FileRow, type MessageRow, type RoomRow } from './store'
import { looksSensitive } from './sensitive'

export { looksSensitive }

/** files of one message saved at once (a message holds at most this many) */
export const SAVE_FILES_MAX = 10
/** tracked places looked at for one room's list (newest first) */
const SAVED_ROWS_MAX = 300
/** a small text file's bytes looked at for a resident number (a hint only) */
const SNIFF_MAX = 256 * 1024

// ---------------- the file, as the person sees it ----------------
type Found = { file: FileRow; message: MessageRow; room: RoomRow }

/** A file of this room as the person sees it now (room_file's lookup: findRoomFile with their member row), else 404. */
function lookup(ctx: AppContext, userId: string, roomId: string, fileId: string): Found {
  const f = findRoomFile(ctx.db, userId, roomId, fileId, 'UTC')
  // the route names the room by id; a name that happened to match another room is not this one
  if ('text' in f || f.room.id !== roomId || f.file.id !== fileId) return fail('not_found')
  return { file: f.file, message: f.message, room: f.room }
}

function noGuests(ctx: AppContext, userId: string) {
  if (isGuest(ctx.db, userId)) fail('forbidden')
}

/** The words a file was sent with: the room's own name (not a DM's: that is a person's name), its message and, for a
 * reply, the thread's first message (who a thread is about is usually said there). */
function contextWords(ctx: AppContext, f: Found): string {
  const parts: string[] = []
  if (f.room.kind !== 'dm' && f.room.name) parts.push(f.room.name)
  if (f.message.body) parts.push(f.message.body.slice(0, 2000))
  if (f.message.thread_root_id) {
    const root = messageRow(ctx.db, f.room.id, f.message.thread_root_id)
    if (root && !root.deleted_at && root.body) parts.push(root.body.slice(0, 2000))
  }
  return parts.join('\n')
}

// ---------------- the folder ----------------
/** A folder the person can see and write, by its path (actual names on disk); else the policy's errors. */
function writableFolder(files: TeamFiles, user: Principal, rules: RuleSet, raw: string): string {
  const p = raw.normalize('NFC').replace(/^\/+|\/+$/g, '')
  if (!p) throw new HttpError('validation', 'Pick a folder.', { fields: { 'body.folder': 'empty' } })
  const segs = p.split('/')
  if (segs.some((s, i) => badSegment(s) !== null || hiddenEntry(s, i))) fail('not_found')
  const a = authorize(files.fx, rules, user, p, 'list')
  if (!a.st?.isDirectory()) throw new ToolError(`'${a.rel}' is a file`, 'not_folder')
  if (inSkills(a.rel) || /^users\/[^/]+\/skills(\/|$)/i.test(a.rel)) throw new HttpError('validation', 'Files from a conversation are not saved in a skills folder.', { params: { reason: 'skills_folder' } })
  authorize(files.fx, rules, user, a.rel, 'write')
  return a.rel
}

/** How many active people can open the folder and are not in the room now (a count, never who). */
function outsideRoom(ctx: AppContext, rules: RuleSet, roomId: string, folder: string): number {
  const inRoom = new Set((ctx.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as { user_id: string }[]).map((r) => r.user_id))
  const reads = readerCheck(ctx.db, rules)
  const segs = folder.split('/')
  return activePeople(ctx.db).filter((p) => !inRoom.has(p.id) && reads(p, segs)).length
}

// ---------------- same bytes ----------------
const hashing = new Map<string, Promise<string>>()
/** The team file's identity and, when it has `size` bytes, its sha256 (hashed once even when asked at the same time);
 * `seen`: the identity its bytes were last found to be the room file's (no hash then). null: not a file of that size. */
async function bytesOf(abs: string, size: number, sha: string, seen: string | null): Promise<{ sha: string; key: string } | null> {
  let st: fs.Stats
  try { st = checkRegular(abs) } catch { return null }
  if (st.size !== size) return null
  const key = statKey(st)
  if (seen === key) return { sha, key }
  const k = `${abs}\0${key}`
  let p = hashing.get(k)
  if (!p) {
    p = hashFile(abs).finally(() => hashing.delete(k))
    hashing.set(k, p)
  }
  return { sha: await p, key }
}

type SaveRow = { path: string; sha256: string; seen: string | null }
/** The first tracked place of this file that is still there with its bytes and that `user` may open, or null. A place
 * hashed again is remembered by its identity on disk, so the next read does not hash it. */
async function placeOf(ctx: AppContext, files: TeamFiles, user: Principal, rules: RuleSet, file: Pick<FileRow, 'id' | 'sha256' | 'size'>, rows: SaveRow[]): Promise<string | null> {
  return (await placeAndKey(ctx, files, user, rules, file, rows))?.rel ?? null
}

/** placeOf, with the copy's identity on disk now (for a row of another file with these bytes, written for this one). */
async function placeAndKey(ctx: AppContext, files: TeamFiles, user: Principal, rules: RuleSet, file: Pick<FileRow, 'id' | 'sha256' | 'size'>, rows: SaveRow[]): Promise<{ rel: string; key: string } | null> {
  for (const r of rows) {
    if (r.sha256 !== file.sha256) continue
    const segs = r.path.split('/')
    if (!atLeast(rules.access(user, segs), 'read')) continue
    let a
    try { a = authorize(files.fx, rules, user, r.path, 'read', { mustExist: true }) } catch { continue }
    if (!a.st?.isFile()) continue
    const b = await bytesOf(a.abs, file.size, file.sha256, r.seen)
    if (b?.sha !== file.sha256) continue
    if (b.key !== r.seen) ctx.db.query('UPDATE room_file_saves SET seen = ? WHERE file_id = ? AND path = ?').run(b.key, file.id, r.path)
    return { rel: a.rel, key: b.key }
  }
  return null
}

const savedRows = (ctx: AppContext, fileId: string) => ctx.db.query('SELECT path, sha256, seen FROM room_file_saves WHERE file_id = ? ORDER BY saved_at DESC').all(fileId) as SaveRow[]
/** the tracked places in `folder` (directly in it) of any room file with these bytes (each still checked by placeOf: there, the same bytes, readable) */
const sameBytesRows = (ctx: AppContext, sha256: string, folder: string) => (ctx.db.query("SELECT path, sha256, seen FROM room_file_saves WHERE sha256 = ? AND substr(path, 1, ?) = ? ORDER BY saved_at DESC LIMIT ?")
  .all(sha256, folder.length + 1, folder + '/', SAVED_ROWS_MAX) as SaveRow[]).filter((r) => !r.path.slice(folder.length + 1).includes('/'))

// ---------------- the three calls ----------------
/** GET /api/rooms/:id/saved-files: this room's files that are in the team folder where this viewer can open them. */
export async function savedFiles(ctx: AppContext, userId: string, roomId: string): Promise<{ items: RoomSavedFile[] }> {
  noGuests(ctx, userId)
  const rooms = roomFilesOf(ctx)
  // a member of the room now, the room not archived (else 404 like a room that is not there)
  const room = roomRow(ctx.db, roomId)
  if (!room || room.archived_at || !memberRow(ctx.db, roomId, userId)) fail('not_found')
  const rows = ctx.db.query(`SELECT s.file_id, s.path, s.sha256, s.seen, f.sha256 AS file_sha, f.size FROM room_file_saves s JOIN room_files f ON f.id = s.file_id
    WHERE f.room_id = ? AND f.message_id IS NOT NULL ORDER BY s.saved_at DESC LIMIT ?`).all(roomId, SAVED_ROWS_MAX) as (SaveRow & { file_id: string; file_sha: string; size: number })[]
  if (!rows.length) return { items: [] }
  const files = componentC(ctx).files
  const user = files.principal(userId)
  const rules = files.rules()
  const byFile = new Map<string, typeof rows>()
  for (const r of rows) byFile.set(r.file_id, [...(byFile.get(r.file_id) ?? []), r])
  const items: RoomSavedFile[] = []
  for (const [fileId, list] of byFile) {
    // the file's message still there and visible to this viewer (the room's own read check)
    try { rooms.open(userId, roomId, fileId, false) } catch { continue }
    const at = await placeOf(ctx, files, user, rules, { id: fileId, sha256: list[0]!.file_sha, size: list[0]!.size }, list)
    if (at) items.push({ fileId, path: at })
  }
  return { items }
}

/** POST /api/rooms/:id/save-plan: the sheet's files, the folder it pre-selects and, for `folder`, its audience. */
export async function savePlan(ctx: AppContext, userId: string, roomId: string, fileIds: readonly string[], folder?: string): Promise<RoomSavePlan> {
  noGuests(ctx, userId)
  // every plan counts (it reads files and may hash), with or without a suggestion: the Move picker's limit
  admitSuggest(userId)
  const found = [...new Set(fileIds)].slice(0, SAVE_FILES_MAX).map((id) => lookup(ctx, userId, roomId, id))
  const files = componentC(ctx).files
  const user = files.principal(userId)
  const rules = files.rules()
  const rooms = roomFilesOf(ctx)
  const out: RoomSavePlan = { files: [], suggestion: null, sensitive: false }
  // per file: a personal-looking one gets no suggestion, the others keep theirs (QA 11-17: one bank book in a message
  // took the suggestion from every file); an identical one is the same file, saved once (TC-4803)
  const personal = new Set<string>()
  const firstOf = new Map<string, string>()
  for (const f of found) {
    const savedPath = await placeOf(ctx, files, user, rules, f.file, savedRows(ctx, f.file.id))
    const sameAs = firstOf.get(f.file.sha256)
    if (!sameAs) firstOf.set(f.file.sha256, f.file.id)
    const sniff = () => {
      if (f.file.size > SNIFF_MAX) return null
      try { return readRegular(rooms.open(userId, roomId, f.file.id, false).abs, SNIFF_MAX).bytes } catch { return null }
    }
    const sensitive = looksSensitive(f.file.name, contextWords(ctx, f), sniff)
    if (sensitive) { personal.add(f.file.id); out.sensitive = true }
    out.files.push({ id: f.file.id, name: f.file.name, size: f.file.size, ...(savedPath ? { savedPath } : {}), ...(sensitive ? { sensitive } : {}), ...(sameAs ? { sameAs } : {}) })
  }
  if (folder !== undefined) {
    const at = writableFolder(files, user, rules, folder)
    out.folder = { path: at, outside: outsideRoom(ctx, rules, roomId, at) }
    return out
  }
  // the suggestion is for the files still to save that look ordinary (a copy of another counts once); none when every
  // one looks personal: the person picks the place themselves
  const todo = found.filter((f) => {
    const x = out.files.find((y) => y.id === f.file.id)!
    return !x.savedPath && !x.sameAs && !personal.has(f.file.id)
  })
  if (!todo.length) return out
  // a folder by name only when it fits every one of them ('every': one folder for a message of a minutes file and a sales
  // sheet would be wrong for one of them); else a folder the person recently saved to, labelled Recent
  const s = await suggestForNames(files, userId, todo.map((f) => ({ name: f.file.name, context: contextWords(ctx, f) })), { every: true })
  const pick = s.suggested[0] ? { path: s.suggested[0].path, why: 'suggested' as const } : s.recent[0] ? { path: s.recent[0].path, why: 'recent' as const } : null
  if (pick) out.suggestion = { ...pick, outside: outsideRoom(ctx, rules, roomId, pick.path) }
  return out
}

/** POST /api/rooms/:id/save-to-team: copy the files into `folder`, each next to what is there, never over it. */
export async function saveToTeam(ctx: AppContext, userId: string, roomId: string, fileIds: readonly string[], folder: string, o: { askWiden?: boolean; confirm?: boolean } = {}): Promise<RoomSaveResult> {
  noGuests(ctx, userId)
  const files = componentC(ctx).files
  const rooms = roomFilesOf(ctx)
  const ids = [...new Set(fileIds)].slice(0, SAVE_FILES_MAX)
  // every file and the place checked before anything is copied: one that cannot go refuses the whole save
  const found = ids.map((id) => lookup(ctx, userId, roomId, id))
  const user0 = files.principal(userId)
  const at = writableFolder(files, user0, files.rules(), folder)
  for (const f of found) {
    if (ctx.files.quarantine.hasHash(f.file.sha256)) throw new HttpError('unavailable', 'This file is held by the team\'s safety check.', { params: { reason: 'quarantined' } })
    if (f.file.size > SMALL_UPLOAD_MAX) throw new HttpError('payload_too_large', 'Larger than 50 MB: download it and upload it on the Files screen.', { params: { reason: 'too_large' } })
    const target = `${at}/${f.file.name}`
    if (badSegment(f.file.name) !== null || instructionLike(target)) throw new HttpError('validation', 'A file with this name is not saved from a conversation.', { params: { reason: 'instruction_file' } })
  }
  // more people than the conversation's can see the folder (QA TC-ask2-6: a private room's file saved to Company-wide,
  // 17 people, no question): with askWiden, the person's yes first (409 audience_widened with how many), as a move or a
  // restore asks (team-files/service.ts). Files already saved there count too: one question for the whole save
  if (o.askWiden && !o.confirm) {
    const n = outsideRoom(ctx, files.rules(), roomId, at)
    if (n > 0) throw new HttpError('conflict', undefined, { params: { reason: 'audience_widened', viewersAdded: n } })
  }
  const saved: RoomSaveResult['saved'] = []
  for (const f of found) {
    const target = `${at}/${f.file.name}`
    const rules = files.rules()
    const user = files.principal(userId)
    // the same bytes there already (at its own name, or a copy saved beside another file earlier, in this folder, from
    // this file or any room file with these bytes: an identical file of the same message saved a moment ago, or sent
    // again later): that is where it is, no second copy and no skipped number (TC-4803)
    const here = sameBytesRows(ctx, f.file.sha256, at)
    const before = await placeAndKey(ctx, files, user, rules, f.file, here)
    if (before) {
      recordRoomFileSave(ctx, f.file.id, before.rel, f.file.sha256, f.file.size, before.key)
      saved.push({ fileId: f.file.id, path: before.rel, existed: true })
      continue
    }
    try {
      const a = authorize(files.fx, rules, user, target, 'read', { mustExist: true })
      const b = a.st?.isFile() ? await bytesOf(a.abs, f.file.size, f.file.sha256, null) : null
      if (b?.sha === f.file.sha256) {
        recordRoomFileSave(ctx, f.file.id, a.rel, f.file.sha256, f.file.size, b.key)
        saved.push({ fileId: f.file.id, path: a.rel, existed: true })
        continue
      }
    } catch (e) { if (!(e instanceof Denied || e instanceof ToolError)) throw e }
    // the room's read check again right before the bytes (the person still in the room, the message still there)
    const abs = rooms.open(userId, roomId, f.file.id, false).abs
    const workRoot = path.join(ctx.engineConfig.dataDir, 'work')
    fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 })
    const work = fs.mkdtempSync(path.join(workRoot, 'room-save-'))
    try {
      const tmp = path.join(work, 'file')
      const bytes = readRegular(abs, SMALL_UPLOAD_MAX).bytes
      ctx.files.quarantine.assertBytes(bytes)
      fs.writeFileSync(tmp, bytes, { mode: 0o600 })
      // the person confirmed the place on the sheet, which showed who can see it: no further card
      // a fresh record of reads for each file: one that says a file of this name was "read" would let the next file of
      // the same name (two in one message) replace it instead of going beside it
      const c: ToolCtx = { user, turnId: null, files: new TurnFiles() }
      // a different file has the name: this copy is "name (2).ext" beside it (the person's own save, so not the AI's
      // "conflict copy - <name>" wording); placeProduced still never overwrites if one appears in between
      const free = freeName(path.join(files.root, ...at.split('/')), f.file.name)
      const made = await placeProduced(ctx, files, c, [...at.split('/'), free], tmp, 'save_room_file', undefined, { turnBytes: false, thisAnswerOnly: true, fetched: true, detail: { type: f.file.mime, by: 'person' } })
      const nextTo = made.conflictCopyOf ?? (free !== f.file.name ? target : undefined)
      let seen: string | null = null
      try { seen = statKey(fs.statSync(path.join(files.root, ...made.path.split('/')))) } catch { /* hashed on the next read */ }
      recordRoomFileSave(ctx, f.file.id, made.path, made.sha256, made.size, seen)
      // (no Undo token any more: Save to project's Undo was retired with the project link, its endpoint answers 410)
      saved.push({ fileId: f.file.id, path: made.path, existed: false, ...(nextTo ? { nextTo } : {}) })
    } finally { fs.rmSync(work, { recursive: true, force: true }) }
  }
  return { saved }
}

