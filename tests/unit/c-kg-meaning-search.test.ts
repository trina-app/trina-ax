// The combined search (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 2, steps 11–12): the
// pieces' vectors in the search worker (meaning/search.ts), the query's embedding, rank fusion with the keyword search
// (documents/index.ts hits) and the deadline (documents/search-worker.ts combinedSearch). A stand-in embedder maps a
// few words in English and Korean to fixed directions, so "outage" is close to "장애".
// - fusion order (reciprocal rank fusion), ties go to the keyword search, meaning-only pieces marked byMeaning
// - meaning: false, no vectors in the folders asked, or a missing vec column: exactly the keyword search
// - the deadline: a slow embedding is left out and the keyword result comes back in time; later searches fuse
// - a cold model or cold vectors are never waited for: keyword only at once, loading starts, later searches fuse
// - the top-k scan yields: a lookup queued in the worker behind a 100,000-vector scan answers first; the scan stops at
//   its deadline
// - the vector set picks up new, re-indexed and newly embedded pieces and drops deleted ones (per document, throttled)
// - rootIds and prefix: neither the vectors nor a stale vector's piece ever bring a row of another folder
// - the model and the vectors leave memory when idle; a worker thread warms meaning at its start and answers async
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocumentIndex, type DocHit, type SearchOptions } from '../../server/src/knowledge-graph/documents'
import { DocSearchWorker, MEANING_MARGIN_MS, openSearchReader } from '../../server/src/knowledge-graph/documents/search-worker'
import { MEANING_IDLE_MS, MEANING_REFRESH_MS, MeaningSearch, MeaningVectors, SCAN_YIELD } from '../../server/src/knowledge-graph/meaning/search'
import { MEANING_DIMS, passageText, quantize, vecToBlob, type Embedder } from '../../server/src/knowledge-graph/meaning/vectors'

setDefaultTimeout(30_000)

// ---------------------------------------------------------------- a stand-in embedder: words to fixed directions
const FAKE_EMBEDDER = `
export const CONCEPTS = [
  [['outage', 'incident', 'downtime', '장애'], 0],
  [['refund', 'money back', '환불'], 1],
  [['leave', 'vacation', '휴가', '연차'], 2],
  [['price', 'cost', '가격'], 3],
]
export function fakeVec(text) {
  const v = new Float32Array(${MEANING_DIMS})
  const low = text.toLowerCase()
  for (const [words, dim] of CONCEPTS) for (const w of words) if (low.includes(w)) v[dim] += 1
  if (!v.some(Boolean)) v[${MEANING_DIMS - 1}] = 1
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}
/** o: openMs (the model takes that long to open), embedMs (each embedding), fail (it never opens), log (what happened) */
export function fakeOpener(o = {}) {
  return async () => {
    o.log?.push('open')
    if (o.openMs) await Bun.sleep(o.openMs)
    if (o.fail) throw new Error('no model here')
    return {
      async embed(texts, kind) {
        o.log?.push('embed:' + kind)
        if (o.embedMs) await Bun.sleep(o.embedMs)
        return texts.map(fakeVec)
      },
      dispose() { o.log?.push('dispose') },
    }
  }
}
`
interface FakeOpts { openMs?: number; embedMs?: number; fail?: boolean; log?: string[] }
let fakeVec: (text: string) => Float32Array
let fakeOpener: (o?: FakeOpts) => () => Promise<Embedder>

let tmp: string
const enc = (s: string) => new TextEncoder().encode(s)
const extract = async (_n: string, b: Uint8Array) => new TextDecoder().decode(b)
let mtime = 1
const put = (idx: DocumentIndex, root: string, rel: string, text: string) => idx.update(root, rel, { bytes: enc(text), size: text.length, mtimeMs: mtime++ })

/** the meaning index's part, as the meaning-index agent does it: the column, and a vector for each piece without one */
function embedAll(dir: string, o: { only?: string } = {}) {
  const db = new Database(path.join(dir, 'documents.db'))
  try {
    if (!db.query("SELECT 1 FROM pragma_table_info('chunks') WHERE name = 'vec'").get()) db.run('ALTER TABLE chunks ADD COLUMN vec BLOB')
    const rows = db.query('SELECT c.id, c.text, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.vec IS NULL').all() as { id: number; text: string; rel: string }[]
    const up = db.prepare('UPDATE chunks SET vec = ? WHERE id = ?')
    db.transaction(() => { for (const r of rows) if (!o.only || r.rel === o.only) up.run(vecToBlob(quantize(fakeVec(passageText(path.posix.basename(r.rel), null, r.text)))), r.id) })()
  } finally { db.close() }
}
const chunkIds = (dir: string, rel: string) => {
  const db = new Database(path.join(dir, 'documents.db'), { readonly: true })
  try { return (db.query('SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.rel = ? ORDER BY c.ord').all(rel) as { id: number }[]).map((r) => r.id) } finally { db.close() }
}
const rels = (hits: DocHit[]) => hits.map((h) => h.relPath)

