// The files of a conversation made a project (POST /api/rooms/:id/make-project, rooms/make-project.ts) move into the
// project's Chat attachments after the conversion (docs/AGENTS/plan/20261121-0619-structure-polish.md A, migration 433
// room_file_moves). The conversion only writes one row per file that moves (planInTx); this mover does the bytes, at
// start and on the rooms' one-minute tick (routes/rooms.ts), one file at a time within a time budget, and right after a
// conversion (kick). The request never waits for bytes.
//
// Which files move (candidates + stayReason): a file on a message that is not deleted and is for the whole room, that
// every member then sees by the room's own rule (SEE_SQL with each member's start, thread roots included; none of them
// has it hidden), kept in room storage (no room_file_refs row), not on the download-only list, and not a copy of a team
// file (a phone's team pick: team_path / origin 'team_copy'; an AI answer's attached copy: origin 'answer_copy', or on an
// older row the message's kept scope naming the file), except a copy of the sender's own file on their own message made
// from nothing but their own files and this room (ownFileCopy: an AI post or "Send to a chat room" of a file in
// users/<sender>/, which they sent on purpose, as an upload). In doubt the file stays. The same test runs again for each file
// just before it moves, for the members of the conversion's moment (people added to the project later were told in the
// confirm that they can open the moved files).
//
// No hard links: many readers refuse a file with more than one link (chat-files, make-zip, the MCP download link,
// isolate, link names). The bytes go by rename only, through <team>/.system/room-moves/<move id> on the same disk; while
// a file is staged there the room's file endpoint reads it from there (rooms/files.ts open), with the same checks.
//
// Per row (`step`), each crash or failure ends in one known state:
//   pending   still wanted (the room is the project's room, the project active: in the trash it waits, deleted → kept;
//             the file still passes the test) and a place (sharedUploadPlace for the sender while they can write
//             there, else for the actor; every current member reads that folder) → one write: placing, staged, the
//             inode, tries + 1 → rename into staging, thumbnails removed.
//   placing   staged there → placeUpload (a taken name "(2)", case-folded names, an instruction file's name and
//             _FILES.md taken, a refused name gets a safe one, never an overwrite; its upload event names the move)
//             → commit. Staged absent and room bytes there (a crash before the rename): renamed again. Both absent (a
//             crash after placing): adopted, by the upload event naming this move (the same inode, or the same sha256)
//             or by the inode among the Chat attachments folder's entries (a crash inside placeUpload, a temp name is
//             put back to staging); nothing found: kept (lost, logged).
//   commit    one write: the room_file_refs row, the room file's name the placed one, no thumbnail, done. The message
//             deleted meanwhile (room_file_id NULL): cancelled instead.
//   cancelled the file this move placed goes to the team trash (the same inode at its path), a staged one is deleted;
//             then its paths are cleared (settled).
//   cleanup   a failure (disk full, five tries, the place narrowed or gone while staged): the staged bytes go back to
//             room storage, then kept with the reason. The file stays readable in the room, "Only in this conversation".
// When a room's moves are all settled, one closing line by the system: { project_files_moved, moved, kept }.
// Quota: a moved file leaves the rooms line (.system/rooms) and counts under Team files; nothing is copied, so the
// storage check is not run again.
import fs from 'node:fs'
import path from 'node:path'
import { PRODUCT } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fileEvent, sha256Regular } from '../files/store'
import { atLeast, loadPrincipal, RuleSet, type Principal } from '../policy/access'
import { badSegment } from '../policy/names'
import { publishChanges } from '../team-files/changes'
import { componentC } from '../team-files/component'
import { FileError } from '../team-files/errors'
import { sharedUploadPlace, type SharedUploadPlace } from '../uploads/shared-chat'
import { roomFileRefsOf } from './file-refs'
import { takenInTeamPlace } from './files'
import { activePeople, readersOf, systemLine } from './project-room'
import { roomsOf } from './service'
import { messageRow, roomRow, SEE_MEMBER_SQL, type FileRow } from './store'

export const MOVES_DIR = 'room-moves'
/** the same failure this many times: the file stays in the conversation */
export const MOVE_TRIES_MAX = 5
/** how long one run may move files before it goes on at the next tick */
export const MOVE_BUDGET_MS = 2000
const OPEN_STATES = "('pending', 'placing', 'cleanup')"
/** rows the mover still has work on: open, or cancelled with something left to clear */
const WORK_SQL = `state IN ${OPEN_STATES} OR (state = 'cancelled' AND (staged IS NOT NULL OR placed_path IS NOT NULL OR ino IS NOT NULL))`
const THUMB_EXTS = ['png', 'jpg'] as const

export interface MoveRow {
  id: string; room_file_id: string | null; room_id: string; project_id: string; actor: string; sender: string | null
  state: 'pending' | 'placing' | 'cleanup' | 'done' | 'kept' | 'cancelled'
  staged: string | null; placed_path: string | null; ino: number | null; dev: number | null; sha256: string
  tries: number; reason: string | null; created_at: string; updated_at: string
}

