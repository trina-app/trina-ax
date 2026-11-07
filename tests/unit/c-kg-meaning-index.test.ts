// Search by meaning, the index side (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 2): the
// embedder (pinned model files, the e5 prefixes, normalization), the vectors in documents.db (the column on old indexes
// too, the pieces still without one, writes that skip a piece that changed), the background indexing (memory check,
// memory limit, the pause while someone waits for an answer, the switch), Korean CP949 text, the embedding process and
// its place in the bundles. No test downloads or loads the real model: loaders, downloads and processes are stand-ins.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DocumentIndex, headingOf } from '../../server/src/knowledge-graph/documents'
import { ensureModel, MODEL_FILES, openEmbedder, wrapModel, type LoadedModel } from '../../server/src/knowledge-graph/meaning/embedder'
import { MeaningIndexer, startEmbedChild, embedWorkerScript, BATCH, MIN_FREE_MIB, MAX_RSS_MIB, RESTARTS_MAX, type EmbedChild, type MeaningIndexerOptions } from '../../server/src/knowledge-graph/meaning/indexer'
import { serveEmbed, type WorkerMessage } from '../../server/src/knowledge-graph/meaning/embed-worker'
import { blobToVec, MEANING_DIMS, MEANING_MODEL, passageText, quantize, vecToBlob, type Embedder } from '../../server/src/knowledge-graph/meaning/vectors'
import { Database } from 'bun:sqlite'
import { makeCApp, type CApp } from '../lib/c-app'
import { knowledgeGraphOf, openDocumentIndex, setKnowledgeGraphForTests, type KnowledgeGraph } from '../../server/src/knowledge-graph/service'
import { linuxBundleFiles } from '../../scripts/build-bundle'
import { bundleManifest } from '../../scripts/build-office'

setDefaultTimeout(60_000)

const enc = (s: string) => new TextEncoder().encode(s)
const file = (bytes: Uint8Array, mtimeMs = 1000) => ({ bytes, size: bytes.byteLength, mtimeMs })
const decode = async (_r: string, b: Uint8Array) => new TextDecoder().decode(b)
let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-meaning-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** a made-up vector for a text: deterministic, not normalized (the embedder normalizes) */
function rawVec(text: string): Float32Array {
  const v = new Float32Array(MEANING_DIMS)
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % MEANING_DIMS]! += 1 + (i % 7)
  v[0]! += 3
  return v
}
const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))

/** a stand-in embedding process around a stand-in model, with its calls and stops counted */
function fakeChild(o: { rss?: () => number; fail?: () => boolean; ready?: Promise<void> } = {}) {
  const calls: string[][] = []
  const emb = wrapModel({ run: async (texts) => texts.map(rawVec), dispose() {} })
  const c = {
    calls, stops: 0, killed: 0,
    ready: o.ready ?? Promise.resolve(),
    async embed(passages: string[]) {
      calls.push(passages)
      if (o.fail?.()) throw new Error('the embedding process ended (killed)')
      if (c.dead) throw new Error('the embedding process was stopped')
      return (await emb.embed(passages, 'passage')).map((v) => new Uint8Array(vecToBlob(quantize(v))))
    },
    async rssMiB() { return o.rss?.() ?? 300 },
    dead: false,
    stop(now = false) { c.stops++; if (now) { c.killed++; c.dead = true } },
  }
  return c
}
type Fake = ReturnType<typeof fakeChild>

function logs() {
  const lines: { level: 'info' | 'warn'; msg: string; x?: Record<string, unknown> }[] = []
  return { lines, log: { info: (msg: string, x?: Record<string, unknown>) => { lines.push({ level: 'info', msg, x }) }, warn: (msg: string, x?: Record<string, unknown>) => { lines.push({ level: 'warn', msg, x }) } } }
}

async function docIndex(name: string, docs: Record<string, string>) {
  const d = DocumentIndex.open(path.join(tmp, name), { extract: decode })
  let t = 1
  for (const [rel, text] of Object.entries(docs)) expect((await d.update('projects/acme', rel, file(enc(text), t++))).ok).toBe(true)
  return d
}
const vecs = (d: DocumentIndex) => (d as unknown as { db: Database }).db.query('SELECT c.id, c.vec, c.text, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id ORDER BY c.id').all() as { id: number; vec: Uint8Array | null; text: string; rel: string }[]

