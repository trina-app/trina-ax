// The text cache's background re-extraction (files/search.ts OfficeCache: what a search left to the background queue,
// upgradeOld, the semantic re-index) runs its converters below interactive work: tools/isolate.ts backgroundPrefix
// (Linux nice 10 + ionice best-effort 7, macOS taskpolicy -c utility) and a longer wall clock. A job that a person's
// grep joined before a converter started runs that converter at normal priority.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKGROUND_WALL_FACTOR, backgroundPrefix, backgroundRun, inBackground, runIsolated } from '../../server/src/tools/isolate'
import { OFFICE_EXTRACT_PARALLEL, OfficeCache } from '../../server/src/files/search'

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
