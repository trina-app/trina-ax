// Who changed what in a dev environment folder (holes 2, 4 and 7 of the review). Every box command runs inside a
// window: a snapshot before (changes since the last one = "in the background", by the dev server, a watcher, a build
// that an earlier command left running), a snapshot after (changes = the command's, by the person of the turn). Each
// change becomes a file_events row (detail.via = "dev_env") and is published like any other file change; the previous
// content of a changed file becomes a file version when the content store has it.
//
// Conflict with Files edits: an edit of a file in the folder from the file screen or another AI while a command runs
// is kept (its bytes go into the content store at once). If the command then changed the same file to something else,
// the edit is not lost: it is saved as a conflict copy next to the file, as for two people saving at once.
//
// Commands of one project run one at a time (the window would otherwise mix two people's changes).
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { FileChange } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { atomicWrite, conflictCopyName, fileEvent, onFileEvent, recordConflictCopy, saveVersion, trashBytes, trashRow } from '../files/store'
import { moveIntoTrash } from '../team-files/place'
import { instructionLike } from '../tools/rename-pattern'
import { publishChanges } from '../team-files/changes'
import { getSetting, getTeamSettings, setSetting } from '../admin/settings'
import { sharesTrashed } from '../files/shares'
import { ownSharedFolders } from '../files/share-readers'
import { diffSnapshots, keepable, PROJECT_CAPS, readInside, SnapshotStore, takeSnapshot, type Change, type Manifest, type StoreCaps } from './snapshot'
import crypto from 'node:crypto'

export interface Actor { userId: string; turnId: string | null }

interface ProjectState {
  store: SnapshotStore
  folder: string
  queue: Promise<unknown>
  /** edits from outside the box during the running command: path -> hash and who */
  outside: Map<string, { sha256: string; userId: string; turnId: string | null }> | null
  lastActor: Actor | null
}

const VIA = 'dev_env'
const states = new WeakMap<Database, Map<string, ProjectState>>()
const hooked = new WeakSet<Database>()

/** The own-folder store's caps (docs/decisions/20261122-ask-less-side-chat-runs.md rule 2): a file up to 8 MiB is kept
 * before a command, at most 256 MiB in all; a larger file's change cannot be undone, and the room card stays. */
export const OWN_CAPS: StoreCaps = { fileMax: 8 << 20, totalMax: 256 << 20 }

/** `key`: a project id, or `own:<userId>` for a person's own folder (its store under dev-env/own/<userId>) */
function state(ctx: AppContext, key: string, folder: string, caps: StoreCaps = PROJECT_CAPS): ProjectState {
  let m = states.get(ctx.db)
  if (!m) states.set(ctx.db, (m = new Map()))
  let s = m.get(key)
  if (!s || s.folder !== folder) {
    // a moved project folder starts a new manifest: the old one names other paths
    const dir = key.startsWith('own:') ? path.join(ctx.engineConfig.dataDir, 'dev-env', 'own', key.slice(4)) : path.join(ctx.engineConfig.dataDir, 'dev-env', key)
    s = { store: new SnapshotStore(dir, caps), folder, queue: Promise.resolve(), outside: null, lastActor: s?.lastActor ?? null }
    m.set(key, s)
  }
  if (!hooked.has(ctx.db)) {
    hooked.add(ctx.db)
    onFileEvent(ctx.db, (e) => {
      if ((e.detail as { via?: unknown } | null)?.via === VIA) return
      for (const st of states.get(ctx.db)?.values() ?? []) {
        if (!st.outside || !(e.path === st.folder || e.path.startsWith(st.folder + '/'))) continue
        if (e.action !== 'update' && e.action !== 'create' && e.action !== 'restore') continue
        try {
          const r = readInside(path.join(ctx.files.fx.root, e.path), fs.realpathSync(path.join(ctx.files.fx.root, st.folder)), st.store.caps.fileMax)
          if (!r) continue
          const bytes = r.bytes
          const h = crypto.createHash('sha256').update(bytes).digest('hex')
          st.store.keep(h, bytes, { left: Number.MAX_SAFE_INTEGER })
          st.outside.set(e.path, { sha256: h, userId: e.userId, turnId: e.turnId })
        } catch {}
      }
    })
  }
  return s
}

