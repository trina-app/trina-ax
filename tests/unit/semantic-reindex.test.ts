// The one-time re-index after 0.2.17 (search/semantic.ts CHUNK_FORMAT 2): documents indexed before get pieces that keep
// their place, in the background, newest first, with low-priority text extraction; their old pieces answer searches
// until then; a search never waits for it (the background run gives way after the current batch); it goes on where it
// stopped after a restart. Plain text files keep their pieces (the same as before).
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHUNK_FORMAT, SemanticIndex, type Embed } from '../../server/src/search/semantic'

const embedOne = (t: string) => {
  const v = new Float32Array(384)
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 384; v[h]! += 1 }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-reindex-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))

/** a team folder with office files whose extracted text the fake office cache gives (the old text before an upgrade) */
function setup(name: string) {
  const root = path.join(W, name, 'team'), data = path.join(W, name, 'data')
  fs.mkdirSync(data, { recursive: true })
  const texts = new Map<string, string>()
  const extracted: { rel: string; background: boolean }[] = []
  /** documents whose cached text is of an older format (the text cache was emptied by the update) */
  const stale = new Set<string>()
  const put = (rel: string, bytes: string, text: string | null, mtime: number) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, bytes)
    fs.utimesSync(abs, new Date(mtime), new Date(mtime))
    if (text !== null) texts.set(rel, text)
  }
  const office = {
    fresh: (rel: string) => !stale.has(rel),
    update: async (rel: string, o: { background?: boolean } = {}) => { extracted.push({ rel, background: !!o.background }); stale.delete(rel) },
    admittedText: (rel: string) => (texts.has(rel) ? { bytes: Buffer.from(texts.get(rel)!) } : null),
    cachePath: (rel: string) => path.join(data, 'textcache', rel + '.txt'),
  } as never
  return { root, data, texts, extracted, stale, put, office }
}

