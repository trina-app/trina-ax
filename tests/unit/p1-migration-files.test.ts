// Migration files the runner would skip, and databases that ran a migration under a name that has changed since.
// The runner applies only NNN_<name>.sql files (MIGRATION_FILE) and knows applied migrations by number only, while the
// builds ship every .sql file. A misnamed file (a hyphen, a capital, four digits) was skipped without a word, and a
// migration renumbered after a dev database had run it left that database skipping the new file at the old number.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS_DIR, MIGRATION_FILE, openDb, readMigrations, renamedMigrations } from '../../server/src/db'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'p1-migration-files')

function folder(name: string, files: Record<string, string>): string {
  const dir = path.join(W, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), sql)
  return dir
}

function logged() {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  return { warnings, log: { warn: (msg: string, fields?: Record<string, unknown>) => { warnings.push({ msg, fields }) } } }
}

const INIT = 'CREATE TABLE t (id INTEGER PRIMARY KEY);'

describe('the migrations folder', () => {
  // a file with another name ships in the builds but never runs: rename it to NNN_<lower-case letters, digits, _>.sql
  test('every file has a name the runner applies', () => {
    const skipped = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f !== '.DS_Store' && !MIGRATION_FILE.test(f))
    expect(skipped).toEqual([])
  })

  test('readMigrations picks up every .sql file', () => {
    const shipped = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.toLowerCase().endsWith('.sql')).sort()
    expect(readMigrations().map((m) => m.name).sort()).toEqual(shipped)
  })

  test('no two files share a number', () => {
    const seen = new Map<number, string[]>()
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^\d+_/.test(x))) seen.set(parseInt(f, 10), [...(seen.get(parseInt(f, 10)) ?? []), f])
    expect([...seen.values()].filter((names) => names.length > 1)).toEqual([])
  })
})

describe('the runner', () => {
  test('skips files with other names, so the folder test above is the guard', () => {
    const dir = folder('names', { '001_init.sql': INIT, '002_a-hyphen.sql': INIT, '003_a_Capital.sql': INIT, '0004_a_four.sql': INIT, '005_a_x.SQL': INIT })
    expect(readMigrations(dir).map((m) => m.name)).toEqual(['001_init.sql'])
  })

  test('refuses two files with one number', () => {
    const dir = folder('twice', { '001_init.sql': INIT, '002_b_one.sql': 'SELECT 1;', '002_b_two.sql': 'SELECT 2;' })
    expect(() => readMigrations(dir)).toThrow(/two migrations with number 2: (002_b_one\.sql, 002_b_two|002_b_two\.sql, 002_b_one)\.sql/)
  })
})

describe('a migration renamed after a database ran it', () => {
  test('a new file at the old number: a warning names both, the server still starts, the new file is skipped', () => {
    const file = path.join(W, 'same-number', 'app.db')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    openDb(file, { migrationsDir: folder('same-number-v1', { '001_init.sql': INIT, '002_b_old.sql': 'CREATE TABLE old_one (id INTEGER);' }) }).close()
    const { warnings, log } = logged()
    const db = openDb(file, { migrationsDir: folder('same-number-v2', { '001_init.sql': INIT, '002_b_new.sql': 'CREATE TABLE new_one (id INTEGER);' }), log })
    try {
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.msg).toContain('002_b_old.sql')
      expect(warnings[0]!.msg).toContain('002_b_new.sql')
      expect(warnings[0]!.fields).toEqual({ version: 2, recorded: '002_b_old.sql', file: '002_b_new.sql', movedTo: null })
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'new_one'").get()).toBeNull()
    } finally { db.close() }
  })

  test('moved to a new number and a new file at the old one: the warning comes before the "duplicate column" failure', () => {
    const file = path.join(W, 'moved', 'app.db')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    const add = 'ALTER TABLE t ADD COLUMN source TEXT;'
    openDb(file, { migrationsDir: folder('moved-v1', { '001_init.sql': INIT, '002_b_sources.sql': add }) }).close()
    const { warnings, log } = logged()
    const v2 = folder('moved-v2', { '001_init.sql': INIT, '002_b_agents.sql': 'CREATE TABLE agents (id INTEGER);', '003_b_sources.sql': add })
    expect(() => openDb(file, { migrationsDir: v2, log })).toThrow(/duplicate column/)
    expect(warnings.map((w) => w.fields)).toEqual([{ version: 2, recorded: '002_b_sources.sql', file: '002_b_agents.sql', movedTo: '003_b_sources.sql' }])
    expect(warnings[0]!.msg).toContain('002_b_agents.sql')
    expect(warnings[0]!.msg).toContain('003_b_sources.sql, which runs on this database again')
  })

  test('moved with no file left at the old number: a warning names both', () => {
    const file = path.join(W, 'moved-away', 'app.db')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    const lists = 'CREATE TABLE IF NOT EXISTS lists (id INTEGER);'
    openDb(file, { migrationsDir: folder('moved-away-v1', { '001_init.sql': INIT, '005_b_lists.sql': lists }) }).close()
    const { warnings, log } = logged()
    const v2 = folder('moved-away-v2', { '001_init.sql': INIT, '003_b_lists.sql': lists })
    openDb(file, { migrationsDir: v2, log }).close()
    expect(warnings.map((w) => w.fields)).toEqual([{ version: 5, recorded: '005_b_lists.sql', file: null, movedTo: '003_b_lists.sql' }])
    expect(warnings[0]!.msg).toContain('005_b_lists.sql')
    expect(warnings[0]!.msg).toContain('003_b_lists.sql, which runs on this database again')
    // the next start: 003 has run, the warning stays and says so
    openDb(file, { migrationsDir: v2, log }).close()
    expect(warnings).toHaveLength(2)
    expect(warnings[1]!.msg).toContain('003_b_lists.sql, whose number this database has recorded too, so it does not run')
  })

  test('no warning for a newer build\'s migration after a downgrade, nor for a database that matches its files', () => {
    const file = path.join(W, 'downgrade', 'app.db')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    openDb(file, { migrationsDir: folder('downgrade-new', { '001_init.sql': INIT, '002_b_later.sql': 'CREATE TABLE later (id INTEGER);' }) }).close()
    const { warnings, log } = logged()
    openDb(file, { migrationsDir: folder('downgrade-old', { '001_init.sql': INIT }), log }).close()
    expect(warnings).toEqual([])

    const real = openDb(':memory:', { log })
    try { expect(renamedMigrations(real, readMigrations())).toEqual([]) } finally { real.close() }
    expect(warnings).toEqual([])
  })
})