/** A room-stored file sent on a message the whole room may see, with what the test reads of its message. */
export interface Candidate extends FileRow { origin: string | null; source_scope: string | null; seq: number; author_kind: string; author_id: string | null }

/** The room-stored files of a room on a message that is not deleted, not an event and for the whole room (`fileId`:
 * that one only). */
export function candidates(ctx: AppContext, roomId: string, fileId?: string): Candidate[] {
  return ctx.db.query(`SELECT f.*, m.source_scope, m.seq, m.author_kind, m.author_id FROM room_files f JOIN room_messages m ON m.id = f.message_id AND m.room_id = f.room_id
    WHERE f.room_id = ? AND f.message_id IS NOT NULL AND m.deleted_at IS NULL AND m.event IS NULL AND m.visibility = 'room'
      AND NOT EXISTS (SELECT 1 FROM room_file_refs rr WHERE rr.room_file_id = f.id)${fileId ? ' AND f.id = ?' : ''} ORDER BY f.rowid`)
    .all(...(fileId ? [roomId, fileId] : [roomId])) as Candidate[]
}

/** Why this file stays in the conversation, or null when it moves. `joinedBy`: only the members who had joined by then
 * (the conversion's moment) are asked whether they see it. */
export function stayReason(ctx: AppContext, f: Candidate, joinedBy = '9999'): string | null {
  if (f.team_path) return 'team_copy'
  // a copy of the sender's own file that they sent themselves (post_to_room's card, "Send to a chat room") moves like
  // their upload of it (QA TC-7046, docs/decisions/20261121-make-project-own-file-copies.md); any other copy stays
  const ownCopy = ownFileCopy(ctx, f)
  if (f.origin && f.origin !== 'upload' && !(f.origin === 'answer_copy' && ownCopy)) return f.origin
  // an older row: a copy an AI answer attached is named in its message's kept scope (chat/answer-share.ts attached);
  // anything that names the file there stays (in doubt, keep)
  if (!ownCopy && f.source_scope && f.source_scope.includes(f.id)) return 'answer_copy'
  if (ctx.files.quarantine.hasHash(f.sha256)) return 'quarantined'
  const unseen = ctx.db.query(`SELECT 1 FROM room_messages m JOIN room_members mm ON mm.room_id = m.room_id JOIN users uu ON uu.id = mm.user_id AND uu.status = 'active' AND uu.deleted_at IS NULL
    WHERE m.id = ? AND mm.joined_at <= ? AND NOT (${SEE_MEMBER_SQL}) LIMIT 1`).get(f.message_id, joinedBy)
  return unseen ? 'not_seen' : null
}

/** Is this room file a copy its sender made of a file in their own folder (users/<sender>/…), on their own message, from
 * nothing but their own files and this conversation? Read from the message's kept scope (chat/answer-share.ts): the copy
 * in `attached` with the team path it was made from, and `sources`, everything the answer and the files that went with
 * it used (an AI-made file's own inputs too), complete (`unknown` false). Every source must be the sender's own folder
 * or this room (its files move with it, and its people are the project's; a file made from a team folder, another room,
 * a connection or a shared Drive stays: people added later would get what they may not see). Anything else, or a scope
 * that does not parse: no (in doubt, keep). */
function ownFileCopy(ctx: AppContext, f: Candidate): boolean {
  const sender = f.user_id
  if (!f.source_scope || !sender || f.author_kind !== 'user' || f.author_id !== sender) return false
  const fold = (x: string) => (ctx.files.fx.caseInsensitive ? x.normalize('NFC').toLowerCase() : x.normalize('NFC'))
  const mine = (p: unknown): boolean => {
    if (typeof p !== 'string') return false
    const segs = p.split('/').filter((x) => x && x !== '.')
    return segs.length >= 2 && !segs.includes('..') && fold(segs[0]!) === 'users' && fold(segs[1]!) === fold(sender)
  }
  try {
    const kept = JSON.parse(f.source_scope) as { sources?: unknown; unknown?: unknown; attached?: unknown }
    if (kept.unknown !== false || !Array.isArray(kept.sources) || !Array.isArray(kept.attached)) return false
    const hit = kept.attached.filter((a) => !!a && typeof a === 'object' && (a as { file?: unknown }).file === f.id) as { path?: unknown }[]
    if (hit.length !== 1 || !mine(hit[0]!.path) || String(hit[0]!.path).split('/').filter(Boolean).length < 3) return false
    return kept.sources.every((x) => {
      if (!x || typeof x !== 'object') return false
      const s = x as { type?: unknown; id?: unknown; path?: unknown; via?: unknown }
      // (not what the sender's personal connection or browser returned: { type: 'user', via })
      if (s.type === 'user') return s.id === sender && !s.via
      if (s.type === 'name') return mine(s.path)
      if (s.type === 'room') return s.id === f.room_id
      return false
    })
  } catch { return false }
}

