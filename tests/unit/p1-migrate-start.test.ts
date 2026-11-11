// QA TC-278: a large database could never finish an update. The copy before migrating (VACUUM INTO) and the migrations
// ran before the server listened, so the bootstrap's 120 s health check rolled the new version back on every try, and
// each try left another full-size copy. Now /api/health answers "migrating" meanwhile (system/migrate-start.ts), and
// copies of the same schema / of killed processes do not pile up (db.ts).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { openDb, pendingMigrationCount, SchemaTooNewError } from '../../server/src/db'
import { migrateBeforeStart } from '../../server/src/system/migrate-start'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'p1-migrate-start')
const MAIN = path.join(import.meta.dir, '..', '..', 'server', 'src', 'main.ts')
const silent = { info() {}, warn() {}, error() {} }
const peerIp = (a: string | null | undefined) => a ?? null
// a migration that takes a moment: long enough for a few health polls
const SLOW = 'CREATE TABLE slow AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1500000) SELECT x FROM c;'

/** a database with data whose build had migrations 001-002; the new build adds `third` as 003 */
function oldDb(name: string, third: string) {
  const dir = path.join(W, name)
  fs.rmSync(dir, { recursive: true, force: true })
  const mig = path.join(dir, 'migrations')
  fs.mkdirSync(mig, { recursive: true })
  fs.writeFileSync(path.join(mig, '001_a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);')
  fs.writeFileSync(path.join(mig, '002_b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);')
  const file = path.join(dir, 'data', 'app.db')
  const db = openDb(file, { migrationsDir: mig })
  db.query('INSERT INTO a (v) VALUES (?)').run('kept')
  db.close()
  fs.writeFileSync(path.join(mig, '003_c.sql'), third)
  return { dir, mig, file, backups: path.join(dir, 'data', 'backups') }
}

async function freePort() {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = s.port!
  s.stop(true)
  return p
}

const applied = (file: string) => {
  const d = new Database(file, { readonly: true })
  try { return (d.query('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n } finally { d.close() }
}

describe('start-up on a database an update must migrate', () => {
  test('/api/health answers 503 "migrating" with the version while the copy and the migrations run', async () => {
    const x = oldDb('slow', SLOW)
    expect(pendingMigrationCount(x.file, x.mig)).toBe(1)
    const port = await freePort()
    const cfg = { listen: { host: '127.0.0.1', port }, tunnel: null } as never
    const run = migrateBeforeStart({ cfg, file: x.file, version: '9.9.9', log: silent, entry: MAIN, migrationsDir: x.mig, peerIp })
    let done = false
    void run.finally(() => { done = true })
    const seen: { status: number; body: Record<string, unknown> }[] = []
    while (!done) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
        seen.push({ status: r.status, body: await r.json() as Record<string, unknown> })
        const other = await fetch(`http://127.0.0.1:${port}/api/me`)
        expect(other.status).toBe(503)
        expect(((await other.json()) as { error: { code: string } }).error.code).toBe('unavailable')
      } catch { /* not listening yet, or just stopped */ }
      await Bun.sleep(30)
    }
    expect(await run).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) {
      expect(s.status).toBe(503)
      expect(s.body).toMatchObject({ ok: false, status: 'migrating', version: '9.9.9', migrating: { pending: 1 } })
    }
    expect(applied(x.file)).toBe(3)
    expect(pendingMigrationCount(x.file, x.mig)).toBe(0)
    // the copy of the old schema is there; nothing half-written is left
    const left = fs.readdirSync(x.backups)
    expect(left.filter((n) => n.startsWith('pre-migrate-'))).toHaveLength(1)
    expect(left.filter((n) => n.startsWith('.pending-migration-'))).toEqual([])
    // the stand-in is gone: the real server can listen on the same port
    const real = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('real') })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('real')
    real.stop(true)
  }, 60_000)

  test('nothing pending, or a new database: no stand-in, no child', async () => {
    const x = oldDb('none', 'CREATE TABLE c (id INTEGER PRIMARY KEY);')
    openDb(x.file, { migrationsDir: x.mig }).close()
    const cfg = { listen: { host: '127.0.0.1', port: await freePort() }, tunnel: null } as never
    expect(await migrateBeforeStart({ cfg, file: x.file, version: '1', log: silent, entry: '/nonexistent', migrationsDir: x.mig, peerIp })).toBe(false)
    expect(await migrateBeforeStart({ cfg, file: path.join(x.dir, 'new.db'), version: '1', log: silent, entry: '/nonexistent', migrationsDir: x.mig, peerIp })).toBe(false)
  })

  test('a failing migration fails the start with its reason and leaves the database as it was', async () => {
    const x = oldDb('failing', 'CREATE TABLE c (id INTEGER PRIMARY KEY); INSERT INTO nope VALUES (1);')
    const cfg = { listen: { host: '127.0.0.1', port: await freePort() }, tunnel: null } as never
    await expect(migrateBeforeStart({ cfg, file: x.file, version: '1', log: silent, entry: MAIN, migrationsDir: x.mig, peerIp })).rejects.toThrow(/nope/)
    expect(applied(x.file)).toBe(2)
  }, 60_000)

  test('a database that needs a newer build: the child exits 75 and openDb then throws SchemaTooNewError', async () => {
    const x = oldDb('too-new', 'CREATE TABLE c (id INTEGER PRIMARY KEY);')
    const db = new Database(x.file)
    db.query("UPDATE schema_migrations SET min_compatible_reader = 99 WHERE version = 2").run()
    db.close()
    const cfg = { listen: { host: '127.0.0.1', port: await freePort() }, tunnel: null } as never
    expect(await migrateBeforeStart({ cfg, file: x.file, version: '1', log: silent, entry: MAIN, migrationsDir: x.mig, peerIp })).toBe(false)
    expect(() => openDb(x.file, { migrationsDir: x.mig })).toThrow(SchemaTooNewError)
  }, 60_000)
})

