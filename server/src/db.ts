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
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
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
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const cols = new Set((db.query('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('min_compatible_reader')) db.exec('ALTER TABLE schema_migrations ADD COLUMN min_compatible_reader INTEGER NOT NULL DEFAULT 1')
  checkReadable(db, o.readerLevel ?? SCHEMA_READER_LEVEL)

  const done = new Set((db.query('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
  const pending = readMigrations(o.migrationsDir).filter((m) => !done.has(m.version))
  if (!pending.length) return
  if (done.size && o.backupDir) backupBeforeMigrate(db, o.backupDir)
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      db.query('INSERT INTO schema_migrations (version, name, applied_at, min_compatible_reader) VALUES (?, ?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString(), m.minCompatibleReader)
    })()
  }
  checkReadable(db, o.readerLevel ?? SCHEMA_READER_LEVEL)
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
  const out = path.join(dir, `pre-migrate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  db.query('VACUUM INTO ?').run(out)
  try { fs.chmodSync(out, 0o600) } catch {}
}

/** New row id (UUIDv7). users.id is the exception (a slug). */
export const newId = (): string => uuidv7()
export const nowIso = () => new Date().toISOString()