const DOCS: [string, string, string][] = [
  ['shared', 'incident-2026-09.md', '# 장애 보고서 — 2026-09-12\n예약 API 전체 중단, 47분. 원인: 인증서 만료.\n'],
  ['shared', 'refund.md', '# Refund policy\nCustomers get a refund within 14 days of purchase.\n'],
  ['shared', '환불.md', '# 환불 규정\n구매 후 7일 이내에 돌려받을 수 있다.\n'],
  ['shared', 'leave.md', '# 휴가 규정\n연차는 15일이다. Annual leave policy.\n'],
  ['shared', 'report-template.md', '# Report template\nEvery report has a title and a date.\n'],
  ['projects/x', 'notes/downtime-notes.md', '# Notes\nThe downtime in March lasted an hour.\n'],
  ['projects/x', 'prices/price-list.md', '# Price list\nStarter costs 290,000 KRW.\n'],
  ['groups/secret', 'outage.md', '# Secret outage\nThe outage in the secret group. SECRET-CANARY\n'],
]

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-meaning-search-'))
  fs.writeFileSync(path.join(tmp, 'fake-embedder.ts'), FAKE_EMBEDDER)
  const m = await import(path.join(tmp, 'fake-embedder.ts'))
  fakeVec = m.fakeVec
  fakeOpener = m.fakeOpener
})
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** a fresh index with DOCS (embedded unless `vectors: false`) and its writer */
async function fixture(name: string, o: { vectors?: boolean } = {}) {
  // laid out as on a server (<data>/knowledge-graph/documents), so the model folder the worker looks in
  // (meaningModelDirs: <data>/models) is this test's own, never the system's temp folder
  const dir = path.join(tmp, name, 'knowledge-graph', 'documents')
  const writer = DocumentIndex.open(dir, { extract })
  for (const [root, rel, text] of DOCS) await put(writer, root, rel, text)
  if (o.vectors !== false) embedAll(dir)
  return { dir, writer }
}

describe('rank fusion (DocumentIndex.hits with a meaning list)', () => {
  test('the fused order is reciprocal rank fusion; a piece only meaning found is marked and read again', async () => {
    const dir = path.join(tmp, 'fusion')
    const w = DocumentIndex.open(dir, { extract })
    try {
      await put(w, 'shared', 'a.md', 'alpha beta gamma together here')
      await put(w, 'shared', 'b.md', 'alpha beta only')
      await put(w, 'shared', 'c.md', 'alpha alone')
      await put(w, 'shared', 'd.md', 'nothing of the words')
      const o: SearchOptions = { rootIds: ['shared'], passage: 400 }
      const ranked = w.rankKeywords('alpha beta gamma', o)
      expect(ranked.scored.map((s) => s.r.rel)).toEqual(['a.md', 'b.md', 'c.md'])
      const [a] = chunkIds(dir, 'a.md'), [c] = chunkIds(dir, 'c.md'), [d] = chunkIds(dir, 'd.md')
      // keyword a, b, c; meaning d, c, a: a = 1/61 + 1/63, c = 1/63 + 1/62, d = 1/61, b = 1/62
      const hits = w.hits(ranked, o, [{ id: d!, score: 0.9 }, { id: c!, score: 0.8 }, { id: a!, score: 0.7 }])
      expect(rels(hits)).toEqual(['a.md', 'c.md', 'd.md', 'b.md'])
      expect(hits.map((h) => !!h.byMeaning)).toEqual([false, false, true, false])
      expect(hits[0]!.score).toBeCloseTo(15 * 61 / 2 * (1 / 61 + 1 / 63), 2)
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
      expect(hits[2]!.passage).toBe('nothing of the words')
      // a tie goes to the piece the keyword search found
      expect(rels(w.hits(w.rankKeywords('alpha', o), o, [{ id: d!, score: 0.9 }])).slice(0, 2)).toEqual(['a.md', 'd.md'])
      // no meaning list, or an empty one: exactly search()
      expect(w.hits(ranked, o, [])).toEqual(w.search('alpha beta gamma', o))
      expect(w.hits(ranked, o, null)).toEqual(w.search('alpha beta gamma', o))
    } finally { w.close() }
  })

  test('the per-file limit holds after fusion; a meaning-only piece of another folder, prefix or a deleted one gives nothing', async () => {
    const { dir, writer } = await fixture('fusion-scope')
    try {
      const secret = chunkIds(dir, 'outage.md')
      const notes = chunkIds(dir, 'notes/downtime-notes.md')
      const prices = chunkIds(dir, 'prices/price-list.md')
      const o: SearchOptions = { rootIds: ['shared'] }
      const hits = writer.hits(writer.rankKeywords('refund', o), o, secret.map((id) => ({ id, score: 1 })))
      expect(hits.some((h) => h.rootId !== 'shared')).toBe(false)
      expect(JSON.stringify(hits)).not.toContain('SECRET-CANARY')
      const inX: SearchOptions = { rootIds: ['projects/x'], prefix: 'notes' }
      expect(rels(writer.hits(writer.rankKeywords('zzz', inX), inX, [...prices, ...notes].map((id) => ({ id, score: 1 }))))).toEqual(['notes/downtime-notes.md'])
      // a piece deleted since the vectors were loaded
      writer.remove('projects/x', 'notes/downtime-notes.md')
      expect(writer.hits(writer.rankKeywords('zzz', inX), inX, notes.map((id) => ({ id, score: 1 })))).toEqual([])
      // at most 3 pieces per file, fused or not
      await put(writer, 'shared', 'long.md', Array.from({ length: 12 }, (_, i) => `## Part ${i}\n${'refund words and more text. '.repeat(70)}`).join('\n'))
      const long = chunkIds(dir, 'long.md')
      expect(long.length).toBeGreaterThan(3)
      const fused = writer.hits(writer.rankKeywords('refund', o), o, long.map((id) => ({ id, score: 1 })))
      expect(fused.filter((h) => h.relPath === 'long.md')).toHaveLength(3)
    } finally { writer.close() }
  })
})

