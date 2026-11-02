// The text cache's background re-extraction (files/search.ts OfficeCache: what a search left to the background queue,
// upgradeOld, the semantic re-index) runs its converters below interactive work: tools/isolate.ts backgroundPrefix
// (Linux nice 10 + ionice best-effort 7, macOS taskpolicy -c utility) and a longer wall clock. A job that a person's
// grep joined before a converter started runs that converter at normal priority. A converter that a limit stopped (a
// background one waiting for the CPU on a busy Mac) leaves the document without text for a while, never with an empty
// text that would stand for "no text" until the file changes: it is tried again later, a few times. Of the two office
// workers, background work takes at most one, and people go first among those that wait, until background work's turn:
// it never waits for ever behind people's work that keeps coming.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { BACKGROUND_WALL_FACTOR, backgroundPrefix, backgroundRun, inBackground, runIsolated } from '../../server/src/tools/isolate'
import { OFFICE_EXTRACT_PARALLEL, OFFICE_RETRY_FIRST_MS, OFFICE_RETRY_MAX, OfficeCache } from '../../server/src/files/search'
import { BACKGROUND_PASSED_MAX, BACKGROUND_WAIT_MS, BackgroundTurn, ConverterStopped, extractText, OFFICE_WORKERS_BACKGROUND_MAX, OFFICE_WORKERS_MAX, officeWorkerSlot, officeWorkersRecheck } from '../../server/src/files/extract'
import { ToolError } from '../../server/src/policy/errors'

const dirs: string[] = []
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p)); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const sleepBin = ['/bin/sleep', '/usr/bin/sleep'].find((p) => fs.existsSync(p))!
const unix = process.platform === 'darwin' || process.platform === 'linux'

describe('converter priority (tools/isolate.ts)', () => {
  test('the prefix per platform: system tools only, each execs the next in place', () => {
    const linux = backgroundPrefix('linux')
    if (fs.existsSync('/usr/bin/nice') || fs.existsSync('/bin/nice')) expect(linux.slice(0, 3)).toEqual([expect.stringMatching(/^\/(usr\/)?bin\/nice$/), '-n', '10'])
    const io = linux.findIndex((a) => a.endsWith('/ionice'))
    if (io >= 0) expect(linux.slice(io + 1)).toEqual(['-t', '-c', '2', '-n', '7'])
    if (fs.existsSync('/usr/sbin/taskpolicy')) expect(backgroundPrefix('darwin')).toEqual(['/usr/sbin/taskpolicy', '-c', 'utility'])
    expect(backgroundPrefix('win32')).toEqual([])
  })

  /** run `sleep <unique>` and read its priority from outside while it runs: macOS the scheduling priority (pri), Linux
   * the nice value */
  async function priorityOf(o: { background?: boolean; scope?: () => boolean }): Promise<number> {
    const arg = `0.${String(Math.floor(Math.random() * 1e6)).padStart(6, '1')}9`
    const start = () => runIsolated({ cmd: sleepBin, args: [arg], timeoutMs: 10_000, ...(o.background !== undefined ? { background: o.background } : {}) })
    const run = o.scope ? inBackground(o.scope, async () => { await Bun.sleep(1); return start() }) : start()
    let row: string | undefined
    for (let i = 0; i < 100 && !row; i++) {
      await Bun.sleep(10)
      row = Bun.spawnSync(['ps', '-A', '-o', 'pri=,ni=,args=']).stdout.toString().split('\n').find((l) => l.trim().endsWith(`sleep ${arg}`))
    }
    expect((await run).code).toBe(0)
    expect(row).toBeDefined()
    const [pri, ni] = row!.trim().split(/\s+/).map(Number) as [number, number]
    return process.platform === 'darwin' ? -pri : ni
  }
  test.skipIf(!unix)('a background run starts below a normal one, by flag or inside inBackground while low() holds', async () => {
    const normal = await priorityOf({})
    // larger is lower: macOS -pri (the utility clamp 20 against 31), Linux nice (10 above the server's)
    expect(await priorityOf({ background: true })).toBeGreaterThan(normal)
    expect(await priorityOf({ scope: () => true })).toBeGreaterThan(normal)
    expect(await priorityOf({ scope: () => false })).toBe(normal)
    expect(await priorityOf({ scope: () => true, background: false })).toBe(normal)
    if (process.platform === 'linux') expect(await priorityOf({ background: true })).toBe(Math.min(19, normal + 10))
  })
  test.skipIf(!unix)('a background run may take BACKGROUND_WALL_FACTOR times its time limit (it can wait for the CPU)', async () => {
    const fg = await runIsolated({ cmd: sleepBin, args: ['0.8'], timeoutMs: 400 })
    expect(fg.killed).toBe('timeout')
    expect(BACKGROUND_WALL_FACTOR).toBe(3)
    const bg = await runIsolated({ cmd: sleepBin, args: ['0.8'], timeoutMs: 400, background: true })
    expect(bg.killed).toBeNull()
    expect(bg.code).toBe(0)
  })
  test('outside inBackground nothing is background', async () => {
    expect(backgroundRun()).toBe(false)
    expect(await inBackground(() => true, async () => { await Bun.sleep(1); return backgroundRun() })).toBe(true)
    expect(backgroundRun()).toBe(false)
  })
})

