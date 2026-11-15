// Free disk space that every disk check reads (system/disk-stat.ts, QA TC-3099): on an Intel Mac the bundled Bun
// 1.3.12 returns statfs with bsize 0 and shifted fields, so backups and updates saw "0 MB free" with 129 GB free. Such
// a reading is replaced by `df -k -P`; good readings stay exactly what statfs says. Neither readable = "unknown", which
// never blocks a backup or an update as if the disk were full; a really low disk still does.
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diskStat, DiskSpaceUnknown, parseDfK, plausibleStatfs, primeDiskStat, setDfRunnerForTests, type DfRun } from '../../server/src/system/disk-stat'
import { diskSpace, diskSpaceOrUnknown, primeDiskSpace, resolveLayout } from '../../server/src/system/layout'
import { configureStorageGuard, diskAlmostFull, snapshotOf, storageSnapshot } from '../../server/src/system/storage'
import type { AppConfig } from '../../server/src/app-config'
import { openDb } from '../../server/src/db'
import type { Logger } from '../../server/src/log'
import { silentLogger } from '../../server/src/log'
import { BackupManager } from '../../server/src/system/backup'
import { roomFor } from '../../server/src/office/update'

/** what Bun 1.3.12 darwin-x64 gave on the mac1.metal host (macOS 15.8.2, 129 GB free) */
const INTEL_BROKEN = { type: 26, bsize: 0, frsize: 0, blocks: 4096, bfree: 1048576, bavail: 39270390, files: 0, ffree: 0 }
/** df -k -P shaped like that host's (129 GiB available) */
const INTEL_DF = 'Filesystem     1024-blocks     Used Available Capacity  Mounted on\n/dev/disk1s5s1   244810132 10051040 135284000     7%    /\n'
/** a good Apple Silicon reading (bsize 4096) */
const ARM_GOOD = { type: 26, bsize: 4096, frsize: 4096, blocks: 487113810, bfree: 76710803, bavail: 76710803, files: 3068890852, ffree: 3068432120 }
const GiB = 1024 ** 3

describe('plausibleStatfs', () => {
  test('the Intel reading is refused, good readings pass', () => {
    expect(plausibleStatfs(INTEL_BROKEN)).toBe(false)
    expect(plausibleStatfs(ARM_GOOD)).toBe(true)
    expect(plausibleStatfs({ bsize: 4096n, blocks: 1000n, bfree: 10n, bavail: 5n })).toBe(true)
    // a full disk is a real reading, not a broken one
    expect(plausibleStatfs({ bsize: 4096, blocks: 1000, bfree: 0, bavail: 0 })).toBe(true)
  })
  test('each impossible field on its own', () => {
    expect(plausibleStatfs({ ...ARM_GOOD, bsize: 0 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, frsize: 0 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, blocks: 0 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, bavail: ARM_GOOD.blocks + 1 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, bfree: ARM_GOOD.blocks + 1 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, bfree: 10, bavail: 11 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, bavail: -1 })).toBe(false)
    expect(plausibleStatfs({ ...ARM_GOOD, bsize: Number.NaN })).toBe(false)
    // a disk bigger than 1 EiB is shifted fields, not a disk
    expect(plausibleStatfs({ bsize: 1048576, blocks: 2 ** 41, bfree: 1, bavail: 1 })).toBe(false)
  })
})

describe('parseDfK', () => {
  test('the Intel host', () => {
    const s = parseDfK(INTEL_DF)!
    // bfree = bavail, like a good APFS statfs: "used" is the whole container's, as on Apple silicon
    expect(s).toEqual({ bsize: 1024, frsize: 1024, blocks: 244810132, bfree: 135284000, bavail: 135284000 })
    const snap = snapshotOf(s)
    expect(Math.round(snap.freeBytes / GiB)).toBe(129)
    expect(snap.usedBytes).toBe((244810132 - 135284000) * 1024)
    expect(snap.usedBytes + snap.freeBytes).toBe(snap.totalBytes)
  })
  test('a file system name or mount point with spaces', () => {
    const s = parseDfK('Filesystem 1024-blocks Used Available Capacity Mounted on\n//me@srv/My Share   1000  400  600    40%    /Volumes/My Share\n')!
    expect([s.blocks, s.bfree, s.bavail]).toEqual([1000, 600, 600])
  })
  test('anything else is null', () => {
    expect(parseDfK('')).toBeNull()
    expect(parseDfK('df: /nope: No such file or directory\n')).toBeNull()
    expect(parseDfK('Filesystem 1024-blocks Used Available Capacity Mounted on\n')).toBeNull()
    expect(parseDfK('Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto_home 0 0 0 100% /System/Volumes/Data/home\n')).toBeNull()
    expect(parseDfK('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x - - - - /\n')).toBeNull()
    // not 1 KiB blocks (df without -k): the numbers would be read 2x too large
    expect(parseDfK('Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk1s5s1 489620264 20102080 270568000 7% /\n')).toBeNull()
  })
})

