// The text cache's background re-extraction (files/search.ts OfficeCache: what a search left to the background queue,
// upgradeOld, the semantic re-index) runs its converters below interactive work: tools/isolate.ts backgroundPrefix
// (Linux nice 10 + ionice best-effort 7, macOS taskpolicy -c utility) and a longer wall clock. A job that a person's
// grep joined before a converter started runs that converter at normal priority. A converter that a limit stopped (a
// background one waiting for the CPU on a busy Mac) leaves the document without text for a while, never with an empty
// text that would stand for "no text" until the file changes: it is tried again later, a few times.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKGROUND_WALL_FACTOR, backgroundPrefix, backgroundRun, inBackground, runIsolated } from '../../server/src/tools/isolate'
import { OFFICE_EXTRACT_PARALLEL, OFFICE_RETRY_FIRST_MS, OFFICE_RETRY_MAX, OfficeCache } from '../../server/src/files/search'
import { ConverterStopped } from '../../server/src/files/extract'
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