function indexer(d: DocumentIndex | null, o: Partial<MeaningIndexerOptions> & { child?: () => EmbedChild } = {}) {
  const l = logs()
  const children: EmbedChild[] = []
  const ix = new MeaningIndexer({
    store: () => d, on: () => true, peopleWaiting: () => false, log: l.log,
    startChild: () => { const c = o.child ? o.child() : fakeChild(); children.push(c); return c },
    freeMemoryMiB: () => 8000, idleMs: 50, pausePollMs: 10, memPollMs: 10,
    ...o,
  })
  return { ix, children, lines: l.lines }
}

describe('the embedder', () => {
  test('the e5 prefixes go in front of every text, and the vectors come back normalized and checked', async () => {
    const seen: string[][] = []
    const e = wrapModel({ run: async (texts) => { seen.push(texts); return texts.map(rawVec) }, dispose() {} })
    const q = await e.embed(['환불 정책은?'], 'query')
    const p = await e.embed(['refund.md · 환불\n7일 이내 환불', 'second piece'], 'passage')
    expect(seen).toEqual([['query: 환불 정책은?'], ['passage: refund.md · 환불\n7일 이내 환불', 'passage: second piece']])
    for (const v of [...q, ...p]) { expect(v.length).toBe(MEANING_DIMS); expect(Math.abs(norm(v) - 1)).toBeLessThan(1e-5) }
    expect(await e.embed([], 'query')).toEqual([])
    const bad = wrapModel({ run: async (texts) => texts.map(() => new Float32Array(10)), dispose() {} })
    await expect(bad.embed(['x'], 'query')).rejects.toThrow(/shape/)
    await e.dispose()
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/disposed/)
  })

  test('the model files are checked against their pinned hashes: a wrong file is refused and never loaded', async () => {
    const own = path.join(tmp, 'models-own'), shared = path.join(tmp, 'models-shared')
    // a shared folder whose files do not match is not used, and nothing is written there
    for (const rel of Object.keys(MODEL_FILES)) {
      const f = path.join(shared, ...MEANING_MODEL.split('/'), ...rel.split('/'))
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, 'not the model')
    }
    const loaded: string[] = []
    const load = async (dir: string): Promise<LoadedModel> => { loaded.push(dir); return { run: async (t) => t.map(rawVec), dispose() {} } }
    const asked: string[] = []
    // a download that answers with other bytes: refused by its hash, no partial file left
    const wrongBytes = (async (url: string) => { asked.push(String(url)); return new Response('tampered bytes') }) as unknown as typeof fetch
    await expect(openEmbedder({ modelDir: own, sharedDir: shared, load, fetchFn: wrongBytes })).rejects.toThrow(/SHA-256/)
    expect(asked[0]).toBe(`https://huggingface.co/${MEANING_MODEL}/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json`)
    expect(loaded).toEqual([])
    const ownFiles = fs.existsSync(own) ? fs.readdirSync(own, { recursive: true }).map(String) : []
    expect(ownFiles.some((f) => f.endsWith('.part') || f.endsWith('config.json'))).toBe(false)
    expect(fs.readFileSync(path.join(shared, ...MEANING_MODEL.split('/'), 'config.json'), 'utf8')).toBe('not the model')
    // a failed download, and no download at all
    await expect(ensureModel(own, (async () => new Response('', { status: 404 })) as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/)
    await expect(openEmbedder({ modelDir: own, download: false, load })).rejects.toThrow(/do not match/)
    // a wrong file already in the team's folder is replaced only by a download that matches
    const cfg = path.join(own, ...MEANING_MODEL.split('/'), 'config.json')
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, '{"tampered":true}')
    await expect(openEmbedder({ modelDir: own, load, fetchFn: wrongBytes })).rejects.toThrow(/SHA-256/)
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{"tampered":true}')
    expect(loaded).toEqual([])
  })
})

