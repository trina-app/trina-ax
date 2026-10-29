// Resource limits of the grep core (server/src/files/search.ts) that the file screen's content search (R2-ETC-02)
// depends on: ripgrep records have a size cap (a long line never fills the server memory), office extraction keeps
// the deadline of the search, the background extraction is one queue with a fixed number of workers, and a file
// whose extraction fails does not keep its old text in the cache.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OFFICE_EXTRACT_PARALLEL, OFFICE_QUEUE_PER_OWNER, OfficeCache, RG_BASE, runRg } from '../../server/src/files/search'

const rg = Bun.which('rg')
const tools = { pandoc: 'pandoc', pdftotext: 'pdftotext', ocr: null } as never
const dirs: string[] = []
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p)); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An OfficeCache whose text extraction is a fake: it waits `ms`, counts the calls and returns fixed text. */
class FakeCache extends OfficeCache {
  calls = new Map<string, number>()
  running = 0
  maxActive = 0
  constructor(dir: string, root: string, private ms: number) { super(dir, { root } as never, tools) }
  protected override async extract(rel: string): Promise<string> {
    this.calls.set(rel, (this.calls.get(rel) ?? 0) + 1)
    this.running++; this.maxActive = Math.max(this.maxActive, this.running)
    try { await sleep(this.ms); return 'text of ' + rel } finally { this.running-- }
  }
}

function team(n: number) {
  const root = tmp('team-')
  fs.mkdirSync(path.join(root, 'shared'))
  const rels = Array.from({ length: n }, (_, i) => `shared/doc${String(i).padStart(2, '0')}.docx`)
  for (const r of rels) fs.writeFileSync(path.join(root, r), 'not really a docx ' + r)
  return { root, rels, filter: (rel: string) => fs.lstatSync(path.join(root, rel)) }
}

describe.skipIf(!rg)('ripgrep records', () => {
  test('a record longer than the cap never reaches the handler (a 5 MB line, --json)', async () => {
    const dir = tmp('longline-')
    fs.writeFileSync(path.join(dir, 'long.json'), 'x'.repeat(5 * 1024 * 1024) + ' QA-LONG-NEEDLE ' + 'y'.repeat(1000) + '\n')
    fs.writeFileSync(path.join(dir, 'short.txt'), 'a short QA-LONG-NEEDLE line\n')
    const cap = 64 * 1024
    let longest = 0
    const recs: string[] = []
    const r = await runRg(rg!, ['--json', '-F', ...RG_BASE, '-e', 'QA-LONG-NEEDLE', '--', '.'], dir, '\n', (rec) => { longest = Math.max(longest, rec.length); recs.push(rec) }, 20_000, { maxRecordChars: cap })
    expect(longest).toBeLessThanOrEqual(cap)
    expect(r.skipped).toBeGreaterThanOrEqual(1)
    expect(recs.some((x) => x.includes('a short QA-LONG-NEEDLE line'))).toBe(true)
  })
})

describe.skipIf(!rg)('office text cache', () => {
  test('refresh keeps the deadline: slow extraction is left to the background and counted as pending', async () => {
    const t = team(10)
    const c = new FakeCache(tmp('cache-'), t.root, 1500)
    const t0 = Date.now()
    const r = await c.refresh(rg!, ['shared'], [], t.filter, { budget: 8, deadline: Date.now() + 200 })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r.timedOut).toBe(true)
    expect(r.pending).toBe(10)
    // the work goes on in the background, each file once
    await c.idle()
    expect([...c.calls.values()].every((n) => n === 1)).toBe(true)
    expect(c.calls.size).toBe(10)
  }, 30_000)

  test('background extraction is one queue: many searches extract each file once, with a fixed number of workers', async () => {
    const t = team(20)
    const c = new FakeCache(tmp('cache-'), t.root, 30)
    for (let i = 0; i < 6; i++) await c.refresh(rg!, ['shared'], [], t.filter, { budget: 1 })
    await c.idle()
    expect([...c.calls.keys()].sort()).toEqual(t.rels)
    expect([...c.calls.values()].every((n) => n === 1)).toBe(true)
    expect(c.maxActive).toBeLessThanOrEqual(OFFICE_EXTRACT_PARALLEL)
    for (const r of t.rels) expect(c.fresh(r, t.filter(r))).toBe(true)
  })

  test('a file that cannot be read again drops its old text and is not tried again until it changes', async () => {
    const t = team(1)
    const rel = t.rels[0]!
    const abs = path.join(t.root, rel)
    const c = new FakeCache(tmp('cache-'), t.root, 1)
    await c.update(rel)
    expect(fs.readFileSync(c.cachePath(rel), 'utf8')).toBe('text of ' + rel)
    // the file changes (a redaction) and the server cannot read it any more (as a file larger than readMaxBytes)
    fs.writeFileSync(abs, 'redacted')
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000))
    fs.chmodSync(abs, 0o000)
    try {
      await c.update(rel).catch(() => {})
      expect(fs.existsSync(c.cachePath(rel)) ? fs.readFileSync(c.cachePath(rel), 'utf8') : '').toBe('')
      // the failure is remembered for this version of the file, so the next search does not try it again
      expect(c.fresh(rel, t.filter(rel))).toBe(true)
      expect((await c.refresh(rg!, ['shared'], [], t.filter, { budget: 8 })).pending).toBe(0)
      expect(c.calls.get(rel)).toBe(1)
    } finally { fs.chmodSync(abs, 0o644) }
  })
})

