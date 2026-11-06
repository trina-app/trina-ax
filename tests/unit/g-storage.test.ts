// Storage use of the team disk (L17, review UX-14 / BIZ-03): statfs levels (80% notice once per 24 h, 90% / 95% in
// diagnostics), writes refused with 507 storage_full when the free space would drop under max(512 MiB, 2%), the
// breakdown of what uses the space, GET /api/admin/storage. The refusal applies on Linux or with a plan; a Mac keeps
// its own checks. A plan smaller than the disk: the plan's bytes are the capped total, with a 7-day grace period and a
// hard cap of 2x.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ALERT_KEY, assertStorageRoom, assertStorageRoomForAI, cappedSnapshot, configureStorageGuard, GRACE_KEY, GRACE_MS, GRACE_TOLD_KEY, levelOf, reserveBytes, snapshotOf, storageRoom, storageState, treeBytes, type GuardStore, type StatFs } from '../../server/src/system/storage'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { BackupError, BackupManager, SERVER_OWN_SETTINGS } from '../../server/src/system/backup'
import { resolveLayout } from '../../server/src/system/layout'
import { WORK } from '../lib/env'
import { getOps } from '../../server/src/routes/system'
import { HttpError } from '../../server/src/http/errors'
import { ToolError } from '../../server/src/policy/errors'
import { Plan, setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const GiB = 1024 ** 3
/** a disk of `total` bytes with `used` used (4 KiB blocks, no root-reserved blocks) */
const disk = (total: number, used: number): StatFs => ({ bsize: 4096, blocks: total / 4096, bfree: (total - used) / 4096, bavail: (total - used) / 4096 })

describe('levels and room', () => {
  afterEach(() => { configureStorageGuard(null); setLimitsPlatformForTests(null) })
  test('levels at 80 / 90 / 95 %; the reserve is max(512 MiB, 2%)', () => {
    expect([0, 79.9, 80, 89.9, 90, 94.9, 95, 100].map(levelOf)).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high', 'full', 'full'])
    expect(reserveBytes(20 * GiB)).toBe(512 * 1024 * 1024)
    expect(reserveBytes(200 * GiB)).toBe(Math.floor(200 * GiB * 0.02))
    expect(snapshotOf(disk(20 * GiB, 5 * GiB))).toEqual({ totalBytes: 20 * GiB, freeBytes: 15 * GiB, usedBytes: 5 * GiB, percent: 25 })
    // root-reserved blocks are not the team's: the percent is of used + available
    expect(snapshotOf({ bsize: 1, blocks: 100, bfree: 10, bavail: 0 }).percent).toBe(100)
  })
  test('writes are refused near full where limits apply (507 for people, a tool error for the AI); not on a Mac without a plan', () => {
    let s = disk(20 * GiB, 19.4 * GiB) // 0.6 GiB free, reserve 0.5 GiB
    configureStorageGuard({ root: '/', statfs: () => s })
    setLimitsPlatformForTests('darwin')
    setPlanForTests(null)
    expect(storageRoom(200 * 1024 * 1024)).toBeNull()
    expect(() => assertStorageRoom(GiB)).not.toThrow()
    setLimitsPlatformForTests('linux')
    expect(storageRoom(50 * 1024 * 1024)!.ok).toBe(true)
    expect(storageRoom(200 * 1024 * 1024)!.ok).toBe(false)
    const e = (() => { try { assertStorageRoom(200 * 1024 * 1024) } catch (x) { return x } })() as HttpError
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(507)
    expect(e.code).toBe('storage_full')
    expect(() => assertStorageRoomForAI(200 * 1024 * 1024)).toThrow(ToolError)
    s = disk(20 * GiB, 10 * GiB)
    expect(() => assertStorageRoom(GiB)).not.toThrow()
    setPlanForTests(undefined)
  })
  test('treeBytes counts what is on disk, without following links', async () => {
    const d = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'mycel-tree-'))
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(d, 'a', 'b', 'f'), Buffer.alloc(100_000))
    fs.symlinkSync('/usr', path.join(d, 'link'))
    const n = await treeBytes(d)
    expect(n).toBeGreaterThanOrEqual(100_000)
    expect(n).toBeLessThan(10_000_000)
    fs.rmSync(d, { recursive: true, force: true })
  })
})