describe('the combined search in the worker (openSearchReader, in this thread)', () => {
  test('meaning: false, or no vectors in the folders asked: exactly the keyword search (and synchronous)', async () => {
    const { dir, writer } = await fixture('plain')
    const log: string[] = []
    const r = openSearchReader(dir, () => [], fakeOpener({ log }))
    try {
      for (const q of ['refund policy', 'report september outage', '장애', 'price']) {
        const o: SearchOptions = { rootIds: ['shared', 'projects/x'], passage: 1500, limit: 40 }
        const plain = r.search(q, o, Date.now() + 5000)
        expect(plain instanceof Promise).toBe(false)
        expect(plain).toEqual(writer.search(q, o))
      }
      // vectors only elsewhere: a folder without any is the keyword search, and the model is not even opened
      const db = new Database(path.join(dir, 'documents.db'))
      db.run("UPDATE chunks SET vec = NULL WHERE doc_id IN (SELECT id FROM docs WHERE root_id = 'projects/x')")
      db.close()
      const o: SearchOptions = { rootIds: ['projects/x'], meaning: true, passage: 1500 }
      expect(await r.search('downtime', o, Date.now() + 5000)).toEqual(writer.search('downtime', o))
      expect(log).toEqual([])
    } finally { r.close(); writer.close() }
  })

  test('a missing vec column is tolerated: the keyword search, the model never opened; the column added later is picked up', async () => {
    const { dir, writer } = await fixture('no-column', { vectors: false })
    const log: string[] = []
    const r = openSearchReader(dir, () => [], fakeOpener({ log }))
    try {
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      expect(await r.search('report september outage', o, Date.now() + 5000)).toEqual(writer.search('report september outage', o))
      expect(log).toEqual([])
      const v = new MeaningVectors(writer['db'] as Database)
      await v.refresh()
      expect(v.ready).toBe(true)
      expect(v.size).toBe(0)
      expect(await v.topK(new Int8Array(MEANING_DIMS), { rootIds: ['shared'], k: 5 })).toEqual([])
      // the meaning index adds the column and fills it: a look after the refresh time finds them
      embedAll(dir)
      await v.refresh()
      expect(v.size).toBeGreaterThan(0)
    } finally { r.close(); writer.close() }
  })

  test('an English question finds a Korean document by meaning only; a keyword match still comes first', async () => {
    const { dir, writer } = await fixture('combined')
    const log: string[] = []
    const r = openSearchReader(dir, () => [], fakeOpener({ log }))
    try {
      await r.warm?.(true)
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      // keyword: "report" in the template only; meaning: "outage" is the Korean incident report
      expect(rels(writer.search('report september outage', o))).toEqual(['report-template.md'])
      const hits = await r.search('report september outage', o, Date.now() + 5000)
      expect(rels(hits).slice(0, 2).sort()).toEqual(['incident-2026-09.md', 'report-template.md'])
      expect(hits.find((h) => h.relPath === 'incident-2026-09.md')!.byMeaning).toBe(true)
      expect(hits.find((h) => h.relPath === 'report-template.md')!.byMeaning).toBeUndefined()
      expect(hits.find((h) => h.relPath === 'incident-2026-09.md')!.passage).toContain('장애 보고서')
      // nothing by keyword at all: meaning-only results still come back, all marked
      const only = await r.search('downtime', { ...o, rootIds: ['shared'] }, Date.now() + 5000)
      expect(writer.search('downtime', o)).toEqual([])
      expect(rels(only)[0]).toBe('incident-2026-09.md')
      expect(only.every((h) => h.byMeaning)).toBe(true)
      // a piece both found is first: "refund" by keyword and by meaning; the Korean one by meaning only
      const both = await r.search('refund', o, Date.now() + 5000)
      expect(rels(both).slice(0, 2)).toEqual(['refund.md', '환불.md'])
      expect(both.map((h) => !!h.byMeaning).slice(0, 2)).toEqual([false, true])
      expect(log.filter((x) => x === 'open')).toHaveLength(1)
      expect(log).toContain('embed:query')
    } finally { r.close(); writer.close() }
  })

  test('rootIds and prefix: the vectors of other folders are never searched', async () => {
    const { dir, writer } = await fixture('scope')
    const r = openSearchReader(dir, () => [], fakeOpener())
    try {
      await r.warm?.(true)
      const shared = await r.search('outage', { rootIds: ['shared'], meaning: true }, Date.now() + 5000)
      expect(shared.length).toBeGreaterThan(0)
      expect(shared.every((h) => h.rootId === 'shared')).toBe(true)
      expect(JSON.stringify(shared)).not.toContain('SECRET-CANARY')
      const notes = await r.search('outage', { rootIds: ['projects/x'], prefix: 'notes', meaning: true }, Date.now() + 5000)
      expect(rels(notes)).toEqual(['notes/downtime-notes.md'])
      expect(notes[0]!.byMeaning).toBe(true)
      // the vectors themselves, filtered before ranking
      const v = new MeaningVectors(writer['db'] as Database)
      await v.refresh()
      const q = quantize(fakeVec('outage'))
      const secret = new Set(chunkIds(dir, 'outage.md'))
      const all = (await v.topK(q, { rootIds: ['shared', 'projects/x', 'groups/secret'], k: 50 }))!
      expect(all.some((x) => secret.has(x.id))).toBe(true)
      expect((await v.topK(q, { rootIds: ['shared', 'projects/x'], k: 50 }))!.some((x) => secret.has(x.id))).toBe(false)
      expect((await v.topK(q, { rootIds: ['projects/x'], prefix: 'prices', k: 50 }))!.map((x) => x.id)).toEqual(chunkIds(dir, 'prices/price-list.md'))
      expect(await v.topK(q, { rootIds: ['nowhere'], k: 50 })).toEqual([])
      // best first, at most k
      expect(all[0]!.score).toBeGreaterThan(0.9)
      expect(await v.topK(q, { rootIds: ['shared', 'projects/x', 'groups/secret'], k: 2 })).toEqual(all.slice(0, 2))
    } finally { r.close(); writer.close() }
  })

  test('the deadline: a slow embedding is left out and the keyword result comes back in time; once warm, they fuse', async () => {
    const { dir, writer } = await fixture('deadline')
    const r = openSearchReader(dir, () => [], fakeOpener({ openMs: 400 }))
    try {
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      const t0 = performance.now()
      const quick = await r.search('report september outage', o, Date.now() + 120)
      expect(performance.now() - t0).toBeLessThan(120)
      expect(quick).toEqual(writer.search('report september outage', o))
      // the model went on opening meanwhile: a later search in time has the meaning part
      await r.warm?.(true)
      expect(rels(await r.search('report september outage', o, Date.now() + 200))).toContain('incident-2026-09.md')
      // a deadline already inside the margin: keyword alone, at once
      expect(await r.search('report september outage', o, Date.now() + MEANING_MARGIN_MS - 5)).toEqual(writer.search('report september outage', o))
    } finally { r.close() }

    const slow = openSearchReader(dir, () => [], fakeOpener({ embedMs: 300 }))
    try {
      const o: SearchOptions = { rootIds: ['shared'], meaning: true }
      await slow.warm?.(true)
      const t0 = performance.now()
      expect(await slow.search('refund', o, Date.now() + 100)).toEqual(writer.search('refund', o))
      expect(performance.now() - t0).toBeLessThan(100)
    } finally { slow.close() }

    // a model that will not open: keyword only, one line, not tried again on every search
    const warnings: string[] = []
    const log: string[] = []
    const broken = openSearchReader(dir, () => [], fakeOpener({ fail: true, log }), (m) => warnings.push(m))
    try {
      const o: SearchOptions = { rootIds: ['shared'], meaning: true }
      expect(await broken.search('refund', o, Date.now() + 2000)).toEqual(writer.search('refund', o))
      await broken.warm?.(true)
      expect(await broken.search('refund', o, Date.now() + 2000)).toEqual(writer.search('refund', o))
      await broken.warm?.(true)
      expect(log.filter((x) => x === 'open')).toHaveLength(1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('keyword search only')
    } finally { broken.close(); writer.close() }
  })

  test('a cold model is never waited for: keyword only well before the deadline, its loading starts, a later search fuses', async () => {
    const { dir, writer } = await fixture('cold')
    const log: string[] = []
    // the model takes 1.5 s to open (about what the real one takes on 2 cores)
    const r = openSearchReader(dir, () => [], fakeOpener({ openMs: 1500, log }))
    try {
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      // the Files search's 500 ms: the keyword result at once, not just before the deadline
      let t0 = performance.now()
      expect(await r.search('report september outage', o, Date.now() + 500)).toEqual(writer.search('report september outage', o))
      expect(performance.now() - t0).toBeLessThan(150)
      // the AI's tool (the worker's 5 s): no wait through the model's opening either
      t0 = performance.now()
      expect(await r.search('report september outage', o, Date.now() + 5000)).toEqual(writer.search('report september outage', o))
      expect(performance.now() - t0).toBeLessThan(300)
      // the first search started the loading (once): later searches fuse
      await r.warm?.(true)
      expect(log.filter((x) => x === 'open')).toHaveLength(1)
      const fused = await r.search('report september outage', o, Date.now() + 500)
      expect(rels(fused)).toContain('incident-2026-09.md')
      expect(fused.find((h) => h.relPath === 'incident-2026-09.md')!.byMeaning).toBe(true)
    } finally { r.close() }

    // the model in memory but the vectors not (a new MeaningSearch over the same index): keyword only at once, then fused
    const reader = DocumentIndex.openReader(dir)
    const m = new MeaningSearch(reader.readerDb(), { open: fakeOpener() })
    try {
      await m.embedder.warm()
      expect(m.embedder.loaded()).toBe(true)
      expect(m.vectors.ready).toBe(false)
      expect(await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 500 })).toBeNull()
      for (let i = 0; i < 200 && !m.vectors.ready; i++) await Bun.sleep(5)
      expect((await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 500 }))!.length).toBeGreaterThan(0)
    } finally { m.close(); reader.close(); writer.close() }
  })
})