describe('the vectors in documents.db', () => {
  test('pieces without a vector come with their file name and heading; the passage text holds both', async () => {
    // (a Word file's text as the converters give it: its headings as Markdown headings, files/locations.ts)
    const d = await docIndex('pending', {
      'policies/refund-policy.docx': '# 환불 정책\n\n구매 후 7일 이내에는 전액 환불합니다.\n',
      'notes/plain.txt': 'Plain notes without any heading about the warehouse.',
    })
    const p = d.pendingVectors(10)
    expect(p.map((x) => x.name).sort()).toEqual(['plain.txt', 'refund-policy.docx'])
    const refund = p.find((x) => x.name === 'refund-policy.docx')!
    expect(refund.heading).toBe('환불 정책')
    expect(refund.text).toContain('7일 이내')
    expect(p.find((x) => x.name === 'plain.txt')!.heading).toBeNull()
    expect(passageText(refund.name, refund.heading, refund.text)).toBe(`refund-policy.docx · 환불 정책\n${refund.text}`)
    expect(passageText('plain.txt', null, 'x')).toBe('plain.txt\nx')
    // the place a sheet piece is embedded with is its sheet's name; a page or a slide number is not a heading
    expect(headingOf({ kind: 'sheet', sheet: '예산', range: 'A1:B3' })).toBe('예산')
    expect(headingOf({ kind: 'page', page: 3 })).toBeNull()
    expect(headingOf({ kind: 'slide', slide: 2 })).toBeNull()
    expect(d.vectorCounts()).toEqual({ done: 0, pending: p.length })
    d.destroy()
  })

  test('vectors are written in one go; a piece that changed meanwhile is skipped; a document indexed again is embedded again', async () => {
    const d = await docIndex('write', { 'a.md': '# Alpha\nThe alpha launch plan for the expo booth.', 'b.md': '# Beta\nBeta pricing notes for the reseller.' })
    const p = d.pendingVectors(10)
    const v = (x: { name: string; heading: string | null; text: string }) => vecToBlob(quantize(rawVec(x.text).map((n) => n / 100) as Float32Array))
    // a vector made from other text (the piece's id taken by a new piece, say) is not written
    expect(d.writeVectors([{ id: p[0]!.id, passage: 'something else', vec: v(p[0]!) }])).toBe(0)
    // a wrong size is not written either
    expect(d.writeVectors([{ id: p[0]!.id, passage: passageText(p[0]!.name, p[0]!.heading, p[0]!.text), vec: new Uint8Array(10) }])).toBe(0)
    expect(d.writeVectors(p.map((x) => ({ id: x.id, passage: passageText(x.name, x.heading, x.text), vec: v(x) })))).toBe(2)
    expect(d.pendingVectors(10)).toEqual([])
    expect(d.vectorCounts()).toEqual({ done: 2, pending: 0 })
    expect(vecs(d).every((r) => blobToVec(r.vec)?.length === MEANING_DIMS)).toBe(true)
    // written once: a second write of the same piece changes nothing
    expect(d.writeVectors([{ id: p[0]!.id, passage: passageText(p[0]!.name, p[0]!.heading, p[0]!.text), vec: v(p[0]!) }])).toBe(0)
    // the document changes: its pieces are new rows without a vector; the other document keeps its vector
    await d.update('projects/acme', 'a.md', file(enc('# Alpha\nThe alpha launch moved to the spring fair.'), 99))
    const again = d.pendingVectors(10)
    expect(again.map((x) => x.name)).toEqual(['a.md'])
    expect(again[0]!.text).toContain('spring fair')
    expect(vecs(d).find((r) => r.rel === 'b.md')!.vec).not.toBeNull()
    d.destroy()
  })

  test('an index made before the column gets it on open, keeps its documents, and lists its pieces as pending', async () => {
    const dir = path.join(tmp, 'old-index')
    const d = await docIndex('old-index', { 'old.md': '# Old\nAn older index made before search by meaning.' })
    d.close()
    const raw = new Database(path.join(dir, 'documents.db'))
    raw.run('DROP INDEX chunks_novec')
    raw.run('ALTER TABLE chunks DROP COLUMN vec')
    expect((raw.query('PRAGMA table_info(chunks)').all() as { name: string }[]).some((c) => c.name === 'vec')).toBe(false)
    raw.close()
    const d2 = DocumentIndex.open(dir, { extract: decode })
    expect(d2.search('older index', { rootIds: ['projects/acme'] })[0]?.relPath).toBe('old.md')
    expect(d2.pendingVectors(10).map((x) => x.name)).toEqual(['old.md'])
    // a reader (the search worker's connection) opens it too, and sees the column
    const r = DocumentIndex.openReader(dir)
    expect(r.search('older index', { rootIds: ['projects/acme'] }).length).toBe(1)
    r.close()
    d2.destroy()
  })
})

