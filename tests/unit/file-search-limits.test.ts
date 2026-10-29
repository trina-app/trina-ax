// Resource limits of the grep core (server/src/files/search.ts) that the file screen's content search (R2-ETC-02)
// depends on: ripgrep records have a size cap (a long line never fills the server memory), office extraction keeps
// the deadline of the search, the background extraction is one queue with a fixed number of workers, and a file
// whose extraction fails does not keep its old text in the cache.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OFFICE_EXTRACT_PARALLEL, OfficeCache, RG_BASE, runRg } from '../../server/src/files/search'

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