/** `n` more pieces with vectors (and empty text) in one new document of `root`, written straight into documents.db */
function bulkVectors(dir: string, root: string, n: number) {
  const db = new Database(path.join(dir, 'documents.db'))
  try {
    db.transaction(() => {
      const doc = (db.query("INSERT INTO docs (root_id, rel, dir, name_lc, size, mtime, chunks, updated_at) VALUES (?, 'bulk.md', '', 'bulk.md', 1, 1, ?, 1) RETURNING id").get(root, n) as { id: number }).id
      const ins = db.prepare("INSERT INTO chunks (doc_id, ord, text, vec) VALUES (?, ?, '', ?)")
      let seed = 11
      const v = new Int8Array(MEANING_DIMS)
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < MEANING_DIMS; j++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v[j] = (seed % 41) - 20 }
        ins.run(doc, i, new Uint8Array(v.buffer.slice(0)))
      }
    })()
  } finally { db.close() }
}

describe('the top-k scan over 100,000 vectors', () => {
  test('it yields while it runs (a task queued meanwhile runs before it ends), stops at its deadline, and ranks as a plain scan', async () => {
    const { dir, writer } = await fixture('scan-yield')
    bulkVectors(dir, 'shared', 100_000)
    const reader = DocumentIndex.openReader(dir)
    const v = new MeaningVectors(reader.readerDb())
    try {
      await v.refresh()
      expect(v.size).toBeGreaterThan(100_000)
      const q = quantize(fakeVec('refund'))
      let ran = false
      setTimeout(() => { ran = true }, 0)
      const top = (await v.topK(q, { rootIds: ['shared'], k: 50 }))!
      expect(ran).toBe(true)
      // the same as comparing every vector at once
      const all = (reader.readerDb().query("SELECT c.id, c.vec FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.root_id = 'shared' AND c.vec IS NOT NULL").all() as { id: number; vec: Uint8Array }[])
        .map((r) => { const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength); let s = 0; for (let i = 0; i < b.length; i++) s += b[i]! * q[i]!; return { id: r.id, s } })
        .sort((a, b) => b.s - a.s || a.id - b.id).slice(0, 50)
      expect(top.map((x) => x.id)).toEqual(all.map((x) => x.id))
      expect(top[0]!.id).toBe(chunkIds(dir, 'refund.md')[0]!)
      // a deadline that passes during the scan: nothing (the keyword result goes out alone)
      expect(SCAN_YIELD).toBeLessThan(100_000)
      expect(await v.topK(q, { rootIds: ['shared'], k: 50, at: Date.now() - 1 })).toBeNull()
    } finally { reader.close(); writer.close() }
  })

  test('in the worker: a keyword lookup asked right after a combined search over 100,000 vectors answers first', async () => {
    const { dir, writer } = await fixture('scan-worker')
    bulkVectors(dir, 'shared', 100_000)
    const SELF = path.join(import.meta.dir, '../../server/src/knowledge-graph/documents/search-worker.ts')
    const script = path.join(tmp, 'scan-worker.ts')
    fs.writeFileSync(script, `import { parentPort } from 'node:worker_threads'
import { openSearchReader, serveDocSearch } from ${JSON.stringify(SELF)}
import { fakeOpener } from ${JSON.stringify(path.join(tmp, 'fake-embedder.ts'))}
serveDocSearch(parentPort, (dir, people) => openSearchReader(dir, people, fakeOpener()))
`)
    const w = new DocSearchWorker(dir, script, () => {}, { meaning: () => true })
    try {
      w.warm()
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 300 }
      // warm: the vectors and the model loaded (a meaning-only Korean piece is in the answer)
      for (let i = 0; i < 300; i++) { if (rels(await w.search('refund', { ...o, due: Date.now() + 5000 })).includes('환불.md')) break; await Bun.sleep(20) }
      expect(rels(await w.search('refund', { ...o, due: Date.now() + 5000 }))).toContain('환불.md')
      const order: string[] = []
      const combined = w.search('refund', { ...o, due: Date.now() + 5000 }).then((h) => { order.push('combined'); return h })
      const lookup = w.search('refund', { rootIds: ['shared'], due: Date.now() + 5000 }).then((h) => { order.push('lookup'); return h })
      const [c, l] = await Promise.all([combined, lookup])
      expect(order).toEqual(['lookup', 'combined'])
      expect(rels(l)).toEqual(['refund.md'])
      expect(rels(c)).toContain('환불.md')
    } finally { w.close(); writer.close() }
  })
})