describe('Korean CP949 text (the 2026-11-01 lesson)', () => {
  /** CP949 bytes of a text, from the decoder's own table (the runtime has no CP949 encoder) */
  function cp949(s: string): Uint8Array {
    const table = new Map<string, number[]>()
    const dec = new TextDecoder('euc-kr')
    for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x41; b <= 0xfe; b++) {
      const ch = dec.decode(new Uint8Array([a, b]))
      if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, [a, b])
    }
    return new Uint8Array([...s].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : table.get(ch)!)))
  }
  const csv = '거래처,담당자,금액\n가나상사,홍길동,1200000\n다라물산,김철수,출장비 정산 350000\n'

  test('a Korean Excel CSV and a CP949 text file are indexed, and embedded, as their Korean text (the converters grep and read use)', async () => {
    const bytes = cp949(csv)
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    // the index's own converters (files/extract.ts extractText: decodeText, the shared cp949Text rule)
    const d = DocumentIndex.open(path.join(tmp, 'cp949'))
    expect((await d.update('projects/acme', '거래처-목록.csv', file(bytes))).ok).toBe(true)
    expect((await d.update('projects/acme', '메모.txt', file(cp949('출장비 정산은 월말까지 제출합니다.')))).ok).toBe(true)
    expect(d.search('출장비', { rootIds: ['projects/acme'] }).map((h) => h.relPath).sort()).toEqual(['거래처-목록.csv', '메모.txt'])
    const p = d.pendingVectors(10)
    expect(p.find((x) => x.name === '거래처-목록.csv')!.text).toContain('다라물산,김철수')
    expect(p.every((x) => !x.text.includes('�'))).toBe(true)
    // what the model gets: the Korean text, with the file name in front
    expect(passageText(p[0]!.name, p[0]!.heading, p[0]!.text)).not.toContain('�')
    d.destroy()
  })
})

