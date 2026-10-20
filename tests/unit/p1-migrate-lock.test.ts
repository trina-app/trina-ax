// Two processes opening the same database at once (the admin CLI next to a starting server, a restart racing the
// old process) both saw the same pending migrations; the second failed half-way ("duplicate column name",
// "table ... already exists") and refused to start. Migrations now run under the database write lock.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { MIGRATIONS_DIR, migrate, openDb, readMigrations } from '../../server/src/db'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'p1-migrate-lock')
const CHILD = path.join(import.meta.dir, '..', 'lib', 'p1-open-db.ts')
const ALL = readMigrations().length

async function together(file: string, n: number) {
  const ps = Array.from({ length: n }, () => Bun.spawn([process.execPath, CHILD, file, MIGRATIONS_DIR], { stdout: 'pipe', stderr: 'pipe' }))
  return Promise.all(ps.map(async (p) => JSON.parse((await new Response(p.stdout).text()).trim()) as { ok: boolean; applied?: number; error?: string }))
}

describe('migrations under the write lock', () => {
  test('several processes migrating a database with data at once all start', async () => {
    for (let round = 0; round < 3; round++) {
      const dir = path.join(W, `data-${round}`)
      fs.rmSync(dir, { recursive: true, force: true })
      // a database from an older release: only the first two migrations applied
      const part = path.join(dir, 'old-migrations')
      fs.mkdirSync(part, { recursive: true })
      for (const m of readMigrations().slice(0, 2)) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(part, m.name))
      openDb(path.join(dir, 'app.db'), { migrationsDir: part }).close()
      const r = await together(path.join(dir, 'app.db'), 4)
      expect(r).toEqual(Array.from({ length: 4 }, () => ({ ok: true, applied: ALL })))
      // every process that found pending migrations kept its own copy of the old database
      const copies = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('pre-migrate-'))
      expect(copies.length).toBeGreaterThanOrEqual(1)
      for (const c of copies) {
        const d = new Database(path.join(dir, 'backups', c), { readonly: true })
        expect((d.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(2)
        d.close()
      }
    }
  })

  test('several processes creating a new database at once all start', async () => {
    const dir = path.join(W, 'fresh')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const r = await together(path.join(dir, 'app.db'), 4)
    expect(r).toEqual(Array.from({ length: 4 }, () => ({ ok: true, applied: ALL })))
  })

  test('a failing migration leaves the database as it was', () => {
    const dir = path.join(W, 'failing')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);')
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);')
    fs.writeFileSync(path.join(dir, '003_c.sql'), 'CREATE TABLE c (id INTEGER PRIMARY KEY); INSERT INTO nope VALUES (1);')
    const db = new Database(':memory:')
    expect(() => migrate(db, { migrationsDir: dir })).toThrow(/nope/)
    expect(db.inTransaction).toBe(false)
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a','b','c')").all()).toEqual([])
    fs.writeFileSync(path.join(dir, '003_c.sql'), 'CREATE TABLE c (id INTEGER PRIMARY KEY);')
    migrate(db, { migrationsDir: dir })
    expect((db.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(3)
    db.close()
  })
})