describe('the text cache asks for background priority only for background jobs', () => {
  /** an OfficeCache whose extraction records, at each of its two converter starts, whether it runs as background
   * work; it waits for `gate` between the two */
  class Probe extends OfficeCache {
    seen = new Map<string, boolean[]>()
    gates = new Map<string, Promise<void>>()
    protected override async extract(rel: string): Promise<string> {
      const s: boolean[] = []
      this.seen.set(rel, s)
      s.push(backgroundRun())
      await this.gates.get(rel)
      s.push(backgroundRun())
      return 'text of ' + rel
    }
  }
  function setup(names: string[]) {
    const root = tmp('team-')
    fs.mkdirSync(path.join(root, 'shared'))
    for (const n of names) fs.writeFileSync(path.join(root, 'shared', n), 'bytes of ' + n)
    return new Probe(tmp('cache-'), { root, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
  }
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r }); return { p, open } }

  test('a background update runs as background work; a foreground update does not', async () => {
    const c = setup(['a.docx', 'b.docx'])
    await c.update('shared/a.docx', { background: true })
    await c.update('shared/b.docx')
    expect(c.seen.get('shared/a.docx')).toEqual([true, true])
    expect(c.seen.get('shared/b.docx')).toEqual([false, false])
  })
  test('a person joins a background job: converters that start after that run at normal priority', async () => {
    const busy = Array.from({ length: OFFICE_EXTRACT_PARALLEL }, (_, i) => `busy${i}.docx`)
    const c = setup([...busy, 'waiting.docx', 'running.docx'])
    // joined while it waits for a slot: it never runs as background work
    const hold = gate()
    for (const b of busy) c.gates.set('shared/' + b, hold.p)
    const running = busy.map((b) => c.update('shared/' + b))
    const queued = c.update('shared/waiting.docx', { background: true })
    await Bun.sleep(5)
    expect(c.seen.has('shared/waiting.docx')).toBe(false)
    const joined = c.update('shared/waiting.docx')
    hold.open()
    await Promise.all([...running, queued, joined])
    expect(c.seen.get('shared/waiting.docx')).toEqual([false, false])
    // joined between its two converters: the first ran as background work, the second does not
    const mid = gate()
    c.gates.set('shared/running.docx', mid.p)
    const bg = c.update('shared/running.docx', { background: true })
    await Bun.sleep(5)
    const fg = c.update('shared/running.docx')
    mid.open()
    await Promise.all([bg, fg])
    expect(c.seen.get('shared/running.docx')).toEqual([true, false])
  })
})