describe('the background indexing', () => {
  test('pieces get vectors in batches of four; a document indexed again gets new ones', async () => {
    const d = await docIndex('pipeline', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`doc-${i}.docx`, `# Doc ${i}\nPiece number ${i} about the expo booth and the budget.`])))
    const { ix, children, lines } = indexer(d)
    ix.kick()
    await ix.whenIdle()
    const c = children[0] as unknown as Fake
    expect(children.length).toBe(1)
    expect(c.calls.map((b) => b.length)).toEqual([BATCH, BATCH, 1])
    // each passage carries its file name and heading
    expect(c.calls.flat().every((t) => /^doc-\d\.docx · Doc \d\n/.test(t))).toBe(true)
    expect(d.vectorCounts()).toEqual({ done: 9, pending: 0 })
    expect(lines.find((l) => l.msg.includes('indexed'))?.x).toMatchObject({ pieces: 9 })
    // the process ends after its idle time
    await Bun.sleep(120)
    expect(c.stops).toBe(1)
    // an update: only the changed document's pieces are embedded again, by a new process
    await d.update('projects/acme', 'doc-3.docx', file(enc('# Doc 3\nPiece three now covers the spring fair.'), 500))
    expect(d.vectorCounts().pending).toBe(1)
    ix.kick()
    await ix.whenIdle()
    expect(children.length).toBe(2)
    expect((children[1] as unknown as Fake).calls).toEqual([['doc-3.docx · Doc 3\n# Doc 3\nPiece three now covers the spring fair.']])
    expect(d.vectorCounts()).toEqual({ done: 9, pending: 0 })
    // nothing to do: no process
    ix.kick()
    await ix.whenIdle()
    expect(children.length).toBe(2)
    ix.close()
    d.destroy()
  })

  test('the memory check: with too little memory nothing starts, one log line, and it waits for the nightly check', async () => {
    const d = await docIndex('lowmem', { 'a.md': '# A\nSomething to embed.' })
    let free = 900
    const { ix, children, lines } = indexer(d, { freeMemoryMiB: () => free })
    ix.kick()
    await ix.whenIdle()
    expect(children.length).toBe(0)
    expect(lines.length).toBe(1)
    expect(lines[0]!.msg).toContain('not enough free memory')
    expect(lines[0]!.x).toEqual({ freeMiB: 900, needMiB: MIN_FREE_MIB })
    // more uploads meanwhile: no start, no more lines
    free = 4000
    ix.kick(); ix.kick()
    await ix.whenIdle()
    expect(children.length).toBe(0)
    expect(lines.length).toBe(1)
    // the nightly check tries again
    ix.kick({ retry: true })
    await ix.whenIdle()
    expect(children.length).toBe(1)
    expect(d.vectorCounts().pending).toBe(0)
    ix.close()
    d.destroy()
  })

  test('the memory limit: a process above it is stopped and its batch done again; too many stops wait for the nightly check', async () => {
    const d = await docIndex('highmem', Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`m-${i}.md`, `# M ${i}\nMemory test piece ${i}.`])))
    // the first process grows above the limit while it embeds its first batch; the next one stays below
    let n = 0
    const { ix, children, lines } = indexer(d, {
      child: () => {
        const first = n++ === 0
        const c = fakeChild({ rss: () => (first ? MAX_RSS_MIB + 100 : 400) })
        const embed = c.embed.bind(c)
        // the first one is slow enough for the memory poll to see it
        c.embed = async (p: string[]) => { if (first) await Bun.sleep(60); return embed(p) }
        return c
      },
    })
    ix.kick()
    await ix.whenIdle()
    expect(children.length).toBe(2)
    expect((children[0] as unknown as Fake).killed).toBeGreaterThanOrEqual(1)
    expect((children[1] as unknown as Fake).killed).toBe(0)
    expect(lines.some((l) => l.msg.includes('above its memory limit') && l.x?.rssMiB === MAX_RSS_MIB + 100)).toBe(true)
    expect(d.vectorCounts()).toEqual({ done: 6, pending: 0 })
    expect(ix.peak()).toBe(MAX_RSS_MIB + 100)
    ix.close()

    // a process that keeps failing: RESTARTS_MAX tries, then one line and nothing until the nightly check
    await d.update('projects/acme', 'm-0.md', file(enc('# M 0\nChanged.'), 900))
    const bad = indexer(d, { child: () => fakeChild({ fail: () => true }) })
    bad.ix.kick()
    await bad.ix.whenIdle()
    expect(bad.children.length).toBe(RESTARTS_MAX)
    expect(bad.lines.filter((l) => l.level === 'warn').length).toBe(1)
    expect(bad.lines[0]!.msg).toContain('nightly check')
    bad.ix.kick()
    await bad.ix.whenIdle()
    expect(bad.children.length).toBe(RESTARTS_MAX)
    bad.ix.close()
    d.destroy()
  })

  test('a model that cannot load (no internet, a wrong file): one line, keyword search goes on, tried again at the nightly check', async () => {
    const d = await docIndex('nomodel', { 'a.md': '# A\nSomething to embed.' })
    const failed = Promise.reject(new Error('model download config.json: HTTP 503'))
    failed.catch(() => {})
    const { ix, children, lines } = indexer(d, { child: () => fakeChild({ ready: failed }) })
    ix.kick(); await ix.whenIdle()
    ix.kick(); await ix.whenIdle()
    expect(children.length).toBe(1)
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatchObject({ level: 'warn' })
    expect(String(lines[0]!.x?.err)).toContain('HTTP 503')
    expect(d.search('something', { rootIds: ['projects/acme'] }).length).toBe(1)
    ix.close()
    d.destroy()
  })

  test('it pauses between batches while someone waits for an answer', async () => {
    const d = await docIndex('pause', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p-${i}.md`, `# P ${i}\nPause test piece ${i}.`])))
    let waiting = false
    let c: Fake | null = null
    const { ix } = indexer(d, {
      peopleWaiting: () => waiting, idleMs: 10_000,
      child: () => {
        c = fakeChild()
        const embed = c.embed.bind(c)
        // someone asks a question while the first batch is being embedded
        c.embed = async (p: string[]) => { const r = await embed(p); if (c!.calls.length === 1) waiting = true; return r }
        return c
      },
    })
    ix.kick()
    await Bun.sleep(150)
    expect(c!.calls.length).toBe(1)
    expect(d.vectorCounts()).toEqual({ done: 4, pending: 4 })
    // the answer is done: the rest goes on
    waiting = false
    await ix.whenIdle()
    expect(c!.calls.length).toBe(2)
    expect(d.vectorCounts().pending).toBe(0)
    ix.close()
    d.destroy()
  })

  test('a long pause ends the process, so its memory goes back to people\'s work', async () => {
    const d = await docIndex('longpause', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`l-${i}.md`, `# L ${i}\nLong pause piece ${i}.`])))
    let waiting = false
    const { ix, children } = indexer(d, {
      peopleWaiting: () => waiting, idleMs: 40,
      // someone asks while the first process embeds its first batch, and waits longer than the idle time
      child: () => { const c = fakeChild(); const first = !children.length; const embed = c.embed.bind(c); c.embed = async (p: string[]) => { const r = await embed(p); if (first) waiting = true; return r }; return c },
    })
    ix.kick()
    await Bun.sleep(150)
    expect((children[0] as unknown as Fake).stops).toBe(1)
    waiting = false
    await ix.whenIdle()
    expect(children.length).toBe(2)
    expect(d.vectorCounts().pending).toBe(0)
    ix.close()
    d.destroy()
  })
})

