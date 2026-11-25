// The server's heavy-job budget (server/src/system/heavy-jobs.ts, docs/decisions/20261124-heavy-job-budget.md): the MP4
// render, LibreOffice conversions and the browser's prints share one memory budget sized from the box; under 6 GiB one
// at a time; first come, first served; the render's time limit follows its CPUs and frames; the server stays the
// kernel's last OOM choice.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HEAVY_RESERVE_MIB, HEAVY_SHARED_FROM_MIB, HeavyJobError, HeavyJobs, heavyBudgetMiB, heavyJobs, heavyWeightMiB, machineMemoryMiB, setHeavyMemoryForTests, type HeavyKind,
} from '../../server/src/system/heavy-jobs'
import { CONV_OOM_SCORE_ADJ, PRINT_ONE_MIB, VIDEO_OOM_SCORE_ADJ, videoLeafMiB, VIDEO_STREAM_MIB } from '../../server/src/system/cgroups'
import { PRINT_OOM_SCORE_ADJ, renderSlot, tryRenderSlot, _queueForTest } from '../../server/src/files/html-pdf'
import { failureKind, RENDER_CPUS, renderTimeLimitMs, streamsIn } from '../../server/src/promo-video/render'
import { VIDEO_ONE_MIB } from '../../server/src/system/cgroups'
import { DURATION } from '../../server/src/promo-video/layout'

const W: Record<HeavyKind, number> = { video: 1280, office: 1024, print: 768 }
const jobs = (memoryMiB: number) => new HeavyJobs(() => heavyBudgetMiB(memoryMiB), (k) => W[k])
const tick = () => new Promise((r) => setTimeout(r, 0))
/** a promise's state without waiting for it */
async function settled<T>(p: Promise<T>): Promise<'pending' | 'done' | 'failed'> {
  let s: 'pending' | 'done' | 'failed' = 'pending'
  p.then(() => { s = 'done' }, () => { s = 'failed' })
  await tick(); await tick()
  return s
}

