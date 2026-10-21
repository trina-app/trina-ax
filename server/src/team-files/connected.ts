// Connected folders: a folder of the server Mac — a NAS share mounted in Finder (/Volumes/<share>), Google Drive for
// desktop (~/Library/CloudStorage/GoogleDrive-…/My Drive), or any ordinary folder — mirrored read-only into the team
// folder at connected/<name>. A mirror, not a link: the team folder refuses symbolic links everywhere, and a copy lets
// read / grep / search / OCR / previews and the folder rules work unchanged. Changes flow one way (source → team
// folder), every 10 minutes and on "sync now".
//
// The mirror only touches what it wrote itself (connected_files): a file someone saved into connected/<name>, or a
// mirrored file someone changed there, is never overwritten or deleted by a sync. Only the owner connects a folder
// (with their password): it reads a path of the server Mac. Hidden files, symbolic links, names the team folder doesn't
// accept and files over 100 MB are skipped.
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FolderRuleInput } from '@mycel/shared/api'
import { afterAccessChange, captureState, dropFolderRow, ensureFolderRow, getFolderByPath, replaceRules } from '../admin/folders'
import type { AppContext } from '../context'
import { newId } from '../db'
import { badSegment } from '../policy/names'

export const CONNECTED_ROOT = 'connected'
const FILE_MAX = 100 * 1024 * 1024
const LIST_MAX = 50_000
const RUN_COPIES_MAX = 2000
const RUN_BYTES_MAX = 2 * 1024 * 1024 * 1024
const EVERY_MS = 10 * 60_000

export interface ConnectedRow {
  id: string; name: string; source: string; created_by: string | null; created_at: string
  last_sync_at: string | null; last_status: string | null; last_error: string | null; files: number; bytes: number
}
export interface SyncResult { copied: number; updated: number; removed: number; kept: number; skipped: number; pending: boolean; files: number; bytes: number }

export class ConnectedError extends Error {}

/** A folder name under connected/: what the team folder accepts as one path segment. */
export function checkName(name: string): string {
  const n = name.trim().normalize('NFC')
  if (!n || n.length > 60 || badSegment(n) || n.startsWith('.')) throw new ConnectedError('bad_name')
  return n
}

/**
 * The source must be a folder that is meant for sharing: under /Volumes (mounted disks and NAS shares),
 * ~/Library/CloudStorage (Google Drive, OneDrive, Dropbox …), /Users/Shared, or a visible folder in the home (not the
 * home itself, nothing hidden, not ~/Library otherwise), and never the team folder or the server's data.
 */
export function checkSource(raw: string, o: { home?: string; teamRoot: string; dataDir: string }): string {
  raw = raw.trim()
  if (raw === '~' || raw.startsWith('~/')) raw = path.join(o.home ?? os.homedir(), raw.slice(1))
  if (!path.isAbsolute(raw)) throw new ConnectedError('not_absolute')
  let real: string
  try { real = fs.realpathSync(raw) } catch { throw new ConnectedError('not_found') }
  if (!fs.statSync(real).isDirectory()) throw new ConnectedError('not_folder')
  const home = fs.realpathSync(o.home ?? os.homedir())
  const inside = (p: string, root: string) => p === root || p.startsWith(root + '/')
  for (const own of [o.teamRoot, o.dataDir]) {
    const r = fs.realpathSync(own)
    if (inside(real, r) || inside(r, real)) throw new ConnectedError('team_folder')
  }
  if (real.split('/').some((s) => s.startsWith('.'))) throw new ConnectedError('hidden')
  const cloud = path.join(home, 'Library', 'CloudStorage')
  const ok = (real.startsWith('/Volumes/') && real.split('/').length >= 3)
    || (real.startsWith(cloud + '/'))
    || inside(real, '/Users/Shared')
    || (real.startsWith(home + '/') && !inside(real, path.join(home, 'Library')))
  if (!ok) throw new ConnectedError('not_allowed')
  return real
}

interface ManifestRow { path: string; size: number; mtime_ms: number; src_size: number; src_mtime_ms: number }
type Manifest = Map<string, ManifestRow>

export class ConnectedFolders {
  private running = new Map<string, Promise<SyncResult>>()
  /** home: the Mac user's home folder (tests point it at a temporary folder) */
  constructor(private ctx: AppContext, private o: { home?: string } = {}) {}
  private get db(): Database { return this.ctx.db }
  private get root() { return this.ctx.files.fx.root }

  list(): ConnectedRow[] { return this.db.query('SELECT * FROM connected_folders ORDER BY name').all() as ConnectedRow[] }
  get(id: string): ConnectedRow | null { return this.db.query('SELECT * FROM connected_folders WHERE id = ?').get(id) as ConnectedRow | null }
  folderPath(c: Pick<ConnectedRow, 'name'>) { return `${CONNECTED_ROOT}/${c.name}` }

