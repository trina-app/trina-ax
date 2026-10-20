// Backups (design tab 6 "백업·복원", spike B). Component G.
//
// DB:          VACUUM INTO data/backups/<id>.sqlite (bun:sqlite has no backup API; VACUUM INTO is transactionally
//              consistent under writes, 1.1 s for the spike DB). Runs in a child bun process so the server's event
//              loop is never blocked. Session stashes are files in data/sessions/ — not part of the DB copy.
// Team folder: team/.system/backups/<id>/{team.tar.zst, manifest.json, deleted.json, dirs.json, meta.json}. A full
//              archive at most every 7 days, otherwise only the files whose size or mtime changed since the previous
//              backup (and every folder entry), plus the list of deleted paths and the list of folders. .system/backups itself is never archived; .system/history (file versions)
//              and the trash are.
// Metadata:    data/backups/<id>.json (the list the UI shows). Retention 14 days; a backup another kept backup builds
//              on is kept, and so is the newest one.
// Restore:     POST /api/admin/restore only puts an older DB back (same Mac; tab 6). The copy is integrity-checked and
//              staged; the swap happens at the next start, before the DB is opened (applyPendingRestore). Team-folder
//              restores and moving to another Mac go through scripts/ (admin password) using restoreTeamTo().
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { z } from 'zod'
import type { BackupInfo } from '@mycel/shared/api'
import { RestorePending } from '@mycel/shared/install'
import { SCHEMA_READER_LEVEL, checkReadable } from '../db'
import type { Logger } from '../log'
import { diskSpace, type InstallLayout } from './layout'
import { diffManifest, toManifest, walkTree, type Manifest } from './manifest'
import { readFileChunks, writeAtomic, zstdCompress, zstdDecompress } from './streams'
import { extractTar, tarStream, type TarEntryInput } from './tar'

export const BACKUP_RETENTION_DAYS = 14
export const FULL_EVERY_DAYS = 7
/** below this much free space backups stop (tab 7 "디스크 단계") */
export const BACKUP_MIN_FREE_BYTES = 2 * 1024 ** 3

export const BackupKind = z.enum(['daily', 'manual', 'pre-update', 'pre-migrate'])
export const BackupMeta = z.object({
  format: z.literal(1),
  id: z.string(),
  kind: BackupKind,
  scope: z.enum(['db', 'full', 'incremental']),
  createdAt: z.string(),
  serverVersion: z.string(),
  schemaVersion: z.number().int(),
  db: z.object({ file: z.string(), size: z.number().int(), sha256: z.string() }),
  team: z.object({
    /** previous backup this incremental builds on (null for a full archive) */
    base: z.string().nullable(),
    archiveSize: z.number().int(),
    files: z.number().int(),
    bytes: z.number().int(),
    deleted: z.number().int(),
    changedWhileReading: z.number().int(),
  }).nullable(),
})
export type BackupMeta = z.infer<typeof BackupMeta>

export class BackupError extends Error { name = 'BackupError' }

export interface BackupProgress { (fraction: number | null, message: string): void }