describe('the embedding process', () => {
  test('its loop: ready first, int8 vectors as base64 in order, a bad request answered, a failed start said once', async () => {
    const sent: WorkerMessage[] = []
    async function* lines() {
      yield JSON.stringify({ id: 1, texts: ['a.md · A\nfirst', 'second'] })
      yield 'not json'
      yield JSON.stringify({ id: 2, texts: [] })
      yield JSON.stringify({ id: 3, texts: ['third'] })
    }
    let disposed = 0
    const open = async (): Promise<Embedder> => { const e = wrapModel({ run: async (t) => t.map(rawVec), dispose() { disposed++ } }); return e }
    await serveEmbed(lines(), (m) => sent.push(m), open)
    expect(sent[0]).toEqual({ ready: true })
    const one = sent[1] as { id: number; vecs: string[] }
    expect(one.id).toBe(1)
    expect(one.vecs.length).toBe(2)
    const v = new Int8Array(Buffer.from(one.vecs[0]!, 'base64'))
    expect(v.length).toBe(MEANING_DIMS)
    expect(Array.from(v)).toEqual(Array.from(quantize(await wrapModel({ run: async (t) => t.map(rawVec), dispose() {} }).embed(['a.md · A\nfirst'], 'passage').then((r) => r[0]!))))
    expect(sent[2]).toEqual({ id: 2, error: 'bad request' })
    expect((sent[3] as { id: number }).id).toBe(3)
    expect(disposed).toBe(1)
    const failed: WorkerMessage[] = []
    await serveEmbed(lines(), (m) => failed.push(m), async () => { throw new Error('model file config.json: SHA-256 abc, expected def') })
    expect(failed).toEqual([{ error: 'model file config.json: SHA-256 abc, expected def' }])
  })

  test('the real process starts below people\'s work and refuses model files that do not match (nothing downloaded)', async () => {
    const script = embedWorkerScript()
    expect(script).toBeTruthy()
    const dir = path.join(tmp, 'child-models')
    const f = path.join(dir, ...MEANING_MODEL.split('/'), 'config.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, '{}')
    const c = startEmbedChild({ modelDir: dir, sharedDir: null, threads: 1, download: false })
    await expect(c.ready).rejects.toThrow(/do not match/)
    await expect(c.embed(['x'])).rejects.toThrow()
    c.stop(true)
    // without its script it does not start
    const none = startEmbedChild({ modelDir: dir, sharedDir: null, threads: 1 }, null)
    await expect(none.ready).rejects.toThrow(/missing/)
  })

  test('the bundles carry it next to main.js', () => {
    expect(linuxBundleFiles({ arch: 'arm64', codexVersion: '0.163.0', whisper: false, systemd: [] })).toContain('server/src/kg-embed-worker.js')
    expect(bundleManifest({ pandoc: true, desktop: false })).toContain('app/server/src/kg-embed-worker.js')
    // the runtime the process loads is external there and vendored next to the server files
    expect(bundleManifest({ pandoc: true, desktop: false })).toContain('app/server/node_modules/@huggingface/transformers/')
  })
})

describe('the switch, as the service wires it', () => {
  let A: CApp
  let kg: KnowledgeGraph
  const children: Fake[] = []
  const put = (rel: string, text: string) => { const p = path.join(A.team, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  const pending = () => { const db = new Database(path.join(A.data, 'knowledge-graph', 'documents', 'documents.db'), { readonly: true }); try { return (db.query('SELECT count(*) AS n FROM chunks WHERE vec IS NULL').get() as { n: number }).n } finally { db.close() } }
  beforeAll(async () => {
    setKnowledgeGraphForTests({
      runner: null, openDocs: openDocumentIndex, debounceMs: 50, maxWaitMs: 500, pauseMinMs: 0, pauseMaxMs: 0,
      meaning: { startChild: () => { const c = fakeChild(); children.push(c); return c }, freeMemoryMiB: () => 8000, idleMs: 50, pausePollMs: 10, memPollMs: 10 },
    })
    A = await makeCApp('c-kg-meaning-index')
    setKnowledgeGraphForTests(undefined)
    kg = knowledgeGraphOf(A.ctx)
    put('shared/meaning/refund.md', '# 환불 정책\n구매 후 7일 이내에는 전액 환불합니다.\n')
    put('shared/meaning/expo.md', '# Expo\nThe expo booth budget is eight million won.\n')
  })
  afterAll(async () => { await A?.close() })
  const indexer = () => (kg as unknown as { meaning: MeaningIndexer | null }).meaning

  test('off unless server.json says true: documents are indexed, nothing is embedded, no process starts', async () => {
    expect(A.ctx.config.knowledgeGraph?.meaning).toBeUndefined()
    expect(kg.meaningOn()).toBe(false)
    kg.checkAll()
    await kg.whenIdle()
    expect(pending()).toBeGreaterThanOrEqual(2)
    expect(children.length).toBe(0)
    expect(indexer()).toBeNull()
    ;(A.ctx.config as { knowledgeGraph?: { meaning?: boolean } }).knowledgeGraph = { meaning: false }
    kg.checkAll()
    await kg.whenIdle()
    expect(kg.meaningOn()).toBe(false)
    expect(children.length).toBe(0)
  })

  test('on: the nightly check embeds what is pending, and a change embeds its new pieces; a running answer pauses it', async () => {
    ;(A.ctx.config as { knowledgeGraph?: { meaning?: boolean } }).knowledgeGraph = { meaning: true }
    expect(kg.meaningOn()).toBe(true)
    // someone is waiting for an answer: a running turn (the chat runtime's state in the turns table)
    A.ctx.db.run('PRAGMA foreign_keys = OFF')
    A.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at) VALUES ('turn-meaning', 'chat-x', 'alice', 'claude', 'running', ?)").run(new Date().toISOString())
    kg.checkAll()
    await kg.whenIdle()
    await Bun.sleep(100)
    expect(pending()).toBeGreaterThanOrEqual(2)
    expect(children.flatMap((c) => c.calls).length).toBe(0)
    A.ctx.db.query("UPDATE turns SET status = 'done', ended_at = ? WHERE id = 'turn-meaning'").run(new Date().toISOString())
    A.ctx.db.run('PRAGMA foreign_keys = ON')
    await indexer()!.whenIdle()
    expect(pending()).toBe(0)
    expect(children.flatMap((c) => c.calls).flat().some((t) => t.startsWith('refund.md\n# 환불 정책'))).toBe(true)
    // a file changes: the service indexes it and then embeds its new pieces
    put('shared/meaning/expo.md', '# Expo\nThe expo booth budget moved to nine million won.\n')
    kg.noteChanges(['shared/meaning/expo.md'])
    await kg.whenIdle()
    await indexer()!.whenIdle()
    expect(pending()).toBe(0)
    expect(children.flatMap((c) => c.calls).flat().some((t) => t.includes('nine million'))).toBe(true)
  })

  test('the documents part off: the indexing ends with it', async () => {
    kg.setDocsEnabled(false)
    expect(kg.meaningOn()).toBe(false)
    expect(indexer()).toBeNull()
    kg.setDocsEnabled(true)
  })
})
