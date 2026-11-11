// QA TC-209: a low or full disk is said plainly and the same way everywhere. The storage card agrees with the disk
// check where the Mac's absolute floor decides it; a backup refused for room says so in the person's language; an
// error from a full disk (ENOSPC, SQLite full) is 507 storage_full "the server's storage is full, an admin has to free
// space", not 500 "서버 오류". (A chat turn on a full disk: tests/unit/b-full-disk.test.ts.)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_DISK_FULL } from '@mycel/shared/api'
import { buildApp } from '../../server/src/app'
import type { AppConfig } from '../../server/src/app-config'
import { createContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import type { RouteModule } from '../../server/src/routes'
import { M } from '../../server/src/system/messages'
import { OpsService } from '../../server/src/system/ops'
import { absoluteFloor, configureStorageGuard, diskAlmostFull, isDiskFullError, StorageMonitor, type StatFs } from '../../server/src/system/storage'
import { WORK } from '../lib/env'
import { harness, withOwner, type Client, type Harness } from './a-lib'

const MiB = 1024 ** 2, GiB = 1024 ** 3
/** a disk of `total` bytes with `used` used (4 KiB blocks) */
const disk = (total: number, used: number): StatFs => ({ bsize: 4096, blocks: Math.floor(total / 4096), bfree: Math.floor((total - used) / 4096), bavail: Math.floor((total - used) / 4096) })

describe('what a full disk looks like', () => {
  test('ENOSPC, EDQUOT and SQLite full are a full disk, also as the cause of another error; other errors are not', () => {
    expect(isDiskFullError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).toBe(true)
    expect(isDiskFullError({ code: 'EDQUOT' })).toBe(true)
    expect(isDiskFullError(new Error('saving failed', { cause: Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }) }))).toBe(true)
    expect(isDiskFullError(new Error('database or disk is full'))).toBe(true)
    expect(isDiskFullError(new Error('boom'))).toBe(false)
    expect(isDiskFullError({ code: 'ENOENT' })).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
    expect(diskAlmostFull(['/x'], 64 * MiB, () => disk(GiB, GiB - 10 * MiB))).toBe(true)
    expect(diskAlmostFull(['/x'], 64 * MiB, () => disk(GiB, GiB / 2))).toBe(false)
    expect(diskAlmostFull(['/x'], 64 * MiB, () => { throw new Error('gone') })).toBe(false)
    expect(absoluteFloor(600 * MiB)).toBe(10 * GiB)
    expect(absoluteFloor(1000 * GiB)).toBe(50 * GiB)
  })
})

describe('the storage card and the backup line', () => {
  let h: Harness
  let owner: Client
  beforeAll(async () => {
    h = await harness('full-disk-words')
    owner = await withOwner(h)
  })
  afterAll(() => { configureStorageGuard(null); h.close() })

  test('a small disk under the floor is "full" on the card, as the disk check says; a roomy one stays ok', async () => {
    // the QA's 600 MB volume: 592 MB free, 1% used. The card said 여유 있음 while the check below said almost full
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => disk(600 * MiB, 8 * MiB) })
    expect(await owner.call('GET', '/api/admin/storage')).toMatchObject({ percent: 1.3, level: 'full' })
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => disk(50 * GiB, 10 * GiB) })
    expect((await owner.call('GET', '/api/admin/storage')).level).toBe('ok')
    // a Linux production install judges by the percent levels in both places
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => disk(600 * MiB, 8 * MiB) })
    const linuxProd = new StorageMonitor({ db: h.ctx.db, teamRoot: h.ctx.config.teamRoot, dataDir: h.ctx.config.dataDir, appDir: null, notify: () => {}, audit: () => {}, absoluteRule: () => false })
    expect(linuxProd.status().level).toBe('ok')
  })

  test('a backup refused for room says so in the person\'s language, without the English reason', async () => {
    const dir = path.join(WORK, 'full-disk-words-ops')
    fs.rmSync(dir, { recursive: true, force: true })
    const cfg = {
      mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(dir, 'team'), dataDir: path.join(dir, 'data'), logDir: null, logLevel: 'error',
      engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
      validateResponses: true, setupToken: null,
    } as AppConfig
    fs.mkdirSync(cfg.dataDir, { recursive: true })
    fs.mkdirSync(cfg.teamRoot, { recursive: true })
    const db = openDb(path.join(cfg.dataDir, 'app.db'))
    try {
      const ops = new OpsService(createContext({ config: cfg, db, log: silentLogger }), { engines: async () => [] })
      fs.mkdirSync(ops.layout.dbBackupsDir, { recursive: true })
      const lastError = (reason: string) => fs.writeFileSync(path.join(ops.layout.dbBackupsDir, 'last-error.json'),
        JSON.stringify({ at: new Date().toISOString(), message: 'not enough free disk space for a backup (592 MB free, 2 GB needed)', reason }))
      const line = async (locale: 'ko' | 'en') => (await ops.diagnostics(locale)).checks.find((c) => c.id === 'backups')!
      lastError('disk_space')
      expect(await line('ko')).toMatchObject({ status: 'fail', detail: M.backupFailedNoSpace.ko })
      expect((await line('ko')).detail).not.toContain('not enough')
      expect((await line('en')).detail).toBe(M.backupFailedNoSpace.en)
      lastError('plan_space')
      expect(await line('ko')).toMatchObject({ status: 'warn', detail: M.backupFailedPlanSpace.ko })
    } finally { db.close() }
  }, 30_000)
})

describe('an error from a full disk', () => {
  test('is 507 storage_full with "the server\'s storage is full", in the person\'s language; other errors stay 500', async () => {
    const dir = path.join(WORK, 'full-disk-words-app')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const cfg = {
      mode: 'dev', configFile: null, listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
      teamRoot: path.join(dir, 'team'), dataDir: dir, logDir: null, logLevel: 'error',
      engine: { authMode: 'local-login' }, relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
      validateResponses: true, setupToken: null,
    } as AppConfig
    const db = openDb(path.join(dir, 'app.db'))
    try {
      const throwing: RouteModule = {
        name: 'test', owner: 'G',
        register(kit) {
          kit.app.get('/api/test/enospc', () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }) })
          kit.app.get('/api/test/sqlite-full', () => { db.exec("CREATE TEMP TRIGGER IF NOT EXISTS full_disk BEFORE INSERT ON settings BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END"); db.query("INSERT INTO settings (key, value) VALUES ('x', '1')").run(); return new Response('no') })
          kit.app.get('/api/test/boom', () => { throw new Error('boom') })
        },
      }
      const app = await buildApp(createContext({ config: cfg, db, log: silentLogger }), [throwing])
      const get = async (p: string) => { const r = await app.request(p, { headers: { host: '127.0.0.1' } }); return { status: r.status, body: await r.json() as { error: { code: string; message: string; params?: Record<string, unknown> } } } }
      const enospc = await get('/api/test/enospc')
      expect(enospc.status).toBe(507)
      expect(enospc.body.error).toMatchObject({ code: 'storage_full', params: { reason: 'server_disk_full' } })
      expect(Object.values(SERVER_DISK_FULL)).toContain(enospc.body.error.message)
      const full = await get('/api/test/sqlite-full')
      expect(full.status).toBe(507)
      expect(full.body.error.code).toBe('storage_full')
      const boom = await get('/api/test/boom')
      expect(boom.status).toBe(500)
      expect(boom.body.error.code).toBe('internal')
    } finally { db.close() }
  })
})