describe('diskStat', () => {
  test('macOS with the broken Intel reading: df gives the free space (129 GB, not 0)', () => {
    const seen: string[] = []
    const s = diskStat('/Users/x/TeamAX/data', { platform: 'darwin', statfs: () => INTEL_BROKEN, df: (p) => { seen.push(p); return INTEL_DF } })
    expect(seen).toEqual(['/Users/x/TeamAX/data'])
    expect(Number(s.bavail) * Number(s.bsize)).toBe(135284000 * 1024)
    // the backup needs 2 GB: there is plenty
    expect(Number(s.bavail) * Number(s.bsize)).toBeGreaterThan(2 * GiB)
  })
  test('macOS with a good reading (Apple Silicon): statfs as it is, df never runs', () => {
    const s = diskStat('/', { platform: 'darwin', statfs: () => ARM_GOOD, df: () => { throw new Error('df must not run') } })
    expect(s).toBe(ARM_GOOD)
  })
  test('Linux: a good reading as it is (df never runs); a broken one is checked with df too', () => {
    const good = { bsize: 4096, blocks: 1000, bfree: 500, bavail: 400 }
    expect(diskStat('/', { platform: 'linux', statfs: () => good, df: () => { throw new Error('df must not run') } })).toBe(good)
    expect(Number(diskStat('/', { platform: 'linux', statfs: () => INTEL_BROKEN, df: () => INTEL_DF }).bavail)).toBe(135284000)
  })
  test('Windows has no df: a broken reading is unknown', () => {
    expect(() => diskStat('C:\\x', { platform: 'win32', statfs: () => INTEL_BROKEN, df: () => { throw new Error('df must not run') } })).toThrow(DiskSpaceUnknown)
  })
  test('broken reading and df fails: DiskSpaceUnknown, never "0 bytes free"', () => {
    expect(() => diskStat('/x', { platform: 'darwin', statfs: () => INTEL_BROKEN, df: () => null })).toThrow(DiskSpaceUnknown)
    expect(() => diskStat('/x', { platform: 'darwin', statfs: () => INTEL_BROKEN, df: () => 'garbage' })).toThrow(/could not read the free disk space/)
  })
  test('a statfs error is passed on as it is', () => {
    const e = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    expect(() => diskStat('/x', { platform: 'darwin', statfs: () => { throw e } })).toThrow(e)
  })
})

