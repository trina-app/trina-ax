// The conversion runs after every pending migration, in the same transaction (server/src/db.ts migrate(),
// server/src/db-steps.ts; review 2 H3): a fresh database migrates and works (folders, projects, a leave), an old one
// converts, and a step that throws leaves the database exactly as it was, pending migration files included.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { MIGRATIONS_DIR, migrate, openDb } from '../../server/src/db'
import { POST_MIGRATION_STEPS, runPostMigrationSteps } from '../../server/src/db-steps'
import { ensureFolderRow, setProjectException, writeFolderAccess } from '../../server/src/admin/folders'
import { folderAccessProblems } from '../../server/src/policy/invariants'
import { legacyDb, oldMigrations } from '../lib/legacy-db'

test('a fresh database: every migration, the marker, then folders, a project folder and a leave work', () => {
  const db = openDb(':memory:')
  expect(folderAccessProblems(db)).toEqual([])
  db.query("INSERT INTO users (id, username, name, role) VALUES ('k', 'k', 'k', 'member')").run()
  db.transaction(() => {
    writeFolderAccess(db, ensureFolderRow(db, 'shared').id, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'write' }] }, null)
    const p = ensureFolderRow(db, 'projects/a')
    writeFolderAccess(db, p.id, { rules: [{ subjectType: 'user', subjectId: 'k', access: 'write' }], limited: true }, null)
    db.query("INSERT INTO projects (id, name, folder_path) VALUES ('a', 'a', 'projects/a')").run()
    setProjectException(db, p.id, 'k', true, null)
  })()
  expect(folderAccessProblems(db)).toEqual([])
  // the safe-ops triggers see the limit and origin
  expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'safe_ops_folders_update'").get() as { sql: string }).sql).toContain('limited')
  expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'safe_ops_folder_rules_update'").get() as { sql: string }).sql).toContain('origin')
})

test('an old database converts in the same transaction as its pending files', () => {
  const w = legacyDb()
  w.user('m'); w.group('g')
  w.rule('shared', 'everyone', null, 'write'); w.rule('shared/x', 'group', 'g', 'none')
  w.convert()
  expect(folderAccessProblems(w.db)).toEqual([])
  expect((w.db.query("SELECT 1 AS ok FROM schema_migrations WHERE version = 121").get() as { ok: number }).ok).toBe(1)
})

test('a step that throws rolls back everything, the pending migration files included; the database works with the old build', () => {
  const w = legacyDb()
  w.user('m'); w.group('g')
  w.rule('shared', 'everyone', null, 'write'); w.rule('shared/x', 'group', 'g', 'none')
  const steps = POST_MIGRATION_STEPS as unknown as { name: string; run: (db: Database) => void }[]
  const conv = steps.find((s) => s.name === 'folderAccessAdditive')!
  const run = conv.run
  conv.run = () => { throw new Error('boom') }
  try { expect(() => w.convert()).toThrow('boom') } finally { conv.run = run }
  expect(w.db.query('SELECT 1 FROM schema_migrations WHERE version = 121').get()).toBeNull()
  expect((w.db.query('PRAGMA table_info(folders)').all() as { name: string }[]).some((c) => c.name === 'limited')).toBe(false)
  expect(w.db.query("SELECT 1 FROM folder_rules WHERE access = 'none'").get()).not.toBeNull()
  // and the next start converts
  w.convert()
  expect(folderAccessProblems(w.db)).toEqual([])
})

test('the steps check what they need: a database with the safe-ops triggers but without 121 is left alone (review 3 S4)', () => {
  const db = new Database(':memory:', { strict: true })
  migrate(db, { migrationsDir: oldMigrations(), readerLevel: 6 })
  runPostMigrationSteps(db)
  expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'safe_ops_folders_update'").get() as { sql: string }).sql).not.toContain('limited')
  db.query("INSERT INTO folders (id, path) VALUES ('a', 'a')").run()
  db.query("UPDATE folders SET path = 'b' WHERE id = 'a'").run()
})

test('a restored or copied database with no pending file but no marker is converted at the next open, with a copy first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-p2-'))
  try {
    const file = path.join(dir, 'app.db')
    const db = openDb(file)
    db.query("INSERT INTO users (id, username, name, role) VALUES ('m', 'm', 'm', 'member')").run()
    db.query("DELETE FROM settings WHERE key = 'folder_access_model'").run()
    db.close()
    const again = openDb(file)
    expect(folderAccessProblems(again)).toEqual([])
    again.close()
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('pre-migrate-'))).toBe(true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('MIGRATIONS_DIR has 121 in range A', () => { expect(fs.existsSync(path.join(MIGRATIONS_DIR, '121_a_folder_limited.sql'))).toBe(true) })