describe('a plan smaller than the disk', () => {
  const plan = (diskGiB: number) => Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB, maxActiveMembers: 3 })
  const DAY = 24 * 3600_000
  const T0 = Date.parse('2026-11-02T00:00:00.000Z')
  let s: StatFs
  let now: number
  let kept: Map<string, string>
  const room = (bytes = 0) => storageRoom(bytes)!
  const since = () => kept.get(GRACE_KEY) ?? null
  beforeAll(() => {
    now = T0
    kept = new Map()
    s = disk(80 * GiB, GiB)
    const store: GuardStore = { get: (k) => kept.get(k) ?? null, set: (k, v) => { if (v === null) kept.delete(k); else kept.set(k, v) } }
    configureStorageGuard({ root: '/', statfs: () => s, store, now: () => now })
    setPlanForTests(plan(5))
  })
  afterEach(() => { now = T0; kept.clear(); s = disk(80 * GiB, GiB); setPlanForTests(plan(5)) })
  afterAll(() => { configureStorageGuard(null); setPlanForTests(undefined) })

  test('80 GB disk, 5 GB plan, under the limit: the plan is the total, writes pass, no grace state', () => {
    expect(cappedSnapshot(true)).toEqual({ totalBytes: 5 * GiB, usedBytes: GiB, freeBytes: 4 * GiB, percent: 20 })
    expect(room(GiB)).toEqual({ ok: true, freeBytes: 4 * GiB, reserveBytes: 512 * 1024 * 1024 })
    expect(since()).toBeNull()
    expect(storageState()).toEqual({ writesRefused: false, graceEndsAt: null })
  })
  test('the limit is where a real 5 GB disk refuses: used + the reserve above the cap', () => {
    const reserve = reserveBytes(5 * GiB)
    s = disk(80 * GiB, 5 * GiB - reserve)
    expect(room().ok).toBe(true)
    expect(since()).toBeNull()
    s = disk(80 * GiB, 5 * GiB - reserve + 4096)
    expect(room().ok).toBe(true)
    expect(since()).toBe(new Date(T0).toISOString())
  })
  test('a write that first crosses the limit goes through, and the measured use starts the grace period', () => {
    s = disk(80 * GiB, 4 * GiB)
    expect(room(GiB).ok).toBe(true)
    expect(since()).toBeNull()
    s = disk(80 * GiB, 5 * GiB)
    expect(room().ok).toBe(true)
    expect(since()).toBe(new Date(T0).toISOString())
  })
  test('a write that never lands starts no grace period, so the first real crossing gets all 7 days', () => {
    s = disk(80 * GiB, 4.2 * GiB)
    expect(room(GiB).ok).toBe(true)
    expect(since()).toBeNull()
    now = T0 + 30 * 86_400_000
    s = disk(80 * GiB, 4.7 * GiB)
    expect(room(1024 ** 2).ok).toBe(true)
    expect(since()).toBe(new Date(now).toISOString())
  })
  test('a write refused at the hard cap starts no grace period', () => {
    expect(room(10 * GiB).ok).toBe(false)
    expect(since()).toBeNull()
  })
  test('over the limit, in grace: writes pass, the free space is 0, the percent is at most 100', () => {
    s = disk(80 * GiB, 6 * GiB)
    expect(cappedSnapshot(true)).toMatchObject({ totalBytes: 5 * GiB, usedBytes: 6 * GiB, freeBytes: 0, percent: 100 })
    expect(room(GiB).ok).toBe(true)
    now = T0 + GRACE_MS - 1
    expect(room(GiB).ok).toBe(true)
    expect(since()).toBe(new Date(T0).toISOString())
    expect(storageState()).toEqual({ writesRefused: false, graceEndsAt: new Date(T0 + GRACE_MS).toISOString() })
  })
  test('after grace: writes are refused, for people and for the AI, until the use drops', () => {
    s = disk(80 * GiB, 6 * GiB)
    room()
    now = T0 + GRACE_MS
    expect(room().ok).toBe(false)
    expect(storageState().writesRefused).toBe(true)
    const e = (() => { try { assertStorageRoom(1) } catch (x) { return x } })() as HttpError
    expect(e.status).toBe(507)
    expect(e.code).toBe('storage_full')
    expect(() => assertStorageRoomForAI(1)).toThrow(ToolError)
    s = disk(80 * GiB, 2 * GiB)
    expect(room(GiB).ok).toBe(true)
    expect(since()).toBeNull()
  })
  test('a hard cap of 2x applies at once, also in grace', () => {
    s = disk(80 * GiB, 9.5 * GiB)
    expect(room(GiB).ok).toBe(false)
    expect(room(0.5 * GiB).ok).toBe(true)
    s = disk(80 * GiB, 10.5 * GiB)
    expect(room().ok).toBe(false)
    expect(storageState().writesRefused).toBe(true)
  })
  test('a dip under the limit: writes work at once, but the grace period goes on until the use is under 80%', () => {
    s = disk(80 * GiB, 6 * GiB)
    room()
    now = T0 + 6 * DAY
    s = disk(80 * GiB, 4.4 * GiB) // under the limit, above 80%
    expect(room(0.1 * GiB).ok).toBe(true)
    expect(since()).toBe(new Date(T0).toISOString())
    expect(storageState().graceEndsAt).toBeNull()
    s = disk(80 * GiB, 4.6 * GiB)
    now = T0 + GRACE_MS
    expect(room().ok).toBe(false)
    s = disk(80 * GiB, 3.9 * GiB)
    expect(room().ok).toBe(true)
    expect(since()).toBeNull()
  })
  test('a grace state written while the clock was ahead comes back to now', () => {
    kept.set(GRACE_KEY, new Date(T0 + 30 * DAY).toISOString())
    s = disk(80 * GiB, 6 * GiB)
    room()
    expect(since()).toBe(new Date(T0).toISOString())
  })
  test('what is pending counts only at the hard cap, and only where a plan caps the disk', () => {
    s = disk(80 * GiB, 9 * GiB)
    expect(storageRoom(0.5 * GiB, 0.4 * GiB)!.ok).toBe(true)
    expect(storageRoom(0.5 * GiB, 0.6 * GiB)!.ok).toBe(false)
    setPlanForTests(null)
    setLimitsPlatformForTests('linux')
    expect(storageRoom(GiB, 500 * GiB)!.ok).toBe(true)
    setLimitsPlatformForTests(null)
  })
  test('a restore keeps the grace state of the server', () => {
    expect(SERVER_OWN_SETTINGS).toContain(GRACE_KEY)
    expect(SERVER_OWN_SETTINGS).toContain(GRACE_TOLD_KEY)
  })
  test('grace cleared after the use drops: going over again gets a new grace period', () => {
    s = disk(80 * GiB, 6 * GiB)
    room()
    now = T0 + 8 * DAY
    s = disk(80 * GiB, 2 * GiB)
    expect(room().ok).toBe(true)
    expect(since()).toBeNull()
    s = disk(80 * GiB, 6 * GiB)
    expect(room().ok).toBe(true)
    expect(since()).toBe(new Date(T0 + 8 * DAY).toISOString())
  })
  test('a look at the state starts nothing and clears nothing', () => {
    s = disk(80 * GiB, 6 * GiB)
    expect(storageState()).toEqual({ writesRefused: false, graceEndsAt: null })
    expect(since()).toBeNull()
  })
  test('an upgrade clears the grace state, because the cap rises', () => {
    s = disk(80 * GiB, 6 * GiB)
    room()
    now = T0 + 8 * DAY
    expect(room().ok).toBe(false)
    setPlanForTests(plan(20))
    expect(room().ok).toBe(true)
    expect(since()).toBeNull()
  })
  test('no plan: no change, and the grace state is not read', () => {
    setPlanForTests(null)
    setLimitsPlatformForTests('linux')
    const old = new Date(T0 - 30 * DAY).toISOString()
    kept.set(GRACE_KEY, old)
    s = disk(80 * GiB, 70 * GiB)
    expect(cappedSnapshot(true)).toMatchObject({ totalBytes: 80 * GiB, freeBytes: 10 * GiB })
    expect(room(GiB)).toEqual({ ok: true, freeBytes: 10 * GiB, reserveBytes: reserveBytes(80 * GiB) })
    expect(storageState()).toEqual({ writesRefused: false, graceEndsAt: null })
    expect(since()).toBe(old) // a bad plan file for a minute does not give a new grace period
    setLimitsPlatformForTests(null)
  })
  test('a plan larger than the disk uses the disk; an old grace state is ignored', () => {
    setPlanForTests(plan(100))
    kept.set(GRACE_KEY, new Date(T0 - 30 * DAY).toISOString())
    s = disk(80 * GiB, 70 * GiB)
    expect(cappedSnapshot(true)).toMatchObject({ totalBytes: 80 * GiB, freeBytes: 10 * GiB, percent: 87.5 })
    expect(room(GiB).ok).toBe(true)
    s = disk(80 * GiB, 79 * GiB)
    expect(room(GiB).ok).toBe(false)
  })
  test('the real-disk check still applies when the plan is nearly the disk', () => {
    setPlanForTests(plan(79))
    s = disk(80 * GiB, 78.5 * GiB)
    expect(room(0).ok).toBe(false) // in grace for the plan, but the real disk is near full
    expect(storageState().writesRefused).toBe(true)
  })
})