describe('the vectors in memory (MeaningVectors)', () => {
  test('new, re-indexed and newly embedded pieces are picked up and deleted ones dropped, per document', async () => {
    const { dir, writer } = await fixture('refresh')
    const db = writer['db'] as Database
    let now = 1_000_000
    const v = new MeaningVectors(db, { now: () => now })
    try {
      await v.refresh()
      const q = quantize(fakeVec('vacation'))
      const top = async () => (await v.topK(q, { rootIds: ['shared'], k: 3 }))!.map((x) => x.id)
      expect((await top())[0]).toBe(chunkIds(dir, 'leave.md')[0]!)
      const before = v.size
      // a new document, not embedded yet: not there; embedded: there (and a document not fully embedded is looked at again)
      await put(writer, 'shared', 'vacation-2027.md', '# Vacation plan 2027\nEveryone takes a vacation week in August.\n')
      await v.refresh()
      expect(v.size).toBe(before)
      embedAll(dir)
      await v.refresh()
      expect(v.size).toBe(before + 1)
      expect(await top()).toContain(chunkIds(dir, 'vacation-2027.md')[0]!)
      // indexed again: new piece ids, the old ones gone
      const oldIds = chunkIds(dir, 'leave.md')
      await put(writer, 'shared', 'leave.md', '# 휴가 규정 v2\n연차는 16일이다. Annual leave policy, new.\n')
      embedAll(dir)
      await v.refresh()
      const newIds = chunkIds(dir, 'leave.md')
      expect(newIds).not.toEqual(oldIds)
      const found = (await v.topK(q, { rootIds: ['shared'], k: 50 }))!.map((x) => x.id)
      for (const id of newIds) expect(found).toContain(id)
      for (const id of oldIds.filter((x) => !newIds.includes(x))) expect(found).not.toContain(id)
      // removed: gone
      const [vacation] = chunkIds(dir, 'vacation-2027.md')
      writer.remove('shared', 'vacation-2027.md')
      await v.refresh()
      expect(v.size).toBe(before)
      expect(await top()).not.toContain(vacation!)
      // a whole folder dropped
      writer.dropRoot('projects/x')
      await v.refresh()
      expect(await v.topK(q, { rootIds: ['projects/x'], k: 5 })).toEqual([])
    } finally { writer.close() }
  })

  test('maybeRefresh: only when the index changed, and at most once per refresh time', async () => {
    const { dir, writer } = await fixture('throttle')
    const reader = DocumentIndex.openReader(dir)
    let now = 5_000_000
    const v = new MeaningVectors(reader.readerDb(), { now: () => now })
    try {
      await v.refresh()
      const before = v.size
      await put(writer, 'shared', 'outage-2.md', 'Another outage in October.\n')
      embedAll(dir)
      // too soon after the last look: nothing
      v.maybeRefresh()
      await Bun.sleep(10)
      expect(v.size).toBe(before)
      now += MEANING_REFRESH_MS
      v.maybeRefresh()
      await Bun.sleep(10)
      expect(v.size).toBe(before + 1)
      // nothing changed since: no look (the clock alone does not reload)
      now += MEANING_REFRESH_MS
      const spy = v.refresh.bind(v)
      let looked = 0
      v.refresh = () => { looked++; return spy() }
      v.maybeRefresh()
      expect(looked).toBe(0)
    } finally { reader.close(); writer.close() }
  })
})

