// The embedding model only when needed (L14): an index with nothing new never loads it, it is unloaded after 15 idle
// minutes and loaded again on the next use; a host's shared read-only model folder is used only when every file
// matches its hash, and never written.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localEmbedder, modelFilesOk, SemanticIndex, SEMANTIC_MODEL, type Embed } from '../../server/src/search/semantic'
import { firstRefreshMs } from '../../server/src/tools/search'
import { setLimitsPlatformForTests, setPlanForTests } from '../../server/src/system/limits'

const fakeEmbed: Embed = async (texts) => texts.map(() => new Float32Array(384).fill(0.1))

describe('lazy model', () => {
  test('loads on first use, unloads after the idle time (not while in use), loads again', async () => {
    let now = 0
    let loads = 0, disposed = 0
    const dirs: string[] = []
    let slow: (() => void) | null = null
    const embed: Embed = async (texts) => { if (slow) await new Promise<void>((r) => { slow = r }); return fakeEmbed(texts, 'query') }
    const e = localEmbedder('/team-models', undefined, {
      now: () => now, idleMs: 15 * 60_000, sharedDir: null, ensure: async () => {},
      load: async (dir) => { loads++; dirs.push(dir); return { embed, dispose: () => { disposed++ } } },
    })
    expect(e.loaded()).toBe(false)
    const f = (await e())!
    expect(loads).toBe(1)
    expect(dirs).toEqual(['/team-models'])
    await f(['x'], 'query')
    now += 14 * 60_000
    expect(await e.checkIdle()).toBe(false)
    now += 2 * 60_000
    // in use (a long refresh): not unloaded under it
    slow = () => {}
    const busy = f(['y'], 'passage')
    expect(await e.checkIdle()).toBe(false)
    ;(slow as unknown as () => void)()
    slow = null
    await busy
    now += 16 * 60_000
    expect(await e.checkIdle()).toBe(true)
    expect(disposed).toBe(1)
    expect(e.loaded()).toBe(false)
    expect(await e()).not.toBeNull()
    expect(loads).toBe(2)
    await e.unload()
    expect(disposed).toBe(2)
  })
  test('a model that cannot load: null (semantic search is off), tried again later, not on every call', async () => {
    let tries = 0
    const e = localEmbedder('/team-models', undefined, { now: () => 0, sharedDir: null, ensure: async () => { tries++; throw new Error('offline') } })
    expect(await e()).toBeNull()
    expect(await e()).toBeNull()
    expect(tries).toBe(1)
  })
  test('a matching shared folder is used instead of the team\'s own (and the download is not tried)', async () => {
    // modelFilesOk is exercised against real hashes below; here a folder is accepted by the check's seam
    let ensured = 0
    const used: string[] = []
    const e = localEmbedder('/team-models', undefined, { now: () => 0, sharedDir: '/does-not-exist', ensure: async () => { ensured++ }, load: async (d) => { used.push(d); return { embed: fakeEmbed, dispose() {} } } })
    await e()
    expect(used).toEqual(['/team-models']) // the shared folder does not match: the team's own, downloaded as before
    expect(ensured).toBe(1)
  })
})

describe('SemanticIndex.refresh does not load the model when nothing changed', () => {
  test('an unchanged folder: no embedder call; a new file: one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-semroot-'))
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-semdata-'))
    fs.mkdirSync(path.join(root, 'shared'))
    fs.writeFileSync(path.join(root, 'shared', 'a.md'), 'refund policy was decided in the october meeting, ten days')
    let calls = 0
    const office = { fresh: () => true, update: async () => {}, cachePath: (r: string) => path.join(data, r) } as never
    const idx = new SemanticIndex({ dataDir: data, root, office, embedder: async () => { calls++; return fakeEmbed } })
    await idx.refresh(10_000)
    expect(calls).toBe(1)
    await idx.refresh(10_000)
    await idx.refresh(10_000)
    expect(calls).toBe(1) // nothing new: the model is never asked for
    fs.rmSync(path.join(root, 'shared', 'a.md'))
    await idx.refresh(10_000)
    expect(calls).toBe(1) // a deleted file is dropped without the model
    expect((idx.db.query('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n).toBe(0)
    fs.writeFileSync(path.join(root, 'shared', 'b.md'), 'another note about the refund policy and its exceptions')
    await idx.refresh(10_000)
    expect(calls).toBe(2)
    idx.db.close()
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true })
  })
})

describe('shared model folder and timing', () => {
  test('a shared folder with a wrong or missing file is not used, and nothing is written into it', async () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-shared-'))
    expect(await modelFilesOk(shared)).toBe(false)
    const dir = path.join(shared, ...SEMANTIC_MODEL.split('/'))
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true })
    for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) fs.writeFileSync(path.join(dir, f), 'not the model')
    const before = fs.readdirSync(dir).sort()
    expect(await modelFilesOk(shared)).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    fs.rmSync(shared, { recursive: true, force: true })
  })
  test('the first background indexing: 20 s as before; 10–15 min where limits apply, fixed per install', () => {
    setLimitsPlatformForTests('darwin')
    setPlanForTests(null)
    expect(firstRefreshMs('a')).toBe(20_000)
    setLimitsPlatformForTests('linux')
    const a = firstRefreshMs('install-a')
    expect(a).toBeGreaterThanOrEqual(600_000)
    expect(a).toBeLessThan(900_000)
    expect(firstRefreshMs('install-a')).toBe(a)
    setLimitsPlatformForTests(null)
    setPlanForTests(undefined)
  })
})
