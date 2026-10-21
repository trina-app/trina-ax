// Search by meaning (server/src/search/semantic.ts) with a stand-in embedder: chunking, incremental indexing,
// deleted files, the visibility filter and ranking. The real model is checked in tests/unit/semantic-model.test.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chunkText, ensureModel, SemanticIndex, type Embed } from '../../server/src/search/semantic'

// letters → a 384-dim count vector (normalized): texts sharing words score high
const fakeEmbed: Embed = async (texts) => texts.map((t) => {
  const v = new Float32Array(384)
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 384; v[h]! += 1 }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
})

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-sem-'))
afterAll(() => fs.rmSync(W, { recursive: true, force: true }))
const root = path.join(W, 'team'), data = path.join(W, 'data')
fs.mkdirSync(data, { recursive: true })
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
put('shared/예약.md', '진료 예약은 평일 오전 9시부터 오후 6시까지 받습니다. 토요일은 오전만 합니다.')
put('groups/재무/예산.md', '광고비 예산은 4분기 4천7백만 원입니다. 인건비 예산 별도.')
put('shared/.hidden.md', '진료 예약 숨김 파일')
put('.system/trash/old.md', '진료 예약 휴지통')
put('shared/photo.png', 'not indexed')

let embeds = 0
const office = { fresh: () => true, update: async () => {}, cachePath: (r: string) => path.join(data, 'textcache', r + '.txt') } as never
const idx = new SemanticIndex({ dataDir: data, root, office, embedder: async () => async (t, k) => { embeds += t.length; return fakeEmbed(t, k) } })

describe('chunkText', () => {
  test('pieces of at most ~800 characters along lines; tiny pieces dropped', () => {
    const c = chunkText(Array.from({ length: 50 }, (_, i) => `${i}번째 줄입니다 회의록 내용 정리`).join('\n'))
    expect(c.length).toBeGreaterThan(1)
    expect(c.every((x) => x.length <= 800)).toBe(true)
    expect(chunkText('a'.repeat(2000))).toHaveLength(3)
    expect(chunkText('짧음\n\n')).toEqual([])
  })
})

describe('SemanticIndex', () => {
  test('indexes text files only, outside dot folders', async () => {
    expect((await idx.refresh()).pending).toBe(0)
    const files = (idx.db.query('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path)
    expect(files).toEqual(['groups/재무/예산.md', 'shared/예약.md'])
  })
  test('a second refresh embeds nothing; a changed file is redone; a deleted one leaves', async () => {
    embeds = 0
    await idx.refresh()
    expect(embeds).toBe(0)
    put('shared/예약.md', '진료 예약은 평일 오전 9시부터 오후 7시까지로 바뀌었습니다. 토요일 휴진.')
    fs.utimesSync(path.join(root, 'shared/예약.md'), new Date(), new Date(Date.now() + 5000))
    await idx.refresh()
    expect(embeds).toBe(1)
    put('shared/임시.md', '임시 메모 파일 삭제 예정입니다 진료')
    await idx.refresh()
    fs.rmSync(path.join(root, 'shared/임시.md'))
    await idx.refresh()
    expect(idx.db.query("SELECT count(*) AS n FROM chunks WHERE path = 'shared/임시.md'").get()).toEqual({ n: 0 })
  })
  test('query: closest first, only files the person may see', async () => {
    const all = await idx.query('진료 예약 시간', () => true)
    expect(all?.[0]?.path).toBe('shared/예약.md')
    const noShared = await idx.query('진료 예약 시간', (p) => !p.startsWith('shared/'))
    expect(noShared?.map((h) => h.path)).toEqual(['groups/재무/예산.md'])
    expect((await idx.query('광고비 예산', () => true))?.[0]?.path).toBe('groups/재무/예산.md')
  })
  test('no embedder (model unavailable): refresh does nothing, query says null', async () => {
    const off = new SemanticIndex({ dataDir: fs.mkdtempSync(path.join(W, 'd')), root, office, embedder: async () => null })
    expect(await off.refresh()).toEqual({ pending: 0 })
    expect(await off.query('x', () => true)).toBeNull()
  })
})

describe('model files', () => {
  test('a downloaded file with the wrong SHA-256 is refused and not kept', async () => {
    const dir = fs.mkdtempSync(path.join(W, 'm'))
    let asked = ''
    const fake = (async (u: string) => { asked = String(u); return new Response('not the model') }) as unknown as typeof fetch
    await expect(ensureModel(dir, fake)).rejects.toThrow(/SHA-256/)
    expect(asked).toContain('/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/')
    expect(fs.readdirSync(path.join(dir, 'Xenova', 'multilingual-e5-small'))).toEqual([])
  })
})