describe('the meaning part over time (MeaningSearch)', () => {
  test('the model and the vectors leave memory after the idle time; the next search loads them again', async () => {
    const { dir, writer } = await fixture('idle')
    const reader = DocumentIndex.openReader(dir)
    const log: string[] = []
    let now = 9_000_000
    const m = new MeaningSearch(reader.readerDb(), { open: fakeOpener({ log }), now: () => now })
    try {
      expect((await m.topK('outage', { rootIds: ['shared'] }))!.length).toBeGreaterThan(0)
      expect(m.embedder.loaded()).toBe(true)
      now += MEANING_IDLE_MS - 1
      expect(m.checkIdle()).toBe(false)
      now += 1
      expect(m.checkIdle()).toBe(true)
      expect(m.embedder.loaded()).toBe(false)
      expect(m.vectors.ready).toBe(false)
      await Bun.sleep(5)
      expect(log.filter((x) => x === 'dispose')).toHaveLength(1)
      expect((await m.topK('outage', { rootIds: ['shared'] }))!.length).toBeGreaterThan(0)
      expect(log.filter((x) => x === 'open')).toHaveLength(2)
    } finally { m.close(); reader.close(); writer.close() }
  })

  test('a scan that missed its time is remembered: a later search with less time left skips the scan at once (review of wave 2)', async () => {
    const { dir, writer } = await fixture('scan-miss')
    const reader = DocumentIndex.openReader(dir)
    const m = new MeaningSearch(reader.readerDb(), { open: fakeOpener(), now: () => 1 })
    const vectors = m.vectors as { topK: MeaningVectors['topK'] }
    const real = vectors.topK.bind(m.vectors)
    try {
      await m.warm()
      expect(m.embedder.loaded()).toBe(true)
      // a scan slower than the time left: it runs to its deadline and gives nothing
      let scans = 0
      vectors.topK = async (_q, o) => { scans++; await Bun.sleep(Math.max(0, (o.at ?? 0) - Date.now()) + 2); return null }
      expect(await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 400 })).toBeNull()
      expect(scans).toBe(1)
      // less time left than that scan ran: no scan, null at once (the keyword result goes out alone)
      const t0 = performance.now()
      expect(await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 150 })).toBeNull()
      expect(scans).toBe(1)
      expect(performance.now() - t0).toBeLessThan(100)
      // more time left: it scans again; a scan that ends in time sets the estimate to what it took
      vectors.topK = real
      expect((await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 2000 }))!.length).toBeGreaterThan(0)
      expect((await m.topK('outage', { rootIds: ['shared'], at: Date.now() + 300 }))!.length).toBeGreaterThan(0)
    } finally { m.close(); reader.close(); writer.close() }
  })

  test('warm: the vectors, then the model when there are any; none: the model stays closed', async () => {
    const empty = await fixture('warm-empty', { vectors: false })
    const er = DocumentIndex.openReader(empty.dir)
    const elog: string[] = []
    const em = new MeaningSearch(er.readerDb(), { open: fakeOpener({ log: elog }), now: () => 1 })
    await em.warm()
    expect(em.vectors.ready).toBe(true)
    expect(elog).toEqual([])
    em.close(); er.close(); empty.writer.close()

    const full = await fixture('warm-full')
    const fr = DocumentIndex.openReader(full.dir)
    const flog: string[] = []
    const fm = new MeaningSearch(fr.readerDb(), { open: fakeOpener({ log: flog }), now: () => 1 })
    await fm.warm()
    expect(fm.embedder.loaded()).toBe(true)
    expect(flog).toEqual(['open'])
    fm.close(); fr.close(); full.writer.close()
  })
})