describe('the real callers', () => {
  let spy: { mockRestore(): void } | null = null
  afterEach(() => { spy?.mockRestore(); spy = null })

  test.skipIf(process.platform === 'win32')('diskSpace (backup preflight): broken statfs → the real /bin/df', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-stat-'))
    try {
      spy = spyOn(fs, 'statfsSync').mockImplementation((() => INTEL_BROKEN) as unknown as typeof fs.statfsSync)
      await primeDiskSpace(dir)
      const d = diskSpace(dir)
      // the real df of this machine's temp folder: a real disk, not 0
      expect(d.total).toBeGreaterThan(0)
      expect(d.free).toBeGreaterThan(0)
      expect(d.free).toBeLessThanOrEqual(d.total)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('diskSpaceOrUnknown: an unreadable disk is null (and reported), not 0 free', () => {
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => { throw new DiskSpaceUnknown('no df') }) as unknown as typeof fs.statfsSync)
    const seen: unknown[] = []
    expect(diskSpaceOrUnknown(os.tmpdir(), (e) => seen.push(e))).toBeNull()
    expect(seen[0]).toBeInstanceOf(DiskSpaceUnknown)
  })

  test('diskSpaceOrUnknown passes any other error on (statfs EIO is not "unknown")', () => {
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }) as unknown as typeof fs.statfsSync)
    expect(() => diskSpaceOrUnknown(os.tmpdir())).toThrow('EIO')
  })

  test('diskSpace with a good statfs reading is unchanged on every system', () => {
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => ARM_GOOD) as unknown as typeof fs.statfsSync)
    expect(diskSpace(os.tmpdir())).toEqual({ free: ARM_GOOD.bavail * 4096, total: ARM_GOOD.blocks * 4096 })
  })

  test.skipIf(process.platform === 'win32')('roomFor (update preflight) with the broken reading has room (real df)', async () => {
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => INTEL_BROKEN) as unknown as typeof fs.statfsSync)
    await primeDiskSpace(os.tmpdir())
    const r = roomFor(os.tmpdir(), 1024)
    expect(r.ok).toBe(true)
    expect(r.freeBytes).toBeGreaterThan(0)
  })

  test('roomFor: unknown free space is not "no room"; a really low disk still is', () => {
    expect(roomFor(os.tmpdir(), 1024, () => { throw new DiskSpaceUnknown('no df') })).toEqual({ ok: true, freeBytes: null, needBytes: 1024 })
    expect(roomFor(os.tmpdir(), 1024, () => ({ bsize: 4096, blocks: 1e6, bfree: 10, bavail: 10 })).ok).toBe(false)
    // any other error is passed on as before
    expect(() => roomFor(os.tmpdir(), 1024, () => { throw new Error('EIO') })).toThrow('EIO')
  })

  test('diskAlmostFull and the storage guard: unknown is "not full", a real low disk is', () => {
    const unknown = () => { throw new DiskSpaceUnknown('no df') }
    expect(diskAlmostFull(['/'], 64 * 1024 ** 2, unknown)).toBe(false)
    expect(diskAlmostFull(['/'], 64 * 1024 ** 2, () => ({ bsize: 4096, blocks: 1e6, bfree: 10, bavail: 10 }))).toBe(true)
    try {
      configureStorageGuard({ root: '/', statfs: unknown })
      expect(storageSnapshot(true)).toBeNull() // no snapshot = no refusal (storageRoom null)
      configureStorageGuard({ root: '/', statfs: () => diskStat('/', { platform: 'darwin', statfs: () => INTEL_BROKEN, df: () => INTEL_DF }) })
      expect(Math.round(storageSnapshot(true)!.freeBytes / GiB)).toBe(129)
    } finally { configureStorageGuard(null) }
  })
})

describe('df runs in the background: a hung df never blocks', () => {
  afterEach(() => setDfRunnerForTests(null))
  const dir = os.tmpdir()

  test('a df that never answers: the sync reading is "unknown" at once, prime gives up, one df at a time', async () => {
    let calls = 0
    setDfRunnerForTests(() => { calls++; return new Promise<string | null>(() => {}) }, { timeoutMs: 50 })
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) expect(() => diskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })).toThrow(DiskSpaceUnknown)
    expect(Date.now() - t0).toBeLessThan(200)
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(calls).toBe(1)
  })

  test('the hot path reads the cache; prime waits for the answer; an old answer is refreshed once', async () => {
    let calls = 0
    setDfRunnerForTests(async () => { calls++; return INTEL_DF })
    const read = () => diskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    // nothing cached yet: unknown now (never a wait), and a refresh has started
    expect(read).toThrow(DiskSpaceUnknown)
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    expect(Number(read().bavail)).toBe(135284000)
    expect(Number(read().bavail)).toBe(135284000)
    expect(calls).toBe(1)
    // a good statfs reading needs no df at all
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => ARM_GOOD })
    expect(calls).toBe(1)
  })

  test('an old answer: refreshed once in the background after freshMs; past maxAgeMs it is unknown', async () => {
    let now = 1_000_000, calls = 0
    let answer: ((v: string | null) => void) | null = null
    setDfRunnerForTests(() => { calls++; return calls === 1 ? Promise.resolve(INTEL_DF) : new Promise<string | null>((r) => { answer = r }) }, { freshMs: 10_000, maxAgeMs: 60_000, now: () => now })
    const read = () => Number(diskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN }).bavail)
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    expect(read()).toBe(135284000)
    now += 9_000
    expect(read()).toBe(135284000)
    expect(calls).toBe(1) // still fresh: no df
    now += 2_000
    expect(read()).toBe(135284000) // old but usable: the cached answer, and one refresh started
    expect(read()).toBe(135284000)
    expect(calls).toBe(2) // not one per read
    now += 60_000
    expect(() => diskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })).toThrow(DiskSpaceUnknown) // too old
    answer!(INTEL_DF.replace('135284000', '135000000'))
    await Bun.sleep(5)
    expect(read()).toBe(135000000)
  })

  test('a df whose answer was given up on but whose process is still alive: no second df for that path', async () => {
    let calls = 0
    let exit: () => void = () => {}
    const runner = (): DfRun => { calls++; return { answer: Promise.resolve(null), exited: new Promise<void>((r) => { exit = r }) } }
    let now = 0
    setDfRunnerForTests(runner, { raw: true, freshMs: 10, now: () => now })
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    expect(calls).toBe(1)
    for (let i = 0; i < 3; i++) {
      now += 100
      expect(() => diskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })).toThrow(DiskSpaceUnknown)
      await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    }
    expect(calls).toBe(1)
    exit()
    await Bun.sleep(5)
    now += 100
    await primeDiskStat(dir, { platform: 'darwin', statfs: () => INTEL_BROKEN })
    expect(calls).toBe(2)
  })
})

