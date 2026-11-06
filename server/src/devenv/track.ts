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
import { atomicWrite, conflictCopyName, fileEvent, onFileEvent, recordConflictCopy, saveVersion } from '../files/store'
import { publishChanges } from '../team-files/changes'
import { getSetting, setSetting } from '../admin/settings'
import { CAS_FILE_MAX, diffSnapshots, readInside, SnapshotStore, takeSnapshot, type Change } from './snapshot'
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

function state(ctx: AppContext, projectId: string, folder: string): ProjectState {
  let m = states.get(ctx.db)
  if (!m) states.set(ctx.db, (m = new Map()))
  let s = m.get(projectId)
  if (!s || s.folder !== folder) {
    // a moved project folder starts a new manifest: the old one names other paths
    s = { store: new SnapshotStore(path.join(ctx.engineConfig.dataDir, 'dev-env', projectId)), folder, queue: Promise.resolve(), outside: null, lastActor: s?.lastActor ?? null }
    m.set(projectId, s)
  }
  if (!hooked.has(ctx.db)) {
    hooked.add(ctx.db)
    onFileEvent(ctx.db, (e) => {
      if ((e.detail as { via?: unknown } | null)?.via === VIA) return
      for (const st of states.get(ctx.db)?.values() ?? []) {
        if (!st.outside || !(e.path === st.folder || e.path.startsWith(st.folder + '/'))) continue
        if (e.action !== 'update' && e.action !== 'create' && e.action !== 'restore') continue
        try {
          const r = readInside(path.join(ctx.files.fx.root, e.path), fs.realpathSync(path.join(ctx.files.fx.root, st.folder)), CAS_FILE_MAX)
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

/** Record changes as file events (+ versions of the previous content), publish them. */
function record(ctx: AppContext, s: ProjectState, changes: Change[], by: Actor, extra: Record<string, unknown>): void {
  if (!changes.length) return
  const root = ctx.files.fx.root
  const out: FileChange[] = []
  for (const c of changes) {
    if (c.before && c.action !== 'create') {
      const old = s.store.blob(c.before)
      if (old) try { saveVersion(ctx.db, root, c.path, old, by) } catch {}
    }
    fileEvent(ctx.db, { turnId: by.turnId, userId: by.userId, path: c.path, action: c.action, ...(c.size !== null ? { size: c.size } : {}), ...(c.after ? { sha256: c.after } : {}), detail: { via: VIA, ...extra } })
    out.push({ path: c.path, action: c.action, by: userRef(ctx.db, by.userId), turnId: by.turnId })
  }
  try { publishChanges(ctx, out) } catch (e) { ctx.log.warn('dev env change publish failed', { err: e }) }
}

export interface WindowResult<T> { value: T; changes: Change[]; background: Change[]; conflicts: string[] }

/**
 * Run `fn` (one box command) inside a change window of the project folder. Commands of one project wait for each
 * other. `background` = what changed since the last window (attributed to the person of the last command).
 */
export function withChangeWindow<T>(ctx: AppContext, project: { id: string; folderPath: string }, by: Actor, extra: Record<string, unknown>, fn: () => Promise<T>): Promise<WindowResult<T>> {
  const s = state(ctx, project.id, project.folderPath)
  const run = async (): Promise<WindowResult<T>> => {
    const root = ctx.files.fx.root
    const prev = s.store.load()
    const start = takeSnapshot(root, project.folderPath, prev, s.store)
    const background = prev ? diffSnapshots(prev, start) : []
    // after a server restart the person of the last command is not known: the change is shown as the box's
    if (background.length) record(ctx, s, background, s.lastActor ?? by, { background: true, ...(s.lastActor ? {} : { actorUnknown: true }) })
    const outside = new Map<string, { sha256: string; userId: string; turnId: string | null }>()
    s.outside = outside
    let value: T
    // the snapshot after runs even when the command failed or was stopped: what it wrote is still there
    try { value = await fn() } finally { s.outside = null }
    const end = takeSnapshot(root, project.folderPath, start, s.store)
    s.store.save(end)
    s.lastActor = by
    // a file the command changed AND someone else saved during the command: changes from the outside save are not
    // the box's (they are already recorded by the file layer), only the difference from it is
    const changes = diffSnapshots(start, end).filter((c) => { const o = outside.get(c.path); return !o || o.sha256 !== c.after })
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
    record(ctx, s, changes, by, extra)
    return { value, changes, background, conflicts }
  }
  const p = s.queue.then(run, run)
  s.queue = p.catch(() => {})
  return p
}

// ---------------- "changed by someone else since your last command" (hole 2) ----------------
const seenKey = (projectId: string, userId: string) => `devEnv.seen.${projectId}.${userId}`

export interface ForeignChange { path: string; action: string; by: { id: string; name: string }; at: string; background: boolean }

/** Changes in the folder by other people (box or not) since this person's last acknowledged point. */
export function changesByOthers(ctx: AppContext, project: { id: string; folderPath: string }, userId: string, limit = 50): { items: ForeignChange[]; total: number; lastId: number } {
  const since = getSetting<number>(ctx.db, seenKey(project.id, userId)) ?? 0
  const like = project.folderPath.replace(/[\\%_]/g, (m) => '\\' + m) + '/%'
  const where = `e.id > ? AND (e.path = ? OR e.path LIKE ? ESCAPE '\\') AND e.user_id != ? AND e.action IN ('create','update','delete','restore','upload')`
  const total = (ctx.db.query(`SELECT COUNT(*) AS n, COALESCE(MAX(e.id), 0) AS m FROM file_events e WHERE ${where}`).get(since, project.folderPath, like, userId) as { n: number; m: number })
  const rows = ctx.db.query(`SELECT e.path, e.action, e.user_id, u.name, e.at, e.detail FROM file_events e LEFT JOIN users u ON u.id = e.user_id WHERE ${where} ORDER BY e.id DESC LIMIT ?`)
    .all(since, project.folderPath, like, userId, limit) as { path: string; action: string; user_id: string; name: string | null; at: string; detail: string | null }[]
  const items = rows.map((r) => {
    let bg = false
    try { bg = !!(r.detail && (JSON.parse(r.detail) as { background?: unknown }).background) } catch {}
    return { path: r.path, action: r.action, by: { id: r.user_id, name: r.name ?? r.user_id }, at: r.at, background: bg }
  })
  return { items, total: total.n, lastId: total.m }
}

export function markSeen(ctx: AppContext, projectId: string, userId: string, lastId?: number) {
  const id = lastId ?? (ctx.db.query('SELECT COALESCE(MAX(id), 0) AS m FROM file_events').get() as { m: number }).m
  setSetting(ctx.db, seenKey(projectId, userId), id)
}
