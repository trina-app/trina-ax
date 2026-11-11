// The file list's sidecar: what the server knows about each listed file, in the server's data folder (never the team
// folder): <data>/file-list/state.db. Size, mtime and content hash per file decide what a run reads again, and which
// lines the AI's tools may show (view.ts: the file must still have that size and mtime); the validated fields are what
// the lines are rendered from. Nothing of it is ever written into the team folder.
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { FileListRun, FileListStop } from '@mycel/shared/api'
import type { Fields } from './format'
import type { Kind } from './sniff'

/** how a file's fields were made: model (the AI read it), copy (same bytes as a file read in this unit), moved (same
 * bytes as a file that was at another path), meta (no model: video, empty, unreadable), failed (the AI gave nothing) */
export type Via = 'model' | 'copy' | 'moved' | 'meta' | 'failed'

export interface Entry {
  /** team path, the actual names on disk */
  path: string
  size: number
  mtimeMs: number
  sha: string | null
  kind: Kind | null
  /** the real format when the extension says another */
  real: string | null
  /** null: found, not read yet */
  fields: Fields | null
  via: Via | null
  readAt: string | null
  /** failed reads (a file that keeps failing is tried again after FAILED_RETRY_DAYS) */
  tries: number
}

interface Row { path: string; size: number; mtime: number; sha: string | null; kind: string | null; real: string | null; fields: string | null; via: string | null; read_at: string | null; tries: number }

export class Sidecar {
  readonly db: Database
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.db = new Database(path.join(dir, 'state.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, sha TEXT, kind TEXT,
      real TEXT, fields TEXT, via TEXT, read_at TEXT, tries INTEGER NOT NULL DEFAULT 0)`)
    this.db.exec('CREATE INDEX IF NOT EXISTS files_sha ON files(sha)')
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, ended_at TEXT, trigger TEXT NOT NULL,
      engine TEXT, model TEXT, read INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, stopped_by TEXT)`)
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  close() { try { this.db.close() } catch {} }
  /** bumped on every change of the files table (the per-person view caches by it) */
  version = 0

  private entry(r: Row): Entry {
    let fields: Fields | null = null
    try { fields = r.fields ? JSON.parse(r.fields) as Fields : null } catch { fields = null }
    return { path: r.path, size: r.size, mtimeMs: r.mtime, sha: r.sha, kind: r.kind as Kind | null, real: r.real, fields, via: r.via as Via | null, readAt: r.read_at, tries: r.tries }
  }
  all(): Map<string, Entry> {
    const m = new Map<string, Entry>()
    for (const r of this.db.query('SELECT * FROM files').all() as Row[]) m.set(r.path, this.entry(r))
    return m
  }
  get(p: string): Entry | null { const r = this.db.query('SELECT * FROM files WHERE path = ?').get(p) as Row | null; return r ? this.entry(r) : null }
  /** entries at `p` or below it */
  under(p: string): Entry[] {
    // the paths that start with p + '/': the range [p/, p0) ('0' follows '/'), on the primary key
    return (this.db.query('SELECT * FROM files WHERE path = ? OR (path >= ? AND path < ?)').all(p, p + '/', p + '0') as Row[]).map((r) => this.entry(r))
  }
  put(e: Entry) {
    this.db.query(`INSERT INTO files (path, size, mtime, sha, kind, real, fields, via, read_at, tries) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha=excluded.sha, kind=excluded.kind, real=excluded.real,
      fields=excluded.fields, via=excluded.via, read_at=excluded.read_at, tries=excluded.tries`)
      .run(e.path, e.size, e.mtimeMs, e.sha, e.kind, e.real, e.fields ? JSON.stringify(e.fields) : null, e.via, e.readAt, e.tries)
    this.version++
  }
  delete(p: string) { this.db.query('DELETE FROM files WHERE path = ?').run(p); this.version++ }
  /** every stored line (the switch went off, policy.ts FORGET_ON_OFF) */
  clear() { this.db.query('DELETE FROM files').run(); this.version++ }
  tx<T>(f: () => T): T { return this.db.transaction(f)() }
  counts(): { listed: number; waiting: number } {
    const r = this.db.query('SELECT SUM(fields IS NOT NULL) AS listed, SUM(fields IS NULL) AS waiting FROM files').get() as { listed: number | null; waiting: number | null }
    return { listed: r.listed ?? 0, waiting: r.waiting ?? 0 }
  }

  // ---------------- the run lease: one run at a time, also across a restart or a second process
  /** take the lease when it is free or its holder has not renewed it for `staleMs` */
  takeLease(holder: string, staleMs: number, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const cur = this.meta('lease')
      if (cur) { try { const l = JSON.parse(cur) as { holder: string; at: number }; if (l.holder !== holder && now - l.at < staleMs) return false } catch {} }
      this.setMeta('lease', JSON.stringify({ holder, at: now }))
      return true
    })()
  }
  renewLease(holder: string, now = Date.now()) { const cur = this.meta('lease'); if (cur?.includes(JSON.stringify(holder))) this.setMeta('lease', JSON.stringify({ holder, at: now })) }
  dropLease(holder: string) { const cur = this.meta('lease'); if (cur?.includes(JSON.stringify(holder))) this.setMeta('lease', null) }

  // ---------------- runs
  startRun(trigger: FileListRun['trigger'], engine: string | null, model: string | null): number {
    return Number(this.db.query('INSERT INTO runs (started_at, trigger, engine, model) VALUES (?,?,?,?)').run(new Date().toISOString(), trigger, engine, model).lastInsertRowid)
  }
  addUsage(id: number, u: { read?: number; calls?: number; input?: number; output?: number; cost?: number }) {
    this.db.query('UPDATE runs SET read = read + ?, calls = calls + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?')
      .run(u.read ?? 0, u.calls ?? 0, u.input ?? 0, u.output ?? 0, u.cost ?? 0, id)
  }
  endRun(id: number, stoppedBy: FileListStop) { this.db.query('UPDATE runs SET ended_at = ?, stopped_by = ? WHERE id = ?').run(new Date().toISOString(), stoppedBy, id) }
  /** a run the server's stop interrupted (no end): ended as stopped */
  closeOpenRuns() { this.db.query("UPDATE runs SET ended_at = ?, stopped_by = 'stopped' WHERE ended_at IS NULL").run(new Date().toISOString()) }
  lastRun(): (FileListRun & { id: number; engine: string | null; model: string | null; calls: number; inputTokens: number; outputTokens: number; costUsd: number }) | null {
    const r = this.db.query('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as Record<string, any> | null
    if (!r) return null
    return { id: r.id, startedAt: r.started_at, endedAt: r.ended_at, trigger: r.trigger, read: r.read, stoppedBy: r.stopped_by, engine: r.engine, model: r.model,
      calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd }
  }

  meta(k: string): string | null { return (this.db.query('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | null)?.value ?? null }
  setMeta(k: string, v: string | null) {
    if (v === null) this.db.query('DELETE FROM meta WHERE key = ?').run(k)
    else this.db.query('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)
  }
}