describe('the office workers: background work takes at most one, people go first (extract.ts officeWorkerSlot)', () => {
  const settle = () => Bun.sleep(5)
  /** every holder lets go after its test, also a test that failed: the workers are shared by the whole file */
  const held: (() => void)[] = []
  afterEach(() => { for (const finish of held.splice(0)) finish() })
  /** work that holds a worker until `finish`; `low` (and `behind`, default `low`): as background work (inBackground) */
  function holder(started: string[], name: string, low?: () => boolean, behind?: () => boolean) {
    let finish!: () => void
    const until = new Promise<void>((r) => { finish = r })
    held.push(finish)
    const work = () => officeWorkerSlot(async () => { started.push(name); await until })
    return { finish, done: low ? inBackground(low, work, behind) : work() }
  }
  const small = () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['total', 1200]]), 'S1')
    return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
  }

  test('background work takes one worker, the next waits for it; the other worker stays free for a person', async () => {
    expect(OFFICE_WORKERS_MAX).toBe(2)
    expect(OFFICE_WORKERS_BACKGROUND_MAX).toBe(1)
    const started: string[] = []
    const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => true)
    await settle()
    expect(started).toEqual(['b1'])
    const person = holder(started, 'person')
    await settle()
    expect(started).toEqual(['b1', 'person'])
    b1.finish()
    await settle()
    expect(started).toEqual(['b1', 'person', 'b2'])
    person.finish(); b2.finish()
    await Promise.all([b1.done, b2.done, person.done])
  })

  test('among those that wait a person goes first, also when background work came first; a free worker stays free while background work has one', async () => {
    const started: string[] = []
    const p1 = holder(started, 'p1'), p2 = holder(started, 'p2')
    const b1 = holder(started, 'b1', () => true)
    const p3 = holder(started, 'p3')
    await settle()
    expect(started).toEqual(['p1', 'p2'])
    p1.finish()
    await settle()
    expect(started).toEqual(['p1', 'p2', 'p3'])
    p2.finish()
    await settle()
    expect(started).toEqual(['p1', 'p2', 'p3', 'b1'])
    const b2 = holder(started, 'b2', () => true)
    p3.finish()
    await settle()
    // a worker is free, and it stays free
    expect(started).toHaveLength(4)
    b1.finish()
    await settle()
    expect(started.at(-1)).toBe('b2')
    b2.finish()
    await Promise.all([p1.done, p2.done, p3.done, b1.done, b2.done])
  })

  test('work that fails gives its worker back', async () => {
    const failing = () => officeWorkerSlot(async () => { throw new Error('no') })
    await expect(inBackground(() => true, failing)).rejects.toThrow('no')
    await expect(failing()).rejects.toThrow('no')
    const started: string[] = []
    const b = holder(started, 'b', () => true), p1 = holder(started, 'p1'), p2 = holder(started, 'p2')
    await settle()
    expect(started).toEqual(['b', 'p1'])
    b.finish(); p1.finish()
    await settle()
    expect(started).toEqual(['b', 'p1', 'p2'])
    p2.finish()
    await Promise.all([b.done, p1.done, p2.done])
  })

  test('background work that a person joined while it waited takes the free worker at once', async () => {
    const started: string[] = []
    let low = true
    const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => low)
    await settle()
    expect(started).toEqual(['b1'])
    low = false
    officeWorkersRecheck()
    await settle()
    expect(started).toEqual(['b1', 'b2'])
    b1.finish(); b2.finish()
    await Promise.all([b1.done, b2.done])
  })

  test('a text cache job that waits for a worker: a person who joins it moves it up', async () => {
    const started: string[] = []
    const finish = new Map<string, () => void>()
    class Cache extends OfficeCache {
      protected override extract(rel: string): Promise<string> {
        return officeWorkerSlot(async () => {
          started.push(rel)
          await new Promise<void>((r) => { finish.set(rel, r); held.push(r) })
          return 'text of ' + rel
        })
      }
    }
    const root = tmp('team-')
    fs.mkdirSync(path.join(root, 'shared'))
    for (const n of ['a.xlsx', 'b.xlsx']) fs.writeFileSync(path.join(root, 'shared', n), 'bytes of ' + n)
    const c = new Cache(tmp('cache-'), { root, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
    const a = c.update('shared/a.xlsx', { background: true }), b = c.update('shared/b.xlsx', { background: true })
    await settle()
    expect(started).toEqual(['shared/a.xlsx'])
    const joined = c.update('shared/b.xlsx')
    await settle()
    expect(started).toEqual(['shared/a.xlsx', 'shared/b.xlsx'])
    for (const f of finish.values()) f()
    await Promise.all([a, b, joined])
  })

  test('a person joins one of several waiting background jobs: that one takes the free worker, the others keep their order', async () => {
    const started: string[] = []
    let low = true
    const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => true), b3 = holder(started, 'b3', () => low), b4 = holder(started, 'b4', () => true)
    await settle()
    expect(started).toEqual(['b1'])
    low = false
    officeWorkersRecheck()
    await settle()
    expect(started).toEqual(['b1', 'b3'])
    b1.finish()
    await settle()
    expect(started).toEqual(['b1', 'b3', 'b2'])
    b2.finish()
    await settle()
    expect(started).toEqual(['b1', 'b3', 'b2', 'b4'])
    b3.finish(); b4.finish()
    await Promise.all([b1.done, b2.done, b3.done, b4.done])
  })

  test('a background worker that a person joins while it runs still gives its place back: the next background job starts', async () => {
    const started: string[] = []
    let low = true
    const b1 = holder(started, 'b1', () => low)
    await settle()
    low = false
    const b2 = holder(started, 'b2', () => true)
    await settle()
    expect(started).toEqual(['b1'])
    b1.finish()
    await settle()
    expect(started).toEqual(['b1', 'b2'])
    b2.finish()
    await Promise.all([b1.done, b2.done])
  })

  /** `loops` of people's work back to back, one job each. How many of their jobs ended after `lows` background jobs asked
   * for a worker and before each of them started; -1: it had not started when people's work stopped */
  async function amongPeople(loops: number, lows: number) {
    let done = 0, stop = false
    const person = async () => { while (!stop) { await officeWorkerSlot(() => new Promise<void>((r) => setImmediate(r))); done++ } }
    const people = Array.from({ length: loops }, person)
    await Bun.sleep(1)
    const from = done
    const at: number[] = Array.from({ length: lows }, () => -1)
    const background = at.map((_, i) => inBackground(() => true, () => officeWorkerSlot(async () => { at[i] = done - from })))
    const all = Promise.all(background)
    await Promise.race([all, Bun.sleep(3000)])
    stop = true
    await Promise.all(people)
    await all
    return at
  }

  test.each([3, 8])('background work starts while %i loops of people\'s work keep coming, after at most its turn', async (loops) => {
    const [at] = await amongPeople(loops, 1)
    expect(at).toBeGreaterThanOrEqual(0)
    // the jobs already in line when it came, then BACKGROUND_PASSED_MAX, then those running when its turn came
    expect(at!).toBeLessThanOrEqual(BACKGROUND_PASSED_MAX + loops + OFFICE_WORKERS_MAX)
  })

  test('the next background job waits its own turn, so people\'s work goes on between them', async () => {
    const [first, second, third] = (await amongPeople(3, 3)).sort((a, b) => a - b)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second! - first!).toBeGreaterThanOrEqual(BACKGROUND_PASSED_MAX - OFFICE_WORKERS_MAX)
    expect(third! - second!).toBeGreaterThanOrEqual(BACKGROUND_PASSED_MAX - OFFICE_WORKERS_MAX)
  })

  test('long jobs of people: after BACKGROUND_WAIT_MS the next free worker is background work\'s, ahead of people in line', async () => {
    const started: string[] = []
    const t0 = Date.now()
    try {
      const p1 = holder(started, 'p1'), p2 = holder(started, 'p2'), b = holder(started, 'b', () => true), p3 = holder(started, 'p3')
      await settle()
      expect(started).toEqual(['p1', 'p2'])
      setSystemTime(new Date(t0 + BACKGROUND_WAIT_MS - 1000))
      p1.finish()
      await settle()
      // not yet: people first
      expect(started).toEqual(['p1', 'p2', 'p3'])
      const p4 = holder(started, 'p4')
      setSystemTime(new Date(t0 + BACKGROUND_WAIT_MS + 1000))
      p2.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'p3', 'b'])
      // it takes the one worker background work may have, and only that: the worker after it goes to people again
      p3.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'p3', 'b', 'p4'])
      b.finish(); p4.finish()
      await Promise.all([p1.done, p2.done, p3.done, p4.done, b.done])
    } finally { setSystemTime() }
  })

  test('a person joins the background job whose turn it was: the next background job waits from its own start', async () => {
    const started: string[] = []
    const t0 = Date.now()
    try {
      let low = true
      const p1 = holder(started, 'p1'), p2 = holder(started, 'p2'), b1 = holder(started, 'b1', () => low)
      await settle()
      setSystemTime(new Date(t0 + BACKGROUND_WAIT_MS + 1000))
      low = false
      officeWorkersRecheck()
      p1.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'b1'])
      const b2 = holder(started, 'b2', () => true), p3 = holder(started, 'p3')
      await settle()
      p2.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'b1', 'p3'])
      p3.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'b1', 'p3', 'b2'])
      b1.finish(); b2.finish()
      await Promise.all([p1.done, p2.done, p3.done, b1.done, b2.done])
    } finally { setSystemTime() }
  })

  test('people going first leaves background work in its own order', async () => {
    const started: string[] = []
    const p1 = holder(started, 'p1'), p2 = holder(started, 'p2')
    const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => true), p3 = holder(started, 'p3')
    await settle()
    p1.finish()
    await settle()
    expect(started).toEqual(['p1', 'p2', 'p3'])
    p2.finish()
    await settle()
    expect(started).toEqual(['p1', 'p2', 'p3', 'b1'])
    b1.finish()
    await settle()
    expect(started).toEqual(['p1', 'p2', 'p3', 'b1', 'b2'])
    p3.finish(); b2.finish()
    await Promise.all([p1.done, p2.done, p3.done, b1.done, b2.done])
    // behind a running background job too
    const seen: string[] = []
    const b3 = holder(seen, 'b3', () => true), p4 = holder(seen, 'p4')
    const b4 = holder(seen, 'b4', () => true), b5 = holder(seen, 'b5', () => true), p5 = holder(seen, 'p5')
    await settle()
    expect(seen).toEqual(['b3', 'p4'])
    p4.finish()
    await settle()
    expect(seen).toEqual(['b3', 'p4', 'p5'])
    b3.finish()
    await settle()
    expect(seen).toEqual(['b3', 'p4', 'p5', 'b4'])
    b4.finish()
    await settle()
    expect(seen).toEqual(['b3', 'p4', 'p5', 'b4', 'b5'])
    p5.finish(); b5.finish()
    await Promise.all([b3.done, b4.done, b5.done, p4.done, p5.done])
  })

  test('background work that asks just as a worker ends does not go ahead of people in line', async () => {
    // the moment between a job's end and the start of the person it woke is a few microtasks long: every one is tried
    for (let hops = 0; hops < 30; hops++) {
      const started: string[] = []
      const p1 = holder(started, 'p1'), p2 = holder(started, 'p2'), h1 = holder(started, 'h1'), h2 = holder(started, 'h2')
      await settle()
      p1.finish()
      for (let i = 0; i < hops; i++) await null
      const b = holder(started, 'b', () => true)
      await settle()
      expect(started).toEqual(['p1', 'p2', 'h1'])
      p2.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'h1', 'h2'])
      h1.finish(); h2.finish(); b.finish()
      await Promise.all([p1.done, p2.done, h1.done, h2.done, b.done])
    }
  })

  test('two workers end at once on background work\'s turn: one job takes a worker, the first person in line the other', async () => {
    const started: string[] = []
    const t0 = Date.now()
    try {
      const p1 = holder(started, 'p1'), p2 = holder(started, 'p2')
      const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => true), p3 = holder(started, 'p3')
      await settle()
      setSystemTime(new Date(t0 + BACKGROUND_WAIT_MS + 1000))
      p1.finish(); p2.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'b1', 'p3'])
      b1.finish(); p3.finish()
      await settle()
      expect(started).toEqual(['p1', 'p2', 'b1', 'p3', 'b2'])
      b2.finish()
      await Promise.all([p1.done, p2.done, p3.done, b1.done, b2.done])
    } finally { setSystemTime() }
  })

  test('its turn never gives background work a second worker', async () => {
    const started: string[] = []
    const t0 = Date.now()
    try {
      const b1 = holder(started, 'b1', () => true), p = holder(started, 'p'), b2 = holder(started, 'b2', () => true), b3 = holder(started, 'b3', () => true), q = holder(started, 'q')
      await settle()
      expect(started).toEqual(['b1', 'p'])
      setSystemTime(new Date(t0 + 10 * BACKGROUND_WAIT_MS))
      p.finish()
      await settle()
      expect(started).toEqual(['b1', 'p', 'q'])
      b1.finish()
      await settle()
      // b1 has ended: a new turn starts for b2 (not woken before, so still first in line), with a free worker it may take
      expect(started).toEqual(['b1', 'p', 'q', 'b2'])
      b2.finish()
      await settle()
      expect(started).toEqual(['b1', 'p', 'q', 'b2', 'b3'])
      b3.finish(); q.finish()
      await Promise.all([b1.done, b2.done, b3.done, p.done, q.done])
    } finally { setSystemTime() }
  })

  test('BackgroundTurn: by people\'s jobs or by time; not while nothing waits; start over', () => {
    let now = 1000
    const t = new BackgroundTurn(() => now)
    expect([BACKGROUND_PASSED_MAX, BACKGROUND_WAIT_MS]).toEqual([8, 30_000])
    expect(t.due()).toBe(false)
    for (let i = 0; i < BACKGROUND_PASSED_MAX + 1; i++) t.pass()
    now += BACKGROUND_WAIT_MS
    expect(t.due()).toBe(false)
    // people's jobs before it began to wait do not count
    t.wait()
    expect(t.due()).toBe(false)
    for (let i = 0; i < BACKGROUND_PASSED_MAX - 1; i++) t.pass()
    expect(t.due()).toBe(false)
    t.pass()
    expect(t.due()).toBe(true)
    t.restart(true)
    expect(t.due()).toBe(false)
    now += BACKGROUND_WAIT_MS - 1
    t.wait()
    expect(t.due()).toBe(false)
    now += 1
    expect(t.due()).toBe(true)
  })

  test('work at normal priority that nobody asked for (a last try) still waits as background work', async () => {
    const started: string[] = []
    const b1 = holder(started, 'b1', () => true)
    const last = holder(started, 'last', () => false, () => true)
    await settle()
    expect(started).toEqual(['b1'])
    const person = holder(started, 'person')
    await settle()
    expect(started).toEqual(['b1', 'person'])
    b1.finish()
    await settle()
    expect(started).toEqual(['b1', 'person', 'last'])
    person.finish(); last.finish()
    await Promise.all([b1.done, last.done, person.done])
  })

  test('a text cache job on its last try runs at normal priority and still gives way to a person', async () => {
    const started: string[] = []
    let priority: boolean | undefined
    class Cache extends OfficeCache {
      clock = 1_000_000
      protected override now() { return this.clock }
      protected override extract(rel: string, _bytes: Buffer, o: { lastTry?: boolean } = {}): Promise<string> {
        return officeWorkerSlot(async () => {
          if (!o.lastTry) throw new ConverterStopped('could not convert the file to text (pandoc: took too long)')
          priority = backgroundRun()
          started.push(rel)
          await new Promise<void>((r) => held.push(r))
          return 'text of ' + rel
        })
      }
    }
    const root = tmp('team-')
    fs.mkdirSync(path.join(root, 'shared'))
    const rel = 'shared/slow.xlsx'
    fs.writeFileSync(path.join(root, rel), 'bytes')
    const c = new Cache(tmp('cache-'), { root, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
    await c.update(rel, { background: true })
    c.clock += OFFICE_RETRY_FIRST_MS
    await c.update(rel, { background: true })
    c.clock += 4 * OFFICE_RETRY_FIRST_MS
    const other = holder(started, 'other', () => true)
    const last = c.update(rel, { background: true })
    await settle()
    expect(started).toEqual(['other'])
    const person = holder(started, 'person')
    await settle()
    expect(started).toEqual(['other', 'person'])
    other.finish()
    await settle()
    expect(started).toEqual(['other', 'person', rel])
    expect(priority).toBe(false)
    person.finish()
    for (const finish of held.splice(0)) finish()
    await Promise.all([other.done, person.done, last])
  })

  test.skipIf(!unix)('a real read gets its text while one background job has a worker and another waits for one', async () => {
    const started: string[] = []
    const b1 = holder(started, 'b1', () => true), b2 = holder(started, 'b2', () => true)
    expect(await extractText('small.xlsx', small(), { pandoc: null, pdftotext: null })).toContain('total\t1200')
    expect(started).toEqual(['b1'])
    b1.finish(); b2.finish()
    await Promise.all([b1.done, b2.done])
  }, 15_000)
})