const ID_RE = /^[0-9]{8}T[0-9]{6}Z-(daily|manual|pre-update)(-[0-9]+)?$/
const PRE_MIGRATE_RE = /^pre-migrate-[A-Za-z0-9._-]+$/

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** Copy a live SQLite DB with VACUUM INTO in a child bun process (never blocks the server's event loop). */
export async function vacuumInto(src: string, dst: string): Promise<void> {
  await fsp.rm(dst, { force: true })
  const code = `const { Database } = require('bun:sqlite')
const d = new Database(process.env.MYCEL_VACUUM_SRC)
d.exec('PRAGMA busy_timeout = 15000')
d.query('VACUUM INTO ?').run(process.env.MYCEL_VACUUM_DST)
d.close()`
  const p = Bun.spawn([process.execPath, '-e', code], {
    env: { MYCEL_VACUUM_SRC: src, MYCEL_VACUUM_DST: dst, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdout: 'ignore', stderr: 'pipe',
  })
  const [err, exit] = await Promise.all([new Response(p.stderr).text(), p.exited])
  if (exit !== 0) throw new BackupError(`database copy failed: ${err.trim().split('\n').slice(-1)[0] ?? exit}`)
  await fsp.chmod(dst, 0o600)
}

/** integrity check + schema facts of a DB copy; throws when it is not usable */
export function inspectDbCopy(file: string): { schemaVersion: number } {
  const d = new Database(file)
  try {
    const r = d.query('PRAGMA quick_check').get() as Record<string, string> | null
    const v = r ? Object.values(r)[0] : null
    if (v !== 'ok') throw new BackupError(`database copy is damaged (${v ?? 'no answer'})`)
    checkReadable(d, SCHEMA_READER_LEVEL)
    const s = d.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }
    return { schemaVersion: s.v }
  } finally {
    d.close()
  }
}

export interface BackupManagerOptions {
  db: Database
  /** path of the live DB file */
  dbFile: string
  layout: InstallLayout
  log: Logger
  version: string
  now?: () => Date
  /** tests: runs between listing the team folder and archiving it (files can vanish in between) */
  afterWalk?: () => void | Promise<void>
}

export class BackupManager {
  private running: Promise<BackupMeta> | null = null
  constructor(private o: BackupManagerOptions) {}

  private now() { return this.o.now?.() ?? new Date() }
  private metaFile(id: string) { return path.join(this.o.layout.dbBackupsDir, `${id}.json`) }
  private dbCopy(id: string) { return path.join(this.o.layout.dbBackupsDir, `${id}.sqlite`) }
  teamDir(id: string) { return path.join(this.o.layout.teamBackupsDir, id) }

  /** Metadata of our backups (oldest first). Unreadable files are skipped (and logged). */
  metas(): BackupMeta[] {
    let names: string[] = []
    try { names = fs.readdirSync(this.o.layout.dbBackupsDir) } catch { return [] }
    const out: BackupMeta[] = []
    for (const n of names) {
      if (!n.endsWith('.json') || !ID_RE.test(n.slice(0, -5))) continue
      try { out.push(BackupMeta.parse(JSON.parse(fs.readFileSync(path.join(this.o.layout.dbBackupsDir, n), 'utf8')))) } catch (e) {
        this.o.log.warn('unreadable backup metadata', { file: n, err: e })
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** What the UI lists: our backups and the copies the migration runner made (newest first). */
  list(): BackupInfo[] {
    const items: BackupInfo[] = this.metas().map((m) => ({
      id: m.id, kind: m.kind, createdAt: m.createdAt, scope: m.scope,
      size: m.db.size + (m.team?.archiveSize ?? 0),
    }))
    try {
      for (const n of fs.readdirSync(this.o.layout.dbBackupsDir)) {
        if (!n.endsWith('.db') || !PRE_MIGRATE_RE.test(n.slice(0, -3))) continue
        const st = fs.statSync(path.join(this.o.layout.dbBackupsDir, n))
        items.push({ id: n.slice(0, -3), kind: 'pre-migrate', createdAt: st.mtime.toISOString(), scope: 'db', size: st.size })
      }
    } catch {}
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  latest(): BackupMeta | null { return this.metas().at(-1) ?? null }

  lastError(): { at: string; message: string } | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.o.layout.dbBackupsDir, 'last-error.json'), 'utf8')) } catch { return null }
  }

  /** One backup at a time; a second call while one runs waits for it and returns its result. */
  run(o: { kind: 'daily' | 'manual' | 'pre-update'; scope: 'db' | 'full'; progress?: BackupProgress }): Promise<BackupMeta> {
    if (this.running) return this.running
    this.running = this.doRun(o).then(
      (m) => { fs.rmSync(path.join(this.o.layout.dbBackupsDir, 'last-error.json'), { force: true }); return m },
      (e) => {
        try {
          fs.mkdirSync(this.o.layout.dbBackupsDir, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(this.o.layout.dbBackupsDir, 'last-error.json'), JSON.stringify({ at: this.now().toISOString(), message: (e as Error).message }), { mode: 0o600 })
        } catch {}
        throw e
      },
    ).finally(() => { this.running = null })
    return this.running
  }

  private async doRun(o: { kind: 'daily' | 'manual' | 'pre-update'; scope: 'db' | 'full'; progress?: BackupProgress }): Promise<BackupMeta> {
    const L = this.o.layout
    const progress = o.progress ?? (() => {})
    const free = Math.min(diskSpace(L.dataDir).free, diskSpace(L.teamRoot).free)
    if (free < BACKUP_MIN_FREE_BYTES) throw new BackupError(`not enough free disk space for a backup (${Math.round(free / 1024 ** 2)} MB free, 2 GB needed)`)
    await fsp.mkdir(L.dbBackupsDir, { recursive: true, mode: 0o700 })
    const now = this.now()
    let id = `${stamp(now)}-${o.kind}`
    for (let i = 2; fs.existsSync(this.metaFile(id)); i++) id = `${stamp(now)}-${o.kind}-${i}`

    progress(0.02, 'database')
    const dbFile = this.dbCopy(id)
    await vacuumInto(this.o.dbFile, dbFile)
    const { schemaVersion } = inspectDbCopy(dbFile)
    const dbStat = await fsp.stat(dbFile)
    const dbSha = crypto.createHash('sha256')
    for await (const c of readFileChunks(dbFile)) dbSha.update(c)
    const meta: BackupMeta = {
      format: 1, id, kind: o.kind, scope: 'db', createdAt: now.toISOString(), serverVersion: this.o.version, schemaVersion,
      db: { file: path.basename(dbFile), size: dbStat.size, sha256: dbSha.digest('hex') }, team: null,
    }
    try {
      if (o.scope === 'full') {
        progress(0.1, 'team folder')
        meta.team = await this.archiveTeam(id, now, (f) => progress(0.1 + 0.85 * f, 'team folder'))
        meta.scope = meta.team.base ? 'incremental' : 'full'
        await fsp.writeFile(path.join(this.teamDir(id), 'meta.json'), JSON.stringify(meta, null, 1), { mode: 0o600 })
      }
      await writeAtomic([Buffer.from(JSON.stringify(meta, null, 1))], this.metaFile(id))
    } catch (e) {
      await fsp.rm(dbFile, { force: true })
      await fsp.rm(this.teamDir(id), { recursive: true, force: true })
      throw e
    }
    progress(0.97, 'cleaning up')
    const removed = this.prune()
    this.o.log.info('backup done', { id, scope: meta.scope, dbBytes: meta.db.size, teamBytes: meta.team?.archiveSize ?? 0, removed })
    progress(1, 'done')
    return meta
  }

  /** A full archive when there is none from the last 7 days (or the chain is long); otherwise an incremental. */
  private async archiveTeam(id: string, now: Date, progress: (f: number) => void): Promise<NonNullable<BackupMeta['team']>> {
    const metas = this.metas()
    const prev = [...metas].reverse().find((m) => m.team)
    const lastFull = [...metas].reverse().find((m) => m.team && !m.team.base)
    if (!prev || !lastFull || now.getTime() - Date.parse(lastFull.createdAt) >= FULL_EVERY_DAYS * 86400_000) return this.writeTeamArchive(id, null, {}, progress)
    let chainLen = 0
    try { chainLen = this.chain(prev.id).length } catch { return this.writeTeamArchive(id, null, {}, progress) }
    if (chainLen >= BACKUP_RETENTION_DAYS) return this.writeTeamArchive(id, null, {}, progress)
    let prevManifest: Manifest
    try { prevManifest = JSON.parse(await fsp.readFile(path.join(this.teamDir(prev.id), 'manifest.json'), 'utf8')) } catch {
      return this.writeTeamArchive(id, null, {}, progress) // previous list is gone: start a new chain
    }
    return this.writeTeamArchive(id, prev.id, prevManifest, progress)
  }

  private async writeTeamArchive(id: string, base: string | null, prevManifest: Manifest, progress: (f: number) => void): Promise<NonNullable<BackupMeta['team']>> {
    const L = this.o.layout
    const dir = this.teamDir(id)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.chmod(L.teamBackupsDir, 0o700).catch(() => {})
    const tree = await walkTree(L.teamRoot, { exclude: ['.system/backups'] })
    await this.o.afterWalk?.()
    const now = toManifest(tree.files)
    const { changed, deleted } = diffManifest(prevManifest, now)
    const changedSet = new Set(changed)
    const total = tree.files.filter((f) => changedSet.has(f.rel)).reduce((a, f) => a + f.size, 0) || 1
    let done = 0
    let lastReport = 0
    const entries: TarEntryInput[] = []
    // every folder, also in incrementals (headers only): a folder made since the full archive may still be empty
    for (const d of tree.dirs) entries.push({ name: d.rel, type: 'dir', mode: d.mode, mtimeMs: d.mtimeMs })
    for (const f of tree.files) if (changedSet.has(f.rel)) entries.push({ name: f.rel, type: 'file', source: f.abs })
    let changedWhileReading = 0
    let files = 0
    const archived = new Set<string>()
    const written = await writeAtomic(zstdCompress(tarStream(entries, (w) => {
      files++
      archived.add(w.name)
      done += w.size
      if (w.changedWhileReading) { changedWhileReading++; now[w.name] = { s: -1, m: -1 } } // re-archive next time
      else now[w.name] = { s: w.size, m: Math.floor(w.mtimeMs) }
      if (done - lastReport > 8 * 1024 ** 2) { lastReport = done; progress(Math.min(1, done / total)) }
    })), path.join(dir, 'team.tar.zst'))
    // vanished between the walk and the read: not in this archive, so not in its list either (otherwise the restore
    // check would expect it, and the next backup would not notice when it comes back)
    for (const p of changed) {
      if (archived.has(p)) continue
      delete now[p]
      if (p in prevManifest) deleted.push(p) // the older copy in the chain must not come back on restore
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(now), { mode: 0o600 })
    await fsp.writeFile(path.join(dir, 'deleted.json'), JSON.stringify(deleted), { mode: 0o600 })
    // the folders at this point: a restore removes the ones that were deleted since (empty folders leave no file trace)
    await fsp.writeFile(path.join(dir, 'dirs.json'), JSON.stringify(tree.dirs.map((d) => d.rel)), { mode: 0o600 })
    return { base, archiveSize: written.size, files, bytes: done, deleted: deleted.length, changedWhileReading }
  }

  /** ids from the full archive up to `id` (inclusive) */
  chain(id: string): string[] {
    const byId = new Map(this.metas().map((m) => [m.id, m]))
    const out: string[] = []
    let cur = byId.get(id)
    while (cur) {
      out.unshift(cur.id)
      if (!cur.team?.base) break
      cur = byId.get(cur.team.base)
      if (out.length > 1000) throw new BackupError('backup chain loops')
    }
    if (!cur) throw new BackupError(`backup ${id} or one it builds on is missing`)
    return out
  }

  /** Delete backups older than the retention period that nothing kept builds on; always keeps the newest. */
  prune(): string[] {
    const metas = this.metas()
    if (!metas.length) return []
    const cutoff = this.now().getTime() - BACKUP_RETENTION_DAYS * 86400_000
    const keep = new Set<string>()
    const byId = new Map(metas.map((m) => [m.id, m]))
    for (const m of metas) if (Date.parse(m.createdAt) >= cutoff) keep.add(m.id)
    keep.add(metas.at(-1)!.id)
    const lastTeam = [...metas].reverse().find((m) => m.team)
    if (lastTeam) keep.add(lastTeam.id)
    for (const id of [...keep]) {
      let b = byId.get(id)?.team?.base
      while (b && !keep.has(b)) { keep.add(b); b = byId.get(b)?.team?.base }
    }
    const removed: string[] = []
    for (const m of metas) {
      if (keep.has(m.id)) continue
      fs.rmSync(this.teamDir(m.id), { recursive: true, force: true })
      fs.rmSync(this.dbCopy(m.id), { force: true })
      fs.rmSync(this.metaFile(m.id), { force: true })
      removed.push(m.id)
    }
    // copies the migration runner made: same retention, newest kept
    try {
      const pre = fs.readdirSync(this.o.layout.dbBackupsDir).filter((n) => n.endsWith('.db') && PRE_MIGRATE_RE.test(n.slice(0, -3)))
        .map((n) => ({ n, t: fs.statSync(path.join(this.o.layout.dbBackupsDir, n)).mtimeMs })).sort((a, b) => a.t - b.t)
      for (const p of pre.slice(0, -1)) if (p.t < cutoff) { fs.rmSync(path.join(this.o.layout.dbBackupsDir, p.n), { force: true }); removed.push(p.n.slice(0, -3)) }
    } catch {}
    return removed
  }

  /** Path of the DB copy of a backup id (ours or pre-migrate), or null. */
  dbFileOf(id: string): string | null {
    if (ID_RE.test(id)) { const f = this.dbCopy(id); return fs.existsSync(f) ? f : null }
    if (PRE_MIGRATE_RE.test(id)) { const f = path.join(this.o.layout.dbBackupsDir, `${id}.db`); return fs.existsSync(f) ? f : null }
    return null
  }

  createdAtOf(id: string): string | null {
    return this.list().find((b) => b.id === id)?.createdAt ?? null
  }

  /** Check and stage a DB copy; the swap happens at the next server start (applyPendingRestore). */
  async stageDbRestore(id: string, requestedBy: string | null): Promise<RestorePending> {
    const src = this.dbFileOf(id)
    if (!src) throw new BackupError(`backup ${id} not found`)
    const staged = path.join(this.o.layout.dataDir, 'restore-staged.db')
    await fsp.rm(staged, { force: true })
    await fsp.copyFile(src, staged)
    await fsp.chmod(staged, 0o600)
    try { inspectDbCopy(staged) } catch (e) { await fsp.rm(staged, { force: true }); throw e }
    const pending: RestorePending = { format: 1, file: staged, backupId: id, requestedAt: this.now().toISOString(), requestedBy }
    await fsp.writeFile(path.join(this.o.layout.dataDir, 'restore-pending.json'), JSON.stringify(pending), { mode: 0o600 })
    return pending
  }

  /**
   * Rebuild the team folder as it was at backup `id` into `dest` (must not exist): full archive, then every
   * incremental in order with its deletions, then a check against the backup's file list. Nothing is written
   * outside `dest`; on any error `dest` is removed.
   */
  async restoreTeamTo(id: string, dest: string, progress: BackupProgress = () => {}): Promise<{ files: number }> {
    if (fs.existsSync(dest)) throw new BackupError(`restore target already exists: ${dest}`)
    const ids = this.chain(id)
    await fsp.mkdir(dest, { recursive: true, mode: 0o700 })
    try {
      for (const [i, bid] of ids.entries()) {
        progress(i / ids.length, `archive ${i + 1}/${ids.length}`)
        const dir = this.teamDir(bid)
        // deletions first: they are paths of the previous state, and a deleted file may have become a folder (or the
        // other way round) in this archive
        const deleted: string[] = JSON.parse(await fsp.readFile(path.join(dir, 'deleted.json'), 'utf8'))
        for (const p of deleted) {
          const t = path.join(dest, p)
          if (!t.startsWith(dest + path.sep)) throw new BackupError(`unsafe path in deleted.json: ${p}`)
          await fsp.rm(t, { force: true })
        }
        await extractTar(zstdDecompress(readFileChunks(path.join(dir, 'team.tar.zst'))), dest, { replace: i > 0 })
      }
      const want: Manifest = JSON.parse(await fsp.readFile(path.join(this.teamDir(id), 'manifest.json'), 'utf8'))
      // folders: as listed at backup `id` (backups made before dirs.json existed have no list: folders stay as layered)
      let wantDirs: string[] | null = null
      try { wantDirs = JSON.parse(await fsp.readFile(path.join(this.teamDir(id), 'dirs.json'), 'utf8')) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      if (wantDirs) {
        const keep = new Set(wantDirs)
        // deepest first; a folder that still holds files is left for the file check below to report
        for (const d of (await walkTree(dest)).dirs.map((x) => x.rel).filter((r) => !keep.has(r)).reverse()) {
          await fsp.rmdir(path.join(dest, d)).catch(() => {})
        }
        const have = new Set((await walkTree(dest)).dirs.map((x) => x.rel))
        for (const d of wantDirs) if (!have.has(d)) throw new BackupError(`restored folder is missing the folder ${d}`)
      }
      const got = toManifest((await walkTree(dest)).files)
      for (const [p, e] of Object.entries(want)) {
        if (e.s < 0) continue // changed while it was being archived: whatever version made it in is fine
        const g = got[p]
        if (!g || g.s !== e.s) throw new BackupError(`restored folder does not match the backup at ${p}`)
      }
      for (const p of Object.keys(got)) if (!(p in want)) throw new BackupError(`restored folder has a file the backup does not: ${p}`)
      progress(1, 'done')
      return { files: Object.keys(got).length }
    } catch (e) {
      await fsp.rm(dest, { recursive: true, force: true })
      throw e
    }
  }
}

/**
 * Called by the server at start, BEFORE the DB is opened: if a restore was staged, keep the current DB files in
 * data/backups/before-restore-<time>/ and put the staged copy in place. Failures leave the current DB untouched.
 */
export function applyPendingRestore(dataDir: string, log: Pick<Logger, 'info' | 'error'>, o: { rename?: (a: string, b: string) => void } = {}): { applied: boolean; backupId?: string; error?: string } {
  const rename = o.rename ?? fs.renameSync
  const pf = path.join(dataDir, 'restore-pending.json')
  if (!fs.existsSync(pf)) return { applied: false }
  let p: RestorePending
  try { p = RestorePending.parse(JSON.parse(fs.readFileSync(pf, 'utf8'))) } catch (e) {
    fs.rmSync(pf, { force: true })
    log.error('restore-pending.json unreadable; restore skipped', { err: e })
    return { applied: false, error: 'unreadable' }
  }
  const result = path.join(dataDir, 'restore-result.json')
  try {
    if (path.dirname(path.resolve(p.file)) !== path.resolve(dataDir) || !fs.existsSync(p.file)) throw new Error('staged copy missing')
    inspectDbCopy(p.file)
    const live = path.join(dataDir, 'app.db')
    const keep = path.join(dataDir, 'backups', `before-restore-${stamp(new Date())}`)
    fs.mkdirSync(keep, { recursive: true, mode: 0o700 })
    const moved: string[] = []
    try {
      for (const s of ['', '-wal', '-shm']) if (fs.existsSync(live + s)) { rename(live + s, path.join(keep, 'app.db' + s)); moved.push(s) }
      rename(p.file, live)
    } catch (e) {
      // put the current DB back exactly as it was (never start with no DB, or with a DB and someone else's WAL)
      for (const s of moved.reverse()) {
        try { fs.renameSync(path.join(keep, 'app.db' + s), live + s) } catch (e2) { log.error('could not put the database back after a failed restore', { file: live + s, kept: keep, err: e2 }) }
      }
      throw e
    }
    // engine session stashes belong to the replaced DB: a chat keeps its session id across turns and the stash is
    // overwritten after each one, so a stash could hold turns the restored DB does not have. Kept aside with the old
    // DB; every chat starts its next turn on a fresh session from the restored history.
    const sessions = path.join(dataDir, 'sessions')
    if (fs.existsSync(sessions)) {
      try { rename(sessions, path.join(keep, 'sessions')) } catch (e) {
        log.error('could not move the engine session stashes aside; removing them', { err: e })
        fs.rmSync(sessions, { recursive: true, force: true })
      }
    }
    fs.writeFileSync(result, JSON.stringify({ ok: true, backupId: p.backupId, at: new Date().toISOString(), previousDb: keep }), { mode: 0o600 })
    log.info('database restored from backup', { backupId: p.backupId, previousDb: keep })
    return { applied: true, backupId: p.backupId }
  } catch (e) {
    fs.writeFileSync(result, JSON.stringify({ ok: false, backupId: p.backupId, at: new Date().toISOString(), error: (e as Error).message }), { mode: 0o600 })
    log.error('restore failed; the current database was kept', { backupId: p.backupId, err: e })
    return { applied: false, backupId: p.backupId, error: (e as Error).message }
  } finally {
    fs.rmSync(pf, { force: true })
  }
}