/** An OfficeCache whose extraction waits for a gate per file and records the start order. */
class GatedCache extends OfficeCache {
  order: string[] = []
  gates = new Map<string, () => void>()
  constructor(dir: string, root: string) { super(dir, { root } as never, tools) }
  protected override async extract(rel: string): Promise<string> {
    this.order.push(rel)
    await new Promise<void>((r) => this.gates.set(rel, r))
    return 'text of ' + rel
  }
  open(rel: string) { this.gates.get(rel)?.(); this.gates.delete(rel) }
  async openAll() { while (this.queued() > 0 || this.gates.size) { for (const r of [...this.gates.keys()]) this.open(r); await sleep(5) } await this.idle() }
}

function people(counts: Record<string, number>) {
  const root = tmp('team-')
  const rels: Record<string, string[]> = {}
  for (const [who, n] of Object.entries(counts)) {
    fs.mkdirSync(path.join(root, 'users', who), { recursive: true })
    rels[who] = Array.from({ length: n }, (_, i) => `users/${who}/d${String(i).padStart(3, '0')}.docx`)
    for (const r of rels[who]!) fs.writeFileSync(path.join(root, r), 'doc ' + r)
  }
  return { root, rels, filter: (rel: string) => fs.lstatSync(path.join(root, rel)) }
}

describe.skipIf(!rg)('background queue fairness', () => {
  test('the queue takes files from each owner in turn: one person with many files does not delay another', async () => {
    const t = people({ alice: 150, bob: 1 })
    const c = new GatedCache(tmp('cache-'), t.root)
    try {
      const a = await c.refresh(rg!, ['users/alice'], [], t.filter, { budget: 0, owner: 'alice' })
      expect(a.pending + (a.notQueued ?? 0)).toBe(150)
      const b = await c.refresh(rg!, ['users/bob'], [], t.filter, { budget: 0, owner: 'bob' })
      expect(b.pending).toBe(1)
      // the worker extracts one file at a time: open them one by one until bob's file starts
      for (let i = 0; i < 5 && !c.order.includes(t.rels.bob![0]!); i++) { await sleep(20); for (const r of [...c.gates.keys()]) c.open(r); await sleep(20) }
      expect(c.order.indexOf(t.rels.bob![0]!)).toBeGreaterThanOrEqual(0)
      expect(c.order.indexOf(t.rels.bob![0]!)).toBeLessThan(3)
    } finally { await c.openAll() }
  })

  test('one owner queues at most OFFICE_QUEUE_PER_OWNER files; the rest are notQueued, and other owners can still enqueue', async () => {
    const N = OFFICE_QUEUE_PER_OWNER + 30
    const t = people({ carol: N, dan: 2 })
    const c = new GatedCache(tmp('cache-'), t.root)
    try {
      const r = await c.refresh(rg!, ['users/carol'], [], t.filter, { budget: 0, owner: 'carol' })
      // indexing counts only files that are queued or running for this search
      expect(r.pending).toBeLessThanOrEqual(OFFICE_QUEUE_PER_OWNER + 1)
      expect(r.pending).toBe(c.queued())
      expect(r.notQueued).toBe(N - r.pending)
      // the same search again counts the files that wait or run (the worker took one, so one more place is free)
      const again = await c.refresh(rg!, ['users/carol'], [], t.filter, { budget: 0, owner: 'carol' })
      expect(again.pending).toBeLessThanOrEqual(OFFICE_QUEUE_PER_OWNER + 1)
      expect(again.pending).toBe(c.queued())
      expect(again.notQueued).toBe(N - again.pending)
      const d = await c.refresh(rg!, ['users/dan'], [], t.filter, { budget: 0, owner: 'dan' })
      expect(d).toMatchObject({ pending: 2, notQueued: 0 })
    } finally { await c.openAll() }
  })

  test('a foreground caller that joins a background job raises it to high priority', async () => {
    const t = people({ fg: OFFICE_EXTRACT_PARALLEL, bg: 1, hi: 2 })
    const c = new GatedCache(tmp('cache-'), t.root)
    const f = t.rels.bg![0]!
    try {
      // all slots are in use by foreground jobs
      const held = t.rels.fg!.map((r) => c.update(r).catch(() => {}))
      await sleep(20)
      // the background worker takes f; it waits for a slot with low priority
      await c.refresh(rg!, ['users/bg'], [], t.filter, { budget: 0, owner: 'bg' })
      await sleep(20)
      // a foreground caller (the AI grep) needs f too, then two other foreground files wait
      const joined = c.update(f)
      const others = t.rels.hi!.map((r) => c.update(r).catch(() => {}))
      await sleep(20)
      expect(c.order).toEqual(t.rels.fg)
      // one slot is free: f goes first, before the foreground files that came later
      c.open(t.rels.fg![0]!)
      for (let i = 0; i < 50 && c.order.length === OFFICE_EXTRACT_PARALLEL; i++) await sleep(10)
      expect(c.order[OFFICE_EXTRACT_PARALLEL]).toBe(f)
      c.open(f)
      await joined
      void held; void others
    } finally { await c.openAll() }
  })
})