function userRef(db: Database, id: string) {
  const u = db.query('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | null
  return { id, name: u?.name ?? id }
}

/**
 * Record changes as file events, publish them, and keep what they replaced: a changed file's previous content becomes a
 * file version, a deleted file goes to the trash (restorable there, the team's retention days). Returns the changes
 * whose previous content was not kept (too large for the store, or over its total): those cannot be undone.
 */
function record(ctx: AppContext, s: ProjectState, changes: Change[], by: Actor, extra: Record<string, unknown>): Change[] {
  if (!changes.length) return []
  const root = ctx.files.fx.root
  const out: FileChange[] = []
  const lost: Change[] = []
  for (const c of changes) {
    let trashId: string | null = null
    if (c.action !== 'create') {
      const old = c.before ? s.store.blob(c.before) : null
      let kept = false
      if (old) try {
        if (c.action === 'delete') { trashId = trashBytes(ctx.db, root, c.path, old, by, getTeamSettings(ctx.db).trashRetentionDays); try { sharesTrashed(ctx.db, c.path, trashId) } catch {} }
        else saveVersion(ctx.db, root, c.path, old, by)
        kept = true
      } catch (e) { ctx.log.warn('dev env: the previous content was not kept', { err: e, path: c.path }) }
      if (!kept) lost.push(c)
    }
    fileEvent(ctx.db, { turnId: by.turnId, userId: by.userId, path: c.path, action: c.action, ...(c.size !== null ? { size: c.size } : {}), ...(c.after ? { sha256: c.after } : {}), detail: { via: VIA, ...extra, ...(trashId ? { trashId } : {}) } })
    out.push({ path: c.path, action: c.action, by: userRef(ctx.db, by.userId), turnId: by.turnId })
  }
  try { publishChanges(ctx, out) } catch (e) { ctx.log.warn('dev env change publish failed', { err: e }) }
  return lost
}

/** Keep a save from outside the box that the command then changed again: a conflict copy next to the file (as two
 * people saving at once). Returns the copies' paths. */
function conflictCopies(ctx: AppContext, s: ProjectState, changes: Change[], outside: Map<string, { sha256: string; userId: string; turnId: string | null }>): string[] {
  const root = ctx.files.fx.root
  const conflicts: string[] = []
  for (const c of changes) {
    const o = outside.get(c.path)
    if (!o || c.action === 'create') continue
    const bytes = s.store.blob(o.sha256)
    if (!bytes) continue
    const dir = path.posix.dirname(c.path), base = path.posix.basename(c.path)
    const copy = path.posix.join(dir, conflictCopyName(base, userRef(ctx.db, o.userId).name))
    try {
      atomicWrite(root, copy.split('/'), bytes, {})
      recordConflictCopy(ctx.db, ctx.files.events, { original: c.path, copy, userId: o.userId, turnId: o.turnId, size: bytes.length, sha256: o.sha256, tool: VIA })
      fileEvent(ctx.db, { turnId: o.turnId, userId: o.userId, path: copy, action: 'create', size: bytes.length, sha256: o.sha256, detail: { via: VIA, conflictOf: c.path } })
      conflicts.push(copy)
    } catch (e) { ctx.log.warn('dev env conflict copy failed', { err: e, path: c.path }) }
  }
  return conflicts
}

/** `lost`: the changes (the command's and the background's) whose previous content was not kept: no version, no trash */
export interface WindowResult<T> { value: T; changes: Change[]; background: Change[]; conflicts: string[]; lost?: Change[] }

/**
 * Run `fn` (one box command) inside a change window of the project folder. Commands of one project wait for each
 * other. `background` = what changed since the last window (attributed to the person of the last command).
 */
/** `bulk` (devenv/bulk.ts): called with the command's changes before they are recorded; it may move the files the
 * command created out of the folder and returns the team paths that are gone, which are then not recorded. */
export interface WindowOptions { bulk?(changes: Change[], startedMs: number, present: readonly string[]): Promise<Set<string>> }

export function withChangeWindow<T>(ctx: AppContext, project: { id: string; folderPath: string }, by: Actor, extra: Record<string, unknown>, fn: () => Promise<T>, opts: WindowOptions = {}): Promise<WindowResult<T>> {
  const s = state(ctx, project.id, project.folderPath)
  const run = async (): Promise<WindowResult<T>> => {
    const root = ctx.files.fx.root
    const prev = s.store.load()
    const start = takeSnapshot(root, project.folderPath, prev, s.store)
    const background = prev ? diffSnapshots(prev, start) : []
    // after a server restart the person of the last command is not known: the change is shown as the box's
    const lost: Change[] = []
    if (background.length) lost.push(...record(ctx, s, background, s.lastActor ?? by, { background: true, ...(s.lastActor ? {} : { actorUnknown: true }) }))
    const outside = new Map<string, { sha256: string; userId: string; turnId: string | null }>()
    s.outside = outside
    let value: T
    // the start of the command: a folder born after it is the command's (devenv/bulk.ts movableRoots)
    const startedMs = Date.now()
    // the snapshot after runs even when the command failed or was stopped: what it wrote is still there. Saves from
    // outside stay tracked until the bulk guard below is done (its card waits)
    try { value = await fn() } catch (e) { s.outside = null; throw e }
    let end = takeSnapshot(root, project.folderPath, start, s.store)
    const notOutside = (c: Change) => { const o = outside.get(c.path); return !o || o.sha256 !== c.after }
    // a file the command changed AND someone else saved during the command: changes from the outside save are not
    // the box's (they are already recorded by the file layer), only the difference from it is
    let changes = diffSnapshots(start, end).filter(notOutside)
    // many new files: the bulk guard may move them to the chat's scratch folder first; what went is not recorded. What
    // else changed meanwhile (a job, a dev server; not a save from outside, recorded already) is recorded as background
    let meanwhile: Change[] = []
    if (opts.bulk && changes.some((c) => c.action === 'create')) {
      let gone = new Set<string>()
      try { gone = await opts.bulk(changes, startedMs, Object.keys(end.files)) } catch (e) { ctx.log.warn('dev env bulk guard failed', { err: e }) }
      if (gone.size) {
        changes = changes.filter((c) => !gone.has(c.path))
        const fresh = takeSnapshot(root, project.folderPath, end, s.store)
        meanwhile = diffSnapshots(end, fresh).filter((c) => !(c.action === 'delete' && gone.has(c.path))).filter(notOutside)
        end = fresh
      }
    }
    s.outside = null
    s.store.save(end)
    s.lastActor = by
    const conflicts = conflictCopies(ctx, s, changes, outside)
    lost.push(...record(ctx, s, changes, by, extra))
    if (meanwhile.length) lost.push(...record(ctx, s, meanwhile, by, { background: true }))
    return { value, changes, background: [...background, ...meanwhile], conflicts, lost }
  }
  const p = s.queue.then(run, run)
  s.queue = p.catch(() => {})
  return p
}

// ---------------- "changed by someone else since your last command" (hole 2) ----------------
const seenKey = (projectId: string, userId: string) => `devEnv.seen.${projectId}.${userId}`

/** `to` / `from`: a move on the Files screen is two events (a delete {movedTo} at the old place, a create {movedFrom} at
 * the new one): said as a move, never as a delete (QA TC-r2b-01: the AI told people "박준호 deleted the poster") */
export interface ForeignChange { path: string; action: string; by: { id: string; name: string }; at: string; background: boolean; to?: string; from?: string }

/** Changes in the folder by other people (box or not) since this person's last acknowledged point. */
export function changesByOthers(ctx: AppContext, project: { id: string; folderPath: string }, userId: string, limit = 50): { items: ForeignChange[]; total: number; lastId: number } {
  const since = getSetting<number>(ctx.db, seenKey(project.id, userId)) ?? 0
  const like = project.folderPath.replace(/[\\%_]/g, (m) => '\\' + m) + '/%'
  const where = `e.id > ? AND (e.path = ? OR e.path LIKE ? ESCAPE '\\') AND e.user_id != ? AND e.action IN ('create','update','delete','restore','upload')`
  const total = (ctx.db.query(`SELECT COUNT(*) AS n, COALESCE(MAX(e.id), 0) AS m FROM file_events e WHERE ${where}`).get(since, project.folderPath, like, userId) as { n: number; m: number })
  const rows = ctx.db.query(`SELECT e.path, e.action, e.user_id, u.name, e.at, e.detail FROM file_events e LEFT JOIN users u ON u.id = e.user_id WHERE ${where} ORDER BY e.id DESC LIMIT ?`)
    .all(since, project.folderPath, like, userId, limit) as { path: string; action: string; user_id: string; name: string | null; at: string; detail: string | null }[]
  const items = rows.map((r): ForeignChange => {
    let d: { background?: unknown; movedTo?: unknown; movedFrom?: unknown } = {}
    try { d = r.detail ? JSON.parse(r.detail) : {} } catch {}
    const base = { path: r.path, by: { id: r.user_id, name: r.name ?? r.user_id }, at: r.at, background: !!d.background }
    if (r.action === 'delete' && typeof d.movedTo === 'string') return { ...base, action: 'moved', to: d.movedTo }
    if (r.action === 'create' && typeof d.movedFrom === 'string') return { ...base, action: 'moved in', from: d.movedFrom }
    return { ...base, action: r.action }
  })
  return { items, total: total.n, lastId: total.m }
}

export function markSeen(ctx: AppContext, projectId: string, userId: string, lastId?: number) {
  const id = lastId ?? (ctx.db.query('SELECT COALESCE(MAX(id), 0) AS m FROM file_events').get() as { m: number }).m
  setSetting(ctx.db, seenKey(projectId, userId), id)
}

// ---------------- the person's own folder (docs/decisions/20261122-ask-less-side-chat-runs.md rule 2) ----------------
// A run writes users/<id> straight to the disk (srt/access.ts), with no window of its own until now: a command that
// overwrote or removed the person's files left nothing to go back to. One window per person, around each foreground
// command of a chat that is not shared (a shared chat's run has no personal folder): the content of every file up to
// OWN_CAPS.fileMax is in the person's store before the command starts (the start snapshot re-reads only files whose
// size, mtime, ctime or inode changed since the last one), and after it a changed file's previous content becomes a
// file version and a removed file goes to the trash. Changes between commands (the Files screen, a job, a dev server)
// are not the command's and are not recorded here; the start snapshot only takes them as the new baseline.

/** Why a run's change in the own folder could not be undone now, or null when every change can. */
export interface OwnUndo { ok: boolean; unkept: string[]; skipped: string[]; truncated: boolean }
const under = (r: string, xs: readonly string[]) => xs.some((x) => r === x || r.startsWith(x + '/'))
const undoOf = (m: Manifest, exclude: readonly string[] = []): OwnUndo => {
  const unkept = (m.unkept ?? []).filter((r) => !under(r, exclude)), skipped = (m.skipped ?? []).filter((r) => !under(r, exclude))
  return { ok: !m.truncated && !unkept.length && !skipped.length, unkept: unkept.slice(0, 10), skipped: skipped.slice(0, 10), truncated: m.truncated }
}
const ownFolder = (userId: string) => `users/${userId}`
const ownThere = (ctx: AppContext, userId: string) => { try { return fs.lstatSync(path.join(ctx.files.fx.root, ownFolder(userId))).isDirectory() } catch { return false } }
/** the manifest as it is saved: without the report of one snapshot */
const bare = (m: Manifest): Manifest => ({ at: m.at, files: m.files, truncated: m.truncated })
const hashesOf = (m: Manifest) => new Set(Object.values(m.files).map((e) => e.sha256).filter((h): h is string => !!h))

/** Folders of the own folder a run cannot write (srt/access.ts): its skills and the folders the person shares. A change
 * there cannot happen, so nothing there keeps the card. */
export function ownReadOnly(ctx: AppContext, userId: string): string[] {
  let shared: string[] = []
  try { shared = ownSharedFolders(ctx.db, userId) } catch {}
  return [`${ownFolder(userId)}/skills`, ...shared]
}

/**
 * Could every change a command makes in the person's own folder be undone now (stat only: nothing is read or kept
 * here; the command's window reads and keeps, and checks again: OwnNotUndoable)? Not when a file there is over
 * OWN_CAPS.fileMax or past the store's total, a folder skipped by name holds something (node_modules, .git, .env*), or
 * the folder has more files than a snapshot lists. Folders a run cannot write are left out. No folder yet: yes (a
 * command can only make new files there). The room card is skipped only on a yes (chat/turn.ts ownBoxRun).
 */
export function ownFolderUndoable(ctx: AppContext, userId: string): OwnUndo {
  if (!ownThere(ctx, userId)) return { ok: true, unkept: [], skipped: [], truncated: false }
  try {
    const k = keepable(ctx.files.fx.root, ownFolder(userId), OWN_CAPS, ownReadOnly(ctx, userId))
    return { ok: !k.truncated && !k.unkept.length && !k.skipped.length, unkept: k.unkept.slice(0, 10), skipped: k.skipped.slice(0, 10), truncated: k.truncated }
  } catch (e) {
    ctx.log.warn('dev env: own folder check failed', { err: e })
    return { ok: false, unkept: [], skipped: [], truncated: true }
  }
}

/** A command let through without the room card because its changes could be undone (OwnWindowOptions.mustUndo), whose
 * own folder can no longer be fully kept when it is about to start: it does not run. */
export class OwnNotUndoable extends Error {
  constructor(readonly undo: OwnUndo) { super('the own folder cannot be fully kept now') }
}

/** `reverted`: changes undone right after the command (OwnWindowOptions.mustUndo: an instruction file or a hidden file) */
export interface OwnWindowResult<T> { value: T; changes: Change[]; lost: Change[]; conflicts: string[]; reverted: Change[] }
/** `mustUndo`: the command went without the room card on the promise that its changes can be undone (chat/turn.ts
 * ownBoxRun). `exclude`: team paths inside the own folder another window records (a personal project's folder). */
export interface OwnWindowOptions { mustUndo?: boolean; exclude?: readonly string[] }

/** What a command let through without the room card may not change in the own folder even though it can be undone:
 * what the person's AI follows (skills, CLAUDE.md, AGENTS.md ...: chat/turn.ts asks with the whole content on the card
 * after a room read) and hidden files and folders (tool settings, hooks). */
export const ownGuarded = (rel: string, userId: string) => instructionLike(rel) || rel.split('/').slice(2).some((x) => x.startsWith('.'))

/** Undo one change of a command in the own folder (a guarded path): the command's file goes to the trash, the content
 * before it comes back. False when it cannot be undone (the earlier content is not kept). */
function revert(ctx: AppContext, s: ProjectState, c: Change, by: Actor): boolean {
  const root = ctx.files.fx.root
  const segs = c.path.split('/')
  const old = c.before ? s.store.blob(c.before) : null
  if (c.action !== 'create' && !old) return false
  const days = getTeamSettings(ctx.db).trashRetentionDays
  if (c.action !== 'delete') {
    // the command's file, kept in the trash (it may be what the person wanted after all)
    const st = fs.lstatSync(path.join(root, ...segs))
    if (!st.isFile()) return false
    const storage = moveIntoTrash(root, segs)
    trashRow(ctx.db, c.path, storage, st.size, by, days)
  }
  if (old) atomicWrite(root, segs, old, { createDirs: true })
  return true
}

/**
 * Run `fn` (one foreground box command) inside a change window of the person's own folder. Commands of one person wait
 * for each other here. `mustUndo`: when the start snapshot cannot keep everything, `fn` is not called and OwnNotUndoable
 * is thrown; after the command, its changes to guarded paths (ownGuarded) are undone.
 */
export function withOwnFolderWindow<T>(ctx: AppContext, userId: string, by: Actor, extra: Record<string, unknown>, fn: () => Promise<T>, o: OwnWindowOptions = {}): Promise<OwnWindowResult<T>> {
  if (!ownThere(ctx, userId)) {
    // no own folder yet: nothing there to lose (a command that makes one is the person's new files; the next window
    // takes them as its baseline)
    return fn().then((value) => ({ value, changes: [], lost: [], conflicts: [], reverted: [] }))
  }
  const s = state(ctx, `own:${userId}`, ownFolder(userId), OWN_CAPS)
  const exclude = o.exclude ?? []
  const run = async (): Promise<OwnWindowResult<T>> => {
    const root = ctx.files.fx.root
    const start = takeSnapshot(root, s.folder, s.store.load(), s.store, { report: true })
    if (o.mustUndo) {
      const u = undoOf(start, [...exclude, ...ownReadOnly(ctx, userId)])
      if (!u.ok) { s.store.save(bare(start)); throw new OwnNotUndoable(u) }
    }
    const outside = new Map<string, { sha256: string; userId: string; turnId: string | null }>()
    s.outside = outside
    let value: T | undefined, failed: unknown = null, threw = false
    // what the command wrote is there even when it failed or was stopped: recorded either way
    try { value = await fn() } catch (e) { threw = true; failed = e }
    let end = takeSnapshot(root, s.folder, start, s.store)
    let changes = diffSnapshots(start, end).filter((c) => !under(c.path, exclude)).filter((c) => { const x = outside.get(c.path); return !x || x.sha256 !== c.after })
    s.outside = null
    const reverted: Change[] = []
    if (o.mustUndo) {
      for (const c of changes) {
        if (!ownGuarded(c.path, userId)) continue
        try { if (revert(ctx, s, c, by)) reverted.push(c) } catch (e) { ctx.log.warn('dev env: a guarded change was not undone', { err: e, path: c.path }) }
      }
      if (reverted.length) {
        const back = new Set(reverted.map((c) => c.path))
        changes = changes.filter((c) => !back.has(c.path))
        end = takeSnapshot(root, s.folder, end, s.store)
      }
    }
    const conflicts = conflictCopies(ctx, s, changes, outside)
    const lost = record(ctx, s, changes, by, { ...extra, place: 'own' })
    s.store.save(bare(end))
    s.lastActor = by
    // the store keeps only what the newest manifest names: the replaced content is a version or in the trash now
    try { s.store.prune(hashesOf(end)) } catch {}
    if (threw) throw failed
    return { value: value as T, changes, lost, conflicts, reverted }
  }
  const p = s.queue.then(run, run)
  s.queue = p.catch(() => {})
  return p
}