  /** Connect a folder: everyone in the team can read it by default (change it in Folder permissions). */
  add(o: { name: string; source: string; actor: string }): ConnectedRow {
    const name = checkName(o.name)
    const source = checkSource(o.source, { home: this.o.home, teamRoot: this.root, dataDir: this.ctx.engineConfig.dataDir })
    if (this.db.query('SELECT 1 FROM connected_folders WHERE name = ?').get(name)) throw new ConnectedError('name_taken')
    const rel = `${CONNECTED_ROOT}/${name}`
    const abs = path.join(this.root, CONNECTED_ROOT, name)
    if (fs.existsSync(abs)) throw new ConnectedError('name_taken')
    fs.mkdirSync(abs, { recursive: true })
    const id = newId()
    const rules: FolderRuleInput[] = [{ subjectType: 'everyone', subjectId: null, access: 'read' }]
    const before = captureState(this.db)
    this.db.transaction(() => {
      this.db.query('INSERT INTO connected_folders (id, name, source, created_by) VALUES (?, ?, ?, ?)').run(id, name, source, o.actor)
      replaceRules(this.db, ensureFolderRow(this.db, rel).id, rules, o.actor)
      this.db.query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'connected.add', ?, ?)").run(o.actor, rel, JSON.stringify({ source }))
    })()
    afterAccessChange(this.ctx, before, { actor: o.actor, target: rel, created: [rel] })
    return this.get(id)!
  }

  /** Disconnect: the files the mirror wrote (and nobody changed) go away; anything else in the folder stays. */
  remove(id: string, actor: string): boolean {
    const c = this.get(id)
    if (!c) return false
    this.dropMirrored(c, this.manifest(id), new Set())
    // folders the mirror leaves empty go too; an emptied mirror folder loses its rules row (nothing is left to guard)
    const base = path.join(this.root, CONNECTED_ROOT, c.name)
    const prune = (dir: string): boolean => {
      let st: fs.Stats
      try { st = fs.lstatSync(dir) } catch { return true }
      if (!st.isDirectory()) return false
      let empty = true
      for (const n of fs.readdirSync(dir)) if (!prune(path.join(dir, n))) empty = false
      if (empty) fs.rmdirSync(dir)
      return empty
    }
    const gone = prune(base)
    const before = captureState(this.db)
    this.db.transaction(() => {
      if (gone) { const f = getFolderByPath(this.db, this.folderPath(c)); if (f) dropFolderRow(this.db, f.id) }
      this.db.query('DELETE FROM connected_folders WHERE id = ?').run(id)
      this.db.query("INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'connected.remove', ?, ?)").run(actor, this.folderPath(c), JSON.stringify({ source: c.source }))
    })()
    afterAccessChange(this.ctx, before, { actor, target: this.folderPath(c) })
    return true
  }

  private manifest(id: string): Manifest {
    const rows = this.db.query('SELECT path, size, mtime_ms, src_size, src_mtime_ms FROM connected_files WHERE folder_id = ?').all(id) as ManifestRow[]
    return new Map(rows.map((r) => [r.path, r]))
  }

  /** The source's files (relative path → stats), without hidden files, links, unacceptable names or huge files. */
  private listSource(src: string): { files: Map<string, fs.Stats>; skipped: number } {
    const files = new Map<string, fs.Stats>()
    let skipped = 0
    const walk = (rel: string[]) => {
      const names = fs.readdirSync(path.join(src, ...rel))
      for (const n of names.sort()) {
        if (files.size >= LIST_MAX) return
        if (n.startsWith('.') || n.startsWith('~$')) continue
        const nfc = n.normalize('NFC')
        if (badSegment(nfc)) { skipped++; continue }
        let st: fs.Stats
        try { st = fs.lstatSync(path.join(src, ...rel, n)) } catch { skipped++; continue }
        if (st.isDirectory()) walk([...rel, n])
        else if (st.isFile()) { if (st.size > FILE_MAX) skipped++; else files.set([...rel, nfc].join('/'), st) }
      }
    }
    walk([])
    return { files, skipped }
  }

  /** A path inside the mirror folder whose every folder is a real folder (no link planted on the way). */
  private dest(c: ConnectedRow, rel: string): string {
    const base = path.join(this.root, CONNECTED_ROOT, c.name)
    const parts = rel.split('/')
    let cur = base
    for (const p of parts.slice(0, -1)) {
      cur = path.join(cur, p)
      try { if (!fs.lstatSync(cur).isDirectory()) throw new ConnectedError('blocked') } catch (e) { if (e instanceof ConnectedError) throw e; fs.mkdirSync(cur) }
    }
    return path.join(cur, parts[parts.length - 1]!)
  }

  private dropMirrored(c: ConnectedRow, man: Manifest, keep: Set<string>): { removed: number; kept: number } {
    let removed = 0, kept = 0
    for (const [rel, m] of man) {
      if (keep.has(rel)) continue
      const dst = path.join(this.root, CONNECTED_ROOT, c.name, ...rel.split('/'))
      try {
        const st = fs.lstatSync(dst)
        if (st.isFile() && st.size === m.size && Math.floor(st.mtimeMs) === m.mtime_ms) { fs.rmSync(dst); removed++ } else kept++
      } catch { /* already gone */ }
      this.db.query('DELETE FROM connected_files WHERE folder_id = ? AND path = ?').run(c.id, rel)
    }
    return { removed, kept }
  }

  isSyncing(id: string) { return this.running.has(id) }

  sync(id: string): Promise<SyncResult> {
    const going = this.running.get(id)
    if (going) return going
    const p = this.doSync(id).finally(() => this.running.delete(id))
    this.running.set(id, p)
    return p
  }

  private async doSync(id: string): Promise<SyncResult> {
    const c = this.get(id)
    if (!c) throw new ConnectedError('not_found')
    const now = new Date().toISOString()
    let listed: { files: Map<string, fs.Stats>; skipped: number }
    try {
      if (!fs.statSync(c.source).isDirectory()) throw new Error('not a folder')
      listed = this.listSource(c.source)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // macOS privacy (TCC): a background process may not read network volumes or cloud folders until allowed
      const why = code === 'EPERM' || code === 'EACCES' ? 'permission' : code === 'ENOENT' ? 'not_found' : 'unreadable'
      this.db.query("UPDATE connected_folders SET last_sync_at = ?, last_status = 'error', last_error = ? WHERE id = ?").run(now, why, id)
      throw new ConnectedError(why)
    }
    const man = this.manifest(id)
    const r: SyncResult = { copied: 0, updated: 0, removed: 0, kept: 0, skipped: listed.skipped, pending: false, files: 0, bytes: 0 }
    let budget = RUN_BYTES_MAX
    const put = this.db.query('INSERT OR REPLACE INTO connected_files (folder_id, path, size, mtime_ms, src_size, src_mtime_ms) VALUES (?, ?, ?, ?, ?, ?)')
    let n = 0
    for (const [rel, st] of listed.files) {
      // the server keeps answering while a big share is copied
      if (++n % 50 === 0) await new Promise((r) => setImmediate(r))
      const m = man.get(rel)
      let dst: string
      try { dst = this.dest(c, rel) } catch { r.skipped++; continue }
      let cur: fs.Stats | null = null
      try { cur = fs.lstatSync(dst) } catch {}
      const unchangedHere = !!cur && !!m && cur.isFile() && cur.size === m.size && Math.floor(cur.mtimeMs) === m.mtime_ms
      const srcChanged = !m || m.src_size !== st.size || m.src_mtime_ms !== Math.floor(st.mtimeMs)
      if (cur && !unchangedHere) { r.kept++; if (m) this.db.query('DELETE FROM connected_files WHERE folder_id = ? AND path = ?').run(id, rel); continue }
      if (cur && !srcChanged) continue
      if (r.copied + r.updated >= RUN_COPIES_MAX || st.size > budget) { r.pending = true; continue }
      const tmp = path.join(path.dirname(dst), `.mycel-sync-${process.pid}-${Date.now()}`)
      try {
        await fs.promises.copyFile(path.join(c.source, ...rel.split('/')), tmp)
        await fs.promises.utimes(tmp, st.atime, st.mtime)
        await fs.promises.rename(tmp, dst)
      } catch { fs.rmSync(tmp, { force: true }); r.skipped++; continue }
      const after = fs.lstatSync(dst)
      put.run(id, rel, after.size, Math.floor(after.mtimeMs), st.size, Math.floor(st.mtimeMs))
      budget -= st.size
      if (cur) r.updated++; else r.copied++
    }
    const gone = this.dropMirrored(c, man, new Set(listed.files.keys()))
    r.removed = gone.removed
    r.kept += gone.kept
    const tot = this.db.query('SELECT count(*) AS n, coalesce(sum(size), 0) AS b FROM connected_files WHERE folder_id = ?').get(id) as { n: number; b: number }
    r.files = tot.n
    r.bytes = tot.b
    this.db.query('UPDATE connected_folders SET last_sync_at = ?, last_status = ?, last_error = NULL, files = ?, bytes = ? WHERE id = ?')
      .run(now, r.pending ? 'partial' : 'ok', r.files, r.bytes, id)
    return r
  }

  /** Every 10 minutes (and a minute after the start), outside tests. */
  startLoop(): void {
    const tick = () => { for (const c of this.list()) void this.sync(c.id).catch(() => {}) }
    const first = setTimeout(tick, 60_000)
    const every = setInterval(tick, EVERY_MS)
    first.unref?.(); every.unref?.()
    this.ctx.onClose(() => { clearTimeout(first); clearInterval(every) })
  }
}

const SINGLETON = new WeakMap<AppContext, ConnectedFolders>()
export function connectedFolders(ctx: AppContext): ConnectedFolders {
  let c = SINGLETON.get(ctx)
  if (!c) { c = new ConnectedFolders(ctx); SINGLETON.set(ctx, c); if (process.env.NODE_ENV !== 'test') c.startLoop() }
  return c
}