describe('the backup gate', () => {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'disk-stat-bk-')))
  afterAll(() => fs.rmSync(W, { recursive: true, force: true }))
  afterEach(() => { spy?.mockRestore(); spy = null })
  let spy: { mockRestore(): void } | null = null
  const setup = (name: string) => {
    const base = path.join(W, name)
    const cfg = { mode: 'dev', configFile: null, dataDir: path.join(base, 'data'), teamRoot: path.join(base, 'team'), logDir: null } as unknown as AppConfig
    fs.mkdirSync(cfg.dataDir, { recursive: true })
    fs.mkdirSync(path.join(cfg.teamRoot, 'shared'), { recursive: true })
    const dbFile = path.join(cfg.dataDir, 'app.db')
    const db = openDb(dbFile)
    const warns: { msg: string; f?: unknown }[] = []
    const infos: string[] = []
    const log = { ...silentLogger, warn: (msg: string, f?: unknown) => { warns.push({ msg, f }) }, info: (msg: string) => { infos.push(msg) }, child: () => log } as unknown as Logger
    return { db, mgr: new BackupManager({ db, dbFile, layout: resolveLayout(cfg), log, version: '0.1.0', now: (() => { let t = Date.parse('2026-11-15T00:00:00Z'); return () => new Date(t += 1000) })() }), warns, infos }
  }

  test.skipIf(process.platform === 'win32')('the Intel Mac reading: df gives the free space and the backup is made', async () => {
    const e = setup('intel')
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => INTEL_BROKEN) as unknown as typeof fs.statfsSync)
    try {
      const m = await e.mgr.run({ kind: 'pre-update', scope: 'db' })
      expect(m.kind).toBe('pre-update')
      expect(e.warns.filter((w) => /free disk space/.test(w.msg))).toEqual([])
    } finally { e.db.close() }
  })

  test('free space unknown (statfs and df both fail): a warning, and the backup is made', async () => {
    const e = setup('unknown')
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => { throw new DiskSpaceUnknown('could not read the free disk space of x') }) as unknown as typeof fs.statfsSync)
    try {
      const m = await e.mgr.run({ kind: 'manual', scope: 'db' })
      expect(m.scope).toBe('db')
      const unknownWarns = () => e.warns.filter((w) => w.msg === 'could not read the free disk space; backing up anyway').length
      expect(unknownWarns()).toBe(2)
      // the next backup in the same state logs nothing new
      await e.mgr.run({ kind: 'manual', scope: 'db' })
      expect(unknownWarns()).toBe(2)
      // readable again: one line each, then quiet
      spy.mockRestore()
      spy = spyOn(fs, 'statfsSync').mockImplementation((() => ARM_GOOD) as unknown as typeof fs.statfsSync)
      await e.mgr.run({ kind: 'manual', scope: 'db' })
      expect(e.infos.filter((m) => m === 'the free disk space can be read again').length).toBe(2)
    } finally { e.db.close() }
  })

  test('a real low disk still refuses', async () => {
    const e = setup('low')
    spy = spyOn(fs, 'statfsSync').mockImplementation((() => ({ bsize: 4096, frsize: 4096, blocks: 1e6, bfree: 100, bavail: 100 })) as unknown as typeof fs.statfsSync)
    try {
      await expect(e.mgr.run({ kind: 'pre-update', scope: 'db' })).rejects.toThrow(/not enough free disk space for a backup \(0 MB free, 2 GB needed\)/)
    } finally { e.db.close() }
  })
})