const pages = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} page ${i + 1} ${'내용 '.repeat(20)}`).join('\n\f')

describe('documents indexed before 0.2.17', () => {
  const s = setup('upgrade')
  const t0 = Date.parse('2026-10-01T00:00:00Z')
  s.put('shared/old-report.pdf', 'pdf-1', pages(3, 'refund'), t0)
  s.put('shared/new-report.pdf', 'pdf-2', pages(2, 'pricing'), t0 + 86400_000)
  s.put('shared/notes.md', '# 회의록\n결정: 환불 정책은 7일 안에 처리합니다.', null, t0)
  let embeds = 0
  const embed: Embed = async (texts) => { embeds += texts.length; return texts.map(embedOne) }
  const open = () => new SemanticIndex({ dataDir: s.data, root: s.root, office: s.office, embedder: async () => embed })

  test('an index made by an older server: old pieces without places, every file of format 1', async () => {
    const idx = open()
    await idx.refresh(10_000)
    // what 0.2.16 left: pieces without a place, files of format 1
    idx.db.exec('UPDATE chunks SET loc = NULL; UPDATE files SET format = 1')
    idx.db.close()
    const again = open()
    // plain text is cut as before: only the documents are made again
    expect(again.upgrading()).toBe(2)
    expect((again.db.query("SELECT format FROM files WHERE path = 'shared/notes.md'").get() as { format: number }).format).toBe(CHUNK_FORMAT)
    again.db.close()
  })
  test('a search does not make them again (it would wait); their old pieces answer it', async () => {
    const idx = open()
    embeds = 0
    s.extracted.length = 0
    expect(await idx.refresh(10_000)).toEqual({ pending: 0, upgrading: 2 })
    expect(embeds).toBe(0)
    const hits = await idx.query('refund page', () => true)
    expect(hits?.[0]?.path).toBe('shared/old-report.pdf')
    expect(hits?.[0]?.loc).toBeNull()
    idx.db.close()
  })
  test('the background run makes them again newest first, extracting with low priority; then pieces have pages', async () => {
    const idx = open()
    s.extracted.length = 0
    // the update emptied the text cache: the documents' text is extracted again
    s.stale.add('shared/old-report.pdf'); s.stale.add('shared/new-report.pdf')
    const r = await idx.refresh(60_000, { background: true })
    expect(r).toEqual({ pending: 0, upgrading: 0 })
    expect(s.extracted.map((e) => [e.rel, e.background])).toEqual([['shared/new-report.pdf', true], ['shared/old-report.pdf', true]])
    const hits = await idx.query('refund page 2', () => true)
    expect(hits?.find((h) => h.path === 'shared/old-report.pdf')?.loc).toEqual({ kind: 'page', page: 2 })
    expect(idx.upgrading()).toBe(0)
    idx.db.close()
  })
})

describe('the re-index goes on after a restart and gives way to searches', () => {
  const s = setup('resume')
  const t0 = Date.parse('2026-09-01T00:00:00Z')
  for (let i = 0; i < 6; i++) s.put(`shared/doc-${i}.pdf`, `pdf-${i}`, pages(2, `topic${i}`), t0 + i * 3600_000)
  // one long document: 200 pieces, 13 batches
  s.put('shared/big.pdf', 'pdf-big', pages(200, 'manual'), t0 + 100 * 3600_000)
  let delay = 0
  const embed: Embed = async (texts) => { if (delay) await Bun.sleep(delay); return texts.map(embedOne) }
  const open = () => new SemanticIndex({ dataDir: s.data, root: s.root, office: s.office, embedder: async () => embed })
  const makeOld = (idx: SemanticIndex) => idx.db.exec('UPDATE chunks SET loc = NULL; UPDATE files SET format = 1')

  test('a run that ran out of time keeps what it did; the next server goes on with the rest, newest first', async () => {
    let idx = open()
    await idx.refresh(60_000)
    makeOld(idx)
    expect(idx.upgrading()).toBe(7)
    delay = 15
    const r1 = await idx.refresh(120, { background: true })
    expect(r1.upgrading).toBeGreaterThan(0)
    expect(r1.upgrading).toBeLessThan(7)
    const done1 = (idx.db.query('SELECT path FROM files WHERE format = ?').all(CHUNK_FORMAT) as { path: string }[]).map((x) => x.path)
    // newest first: the big manual (newest), then doc-5, doc-4, ...
    expect(done1[0]).toBe('shared/big.pdf')
    idx.db.close()
    // a restart: the format column says what is left
    idx = open()
    expect(idx.upgrading()).toBe(r1.upgrading)
    delay = 0
    expect(await idx.refresh(60_000, { background: true })).toEqual({ pending: 0, upgrading: 0 })
    idx.db.close()
  })
  test('a search during a background run waits at most one batch: the cut-off file keeps its old pieces', async () => {
    const idx = open()
    makeOld(idx)
    delay = 40
    const bg = idx.refresh(60_000, { background: true })
    await Bun.sleep(100)
    const t = Date.now()
    // a new file the search must index itself
    s.put('shared/fresh.md', '# 새 메모\n오늘 정한 출장 규정 FRESH-NOTE 입니다.', null, Date.now())
    const fg = await idx.refresh(3000)
    const waited = Date.now() - t
    expect(fg).toEqual({ pending: 0, upgrading: 7 })
    expect(waited).toBeLessThan(1500)
    const bgResult = await bg
    expect(bgResult.upgrading).toBe(7)
    // the big manual was cut off in the middle: still its old pieces (no place), all of them
    const big = idx.db.query("SELECT COUNT(*) AS n, COUNT(loc) AS placed FROM chunks WHERE path = 'shared/big.pdf'").get() as { n: number; placed: number }
    expect(big.placed).toBe(0)
    expect(big.n).toBe(200)
    expect((await idx.query('출장 규정 FRESH-NOTE', () => true))?.[0]?.path).toBe('shared/fresh.md')
    delay = 0
    expect((await idx.refresh(60_000, { background: true })).upgrading).toBe(0)
    idx.db.close()
  })
})
