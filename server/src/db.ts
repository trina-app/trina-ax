// SQLite database: open, migrate, check that this build can read it.
//
// Migrations are numbered SQL files in server/migrations/, applied once each, in numeric order:
//   NNN_<component>_<name>.sql   e.g. 002_foundation.sql, 101_a_login_attempts.sql, 201_b_message_index.sql
// Number ranges per component (docs/WORKPLAN.md): 001–099 foundation, 100–199 A, 200–299 B, 300–399 C,
// 600–699 F, 700–799 G. A file may only depend on tables from 001–099 and its own range.
//
// Forward compatibility (tab 6 "업데이트": rolling back the app does not roll back the DB):
// - Only additive changes (new tables, new nullable / defaulted columns, indexes). Always named columns in SQL.
//   New tables with FKs use ON DELETE CASCADE. Never rebuild or rename tables.
// - A migration that an older build cannot live with declares `-- min_compatible_reader: N` in its first lines.
//   Every build knows its SCHEMA_READER_LEVEL; at start it refuses a DB whose applied migrations need a newer
//   reader (the owner must restore the pre-update backup instead). Default for a migration: 1.
// - Before applying migrations to a DB that already has data, a copy is made with VACUUM INTO.
// - Pending migrations are applied together in one transaction that holds the write lock (BEGIN IMMEDIATE): a
//   process that opens the file at the same moment waits and then finds nothing left to do; a failing migration
//   leaves the DB exactly as it was.
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared'

export const MIGRATIONS_DIR = path.join(import.meta.dir, '..', 'migrations')
/** Raise when this build stops understanding DBs written by older releases' assumptions (see header). */
export const SCHEMA_READER_LEVEL = 1

export class SchemaTooNewError extends Error {
  constructor(public needed: number, public have: number, public migration: string) {
    super(`database needs schema reader level ${needed} (migration ${migration}); this build reads level ${have}. Restore the backup made before the update, or install the newer version again.`)
    this.name = 'SchemaTooNewError'
  }
}

export interface MigrationFile { version: number; name: string; sql: string; minCompatibleReader: number }

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
  const out = files.map((f) => {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    const m = /^--\s*min_compatible_reader:\s*(\d+)\s*$/m.exec(sql.split('\n').slice(0, 10).join('\n'))
    return { version: parseInt(f, 10), name: f, sql, minCompatibleReader: m ? parseInt(m[1]!, 10) : 1 }
  }).sort((a, b) => a.version - b.version)
  for (let i = 1; i < out.length; i++) if (out[i]!.version === out[i - 1]!.version) throw new Error(`two migrations with number ${out[i]!.version}: ${out[i - 1]!.name}, ${out[i]!.name}`)
  return out
}

export interface OpenDbOptions {
  migrationsDir?: string
  readerLevel?: number
  /** where VACUUM INTO copies go before migrating a DB with data (default: <db dir>/backups) */
  backupDir?: string
}

/** Open (and migrate) the SQLite database. */
export function openDb(file: string, o: OpenDbOptions = {}): Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true, strict: true })
  // busy_timeout first: switching a new file to WAL needs a moment of exclusive access, and another process may be
  // opening the same file right now
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
  if (file !== ':memory:') try { fs.chmodSync(file, 0o600) } catch {}
  try {
    migrate(db, { ...o, backupDir: file === ':memory:' ? undefined : (o.backupDir ?? path.join(path.dirname(file), 'backups')) })
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

export function migrate(db: Database, o: OpenDbOptions = {}) {
  const readerLevel = o.readerLevel ?? SCHEMA_READER_LEVEL
  const all = readMigrations(o.migrationsDir)
  // A first look without the lock: the copy before migrating (VACUUM INTO) cannot run inside a transaction.
  const before = appliedVersions(db)
  if (before && before.size && o.backupDir && all.some((m) => !before.has(m.version))) {
    checkReadable(db, readerLevel)
    backupBeforeMigrate(db, o.backupDir)
  }
  // Then everything under the database write lock: another process may open the same file at the same moment
  // (the admin CLI next to a starting server, a restart racing the old process). Without the lock both saw the
  // same pending list and the second one failed half-way ("duplicate column name") and refused to start.
  withWriteLock(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const cols = new Set((db.query('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('min_compatible_reader')) db.exec('ALTER TABLE schema_migrations ADD COLUMN min_compatible_reader INTEGER NOT NULL DEFAULT 1')
    checkReadable(db, readerLevel)
    const done = appliedVersions(db)!
    for (const m of all) {
      if (done.has(m.version)) continue
      db.exec(m.sql)
      db.query('INSERT INTO schema_migrations (version, name, applied_at, min_compatible_reader) VALUES (?, ?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString(), m.minCompatibleReader)
    }
    checkReadable(db, readerLevel)
  })
}

/** Versions recorded in schema_migrations, or null when the table does not exist yet. */
function appliedVersions(db: Database): Set<number> | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) return null
  return new Set((db.query('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
}

/** How long a process waits for another one that is migrating the same database. */
export const MIGRATION_LOCK_WAIT_MS = 120_000

/** Run `fn` in a BEGIN IMMEDIATE transaction (the write lock), waiting while another connection holds it. */
function withWriteLock(db: Database, fn: () => void, waitMs = MIGRATION_LOCK_WAIT_MS) {
  const until = Date.now() + waitMs
  for (;;) {
    try { db.exec('BEGIN IMMEDIATE'); break } catch (e) {
      if (!/SQLITE_BUSY|database is locked/i.test(`${(e as { code?: string }).code ?? ''} ${(e as Error).message}`) || Date.now() > until) throw e
      Bun.sleepSync(50)
    }
  }
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw e
  }
}

/** Throw SchemaTooNewError when an applied migration needs a newer reader than this build. */
export function checkReadable(db: Database, readerLevel: number) {
  const row = db.query('SELECT name, min_compatible_reader AS r FROM schema_migrations ORDER BY min_compatible_reader DESC, version DESC LIMIT 1').get() as { name: string; r: number } | null
  if (row && row.r > readerLevel) throw new SchemaTooNewError(row.r, readerLevel, row.name)
}

export function schemaInfo(db: Database): { applied: number; maxVersion: number } {
  const r = db.query('SELECT COUNT(*) AS n, COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { n: number; v: number }
  return { applied: r.n, maxVersion: r.v }
}

function backupBeforeMigrate(db: Database, dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // unique per process: two processes starting together must not write into one file
  const out = path.join(dir, `pre-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.db`)
  db.query('VACUUM INTO ?').run(out)
  try { fs.chmodSync(out, 0o600) } catch {}
}

/** New row id (UUIDv7). users.id is the exception (a slug). */
export const newId = (): string => uuidv7()
export const nowIso = () => new Date().toISOString()