/** Why a file stays, as the confirm says it: `copy` (a copy of a file from a folder: people added to the project later
 * would get it), `unseen` (not everyone here sees it) or `other` (its bytes are on the download-only list, or a reason
 * this build does not know). */
export const stayKind = (reason: string): 'copy' | 'unseen' | 'other' => (reason === 'team_copy' || reason === 'answer_copy' ? 'copy' : reason === 'not_seen' ? 'unseen' : 'other')

/** What "Make it a project" will do with a room's files: those that move, how many stay, and of those how many are copies
 * and how many stay for another reason (stayKind). */
export function splitFiles(ctx: AppContext, roomId: string): { moving: Candidate[]; staying: number; stayingCopies: number; stayingOther: number } {
  const moving: Candidate[] = []
  let staying = 0, stayingCopies = 0, stayingOther = 0
  for (const f of candidates(ctx, roomId)) {
    const why = stayReason(ctx, f)
    if (why === null) { moving.push(f); continue }
    staying++
    const k = stayKind(why)
    if (k === 'copy') stayingCopies++
    else if (k === 'other') stayingOther++
  }
  return { moving, staying, stayingCopies, stayingOther }
}

/** A simulated crash (tests): the run stops as the process would, writing nothing more. */
export class MoveCrash extends Error {}
export type MoveStep = 'stage-write' | 'stage-rename' | 'place' | 'commit' | 'after-commit'

const services = new WeakMap<AppContext, RoomFileMoves>()

