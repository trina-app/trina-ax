import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const MIGRATIONS = path.join(import.meta.dir, '..', 'migrations')

/** Open (and migrate) the SQLite database. Migrations are numbered .sql files applied once, in order. */
export function openDb(file: string): Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (file !== ':memory:') try { fs.chmodSync(file, 0o600) } catch {}
  migrate(db)
  return db
}

export function migrate(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const done = new Set((db.query('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
  for (const f of files) {
    const v = parseInt(f, 10)
    if (done.has(v)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(v, f, new Date().toISOString())
    })()
  }
}

export const newId = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20)
export const nowIso = () => new Date().toISOString()