describe('the text cache\'s line: foreground jobs first, but background work gets its turn (OfficeCache.slot)', () => {
  /** an OfficeCache whose clock a test moves; an extraction takes a moment, or until `gates` lets it go */
  class Line extends OfficeCache {
    clock = 1_000_000
    started: string[] = []
    gates = new Map<string, () => void>()
    held = false
    protected override now() { return this.clock }
    protected override async extract(rel: string): Promise<string> {
      this.started.push(rel)
      if (this.held) await new Promise<void>((r) => this.gates.set(rel, r))
      else await new Promise<void>((r) => setImmediate(r))
      return 'text of ' + rel
    }
  }
  function setup(names: string[]) {
    const root = tmp('team-')
    fs.mkdirSync(path.join(root, 'shared'))
    for (const n of names) fs.writeFileSync(path.join(root, 'shared', n), 'bytes of ' + n)
    return new Line(tmp('cache-'), { root, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
  }

  test.each([OFFICE_EXTRACT_PARALLEL + 2, 3 * OFFICE_EXTRACT_PARALLEL])('a background job is done while %i loops of foreground jobs keep coming', async (loops) => {
    const names = Array.from({ length: loops }, (_, i) => `p${i}.docx`)
    const c = setup([...names, 'bg.docx'])
    let done = 0, stop = false
    const person = async (n: string) => {
      const rel = 'shared/' + n
      while (!stop) { await c.update(rel); done++; fs.rmSync(c.cachePath(rel), { force: true }) }
    }
    const people = names.map(person)
    await Bun.sleep(1)
    let at = -1
    const from = done
    const bg = c.update('shared/bg.docx', { background: true }).then(() => { at = done - from })
    await Promise.race([bg, Bun.sleep(3000)])
    stop = true
    await Promise.all(people)
    await bg
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThanOrEqual(BACKGROUND_PASSED_MAX + 2 * loops)
  })

  test('long foreground jobs: after BACKGROUND_WAIT_MS the next free slot is the background job\'s', async () => {
    const busy = Array.from({ length: OFFICE_EXTRACT_PARALLEL }, (_, i) => `busy${i}.docx`)
    const c = setup([...busy, 'next.docx', 'bg.docx'])
    c.held = true
    const running = busy.map((b) => c.update('shared/' + b))
    await Bun.sleep(5)
    const bg = c.update('shared/bg.docx', { background: true })
    const next = c.update('shared/next.docx')
    await Bun.sleep(5)
    c.clock += BACKGROUND_WAIT_MS
    c.gates.get('shared/busy0.docx')!()
    await Bun.sleep(5)
    expect(c.started.slice(busy.length)).toEqual(['shared/bg.docx'])
    c.gates.get('shared/busy1.docx')!()
    await Bun.sleep(5)
    expect(c.started.slice(busy.length)).toEqual(['shared/bg.docx', 'shared/next.docx'])
    for (const open of c.gates.values()) open()
    await Promise.all([...running, bg, next])
  })

  test('two slots end at once on background work\'s turn: one job takes a slot, the first foreground job in line the other', async () => {
    const busy = Array.from({ length: OFFICE_EXTRACT_PARALLEL }, (_, i) => `busy${i}.docx`)
    const c = setup([...busy, 'next.docx', 'bg1.docx', 'bg2.docx'])
    c.held = true
    const running = busy.map((b) => c.update('shared/' + b))
    await Bun.sleep(5)
    const low = ['bg1', 'bg2'].map((b) => c.update(`shared/${b}.docx`, { background: true }))
    const next = c.update('shared/next.docx')
    await Bun.sleep(5)
    c.clock += BACKGROUND_WAIT_MS
    c.gates.get('shared/busy0.docx')!(); c.gates.get('shared/busy1.docx')!()
    await Bun.sleep(5)
    expect(c.started.slice(busy.length)).toEqual(['shared/bg1.docx', 'shared/next.docx'])
    c.held = false
    for (const open of c.gates.values()) open()
    await Promise.all([...running, ...low, next])
  })

  test('a person joins the job whose turn it was: the next background job waits from its own start', async () => {
    const busy = Array.from({ length: OFFICE_EXTRACT_PARALLEL }, (_, i) => `busy${i}.docx`)
    const c = setup([...busy, 'next.docx', 'bg1.docx', 'bg2.docx'])
    c.held = true
    const running = busy.map((b) => c.update('shared/' + b))
    await Bun.sleep(5)
    const first = c.update('shared/bg1.docx', { background: true })
    await Bun.sleep(5)
    c.clock += BACKGROUND_WAIT_MS
    const joined = c.update('shared/bg1.docx')
    const second = c.update('shared/bg2.docx', { background: true }), next = c.update('shared/next.docx')
    await Bun.sleep(5)
    c.gates.get('shared/busy0.docx')!()
    await Bun.sleep(5)
    expect(c.started.slice(busy.length)).toEqual(['shared/bg1.docx'])
    c.gates.get('shared/busy1.docx')!()
    await Bun.sleep(5)
    expect(c.started.slice(busy.length)).toEqual(['shared/bg1.docx', 'shared/next.docx'])
    c.held = false
    for (const open of c.gates.values()) open()
    await Promise.all([...running, first, joined, second, next])
  })
})

describe('a converter stopped by a limit: no text is kept, the file is tried again later', () => {
  /** an OfficeCache whose clock a test moves and whose extraction gives `result()` (a throw: the converter failed),
   * recording for each run whether it ran as background work and whether it was the last try */
  class Stopping extends OfficeCache {
    clock = 1_000_000
    runs: { background: boolean; lastTry: boolean }[] = []
    result: () => string = () => { throw new ConverterStopped('could not convert the file to text (pandoc: took too long)') }
    protected override now() { return this.clock }
    protected override async extract(_rel: string, _bytes: Buffer, o: { lastTry?: boolean } = {}): Promise<string> {
      this.runs.push({ background: backgroundRun(), lastTry: !!o.lastTry })
      await Bun.sleep(1)
      return this.result()
    }
  }
  function setup() {
    const root = tmp('team-')
    fs.mkdirSync(path.join(root, 'shared'))
    const rel = 'shared/report.docx'
    const abs = path.join(root, rel)
    fs.writeFileSync(abs, 'docx bytes')
    const c = new Stopping(tmp('cache-'), { root, caseInsensitive: false } as never, { pandoc: null, pdftotext: null })
    return { c, rel, abs, st: () => fs.lstatSync(abs) }
  }
  const text = (c: OfficeCache, rel: string) => (fs.existsSync(c.cachePath(rel)) ? fs.readFileSync(c.cachePath(rel), 'utf8') : null)

  test('a background timeout keeps no text; until its retry time nobody tries it; then it is tried again and keeps the text', async () => {
    const { c, rel, st } = setup()
    await c.update(rel, { background: true })
    expect(text(c, rel)).toBeNull()
    expect(c.fresh(rel, st())).toBe(false)
    expect(c.waitsForRetry(rel, st())).toBe(true)
    // a search's foreground extraction, the queue, an upload's re-extraction: not before the retry time
    await c.update(rel)
    await c.update(rel, { background: true })
    expect(c.runs).toHaveLength(1)
    c.clock += OFFICE_RETRY_FIRST_MS - 1
    expect(c.waitsForRetry(rel, st())).toBe(true)
    c.clock += 1
    expect(c.waitsForRetry(rel, st())).toBe(false)
    c.result = () => 'the report text'
    await c.update(rel, { background: true })
    // a retry before the last one still gives way to people's work
    expect(c.runs).toEqual([{ background: true, lastTry: false }, { background: true, lastTry: false }])
    expect(text(c, rel)).toBe('the report text')
    expect(c.fresh(rel, st())).toBe(true)
    expect(c.waitsForRetry(rel, st())).toBe(false)
  })

  test('always stopped: each wait is longer; after OFFICE_RETRY_MAX tries "no text" is kept for this version; a changed file starts again', async () => {
    const { c, rel, abs, st } = setup()
    expect(OFFICE_RETRY_MAX).toBe(3)
    await c.update(rel, { background: true })
    c.clock += OFFICE_RETRY_FIRST_MS
    await c.update(rel, { background: true })
    expect(text(c, rel)).toBeNull()
    // the second wait is four times the first
    c.clock += OFFICE_RETRY_FIRST_MS
    expect(c.waitsForRetry(rel, st())).toBe(true)
    await c.update(rel)
    expect(c.runs).toHaveLength(2)
    c.clock += 3 * OFFICE_RETRY_FIRST_MS
    expect(c.waitsForRetry(rel, st())).toBe(false)
    // the last try runs like a foreground one (normal priority and limits), and a part that a converter was stopped
    // on would give its labelled line instead of failing the text
    await c.update(rel, { background: true })
    expect(c.runs).toEqual([{ background: true, lastTry: false }, { background: true, lastTry: false }, { background: false, lastTry: true }])
    expect(text(c, rel)).toBe('')
    expect(c.fresh(rel, st())).toBe(true)
    expect(c.waitsForRetry(rel, st())).toBe(false)
    c.clock += 100 * OFFICE_RETRY_FIRST_MS
    await c.update(rel, { background: true })
    expect(c.runs).toHaveLength(3)
    // the file changes: a new version, tried again from the start (at the caller's priority)
    fs.writeFileSync(abs, 'docx bytes, edited')
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000))
    await c.update(rel, { background: true })
    expect(c.runs.at(-1)).toEqual({ background: true, lastTry: false })
    expect(c.waitsForRetry(rel, st())).toBe(true)
  })

  test('a real "no text" is kept at once: an empty result, a damaged file (a converter that answered)', async () => {
    for (const result of [() => '', () => { throw new ToolError('could not convert the file to text (pandoc: Unknown archive)') }]) {
      const { c, rel, st } = setup()
      c.result = result
      await c.update(rel, { background: true })
      expect(text(c, rel)).toBe('')
      expect(c.fresh(rel, st())).toBe(true)
      expect(c.waitsForRetry(rel, st())).toBe(false)
      await c.update(rel, { background: true })
      expect(c.runs).toHaveLength(1)
    }
  })

  test('a foreground extraction that is stopped (a grep on a busy server, an upload) waits for its retry the same way', async () => {
    const { c, rel, st } = setup()
    await c.update(rel)
    expect(c.runs).toEqual([{ background: false, lastTry: false }])
    expect(text(c, rel)).toBeNull()
    expect(c.waitsForRetry(rel, st())).toBe(true)
  })

  test('the older text of an earlier version is not used meanwhile (grep and search read only fresh text)', async () => {
    const { c, rel, abs, st } = setup()
    c.result = () => 'old version text'
    await c.update(rel)
    fs.writeFileSync(abs, 'docx bytes, redacted')
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000))
    c.result = () => { throw new ConverterStopped('could not convert the file to text (pandoc: took too long)') }
    await c.update(rel, { background: true })
    expect(c.fresh(rel, st())).toBe(false)
    expect(c.waitsForRetry(rel, st())).toBe(true)
  })

  const rg = Bun.which('rg')
  test.skipIf(!rg)('grep counts a waiting file as retryLater and does not extract it; after its time a grep extracts it', async () => {
    const { c, rel, st } = setup()
    const filter = () => st()
    const first = await c.refresh(rg!, ['shared'], [], filter, { budget: 8 })
    expect(first).toMatchObject({ pending: 0, notQueued: 0, retryLater: 1 })
    expect(c.runs).toHaveLength(1)
    // the content search (budget 0) and the AI's grep: not queued, not extracted, said so
    expect(await c.refresh(rg!, ['shared'], [], filter, { budget: 0 })).toMatchObject({ pending: 0, notQueued: 0, retryLater: 1 })
    expect(await c.refresh(rg!, ['shared'], [], filter, { budget: 8 })).toMatchObject({ pending: 0, retryLater: 1 })
    await c.idle()
    expect(c.runs).toHaveLength(1)
    c.clock += OFFICE_RETRY_FIRST_MS
    c.result = () => 'found at last'
    expect(await c.refresh(rg!, ['shared'], [], filter, { budget: 8 })).toMatchObject({ pending: 0, notQueued: 0, retryLater: 0 })
    expect(text(c, rel)).toBe('found at last')
  })

  // the converters' own failures, through the real extraction: a converter killed with SIGKILL (the converter cgroup's
  // memory.max, the system short of memory) is a ConverterStopped; one that crashes, hits its CPU-time limit or answers
  // with an error is not (the same at any priority). A pandoc run with the slide and heading marks that is stopped is
  // not run again without them for the text cache (its text would lack the labels); a read still is. Run in a child
  // process without the sandbox (MYCEL_ISOLATION=none, read once per process), so shell scripts can stand for them.
  test.skipIf(!unix)('a converter killed with SIGKILL is "stopped" (tried again); a crash, the CPU limit or an error is not', async () => {
    const W = tmp('stopped-')
    const kill = path.join(W, 'kill-pdftotext'), fail = path.join(W, 'fail-pdftotext')
    const segv = path.join(W, 'segv-pdftotext'), xcpu = path.join(W, 'xcpu-pdftotext'), pandoc = path.join(W, 'pandoc')
    fs.writeFileSync(kill, '#!/bin/sh\nkill -9 $$\n', { mode: 0o755 })
    fs.writeFileSync(segv, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o755 })
    fs.writeFileSync(xcpu, '#!/bin/sh\nkill -XCPU $$\n', { mode: 0o755 })
    fs.writeFileSync(fail, '#!/bin/sh\necho "Syntax Error: damaged" >&2\nexit 1\n', { mode: 0o755 })
    // killed when it is given the marks filter (-L); without it, plain text
    fs.writeFileSync(pandoc, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-L" ] && kill -9 $$; done\ncat >/dev/null\necho "body text without labels"\n', { mode: 0o755 })
    const root = path.join(W, 'team')
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(root, 'shared', 'scan.pdf'), '%PDF-1.4 not really')
    const script = path.join(W, 'probe.ts')
    fs.writeFileSync(script, `
      import fs from 'node:fs'
      import { ConverterStopped, extractText } from ${JSON.stringify(path.resolve(import.meta.dir, '../../server/src/files/extract'))}
      import { OfficeCache } from ${JSON.stringify(path.resolve(import.meta.dir, '../../server/src/files/search'))}
      const out: Record<string, unknown> = {}
      for (const [k, bin] of Object.entries({ kill: ${JSON.stringify(kill)}, segv: ${JSON.stringify(segv)}, xcpu: ${JSON.stringify(xcpu)}, fail: ${JSON.stringify(fail)} })) {
        try { await extractText('a.pdf', Buffer.from('%PDF-1.4'), { pandoc: null, pdftotext: bin }); out[k] = 'text' }
        catch (e) { out[k] = e instanceof ConverterStopped ? 'stopped' : (e as Error).message }
      }
      for (const [k, strict] of [['pandocCache', true], ['pandocRead', false]] as const) {
        try { out[k] = await extractText('a.odt', Buffer.from('odt bytes'), { pandoc: ${JSON.stringify(pandoc)}, pdftotext: null, stoppedPartFails: strict }) }
        catch (e) { out[k] = e instanceof ConverterStopped ? 'stopped' : (e as Error).message }
      }
      const c = new OfficeCache(${JSON.stringify(path.join(W, 'cache'))}, { root: ${JSON.stringify(root)}, caseInsensitive: false } as never, { pandoc: null, pdftotext: ${JSON.stringify(kill)} })
      await c.update('shared/scan.pdf', { background: true })
      out.cached = fs.existsSync(c.cachePath('shared/scan.pdf'))
      out.waits = c.waitsForRetry('shared/scan.pdf', fs.lstatSync(${JSON.stringify(path.join(root, 'shared', 'scan.pdf'))}))
      console.log(JSON.stringify(out))
    `)
    const p = Bun.spawnSync([process.execPath, script], { env: { ...process.env, MYCEL_ISOLATION: 'none' }, stderr: 'pipe' })
    expect(p.exitCode).toBe(0)
    const out = JSON.parse(p.stdout.toString().trim().split('\n').at(-1)!)
    expect(out.kill).toBe('stopped')
    for (const k of ['segv', 'xcpu']) expect(out[k]).toMatch(/^could not convert the file to text \((segv|xcpu)-pdftotext: exit 1(39|52)\)$/)
    expect(out.fail).toContain('could not convert the file to text (fail-pdftotext: Syntax Error: damaged)')
    expect(out.pandocCache).toBe('stopped')
    expect(out.pandocRead).toContain('body text without labels')
    expect(out).toMatchObject({ cached: false, waits: true })
  }, 30_000)
})