describe('heavy-job budget', () => {
  test('sized from the box: one at a time under 6 GiB, the box minus the reserve above', () => {
    expect(heavyBudgetMiB(3922)).toBe(0)
    expect(heavyBudgetMiB(4096)).toBe(0)
    expect(heavyBudgetMiB(HEAVY_SHARED_FROM_MIB - 1)).toBe(0)
    expect(heavyBudgetMiB(6144)).toBe(6144 - HEAVY_RESERVE_MIB)
    expect(heavyBudgetMiB(16384)).toBe(16384 - HEAVY_RESERVE_MIB)
    // the plan's memory when there is one (a hosted VM), else the machine's
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-plan-'))
    const plan = path.join(dir, 'plan.json')
    fs.writeFileSync(plan, JSON.stringify({ memoryMiB: 4096 }))
    expect(machineMemoryMiB(plan, 16384)).toBe(4096)
    fs.writeFileSync(plan, JSON.stringify({ memoryMiB: 12 }))
    expect(machineMemoryMiB(plan, 16384)).toBe(16384)
    expect(machineMemoryMiB(undefined, 8000)).toBe(8000)
    fs.rmSync(dir, { recursive: true, force: true })
    // weights: each kind's cgroup cap
    expect(heavyWeightMiB('video')).toBe(videoLeafMiB())
    expect(heavyWeightMiB('print')).toBe(PRINT_ONE_MIB)
    expect(heavyWeightMiB('office')).toBeGreaterThanOrEqual(512)
  })

  test('a 4 GiB box: a conversion waits for the render and starts when it ends (the overlap that ended in a global OOM)', async () => {
    const j = jobs(3922)
    const video = await j.acquire('video')
    let waited = false
    const office = j.acquire('office', { onWait: () => { waited = true } })
    expect(waited).toBe(true)
    expect(await settled(office)).toBe('pending')
    expect(j.state()).toMatchObject({ running: ['video'], waiting: ['office'] })
    // a print as well: one at a time, whatever its size
    const print = j.acquire('print')
    expect(await settled(print)).toBe('pending')
    video()
    expect(await settled(office)).toBe('done')
    expect(await settled(print)).toBe('pending')
    ;(await office)()
    expect(await settled(print)).toBe('done')
    ;(await print)()
    expect(j.state()).toMatchObject({ running: [], waiting: [], usedMiB: 0 })
  })

  test('a bigger box runs jobs together while their caps fit; a job alone always runs', async () => {
    const j = jobs(6144) // budget 2560
    const v = await j.acquire('video')
    const p = await j.acquire('print') // 1280 + 768 = 2048
    expect(j.state().running).toEqual(['video', 'print'])
    const o = j.acquire('office') // + 1024 > 2560: waits
    expect(await settled(o)).toBe('pending')
    p()
    expect(await settled(o)).toBe('done') // 1280 + 1024 = 2304
    v(); (await o)()
    // a job heavier than the whole budget still runs when nothing else does
    const big = new HeavyJobs(() => 100, () => 5000)
    const r = await big.acquire('video')
    expect(big.state().running).toEqual(['video'])
    r()
  })

  test('first come, first served: a later job that would fit never passes one that waits (no starvation)', async () => {
    const j = jobs(6144) // budget 2560
    const v = await j.acquire('video') // 1280
    const o1 = await j.acquire('office') // 2304
    const v2 = j.acquire('video') // 3584 > 2560: waits
    const order: string[] = []
    v2.then(() => order.push('video2'))
    // a print and a conversion that come later: neither goes before the waiting render
    const p1 = j.acquire('print'); p1.then(() => order.push('print1'))
    o1()
    await tick(); await tick()
    // the office ended: 1280 used; the render (1280) fits (2560) and goes first; the print behind it waits (3328)
    expect(order).toEqual(['video2'])
    const o2 = j.acquire('office'); o2.then(() => order.push('office2'))
    v()
    await tick(); await tick()
    // the first render ended: the print goes (1280 + 768); the conversion behind it does not fit yet (3072)
    expect(order).toEqual(['video2', 'print1'])
    ;(await v2)()
    await tick(); await tick()
    expect(order).toEqual(['video2', 'print1', 'office2'])
    ;(await p1)(); (await o2)()
    expect(j.state().usedMiB).toBe(0)
  })

  test('tryAcquire never waits and never goes before a waiting job', async () => {
    const j = jobs(16384)
    const v = j.tryAcquire('video')!
    expect(v).toBeTruthy()
    const p = j.tryAcquire('print')!
    expect(p).toBeTruthy()
    p(); v()
    const small = jobs(3922)
    const a = small.tryAcquire('print')!
    expect(small.tryAcquire('print')).toBeNull()
    const w = small.acquire('video')
    a()
    expect(await settled(w)).toBe('done')
    ;(await w)()
    // a waiter in front: no try, even with room
    const hog = new HeavyJobs(() => 2000, (k) => W[k])
    const x = await hog.acquire('video')
    const y = hog.acquire('video')
    expect(hog.tryAcquire('print')).toBeNull()
    x(); (await y)()
    expect(hog.state().running).toEqual([])
  })

  test('a waiting job that is stopped or waits too long leaves the line, and the next one goes', async () => {
    const j = jobs(3922)
    const v = await j.acquire('video')
    const ac = new AbortController()
    const a = j.acquire('office', { signal: ac.signal })
    const b = j.acquire('print', { maxWaitMs: 20 })
    const c = j.acquire('office')
    ac.abort()
    await expect(a).rejects.toMatchObject({ code: 'aborted' })
    await expect(b).rejects.toBeInstanceOf(HeavyJobError)
    await b.catch((e: HeavyJobError) => expect(e.code).toBe('busy'))
    expect(j.state().waiting).toEqual(['office'])
    expect(await settled(c)).toBe('pending')
    v()
    expect(await settled(c)).toBe('done')
    // a release twice gives the room back once
    const r = await c
    r(); r()
    expect(j.state()).toMatchObject({ running: [], usedMiB: 0 })
    // already stopped: never queued
    const stopped = new AbortController(); stopped.abort()
    await expect(j.acquire('video', { signal: stopped.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(j.state().waiting).toEqual([])
  })
})

describe('prints and conversions take the budget', () => {
  afterEach(() => setHeavyMemoryForTests(null))

  test('a LibreOffice conversion waits while the render runs on a 4 GiB box, and a page view is skipped', async () => {
    setHeavyMemoryForTests(3922)
    const video = await heavyJobs.acquire('video')
    try {
      const office = renderSlot('u-office', undefined, 'office')
      expect(await settled(office)).toBe('pending')
      // the print slot is held while it waits (lock order: print slot, then the budget)
      expect(_queueForTest().running).toBe(1)
      expect(tryRenderSlot('page-view')).toBeNull()
      video()
      const release = await office
      expect(heavyJobs.state().running).toEqual(['office'])
      release()
      expect(heavyJobs.state().running).toEqual([])
      expect(_queueForTest().running).toBe(0)
    } finally { video() }
  })

  test('a stopped wait gives the print slot back', async () => {
    setHeavyMemoryForTests(3922)
    const video = await heavyJobs.acquire('video')
    try {
      const ac = new AbortController()
      const p = renderSlot('u-stop', ac.signal)
      expect(await settled(p)).toBe('pending')
      ac.abort()
      await expect(p).rejects.toMatchObject({ code: 'aborted' })
      expect(_queueForTest().running).toBe(0)
      expect(heavyJobs.state().waiting).toEqual([])
    } finally { video() }
  })
})

describe('the render time limit', () => {
  test('from the CPUs it may use and the frames it draws, within 8 (Linux) or 4 (Mac) and 30 minutes', () => {
    const frames = Math.ceil(DURATION * 30)
    expect(renderTimeLimitMs(2, DURATION, 'linux')).toBe(90_000 + Math.ceil(frames * 2000 / 2))
    // about 11 minutes on two cores: qa.trina.app's slowest render (457 s, 2 vCPU) takes at most 75 % of it; 20 on one
    expect(457_000 / renderTimeLimitMs(2, DURATION, 'linux')).toBeLessThan(0.75)
    expect(renderTimeLimitMs(1, DURATION, 'linux') / 60_000).toBeGreaterThan(19)
    // never more cores than a render may use
    expect(renderTimeLimitMs(16, DURATION, 'linux')).toBe(renderTimeLimitMs(RENDER_CPUS, DURATION, 'linux'))
    // a longer video gets longer; the floors and the cap
    expect(renderTimeLimitMs(2, 40, 'linux')).toBeGreaterThan(renderTimeLimitMs(2, DURATION, 'linux'))
    expect(renderTimeLimitMs(2, 3, 'linux')).toBe(8 * 60_000)
    expect(renderTimeLimitMs(2, 3, 'darwin')).toBe(4 * 60_000)
    expect(renderTimeLimitMs(1, 600, 'linux')).toBe(30 * 60_000)
    expect(renderTimeLimitMs(0, DURATION, 'linux')).toBe(renderTimeLimitMs(1, DURATION, 'linux'))
  })

  test('it encodes while it draws only in a leaf with room for it (6 GiB servers); the 4 GiB VM encodes after', () => {
    expect(streamsIn(VIDEO_ONE_MIB)).toBe(false)
    expect(streamsIn(VIDEO_STREAM_MIB)).toBe(true)
  })

  test('a failure says why', () => {
    expect(failureKind('took too long (the time limit, 645 s)')).toBe('too_long')
    expect(failureKind("out of memory (the render's cgroup limit)")).toBe('memory')
    expect(failureKind('hyperframes exit 1')).toBe('other')
    expect(failureKind(null)).toBe('other')
  })
})

describe('the server is the OOM killer\'s last choice', () => {
  test('heavy jobs run with a higher oom_score_adj than the server unit, which sets none (0)', () => {
    const unit = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'scripts', 'linux', 'systemd', 'server.service.in'), 'utf8')
    const set = /^OOMScoreAdjust=(-?\d+)/m.exec(unit)
    const server = set ? Number(set[1]) : 0
    expect(server).toBeLessThanOrEqual(0)
    for (const adj of [CONV_OOM_SCORE_ADJ, PRINT_OOM_SCORE_ADJ, VIDEO_OOM_SCORE_ADJ]) expect(adj).toBeGreaterThan(server)
    // the render and a print go before a conversion (the conversion is in a turn that waits for it)
    expect(VIDEO_OOM_SCORE_ADJ).toBeGreaterThanOrEqual(CONV_OOM_SCORE_ADJ)
  })
})