describe('through a worker thread (DocSearchWorker)', () => {
  test('meaning warmed at the start; a combined search answers asynchronously; a short deadline gets the keyword result', async () => {
    const { dir, writer } = await fixture('thread')
    const SELF = path.join(import.meta.dir, '../../server/src/knowledge-graph/documents/search-worker.ts')
    const script = path.join(tmp, 'meaning-worker.ts')
    // the worker's own loop and reader with the stand-in embedder (it says when it opens, through the warn channel)
    fs.writeFileSync(script, `import { parentPort } from 'node:worker_threads'
import { openSearchReader, serveDocSearch } from ${JSON.stringify(SELF)}
import { fakeOpener } from ${JSON.stringify(path.join(tmp, 'fake-embedder.ts'))}
const log = { push: (x) => parentPort.postMessage({ id: 0, warn: 'fake ' + x }) }
serveDocSearch(parentPort, (dir, people) => openSearchReader(dir, people, fakeOpener({ openMs: 1500, log })))
`)
    const said: string[] = []
    const w = new DocSearchWorker(dir, script, (e) => said.push(e), { meaning: () => true })
    try {
      w.warm()
      // the worker is up (a keyword search); it began opening the model at its start, without any meaning search
      expect(rels(await w.search('refund', { rootIds: ['shared'] }))).toEqual(['refund.md'])
      for (let i = 0; i < 100 && !said.includes('fake open'); i++) await Bun.sleep(10)
      expect(said[0]).toBe('fake open')
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      // the model takes 1.5 s to open: a search meanwhile gets the keyword result at once, not at its deadline (the
      // Files search's 500 ms; before, it answered after about 485 ms)
      const t0 = performance.now()
      const early = await w.search('report september outage', { ...o, due: Date.now() + 500 })
      expect(performance.now() - t0).toBeLessThan(250)
      expect(early).toEqual(writer.search('report september outage', o))
      await Bun.sleep(1600)
      const later = await w.search('report september outage', { ...o, due: Date.now() + 200 })
      expect(rels(later)).toContain('incident-2026-09.md')
      expect(later.find((h) => h.relPath === 'incident-2026-09.md')!.byMeaning).toBe(true)
      // without meaning: the keyword search, as ever
      expect(await w.search('report september outage', { rootIds: ['shared'], passage: 1500 })).toEqual(writer.search('report september outage', o))
    } finally { w.close(); writer.close() }
  })

  test('the real worker script with the model files missing (a search never downloads them): keyword results, one warning line', async () => {
    const { dir, writer } = await fixture('stub')
    const SELF = path.join(import.meta.dir, '../../server/src/knowledge-graph/documents/search-worker.ts')
    const said: string[] = []
    const w = new DocSearchWorker(dir, SELF, (e) => said.push(e), { meaning: () => true })
    try {
      w.warm()
      const o: SearchOptions = { rootIds: ['shared'], meaning: true, passage: 1500 }
      expect(await w.search('report september outage', o)).toEqual(writer.search('report september outage', o))
      for (let i = 0; i < 200 && !said.length; i++) await Bun.sleep(10)
      expect(await w.search('refund', { ...o, due: Date.now() + 200 })).toEqual(writer.search('refund', o))
      expect(said).toHaveLength(1)
      expect(said[0]).toContain('keyword search only')
    } finally { w.close(); writer.close() }
  })
})

