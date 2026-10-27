// Storage use of the team disk (L17, review UX-14 / BIZ-03): statfs levels (80% notice once per 24 h, 90% / 95% in
// diagnostics), writes refused with 507 storage_full when the free space would drop under max(512 MiB, 2%), the
// breakdown of what uses the space, GET /api/admin/storage. The refusal applies on Linux or with a plan; a Mac keeps
// its own checks.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ALERT_KEY, assertStorageRoom, assertStorageRoomForAI, configureStorageGuard, levelOf, reserveBytes, snapshotOf, storageRoom, treeBytes, type StatFs } from '../../server/src/system/storage'
import { getOps } from '../../server/src/routes/system'
import { HttpError } from '../../server/src/http/errors'
import { ToolError } from '../../server/src/policy/errors'
import { Plan, setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'
import { getSetting } from '../../server/src/admin/settings'
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
})
