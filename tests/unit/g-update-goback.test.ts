// Go back only where it can work (QA TC-336): after 0.4.0 -> 0.5.0, 0.4.0 cannot read the database 0.5.0 migrated
// (reader level 4 against 6), so Admin › System must not offer it, the server refuses it, and a Go back that bounced
// (or any update whose version did not stay) is told as such after the restart. Also the root hold of the version that
// runs (QA TC-334) is not shown.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { requiredReaderLevel, requiredReaderLevelOfFile } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { M } from '../../server/src/system/messages'
import { UpdateManager } from '../../server/src/system/update'
import { settleUpdateJob } from '../../server/src/system/update-job'
import { WORK } from '../lib/env'

const W = path.join(WORK, 'g-update-goback')
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })

/** app/versions/<v> with migrations up to reader level `level`, a manifest (unsigned), and state.json previous */
function install(name: string, o: { running: string; previous: string; levels: Record<string, number> }) {
  const app = path.join(W, name, 'app')
  for (const [v, level] of Object.entries(o.levels)) {
    const d = path.join(app, 'versions', v)
    fs.mkdirSync(path.join(d, 'server', 'migrations'), { recursive: true })
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ format: 1, version: v, createdAt: '2026-11-01T00:00:00.000Z', files: {} }))
    fs.writeFileSync(path.join(d, 'server', 'migrations', '001_init.sql'), '-- min_compatible_reader: 1\n')
    if (level > 1) fs.writeFileSync(path.join(d, 'server', 'migrations', `25${level}_b_x.sql`), `-- min_compatible_reader: ${level}\nSELECT 1;\n`)
  }
  fs.symlinkSync(`versions/${o.running}`, path.join(app, 'current'))
  fs.writeFileSync(path.join(app, 'state.json'), JSON.stringify({ format: 1, current: o.running, previous: o.previous, pending: null, pendingSince: null, attempts: 0, history: [] }))
  return app
}

function dbAt(level: number): Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, min_compatible_reader INTEGER NOT NULL DEFAULT 1)')
  db.query('INSERT INTO schema_migrations (version, name, applied_at, min_compatible_reader) VALUES (1, ?, ?, 1), (251, ?, ?, ?)').run('001_init.sql', 'x', '251_b_room_threads.sql', 'x', level)
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, progress REAL, result TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT)")
  return db
}

describe('Go back is offered only to a version that can read the database', () => {
  test('0.4.0 (level 4) after 0.5.0 migrated to level 6: not offered, and rollBack refuses in plain words', async () => {
    const app = install('no', { running: '0.5.0', previous: '0.4.0', levels: { '0.4.0': 4, '0.5.0': 6 } })
    const db = dbAt(6)
    expect(requiredReaderLevel(db)).toBe(6)
    const u = new UpdateManager({ appDir: app, dataDir: path.join(W, 'no', 'data'), version: '0.5.0', channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true, dbReaderLevel: () => requiredReaderLevel(db) })
    const s = u.status()
    expect(s.previous).toBe('0.4.0')
    expect(s.previousNeedsRestore).toBe(true)
    await expect(u.rollBack()).rejects.toThrow(/0\.4\.0 cannot read the database 0\.5\.0 has updated; going back to it needs the backup made before the update/)
    // nothing switched
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('versions/0.5.0')
  })

  test('admin.js rollback reads the level from the database file, read-only (1 when it cannot be read)', async () => {
    const file = path.join(W, 'level.db')
    const d = new Database(file)
    d.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, min_compatible_reader INTEGER NOT NULL DEFAULT 1)')
    d.query("INSERT INTO schema_migrations VALUES (251, '251_b_room_threads.sql', 'x', 6)").run()
    d.close()
    expect(requiredReaderLevelOfFile(file)).toBe(6)
    expect(requiredReaderLevelOfFile(path.join(W, 'missing.db'))).toBe(1)
    expect(fs.existsSync(path.join(W, 'missing.db'))).toBe(false)
    const app = install('cli', { running: '0.5.0', previous: '0.4.0', levels: { '0.4.0': 4, '0.5.0': 6 } })
    const u = new UpdateManager({ appDir: app, dataDir: path.join(W, 'cli', 'data'), version: '0.5.0', channel: 'stable', feedUrl: null, log: silentLogger, allowUnsigned: true, dbReaderLevel: () => requiredReaderLevelOfFile(file) })
    await expect(u.rollBack()).rejects.toThrow(/cannot read the database/)
  })

  test('a previous version at the same level (an update without such a migration): offered', () => {
    const app = install('yes', { running: '0.5.1', previous: '0.5.0', levels: { '0.5.0': 6, '0.5.1': 6 } })
    const db = dbAt(6)
    const u = new UpdateManager({ appDir: app, dataDir: path.join(W, 'yes', 'data'), version: '0.5.1', channel: 'stable', feedUrl: null, log: silentLogger, dbReaderLevel: () => requiredReaderLevel(db) })
    expect(u.status()).toMatchObject({ previous: '0.5.0', previousNeedsRestore: false })
  })

  test('no previous: no field; no reader check given (older callers): offered as before', () => {
    const app = install('none', { running: '0.5.0', previous: '0.5.0', levels: { '0.5.0': 6 } })
    const u = new UpdateManager({ appDir: app, dataDir: path.join(W, 'none', 'data'), version: '0.5.0', channel: 'stable', feedUrl: null, log: silentLogger })
    expect(u.status().previous).toBeNull()
    expect('previousNeedsRestore' in u.status()).toBe(false)
    const app2 = install('nocheck', { running: '0.5.0', previous: '0.4.0', levels: { '0.4.0': 4, '0.5.0': 6 } })
    expect(new UpdateManager({ appDir: app2, dataDir: path.join(W, 'nocheck', 'data'), version: '0.5.0', channel: 'stable', feedUrl: null, log: silentLogger }).status().previousNeedsRestore).toBe(false)
  })
})