describe('the monitor and the API', () => {
  let h: Harness
  let owner: Client
  let member: Client
  let s: StatFs
  beforeAll(async () => {
    h = await harness('g-storage')
    owner = await withOwner(h)
    member = (await addMember(h, owner, { username: 'mina' })).client
    s = disk(50 * GiB, 10 * GiB)
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => s })
    fs.mkdirSync(path.join(h.ctx.config.teamRoot, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(h.ctx.config.teamRoot, 'shared', 'big.bin'), Buffer.alloc(300_000))
    fs.mkdirSync(path.join(h.ctx.config.teamRoot, '.system', 'trash'), { recursive: true })
    fs.writeFileSync(path.join(h.ctx.config.teamRoot, '.system', 'trash', 'old.bin'), Buffer.alloc(200_000))
  })
  afterAll(() => { configureStorageGuard(null); setLimitsPlatformForTests(null); setPlanForTests(undefined); h.close() })

  test('GET /api/admin/storage: admins and the owner; members are refused', async () => {
    const r = await owner.call('GET', '/api/admin/storage')
    expect(r).toMatchObject({ totalBytes: 50 * GiB, usedBytes: 10 * GiB, percent: 20, level: 'ok', writesRefused: false, breakdown: null, planDiskGiB: null })
    expect((await member.try('GET', '/api/admin/storage')).status).toBe(403)
  })
  test('the breakdown after a measurement; the plan\'s disk when there is one (the rest of the plan: GET /api/admin/plan)', async () => {
    await getOps(h.ctx)!.storage.measure()
    setPlanForTests(Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: 12 }))
    const r = await owner.call('GET', '/api/admin/storage')
    expect(r.breakdown.team).toBeGreaterThanOrEqual(300_000)
    expect(r.breakdown.trash).toBeGreaterThanOrEqual(200_000)
    expect(r.breakdown.team).toBeLessThan(r.breakdown.team + r.breakdown.trash)
    expect(typeof r.measuredAt).toBe('string')
    expect(r.planDiskGiB).toBe(50)
    expect(r.plan).toBeUndefined()
    setPlanForTests(undefined)
  })
  test('from 80%: the owner and admins are told once per 24 h (audited)', () => {
    const ops = getOps(h.ctx)!
    expect(ops.storage.checkAlert()).toBe(false)
    s = disk(50 * GiB, 41 * GiB)
    const before = h.hub.events.length
    expect(ops.storage.checkAlert()).toBe(true)
    const told = h.hub.events.slice(before).filter((e) => (e.data as { data?: { code?: string } }).data?.code === 'storage_warn')
    expect(told.map((e) => e.target)).toEqual(['olga'])
    expect((told[0]!.data as { data: { message: string } }).data.message).toContain('82%')
    expect(ops.storage.checkAlert()).toBe(false)
    expect(getSetting<string>(h.ctx.db, ALERT_KEY)).toBeTruthy()
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'storage.warn'").get()).toEqual({ n: 1 })
  })
  test('over the plan on a larger disk: the regular check starts the grace period with no write, tells once, the API shows the capped view', async () => {
    const ops = getOps(h.ctx)!
    const db = h.ctx.db
    const T0 = Date.parse('2026-12-01T00:00:00.000Z')
    let now = T0
    const told = () => h.hub.events.filter((e) => (e.data as { data?: { message?: string } }).data?.message?.match(/2026-12-(0[78]|1[45])/))
    db.query("DELETE FROM settings WHERE key = ?").run(ALERT_KEY)
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => s, now: () => now, store: { get: (k) => getSetting<string | null>(db, k) ?? null, set: (k, v) => setSetting(db, k, v) } })
    setPlanForTests(Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 5, maxActiveMembers: 3 }))
    s = disk(80 * GiB, 6 * GiB)

    expect(ops.storage.checkAlert()).toBe(true)
    expect(getSetting<string>(db, GRACE_KEY)).toBe(new Date(T0).toISOString())
    expect(told().length).toBe(1)
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'storage.grace'").get()).toEqual({ n: 1 })
    expect(ops.storage.checkAlert()).toBe(false) // told once; the 80% notice waits 24 h
    now = T0 + 25 * 3600_000
    expect(ops.storage.checkAlert()).toBe(true) // the 80% notice, on the capped view
    expect(told().length).toBe(1)
    expect(h.hub.events.at(-1)!.data).toMatchObject({ data: { code: 'storage_warn' } })

    expect(await owner.call('GET', '/api/admin/storage')).toMatchObject({ totalBytes: 5 * GiB, usedBytes: 6 * GiB, freeBytes: 0, percent: 100, level: 'full', writesRefused: false, graceEndsAt: new Date(T0 + GRACE_MS).toISOString(), planDiskGiB: 5 })
    now = T0 + GRACE_MS
    expect(await owner.call('GET', '/api/admin/storage')).toMatchObject({ writesRefused: true })
    const save = await owner.try('PUT', '/api/files/content', { path: 'shared/over.md', content: 'x', baseSha256: null })
    expect(save.status).toBe(507)
    // read and delete keep working, and "other" stays the real used value
    expect((await owner.try('GET', '/api/files/tree?path=shared')).status).toBe(200)
    expect((await owner.try('DELETE', '/api/files?path=' + encodeURIComponent('shared/big.bin'))).status).toBe(200)
    await ops.storage.measure()
    expect(ops.storage.status().breakdown!.other).toBeGreaterThan(5 * GiB)

    // the use drops: the regular check clears the state with no write; a new grace period tells again, after 24 h only
    s = disk(80 * GiB, 2 * GiB)
    ops.storage.checkAlert()
    expect(getSetting<string | null>(db, GRACE_KEY) ?? null).toBeNull()
    expect((await owner.call('GET', '/api/admin/storage')).graceEndsAt).toBeNull()
    expect(getSetting<string>(db, GRACE_TOLD_KEY)).toBeTruthy()
    s = disk(80 * GiB, 6 * GiB)
    ops.storage.checkAlert()
    expect(told().length).toBe(2)

    // the regular check with no plan known (a bad plan file) keeps the state; a plan that the disk does not exceed clears it
    const since = getSetting<string>(db, GRACE_KEY)
    expect(since).toBeTruthy()
    setPlanForTests(null)
    ops.storage.checkAlert()
    expect(getSetting<string>(db, GRACE_KEY)).toBe(since)
    setPlanForTests(Plan.parse({ format: 1, plan: 'pro', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 100, maxActiveMembers: 3 }))
    ops.storage.checkAlert()
    expect(getSetting<string | null>(db, GRACE_KEY) ?? null).toBeNull()

    // writes are refused already at the start: the notice says so, with no date
    setPlanForTests(Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 5, maxActiveMembers: 3 }))
    db.query('DELETE FROM settings WHERE key = ?').run(GRACE_TOLD_KEY)
    s = disk(80 * GiB, 12 * GiB)
    expect(ops.storage.checkAlert()).toBe(true)
    expect((h.hub.events.at(-1)!.data as { data: { message: string } }).data.message).not.toMatch(/\d{4}-\d{2}-\d{2}/)

    setPlanForTests(undefined)
    s = disk(50 * GiB, 10 * GiB)
    db.query('DELETE FROM settings WHERE key = ?').run(GRACE_KEY)
    configureStorageGuard({ root: h.ctx.config.teamRoot, statfs: () => s })
  })
  test('open upload sessions count toward the hard cap: several at once cannot pass it', async () => {
    const MiB = 1024 ** 2
    setPlanForTests(Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 5, maxActiveMembers: 3 }))
    s = disk(80 * GiB, 10 * GiB - 300 * MiB)
    const open = (name: string) => owner.try('POST', '/api/upload-sessions', { target: { kind: 'path', path: `shared/${name}` }, size: 200 * MiB, sha256: 'a'.repeat(64) })
    expect((await open('one.bin')).status).toBe(201)
    expect((await open('two.bin')).status).toBe(507)
    setPlanForTests(undefined)
    s = disk(50 * GiB, 10 * GiB)
  })
  test('uploads, saves and attachments get 507 near full (Linux)', async () => {
    setLimitsPlatformForTests('linux')
    s = disk(20 * GiB, 19.6 * GiB)
    const save = await owner.try('PUT', '/api/files/content', { path: 'shared/a.md', content: 'x'.repeat(100), baseSha256: null })
    expect(save.status).toBe(507)
    expect(save.body.error.code).toBe('storage_full')
    const sess = await owner.try('POST', '/api/upload-sessions', { target: { kind: 'path', path: 'shared/b.bin' }, size: 1000, sha256: 'a'.repeat(64) })
    expect(sess.status).toBe(507)
    expect((await owner.call('GET', '/api/admin/storage')).writesRefused).toBe(true)
    s = disk(20 * GiB, 5 * GiB)
    expect((await owner.try('PUT', '/api/files/content', { path: 'shared/a.md', content: 'x', baseSha256: null })).status).toBe(200)
    setLimitsPlatformForTests(null)
  })
  test('a file copy: no check with no plan, as before; refused over the plan\'s hard cap', async () => {
    const copy = (to: string) => owner.try('POST', '/api/files/copy', { from: 'shared/a.md', to })
    setLimitsPlatformForTests('linux')
    setPlanForTests(null)
    s = disk(20 * GiB, 19.6 * GiB)
    expect((await copy('shared/copy-1.md')).status).toBe(201)
    setPlanForTests(Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 5, maxActiveMembers: 3 }))
    s = disk(80 * GiB, 11 * GiB)
    expect((await copy('shared/copy-2.md')).status).toBe(507)
    setPlanForTests(undefined)
    setLimitsPlatformForTests(null)
    s = disk(50 * GiB, 10 * GiB)
  })
})