describe('the embedder in its own thread (threadEmbedder)', () => {
  test('opens there, embeds, and ends with dispose; the search thread is not held while it opens', async () => {
    const { threadEmbedder } = await import('../../server/src/knowledge-graph/documents/search-worker')
    const SELF = path.join(import.meta.dir, '../../server/src/knowledge-graph/documents/search-worker.ts')
    const script = path.join(tmp, 'embed-thread.ts')
    // a thread that blocks for 400 ms while "opening" (as ONNX does), then serves the stand-in; "die" ends it; its
    // model's dispose leaves a mark (in the thread, before the thread ends)
    const freed = path.join(tmp, 'embed-thread-freed')
    fs.writeFileSync(script, `import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import { serveEmbedder } from ${JSON.stringify(SELF)}
import { fakeOpener } from ${JSON.stringify(path.join(tmp, 'fake-embedder.ts'))}
const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} }
const open = fakeOpener({ embedMs: 50, log: { push: (x) => { if (x === 'dispose') fs.appendFileSync(${JSON.stringify(freed)}, 'freed\\n') } } })
serveEmbedder({ on: (ev, f) => parentPort.on(ev, (m) => (m.texts?.[0] === 'die' ? process.exit(1) : f(m))), postMessage: (r) => parentPort.postMessage(r) }, async () => { spin(400); return open() })
`)
    let ticks = 0
    const tick = setInterval(() => ticks++, 1)
    const t0 = performance.now()
    const emb = await threadEmbedder(script, { modelDir: tmp })
    clearInterval(tick)
    expect(performance.now() - t0).toBeGreaterThan(350)
    expect(ticks).toBeGreaterThan(50)
    const [v] = await emb.embed(['the September outage'], 'query')
    expect(Array.from(v!)).toEqual(Array.from(fakeVec('the September outage')))
    // an embedding still running when dispose is asked ends first; then the model is freed in the thread, then it ends
    const running = emb.embed(['refund'], 'query')
    await emb.dispose()
    expect(Array.from((await running)[0]!)).toEqual(Array.from(fakeVec('refund')))
    expect(fs.readFileSync(freed, 'utf8')).toBe('freed\n')
    await expect(emb.embed(['again'], 'query')).rejects.toThrow('embedder closed')

    // a thread that dies: the waiting embedding is refused, and the meaning part drops it (keyword only, one line)
    const dying = await threadEmbedder(script, { modelDir: tmp })
    await expect(dying.embed(['die'], 'query')).rejects.toThrow()
    const { QueryEmbedder } = await import('../../server/src/knowledge-graph/meaning/search')
    const warnings: string[] = []
    let opens = 0
    const q = new QueryEmbedder(async () => { opens++; return threadEmbedder(script, { modelDir: tmp }) }, { warn: (m) => warnings.push(m) })
    expect(await q.embed('die')).toBeNull()
    expect(q.loaded()).toBe(false)
    expect(warnings[0]).toContain('failed')
    expect(await q.embed('outage')).toBeNull()
    expect(opens).toBe(1)

    // the real script with the stub: refused with its reason, the thread gone
    await expect(threadEmbedder(SELF, { modelDir: tmp, download: false })).rejects.toThrow('model files are missing')
  })
})