describe('an update job whose version did not stay is failed at the next start', () => {
  const NOW = new Date('2026-11-12T03:00:30.000Z')
  const job = (db: Database, o: { id?: string; status?: string; result: object; finishedAt?: string; createdAt?: string }) =>
    db.query("INSERT INTO jobs (id, user_id, kind, status, result, created_at, finished_at) VALUES (?, 'u1', 'update', ?, ?, ?, ?)")
      .run(o.id ?? 'j1', o.status ?? 'done', JSON.stringify(o.result), o.createdAt ?? '2026-11-12T02:59:50.000Z', o.finishedAt ?? '2026-11-12T03:00:00.000Z')
  const row = (db: Database, id = 'j1') => db.query('SELECT status, error FROM jobs WHERE id = ?').get(id) as { status: string; error: string | null }
  const bounced = [{ at: '2026-11-12T03:00:20Z', from: '0.4.0', to: '0.5.0', result: 'rolled_back' as const, detail: '0.4.0 cannot read the database: 0.5.0 has already updated it (exit 75)' }]

  test('a Go back to 0.4.0 that came back to 0.5.0: failed, "Could not go back to 0.4.0; still on 0.5.0" and why', () => {
    const db = dbAt(6)
    job(db, { result: { fromVersion: '0.5.0', toVersion: '0.4.0', rolledBack: true } })
    const id = settleUpdateJob({ db, running: '0.5.0', history: bounced, now: NOW, canRead: (v) => v !== '0.4.0', locale: () => 'en' })
    expect(id).toBe('j1')
    const r = row(db)
    expect(r.status).toBe('failed')
    expect(JSON.parse(r.error!)).toEqual({ code: 'conflict', message: 'Could not go back to 0.4.0; still on 0.5.0. 0.4.0 cannot read the database that 0.5.0 has already updated. Nothing was lost. To return to 0.4.0, the backup made before the update has to be restored (see the backup and restore guide).' })
    // once only: a second start changes nothing
    expect(settleUpdateJob({ db, running: '0.5.0', history: bounced, now: NOW, canRead: () => false, locale: () => 'en' })).toBeNull()
  })

  test("an update that the bootstrap sent back: the bootstrap's reason, in the starter's language", () => {
    const db = dbAt(6)
    job(db, { result: { fromVersion: '0.5.0', toVersion: '0.5.1', rolledBack: false } })
    const hist = [{ at: '2026-11-12T03:02:10Z', from: '0.5.1', to: '0.5.0', result: 'rolled_back' as const, detail: 'not healthy within 2m0s' }]
    settleUpdateJob({ db, running: '0.5.0', history: hist, now: NOW, canRead: () => true, locale: () => 'ko' })
    expect(JSON.parse(row(db).error!).message).toBe('0.5.1(으)로 업데이트하지 못했어요. 지금도 0.5.0(으)로 실행 중이에요. 이유: not healthy within 2m0s')
  })

  test('left alone: the version stayed, another job came after, older than a day, or not done', () => {
    const cases: [string, (db: Database) => void, string][] = [
      ['stayed', (db) => job(db, { result: { fromVersion: '0.4.0', toVersion: '0.5.0', rolledBack: false } }), '0.5.0'],
      ['old', (db) => job(db, { result: { fromVersion: '0.5.0', toVersion: '0.4.0', rolledBack: true }, finishedAt: '2026-11-10T03:00:00.000Z' }), '0.5.0'],
      ['failed already', (db) => job(db, { status: 'failed', result: { fromVersion: '0.5.0', toVersion: '0.4.0', rolledBack: true } }), '0.5.0'],
      // no roll-back by the bootstrap recorded for it (a restart, an administrator's switch back): not this job's failure
      ['no roll-back recorded', (db) => job(db, { result: { fromVersion: '0.5.0', toVersion: '0.6.0', rolledBack: false } }), '0.5.0'],
      // a newer job (a backup is another kind; this is a second update) decides, not the older one
      ['not the newest', (db) => {
        job(db, { id: 'j0', result: { fromVersion: '0.5.0', toVersion: '0.4.0', rolledBack: true }, createdAt: '2026-11-12T01:00:00.000Z' })
        job(db, { id: 'j1', result: { fromVersion: '0.4.9', toVersion: '0.5.0', rolledBack: false } })
      }, '0.5.0'],
    ]
    for (const [name, setup, running] of cases) {
      const db = dbAt(6)
      setup(db)
      expect(settleUpdateJob({ db, running, history: bounced, now: NOW, canRead: () => false, locale: () => 'en' }), name).toBeNull()
    }
  })
})

test('Diagnostics: a Go back that bounced is said plainly, in five languages', () => {
  const m = M.goBackBounced('0.4.0', '0.5.0', true, '')
  expect(m.en).toBe('Going back to 0.4.0 did not work: 0.4.0 cannot read the database that 0.5.0 has already updated, so the server runs 0.5.0 again. Nothing was lost. To return to 0.4.0, the backup made before the update has to be restored.')
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(m[l]).toContain('0.4.0')
  expect(M.goBackBounced('0.4.0', '0.5.0', false, 'not healthy within 2m0s').en).toBe('Going back to 0.4.0 did not work, so the server runs 0.5.0 again: not healthy within 2m0s')
})