describe('pre-migrate copies do not pile up', () => {
  test('a new copy replaces older copies of the same schema and keeps copies of other schemas', () => {
    const x = oldDb('same-schema', 'CREATE TABLE c (id INTEGER PRIMARY KEY); INSERT INTO nope VALUES (1);')
    // three failed tries of the same update: each made a copy of the same old schema
    for (let i = 0; i < 3; i++) expect(() => openDb(x.file, { migrationsDir: x.mig })).toThrow(/nope/)
    const copies = () => fs.readdirSync(x.backups).filter((n) => n.startsWith('pre-migrate-')).sort()
    expect(copies()).toHaveLength(1)
    // a copy of another schema (an earlier update) is not touched
    const other = path.join(x.backups, 'pre-migrate-2020-01-01T00-00-00-000Z-1-x.db')
    const o = new Database(other)
    o.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, \'001_a.sql\', \'x\');')
    o.close()
    // an unrelated file is not touched either
    fs.writeFileSync(path.join(x.backups, 'pre-migrate-junk.db'), 'not a database')
    fs.writeFileSync(path.join(x.mig, '003_c.sql'), 'CREATE TABLE c (id INTEGER PRIMARY KEY);')
    openDb(x.file, { migrationsDir: x.mig }).close()
    const after = copies()
    expect(after).toContain(path.basename(other))
    expect(after).toContain('pre-migrate-junk.db')
    expect(after).toHaveLength(3)
    const d = new Database(path.join(x.backups, after.find((n) => n !== path.basename(other) && n !== 'pre-migrate-junk.db')!), { readonly: true })
    try { expect(d.query('SELECT v FROM a').get()).toEqual({ v: 'kept' }) } finally { d.close() }
  })

  test('half-written copies of processes that are gone are removed; a live one and a recent unnamed one stay', () => {
    const x = oldDb('stale', 'CREATE TABLE c (id INTEGER PRIMARY KEY);')
    fs.mkdirSync(x.backups, { recursive: true })
    // a pid that is not running: spawn and wait for a short process
    const gone = Bun.spawnSync(['true']).pid
    const dead = path.join(x.backups, `.pending-migration-${gone}-abcdef`)
    const live = path.join(x.backups, `.pending-migration-${process.ppid}-abcdef`)
    const unnamedOld = path.join(x.backups, '.pending-migration-Qw3rty')
    const unnamedNew = path.join(x.backups, '.pending-migration-Zx9cvb')
    for (const d of [dead, live, unnamedOld, unnamedNew]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'snapshot.db'), 'x') }
    const old = new Date(Date.now() - 7 * 3600_000)
    fs.utimesSync(unnamedOld, old, old)
    openDb(x.file, { migrationsDir: x.mig }).close()
    const left = fs.readdirSync(x.backups).filter((n) => n.startsWith('.pending-migration-')).sort()
    expect(left).toEqual([path.basename(live), path.basename(unnamedNew)].sort())
  })
})