export class RoomFileMoves {
  /** tests: called at each step; a MoveCrash thrown there stops the run as a crash would */
  fault: ((step: MoveStep, row: MoveRow) => void) | null = null
  /** run by itself after a conversion (off in tests: they run it) */
  auto = process.env.NODE_ENV !== 'test'
  private running: Promise<RunResult> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** a kick while a pass runs: one more pass after it (its rows were not in the running pass's list) */
  private again = false
  /** the active people, loaded once per pass (placeFor's check that only the project's people read the folder) */
  private people: Principal[] | null = null
  /** rooms whose moves changed: checked for their closing line after a run */
  private touched = new Set<string>()
  /** touched only by the start's reconcile (old, settled rooms): checked for their closing line, but nobody is told the room changed */
  private quiet = new Set<string>()
  constructor(readonly ctx: AppContext) {}

  private get db() { return this.ctx.db }
  private teamRoot() { return this.ctx.files.fx.root }
  stagingRoot() { return path.join(this.teamRoot(), PRODUCT.systemDir, MOVES_DIR) }
  private stagedRel(moveId: string) { return `${PRODUCT.systemDir}/${MOVES_DIR}/${moveId}` }
  private abs(rel: string) { return path.join(this.teamRoot(), ...rel.split('/')) }
  private roomAbs(roomId: string, fileId: string) { return path.join(this.teamRoot(), PRODUCT.systemDir, 'rooms', roomId, fileId) }
  private row(id: string): MoveRow | null { return this.db.query('SELECT * FROM room_file_moves WHERE id = ?').get(id) as MoveRow | null }
  private set(id: string, cols: Partial<Omit<MoveRow, 'id'>>) {
    const keys = Object.keys(cols)
    this.db.query(`UPDATE room_file_moves SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...(keys.map((k) => (cols as Record<string, unknown>)[k] ?? null) as (string | number | null)[]), nowIso(), id)
  }

  /** Inside the conversion's write: one row per file that moves; returns how many move and stay. */
  planInTx(roomId: string, projectId: string, actor: string): { moving: number; staying: number } {
    const { moving, staying } = splitFiles(this.ctx, roomId)
    const now = nowIso()
    const ins = this.db.query("INSERT INTO room_file_moves (id, room_file_id, room_id, project_id, actor, sender, state, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
    for (const f of moving) ins.run(newId(), f.id, roomId, projectId, actor, f.user_id, f.sha256, now, now)
    this.touched.add(roomId)
    this.quiet.delete(roomId)
    return { moving: moving.length, staying }
  }

  /** Run soon (after a conversion), unless `auto` is off. */
  kick(roomId?: string) {
    if (roomId) { this.touched.add(roomId); this.quiet.delete(roomId) }
    if (!this.auto) return
    if (this.running) { this.again = true; return }
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.run().catch((e) => this.ctx.log.warn('room file moves failed', { err: e })) }, 0)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** One pass: the rows with work left, one file at a time, until the budget is used. A second call while one runs
   * waits for it. */
  run(budgetMs = MOVE_BUDGET_MS): Promise<RunResult> {
    if (this.running) return this.running
    this.running = (async () => {
      try { return await this.pass(budgetMs) } finally {
        this.running = null
        this.people = null
        if (this.again) { this.again = false; this.kick() }
      }
    })()
    return this.running
  }

  private async pass(budgetMs: number): Promise<RunResult> {
    const out: RunResult = { done: 0, kept: 0, cancelled: 0, left: 0 }
    const until = Date.now() + budgetMs
    const ids = (this.db.query(`SELECT id FROM room_file_moves WHERE ${WORK_SQL} ORDER BY created_at, id`).all() as { id: string }[]).map((r) => r.id)
    for (const [i, id] of ids.entries()) {
      if (Date.now() > until) { out.left = ids.length - i; break }
      const row = this.row(id)
      if (!row) continue
      this.touched.add(row.room_id)
      this.quiet.delete(row.room_id)
      let end: StepEnd
      try { end = await this.step(row) } catch (e) {
        if (e instanceof MoveCrash) throw e
        end = this.failed(id, e)
      }
      if (end === 'done' || end === 'kept' || end === 'cancelled') out[end]++
    }
    this.closeSettled()
    return out
  }

  /** A failure of one row: counted. Disk full or the same failure MOVE_TRIES_MAX times: a moving file goes back to
   * the conversation; a 'cancelled' row (its trash failed) or a 'cleanup' row (its way back failed) is settled as it
   * is and logged, so the room's moves end (a staged file of a settled cleanup stays readable from there, and the next
   * start's reconcile puts it back). */
  private failed(id: string, e: unknown): StepEnd {
    const code = (e as NodeJS.ErrnoException)?.code
    const full = code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL' || (e as { code?: string })?.code === 'storage_full'
    const row = this.row(id)
    if (!row) return 'wait'
    // (a placing row's tries went up when it was staged or tried again; every other state's go up here)
    const tries = row.state === 'placing' ? row.tries : row.tries + 1
    this.set(id, { tries, reason: String(code ?? (e as Error)?.name ?? 'error').slice(0, 40) })
    this.ctx.log.warn('a room file did not move', { err: e, move: id, tries, state: row.state })
    if (row.state === 'cancelled' || row.state === 'cleanup') {
      if (tries < MOVE_TRIES_MAX) return 'wait'
      if (row.state === 'cancelled') {
        this.set(id, { staged: null, placed_path: null, ino: null, dev: null, reason: 'trash_failed' })
        this.ctx.log.error('a deleted message\'s moved file could not go to the trash; left where it is', { move: id, path: row.placed_path })
        return 'cancelled'
      }
      this.set(id, { state: 'kept', reason: 'restore_failed' })
      this.ctx.log.error('a room file could not go back to the conversation; it stays readable from the room moves folder', { move: id, staged: row.staged })
      return 'kept'
    }
    if (!full && tries < MOVE_TRIES_MAX) return 'wait'
    try { return this.backToRoom(this.row(id)!, full ? 'disk_full' : 'failed') } catch (err) { this.ctx.log.warn('a room file could not go back to the conversation', { err, move: id }); return 'wait' }
  }

  /** Is the file at `abs` this move's bytes: a single-link regular file of the room file's size (when the row is still
   * there to say it) and of its sha256. Every adoption and every trash of a found file asks this first (an inode
   * number can be used again by another file). */
  private sameBytes(row: MoveRow, abs: string): boolean {
    try {
      const st = fs.lstatSync(abs)
      if (!st.isFile() || st.nlink !== 1) return false
      const size = row.room_file_id ? (this.db.query('SELECT size FROM room_files WHERE id = ?').get(row.room_file_id) as { size: number } | null)?.size ?? null : null
      if (size !== null && st.size !== size) return false
      return sha256Regular(abs, st) === row.sha256
    } catch { return false }
  }

  private async step(row: MoveRow): Promise<StepEnd> {
    if (row.state === 'cancelled') return this.cleanCancelled(row)
    if (row.state === 'cleanup') return this.backToRoom(row, row.reason ?? 'failed')
    const f = row.room_file_id ? this.db.query('SELECT * FROM room_files WHERE id = ?').get(row.room_file_id) as FileRow | null : null
    if (!f) { this.set(row.id, { state: 'cancelled', tries: 0 }); return this.cleanCancelled(this.row(row.id)!) }
    // 1. still wanted?
    const want = this.wanted(row, f)
    if (want === 'wait') return 'wait'
    if (want !== 'ok') return row.state === 'placing' ? this.backToRoom(row, want) : this.keep(row, want)
    // 2. where
    const where = this.placeFor(row, f)
    if (where === 'wait') return 'wait'
    if (typeof where === 'string') return row.state === 'placing' ? this.backToRoom(row, where) : this.keep(row, where)
    const staged = (r: MoveRow) => this.abs(r.staged ?? this.stagedRel(r.id))
    // 3. stage
    if (row.state === 'pending') {
      const from = this.roomAbs(f.room_id, f.id)
      let st: fs.Stats
      try { st = fs.lstatSync(from) } catch { return this.keep(row, 'missing') }
      if (!st.isFile() || st.nlink > 1) return this.keep(row, 'not_regular')
      this.fault?.('stage-write', row)
      this.db.query("UPDATE room_file_moves SET state = 'placing', staged = ?, ino = ?, dev = ?, tries = tries + 1, updated_at = ? WHERE id = ? AND state = 'pending'").run(this.stagedRel(row.id), st.ino, st.dev, nowIso(), row.id)
      row = this.row(row.id)!
      this.fault?.('stage-rename', row)
      fs.mkdirSync(this.stagingRoot(), { recursive: true, mode: 0o700 })
      fs.renameSync(from, staged(row))
      this.removeThumbs(f)
    } else {
      this.db.query('UPDATE room_file_moves SET tries = tries + 1, updated_at = ? WHERE id = ?').run(nowIso(), row.id)
      row = this.row(row.id)!
      if (!fs.existsSync(staged(row))) {
        const from = this.roomAbs(f.room_id, f.id)
        if (fs.existsSync(from)) {
          // a crash between the write and the rename: the rename again
          fs.mkdirSync(this.stagingRoot(), { recursive: true, mode: 0o700 })
          fs.renameSync(from, staged(row))
          this.removeThumbs(f)
        } else {
          // a crash after placing, before the commit (or inside placeUpload): adopted, never placed twice
          const found = this.findPlaced(row, where.folder)
          if (found?.kind === 'placed') return this.commit(row, found.rel)
          if (found?.kind === 'tmp') fs.renameSync(found.abs, staged(row))
          else { this.ctx.log.warn('a moving room file was not found', { move: row.id }); return this.keep(row, 'lost') }
        }
      }
      if (row.tries > MOVE_TRIES_MAX) return this.backToRoom(row, 'failed')
    }
    // 4. place
    const team = componentC(this.ctx).files
    if (!where.exists) {
      try { team.mkdir(where.who, where.folder) } catch (e) { if (!(e instanceof FileError && e.key === 'exists')) throw e }
    }
    this.fault?.('place', row)
    const entry = await team.placeUpload(where.who, where.folder, safeName(f.name), staged(row), 'rename', row.sha256,
      { action: 'upload', detail: { attachment: f.id, roomId: f.room_id, moved: row.id, ...(f.user_id ? { sentBy: f.user_id } : {}) } }, { taken: takenInTeamPlace })
    this.fault?.('commit', row)
    // 5. commit
    return this.commit(row, entry.path)
  }

  /** Is the move still wanted: the room is still the project's room, the project active (in the trash: wait; gone:
   * kept), the file still one that moves for the members of the conversion's moment. */
  private wanted(row: MoveRow, f: FileRow): 'ok' | 'wait' | string {
    const p = this.db.query('SELECT trashed_with FROM projects WHERE id = ?').get(row.project_id) as { trashed_with: string | null } | null
    if (!p) return 'project_gone'
    if (p.trashed_with !== null) return 'wait'
    const link = this.db.query("SELECT 1 FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE l.room_id = ? AND l.project_id = ? AND l.mode = 'room' AND r.archived_at IS NULL").get(row.room_id, row.project_id)
    if (!link) return 'not_project_room'
    const c = candidates(this.ctx, f.room_id, f.id)[0]
    if (!c) return 'not_movable'
    return stayReason(this.ctx, c, row.created_at) ?? 'ok'
  }

  /** Where it goes: the project's Chat attachments as the sender may write it, else as the actor; every member of the
   * room now reads that folder. Safe operations on: wait. */
  private placeFor(row: MoveRow, f: FileRow): ({ who: string } & SharedUploadPlace) | 'wait' | string {
    const files = { fx: this.ctx.files.fx, rules: () => this.ctx.files.rules(), principal: (id: string) => this.ctx.files.principal(id) }
    let place: ({ who: string } & SharedUploadPlace) | null = null
    for (const who of [...new Set([f.user_id ?? row.sender, row.actor].filter((x): x is string => !!x))]) {
      try { place = { who, ...sharedUploadPlace(this.db, files, who, { project_id: row.project_id }) }; break } catch (e) {
        if (e instanceof FileError && e.params?.reason === 'safe_ops') return 'wait'
        // read only, not there for them, a disabled account: the next one
      }
    }
    if (!place) return 'no_writer'
    const rules = RuleSet.load(this.db)
    const segs = place.folder.split('/')
    for (const m of this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(row.room_id) as { user_id: string }[]) {
      const p = loadPrincipal(this.db, m.user_id)
      if (p && !atLeast(rules.access(p, segs), 'read')) return 'narrowed'
    }
    // and nobody else: the confirm promised the files go to the project's people. A folder wider than the project (a
    // rule on Chat attachments for someone outside it) keeps the file in the conversation; the owner and admins are as
    // anywhere else (projects/<name> is limited, so they read it only as its people)
    const project = this.db.query('SELECT folder_path FROM projects WHERE id = ?').get(row.project_id) as { folder_path: string } | null
    if (!project) return 'project_gone'
    const people = (this.people ??= activePeople(this.db))
    const inProject = readersOf(rules, people, { folder_path: project.folder_path, trashed_with: null })
    for (const x of readersOf(rules, people, { folder_path: place.folder, trashed_with: null })) {
      if (inProject.has(x)) continue
      const p = people.find((y) => y.id === x)
      if (p && (p.role === 'owner' || p.role === 'admin')) continue
      return 'wider'
    }
    return place
  }

  /** The file this move put in the team folder, found after a crash: by its upload event (the same inode, or the same
   * bytes), else by its inode among the folder's entries (a temp name: placeUpload stopped halfway). */
  private findPlaced(row: MoveRow, folder: string | null): { kind: 'placed'; rel: string } | { kind: 'tmp'; abs: string } | null {
    const ev = this.db.query("SELECT path FROM file_events WHERE action = 'upload' AND json_extract(detail, '$.moved') = ? ORDER BY id DESC LIMIT 1").get(row.id) as { path: string } | null
    // (each match must hold this move's bytes: sameBytes)
    if (ev && this.sameBytes(row, this.abs(ev.path))) return { kind: 'placed', rel: ev.path }
    if (row.ino === null || !folder) return null
    let names: string[] = []
    try { names = fs.readdirSync(this.abs(folder)) } catch { return null }
    for (const n of names) {
      const abs = path.join(this.abs(folder), n)
      try {
        const st = fs.lstatSync(abs)
        if (!st.isFile() || st.ino !== row.ino || st.dev !== row.dev || !this.sameBytes(row, abs)) continue
        return n.startsWith(PRODUCT.tmpPrefix) ? { kind: 'tmp', abs } : { kind: 'placed', rel: `${folder}/${n}` }
      } catch { /* gone meanwhile */ }
    }
    return null
  }

  /** 5. One write: the reference, the room file's name, done; or cancelled when the message went meanwhile. */
  private commit(row: MoveRow, rel: string): StepEnd {
    const st = fs.lstatSync(this.abs(rel))
    if (!st.isFile() || st.nlink !== 1) throw new Error('the placed file is not a single-link regular file')
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const end = this.db.transaction((): StepEnd => {
      const cur = this.row(row.id)
      const fileId = cur?.room_file_id
      if (!fileId || !this.db.query('SELECT 1 FROM room_files WHERE id = ?').get(fileId)) {
        this.set(row.id, { state: 'cancelled', staged: null, placed_path: rel, ino: st.ino, dev: st.dev })
        return 'cancelled'
      }
      roomFileRefsOf(this.ctx).add(fileId, rel, st, row.sha256)
      this.db.query('UPDATE room_files SET name = ?, thumb = 0 WHERE id = ?').run(name, fileId)
      this.set(row.id, { state: 'done', staged: null, placed_path: rel, ino: st.ino, dev: st.dev })
      return 'done'
    }).immediate()
    if (end === 'cancelled') return this.cleanCancelled(this.row(row.id)!)
    this.fault?.('after-commit', this.row(row.id)!)
    this.tellMessage(row.room_file_id)
    return end
  }

  /** The move is not done: kept in the conversation (nothing was staged). */
  private keep(row: MoveRow, reason: string): StepEnd {
    this.set(row.id, { state: 'kept', reason })
    return 'kept'
  }

  /** The staged bytes go back to room storage (a 'cleanup' row first, so a crash meanwhile goes on here), then kept. A
   * file already placed (nothing staged, nothing in the room; its bytes checked) is adopted when the move failed for the
   * disk's sake (failed, disk_full); for any other reason (the folder narrowed or wider, the file no longer seen by
   * everyone, the room no longer the project's) it is renamed back to room storage, never left in the project. */
  private backToRoom(row: MoveRow, reason: string): StepEnd {
    // (a cleanup resumed after a stop keeps the reason it was given)
    const why = row.state === 'cleanup' ? (row.reason ?? reason) : reason
    if (row.state !== 'cleanup') this.set(row.id, { state: 'cleanup', reason: why, tries: 0 })
    const f = row.room_file_id ? this.db.query('SELECT id, room_id FROM room_files WHERE id = ?').get(row.room_file_id) as { id: string; room_id: string } | null : null
    if (!f) { this.set(row.id, { state: 'cancelled', tries: 0 }); return this.cleanCancelled(this.row(row.id)!) }
    const staged = this.abs(row.staged ?? this.stagedRel(row.id))
    const home = this.roomAbs(f.room_id, f.id)
    const putHome = (from: string) => { fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 }); fs.renameSync(from, home) }
    if (fs.existsSync(staged)) {
      if (!fs.existsSync(home)) putHome(staged)
      else {
        // both there: the staged one is this move's own bytes only when it is the inode the move took; then it is the
        // file (it replaces what is at home), else it is left for the start's reconcile to report
        let st: fs.Stats | null = null
        try { st = fs.lstatSync(staged) } catch { /* gone */ }
        if (st && row.ino !== null && st.ino === row.ino && st.dev === row.dev) putHome(staged)
        else this.ctx.log.warn('a staged room file is not the one the move took; left in the room moves folder', { move: row.id })
      }
    } else if (!fs.existsSync(home)) {
      const found = this.findPlaced(row, this.placedFolder(row))
      if (found?.kind === 'placed') {
        if (why === 'failed' || why === 'disk_full') return this.commit(row, found.rel)
        const size = fs.lstatSync(this.abs(found.rel)).size
        putHome(this.abs(found.rel))
        this.leftProject(row, f, found.rel, size)
      }
      if (found?.kind === 'tmp') putHome(found.abs)
    }
    this.db.query('UPDATE room_files SET thumb = 0 WHERE id = ?').run(f.id)
    this.set(row.id, { state: 'kept', staged: null, reason: why })
    this.tellMessage(f.id)
    return 'kept'
  }

  /** A placed file taken back out of the project's folder: a delete in its history and a change for the lists and
   * search, as any other removal of a team file (its upload event stays; a later findPlaced checks the bytes there). */
  private leftProject(row: MoveRow, f: { id: string; room_id: string }, rel: string, size: number) {
    try {
      fileEvent(this.db, { turnId: null, userId: row.actor, path: rel, action: 'delete', size, detail: { attachment: f.id, roomId: f.room_id, movedBack: row.id } })
      const u = this.db.query('SELECT id, name FROM users WHERE id = ?').get(row.actor) as { id: string; name: string } | null
      publishChanges(this.ctx, [{ path: rel, action: 'delete', by: u ?? { id: row.actor, name: row.actor }, turnId: null }])
    } catch (e) { this.ctx.log.warn('a file taken back to the conversation was not told', { err: e, move: row.id }) }
  }

  /** The project's Chat attachments folder as the actor would be given it (only to look for a placed file). */
  private placedFolder(row: MoveRow): string | null {
    const files = { fx: this.ctx.files.fx, rules: () => this.ctx.files.rules(), principal: (id: string) => this.ctx.files.principal(id) }
    for (const who of [row.sender, row.actor]) {
      if (!who) continue
      try { return sharedUploadPlace(this.db, files, who, { project_id: row.project_id }).folder } catch { /* the next */ }
    }
    return null
  }

  /** 7. A move whose message was deleted: the file it placed goes to the team trash (only that very file: the same inode
   * at its path), a staged one is deleted; then its paths are cleared. */
  private cleanCancelled(row: MoveRow): StepEnd {
    const staged = this.abs(row.staged ?? this.stagedRel(row.id))
    fs.rmSync(staged, { force: true })
    const found = row.placed_path ? { kind: 'placed' as const, rel: row.placed_path } : this.findPlaced(row, this.placedFolder(row))
    if (found?.kind === 'tmp') fs.rmSync(found.abs, { force: true })
    if (found?.kind === 'placed') {
      let st: fs.Stats | null = null
      try { st = fs.lstatSync(this.abs(found.rel)) } catch { /* gone already */ }
      // only the very file this move placed: its inode and its bytes
      if (st?.isFile() && (row.ino === null || (st.ino === row.ino && st.dev === row.dev)) && this.sameBytes(row, this.abs(found.rel))) {
        const team = componentC(this.ctx).files
        let trashed = false
        for (const who of [row.sender, row.actor]) {
          if (!who || trashed) continue
          try { team.remove(who, found.rel); trashed = true } catch { /* the next */ }
        }
        // neither may write there now: the server puts it in the trash itself, in the actor's name
        if (!trashed) team.remove(row.actor, found.rel, null, { system: true })
      }
    }
    this.set(row.id, { staged: null, placed_path: null, ino: null, dev: null })
    return 'cancelled'
  }

  private removeThumbs(f: Pick<FileRow, 'room_id' | 'id'>) {
    for (const e of THUMB_EXTS) fs.rmSync(`${this.roomAbs(f.room_id, f.id)}.thumb.${e}`, { force: true })
  }

  /** The message of a file that moved (or stayed) is told again: its chip reads the team file now. */
  private tellMessage(fileId: string | null) {
    if (!fileId) return
    try {
      const m = this.db.query('SELECT room_id, message_id FROM room_files WHERE id = ?').get(fileId) as { room_id: string; message_id: string | null } | null
      const row = m?.message_id ? messageRow(this.db, m.room_id, m.message_id) : null
      if (row) roomsOf(this.ctx).messageEvent('room.message.updated', row)
    } catch (e) { this.ctx.log.warn('a moved room file was not told', { err: e }) }
  }

  /** The rooms whose moves are all settled get their closing line once: how many moved, how many stay. */
  private closeSettled() {
    const rooms = [...this.touched]
    const quiet = new Set(this.quiet)
    this.touched.clear()
    this.quiet.clear()
    for (const roomId of rooms) {
      try { this.close(roomId, quiet.has(roomId)) } catch (e) { this.ctx.log.warn('the files-moved line was not written', { err: e }) }
    }
  }

  private close(roomId: string, quiet = false) {
    if (this.db.query(`SELECT 1 FROM room_file_moves WHERE room_id = ? AND (${WORK_SQL}) LIMIT 1`).get(roomId)) return
    try { this.closeLine(roomId) } finally {
      // the moves have settled: every member's Room loses filesMoving ("Moving files…") now, line or no line
      if (!quiet && roomRow(this.db, roomId)) roomsOf(this.ctx).roomEvent(roomId, 'updated')
    }
  }

  private closeLine(roomId: string) {
    const db = this.db
    const link = db.query("SELECT l.project_id FROM room_project_links l JOIN rooms r ON r.id = l.room_id WHERE l.room_id = ? AND l.mode = 'room' AND r.archived_at IS NULL").get(roomId) as { project_id: string } | null
    if (!link) return
    // only a conversation made a project (its line by a person): never a room made as a project's
    if (!db.query("SELECT 1 FROM room_messages WHERE room_id = ? AND event IS NOT NULL AND json_extract(event, '$.type') = 'project_made' AND json_extract(event, '$.projectId') = ?").get(roomId, link.project_id)) return
    if (db.query("SELECT 1 FROM room_messages WHERE room_id = ? AND event IS NOT NULL AND json_extract(event, '$.type') = 'project_files_moved' AND json_extract(event, '$.projectId') = ?").get(roomId, link.project_id)) return
    const moved = (db.query("SELECT COUNT(*) n FROM room_file_moves WHERE room_id = ? AND project_id = ? AND state = 'done'").get(roomId, link.project_id) as { n: number }).n
    const kept = candidates(this.ctx, roomId).length
    if (!moved && !kept) return
    const line = db.transaction(() => systemLine(db, roomId, { type: 'project_files_moved', projectId: link.project_id, moved, kept }, nowIso())).immediate()
    const rooms = roomsOf(this.ctx)
    rooms.messageEvent('room.message', messageRow(db, roomId, line)!)
  }

  /**
   * At start, before the first run: the staging folder's files are the mover's. One of a row still open stays (the run
   * goes on with it); one whose row is settled: the very file at its team path (a second link) is unlinked, a kept
   * file's bytes go back to room storage when they are not there (its `staged` cleared), a kept file whose message was
   * deleted meanwhile (restore_failed, then the message went) is deleted, anything else is left and logged. The rooms
   * with moves are looked at for their closing line after the first run.
   */
  reconcile(): { unlinked: number; restored: number; removed: number; left: number } {
    const out = { unlinked: 0, restored: 0, removed: 0, left: 0 }
    // a kept row whose message is gone needs nothing staged: its file (when there) is removed in the loop, the column
    // cleared here either way (the next start then finds nothing to keep)
    const goneKept = this.db.query("SELECT id FROM room_file_moves WHERE state = 'kept' AND staged IS NOT NULL AND room_file_id IS NULL").all() as { id: string }[]
    for (const r of this.db.query('SELECT DISTINCT room_id FROM room_file_moves').all() as { room_id: string }[]) { this.touched.add(r.room_id); this.quiet.add(r.room_id) }
    let names: string[] = []
    try { names = fs.readdirSync(this.stagingRoot()) } catch { return out }
    for (const n of names) {
      const abs = path.join(this.stagingRoot(), n)
      const row = this.row(n)
      if (row && (row.state === 'pending' || row.state === 'placing' || row.state === 'cleanup' || row.state === 'cancelled')) continue
      let st: fs.Stats | null = null
      try { st = fs.lstatSync(abs) } catch { continue }
      if (row?.state === 'done' && row.placed_path) {
        try {
          const t = fs.lstatSync(this.abs(row.placed_path))
          if (t.ino === st.ino && t.dev === st.dev) { fs.rmSync(abs, { force: true }); out.unlinked++; continue }
        } catch { /* not there: left below */ }
      }
      if (row?.state === 'kept' && row.room_file_id) {
        const f = this.db.query('SELECT id, room_id FROM room_files WHERE id = ?').get(row.room_file_id) as { id: string; room_id: string } | null
        const home = f ? this.roomAbs(f.room_id, f.id) : null
        if (home && !fs.existsSync(home)) { fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 }); fs.renameSync(abs, home); this.set(row.id, { staged: null }); out.restored++; continue }
      }
      if (row?.state === 'kept' && !row.room_file_id && row.staged && this.abs(row.staged) === abs) { fs.rmSync(abs, { force: true }); out.removed++; continue }
      out.left++
    }
    for (const r of goneKept) this.set(r.id, { staged: null })
    if (out.left) this.ctx.log.warn('files left in the room moves folder', { left: out.left })
    return out
  }
}

export interface RunResult { done: number; kept: number; cancelled: number; left: number }
type StepEnd = 'done' | 'kept' | 'cancelled' | 'wait'

/** A name the team folder takes: the file's own, or "file" with its extension for one it refuses. */
export function safeName(name: string): string {
  const n = name.normalize('NFC')
  if (!n.includes('/') && !n.includes('\\') && !badSegment(n)) return n
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(n)?.[1]
  return ext ? `file.${ext}` : 'file'
}

export function roomFileMovesOf(ctx: AppContext): RoomFileMoves {
  let s = services.get(ctx)
  if (!s) { s = new RoomFileMoves(ctx); services.set(ctx, s) }
  return s
}