describe('backups under a plan smaller than the disk', () => {
  const DAY = 24 * 3600_000
  const base = path.join(WORK, 'g-storage-backups')
  const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
  let mgr: BackupManager
  let layout: ReturnType<typeof resolveLayout>
  let s: StatFs
  let clock: number
  let db: ReturnType<typeof openDb>
  const reason = (o: Parameters<BackupManager['run']>[0]) => mgr.run(o).then(() => 'done', (e: BackupError) => e.reason)
  beforeAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
    fs.mkdirSync(cfg.dataDir, { recursive: true })
    fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(cfg.teamRoot, 'shared', 'plan.md'), 'x')
    const dbFile = path.join(cfg.dataDir, 'app.db')
    db = openDb(dbFile)
    layout = resolveLayout(cfg)
    clock = Date.parse('2026-11-01T04:00:00Z')
    mgr = new BackupManager({ db, dbFile, layout, log: silentLogger, version: '0.1.0', now: () => new Date(clock) })
    setPlanForTests(Plan.parse({ format: 1, plan: 'free', maxConcurrency: 1, memoryMiB: 2048, cpuCores: 1, diskGiB: 5, maxActiveMembers: 3, localBackupRetentionDays: 3 }))
    configureStorageGuard({ root: cfg.teamRoot, statfs: () => s })
  })
  afterAll(() => { configureStorageGuard(null); setPlanForTests(undefined); db.close(); fs.rmSync(base, { recursive: true, force: true }) })

  test('a full backup needs the room a real disk of the plan\'s size has; a DB backup does not; a new chain drops old archives', async () => {
    s = disk(80 * GiB, 3.5 * GiB) // 1.5 GiB free under the plan
    expect(await reason({ kind: 'daily', scope: 'full' })).toBe('plan_space')
    expect(mgr.lastError()!.reason).toBe('plan_space')
    expect(await reason({ kind: 'pre-update', scope: 'db' })).toBe('done')
    // a mycel-ctl command has no guard: the real disk decides
    configureStorageGuard(null)
    const old = await mgr.run({ kind: 'manual', scope: 'full' })
    configureStorageGuard({ root: cfg.teamRoot, statfs: () => s })

    // inside the retention period an old archive does not count as room
    const file = path.join(layout.dbBackupsDir, `${old.id}.json`)
    fs.writeFileSync(file, JSON.stringify({ ...old, team: { ...old.team, archiveSize: 3 * GiB } }))
    clock += 2 * DAY
    expect(await reason({ kind: 'daily', scope: 'full' })).toBe('plan_space')
    // past it: a new full archive, and prune drops what the team cannot delete
    clock += 2 * DAY
    const fresh = await mgr.run({ kind: 'daily', scope: 'full' })
    expect(fresh.scope).toBe('full')
    expect(mgr.metas().map((m) => m.id)).not.toContain(old.id)
    expect(mgr.lastError()).toBeNull()
    // no old archives left: the gate holds again
    expect(await reason({ kind: 'daily', scope: 'full' })).toBe('plan_space')
  })
})
