// Search by meaning: the team folder's text (plain text files, and office / PDF / Hangul documents through grep's
// text cache) cut into ~800-character chunks, embedded on this machine with multilingual-e5-small (Korean and
// English, ~120 MB, downloaded once into <data>/models, then offline), kept in <data>/semantic.db. A query returns
// the closest chunks of the files the person may read (the same visibility check as grep), for the AI's search tool.
// No document text leaves the server. Off on machines where the model runtime can't load (Intel Macs: onnxruntime
// ships darwin-arm64 only) or with MYCEL_SEMANTIC=off; the AI then has grep only, as before.
import { Database } from 'bun:sqlite'
import { SearchAdmission } from '../files/search-admission'
import type { Quarantine } from '../safe-ops/quarantine'
import { sha256 } from '../files/store'
import fs from 'node:fs'
import path from 'node:path'
import { isOffice } from '../files/extract'
import type { OfficeCache } from '../files/search'
import { onnxThreads } from '../system/limits'

export const SEMANTIC_MODEL = 'Xenova/multilingual-e5-small'
const DIM = 384
const CHUNK = 800
const FILE_TEXT_MAX = 2 * 1024 * 1024
const CHUNKS_PER_FILE_MAX = 300
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'html', 'htm', 'xml', 'log', 'rtf', 'tex', 'srt', 'vtt'])
const BATCH = 16
const RETRY_MS = 10 * 60_000

export type Embed = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>

/** The model files at a fixed revision with their SHA-256: downloaded and checked before anything loads them. */
const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
const MODEL_FILES: Record<string, string> = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
}

const sha256File = async (p: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(p).arrayBuffer()).digest('hex')

/** <modelDir>/<model>/… with every file present and matching its hash (downloads what is missing or wrong). */
export async function ensureModel(modelDir: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const dir = path.join(modelDir, ...SEMANTIC_MODEL.split('/'))
  for (const [rel, want] of Object.entries(MODEL_FILES)) {
    const dst = path.join(dir, ...rel.split('/'))
    if (fs.existsSync(dst) && await sha256File(dst) === want) continue
    const res = await fetchFn(`https://huggingface.co/${SEMANTIC_MODEL}/resolve/${MODEL_REVISION}/${rel}`)
    if (!res.ok) throw new Error(`model download ${rel}: HTTP ${res.status}`)
    const tmp = `${dst}.part`
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    // bytes, not Bun.write(tmp, res): writing the redirected (CDN) response straight to a file hung at 100% CPU
    fs.writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()))
    const got = await sha256File(tmp)
    if (got !== want) { fs.rmSync(tmp, { force: true }); throw new Error(`model file ${rel}: SHA-256 ${got}, expected ${want}`) }
    fs.renameSync(tmp, dst)
  }
}

/** Every model file in `dir` matches its hash (a read-only shared folder is used only then; nothing is written there).
 * Checked once per file version per process: the ONNX file is ~120 MB. */
const verified = new Map<string, string>()
export async function modelFilesOk(dir: string): Promise<boolean> {
  const base = path.join(dir, ...SEMANTIC_MODEL.split('/'))
  for (const [rel, want] of Object.entries(MODEL_FILES)) {
    const f = path.join(base, ...rel.split('/'))
    let st: fs.Stats
    try { st = fs.statSync(f) } catch { return false }
    if (!st.isFile()) return false
    const key = `${f}:${st.size}:${st.mtimeMs}`
    if (verified.get(f) === key) continue
    if (await sha256File(f) !== want) return false
    verified.set(f, key)
  }
  return true
}

export interface LoadedModel { embed: Embed; dispose(): Promise<void> | void }
export interface EmbedderOptions {
  /** read-only model folder shared by the teams of a host ($MYCEL_MODELS_DIR/semantic): used when its files match
   * their hashes, never written; otherwise the model is downloaded into the team's own folder as before */
  sharedDir?: string | null
  /** unload the model after this long without use (default 15 minutes): it holds 150–300 MB */
  idleMs?: number
  /** ONNX threads (default system/limits.ts onnxThreads(): at most 2 where the limits apply) */
  threads?: () => { intraOpNumThreads: number; interOpNumThreads: number } | null
  /** tests: load a model from a folder */
  load?: (dir: string) => Promise<LoadedModel>
  /** tests: the model download (ensureModel) */
  fetchFn?: typeof fetch
  /** tests: what makes the team's own model folder ready (default ensureModel: check the hashes, download what is missing) */
  ensure?: (dir: string) => Promise<void>
  now?: () => number
}
export type Embedder = (() => Promise<Embed | null>) & {
  /** the model is in memory now */
  loaded(): boolean
  /** unload now if it was idle long enough (the timer calls it every minute; tests call it with their clock) */
  checkIdle(): Promise<boolean>
  /** unload now (server shutdown) */
  unload(): Promise<void>
}

async function loadTransformers(dir: string, threads: { intraOpNumThreads: number; interOpNumThreads: number } | null): Promise<LoadedModel> {
  const { pipeline, env } = await import('@huggingface/transformers')
  // only the files checked above: no download by the library itself
  env.cacheDir = dir
  env.localModelPath = dir
  env.allowRemoteModels = false
  env.allowLocalModels = true
  const extractor = await pipeline('feature-extraction', SEMANTIC_MODEL, { dtype: 'q8', ...(threads ? { session_options: threads } : {}) })
  return {
    embed: async (texts: string[], kind: 'query' | 'passage') => {
      const t = await extractor(texts.map((x) => `${kind}: ${x}`), { pooling: 'mean', normalize: true })
      const flat = t.data as Float32Array
      return texts.map((_, i) => flat.slice(i * DIM, (i + 1) * DIM))
    },
    dispose: () => extractor.dispose(),
  }
}

/**
 * The local embedding model, loaded when first needed (null when the runtime or the model can't load) and unloaded
 * after `idleMs` without use: an index with nothing new to embed never loads it (SemanticIndex.refresh), so an idle
 * team's server does not keep 150–300 MB for it.
 */
export function localEmbedder(modelDir: string, log?: { warn(m: string, d?: object): void }, o: EmbedderOptions = {}): Embedder {
  const now = o.now ?? Date.now
  const idleMs = o.idleMs ?? 15 * 60_000
  let ready: Promise<LoadedModel | null> | null = null
  let model: LoadedModel | null = null
  let lastUse = 0
  let busy = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const unload = async () => {
    const p = ready
    ready = null
    model = null
    if (timer) { clearInterval(timer); timer = null }
    const m = await p?.catch(() => null)
    try { await m?.dispose() } catch (e) { log?.warn('embedding model unload failed', { err: String(e).slice(0, 200) }) }
  }
  const checkIdle = async () => {
    if (!model || busy > 0 || now() - lastUse < idleMs) return false
    await unload()
    return true
  }
  const get = async (): Promise<Embed | null> => {
    ready ??= (async () => {
      try {
        const dir = o.sharedDir && await modelFilesOk(o.sharedDir) ? o.sharedDir : (await (o.ensure ? o.ensure(modelDir) : ensureModel(modelDir, o.fetchFn)), modelDir)
        const m = await (o.load ? o.load(dir) : loadTransformers(dir, (o.threads ?? onnxThreads)()))
        model = m
        if (!timer && !o.now) { timer = setInterval(() => { void checkIdle() }, Math.min(60_000, idleMs)); (timer as { unref?: () => void }).unref?.() }
        return m
      } catch (e) {
        log?.warn('semantic search is off: the embedding model could not load', { err: String(e).slice(0, 300) })
        // try again later (no internet at the first start, a download cut off): not on every query
        const p = ready
        setTimeout(() => { if (ready === p) ready = null }, RETRY_MS).unref?.()
        return null
      }
    })()
    const m = await ready
    if (!m) return null
    lastUse = now()
    return async (texts, kind) => {
      busy++
      try { return await m.embed(texts, kind) } finally { busy--; lastUse = now() }
    }
  }
  return Object.assign(get, { loaded: () => model !== null, checkIdle, unload })
}

/** ~800-character pieces along paragraph / line breaks, long lines cut. */
export function chunkText(text: string): string[] {
  const out: string[] = []
  let cur = ''
  const push = () => { const c = cur.trim(); if (c) out.push(c); cur = '' }
  for (const raw of text.split(/\n/)) {
    let line = raw.replace(/[ \t\f\v]+/g, ' ').trimEnd()
    while (line.length > CHUNK) { if (cur) push(); out.push(line.slice(0, CHUNK).trim()); line = line.slice(CHUNK) }
    if (cur.length + line.length + 1 > CHUNK) push()
    cur += (cur ? '\n' : '') + line
  }
  push()
  return out.filter((c) => c.replace(/\s/g, '').length >= 10)
}

export interface SemanticHit { path: string; score: number; text: string }

export class SemanticIndex {
  readonly db: Database
  private cache: { paths: string[]; texts: string[]; hashes: string[]; vecs: Float32Array } | null = null
  private running: Promise<{ pending: number }> | null = null

  constructor(private o: { dataDir: string; root: string; office: OfficeCache; embedder: () => Promise<Embed | null>; quarantine?: Quarantine }) {
    this.db = new Database(path.join(o.dataDir, 'semantic.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (path TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (path, n));`)
    if (!(this.db.query('PRAGMA table_info(files)').all() as {name:string}[]).some(c => c.name === 'source_hash')) {
      // Rebuild old cached text: it has no source hash to check after replacement.
      this.db.exec('ALTER TABLE files ADD COLUMN source_hash TEXT; DELETE FROM chunks; DELETE FROM files;')
    }
    const model = (this.db.query("SELECT v FROM meta WHERE k = 'model'").get() as { v: string } | null)?.v
    if (model !== SEMANTIC_MODEL) {
      this.db.exec('DELETE FROM chunks; DELETE FROM files;')
      this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('model', ?)").run(SEMANTIC_MODEL)
    }
  }

  /** Files the index can hold: plain text and documents, outside dot folders (.system: trash, history, backups). */
  private walk(): Map<string, fs.Stats> {
    const found = new Map<string, fs.Stats>()
    const visit = (rel: string[]) => {
      let names: string[]
      try { names = fs.readdirSync(path.join(this.o.root, ...rel)) } catch { return }
      for (const n of names) {
        if (n.startsWith('.')) continue
        const segs = [...rel, n]
        let st: fs.Stats
        try {
          const abs = path.join(this.o.root, ...segs)
          st = fs.lstatSync(abs)
          if (st.isFile() && this.o.quarantine?.hasFile(abs)) continue
        } catch { continue }
        if (st.isDirectory()) visit(segs)
        else if (st.isFile() && st.nlink === 1) {
          const ext = (/\.([^./]+)$/.exec(n)?.[1] ?? '').toLowerCase()
          if (TEXT_EXT.has(ext) || isOffice(n)) found.set(segs.join('/'), st)
        }
      }
    }
    visit([])
    return found
  }

  private async textOf(rel: string, admission: SearchAdmission): Promise<{text: string; hash: string}> {
    const abs = path.join(this.o.root, rel)
    const input = admission.read(abs, () => {
      if (this.o.quarantine?.hasFile(abs)) return false
      return fs.lstatSync(abs)
    })
    if (!input) return {text:'', hash:''}
    const hash = sha256(input.bytes)
    if (isOffice(rel)) {
      if (!this.o.office.fresh(rel, input.st)) await this.o.office.update(rel)
      if (!this.o.office.fresh(rel, input.st)) return {text:'',hash}
      const cache = this.o.office.cachePath(rel)
      const text = admission.read(cache, () => fs.lstatSync(cache))
      return {text: text ? text.bytes.toString('utf8').slice(0, FILE_TEXT_MAX) : '', hash}
    }
    const buf = input.bytes.subarray(0, FILE_TEXT_MAX)
    return {text: buf.subarray(0, 8000).includes(0) ? '' : buf.toString('utf8'), hash}
  }

  /** Bring the index up to date: new / changed files are embedded (at most `budgetMs` now, the rest stays pending). */
  refresh(budgetMs = 3000): Promise<{ pending: number }> {
    return (this.running ??= this.doRefresh(budgetMs).finally(() => { this.running = null }))
  }

  private async doRefresh(budgetMs: number): Promise<{ pending: number }> {
    // the folder is compared first: with nothing new or changed the model is not loaded at all (it is 150–300 MB)
    const now = this.walk()
    const known = new Map((this.db.query('SELECT path, mtime, size FROM files').all() as { path: string; mtime: number; size: number }[]).map((r) => [r.path, r]))
    let changed = false
    for (const p of known.keys()) if (!now.has(p)) { this.drop(p); changed = true }
    const stale = [...now].filter(([p, st]) => { const k = known.get(p); return !k || k.mtime !== Math.floor(st.mtimeMs) || k.size !== st.size })
    if (!stale.length) { if (changed) this.cache = null; return { pending: 0 } }
    const embed = await this.o.embedder()
    if (!embed) { if (changed) this.cache = null; return { pending: 0 } }
    // newest first: what people just saved is what they ask about
    stale.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    const until = Date.now() + budgetMs
    let done = 0
    for (const [p, st] of stale) {
      if (Date.now() > until) break
      const admission = new SearchAdmission(this.o.quarantine)
      try {
      const input = await this.textOf(p, admission).catch(() => ({text:'',hash:''}))
      const chunks = chunkText(input.text).slice(0, CHUNKS_PER_FILE_MAX)
      const vecs: Float32Array[] = []
      for (let i = 0; i < chunks.length; i += BATCH) vecs.push(...await embed(chunks.slice(i, i + BATCH), 'passage'))
      this.db.transaction(() => {
        this.db.query('DELETE FROM chunks WHERE path = ?').run(p)
        const ins = this.db.query('INSERT INTO chunks (path, n, text, vec) VALUES (?, ?, ?, ?)')
        chunks.forEach((c, i) => ins.run(p, i, c, new Uint8Array(vecs[i]!.buffer, vecs[i]!.byteOffset, vecs[i]!.byteLength)))
        this.db.query('INSERT OR REPLACE INTO files (path, mtime, size, source_hash) VALUES (?, ?, ?, ?)').run(p, Math.floor(st.mtimeMs), st.size, input.hash)
      })()
      changed = true
      done++
      } finally { admission.close() }
    }
    if (changed) this.cache = null
    return { pending: stale.length - done }
  }

  private drop(p: string) {
    this.db.query('DELETE FROM chunks WHERE path = ?').run(p)
    this.db.query('DELETE FROM files WHERE path = ?').run(p)
  }

  private load() {
    if (this.cache) return this.cache
    const rows = this.db.query('SELECT c.path, c.text, c.vec, f.source_hash FROM chunks c JOIN files f ON f.path=c.path').all() as { path: string; text: string; source_hash: string; vec: Uint8Array }[]
    const vecs = new Float32Array(rows.length * DIM)
    rows.forEach((r, i) => vecs.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, DIM), i * DIM))
    return (this.cache = { paths: rows.map((r) => r.path), texts: rows.map((r) => r.text), hashes: rows.map((r) => r.source_hash), vecs })
  }

  /** Closest chunks among the files `visible` allows (best chunk per file first, then more chunks), at most `limit`. */
  async query(q: string, visible: (path: string) => boolean, limit = 8): Promise<SemanticHit[] | null> {
    const embed = await this.o.embedder()
    if (!embed) return null
    const [qv] = await embed([q], 'query')
    const admission = new SearchAdmission(this.o.quarantine)
    return admission.transaction(() => {
    // Keep provenance with the cached text: another index connection may refresh
    // its files table while this process still holds an older in-memory vector.
    const { paths, texts, hashes, vecs } = this.load()
    const allowed = new Map<string, boolean>()
    const scored: SemanticHit[] = []
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]!
      let ok = allowed.get(p)
      if (ok === undefined) {
        try { ok = visible(p) && !this.o.quarantine?.hasHash(hashes[i] ?? '') && !this.o.quarantine?.hasFile(path.join(this.o.root,p)) } catch { ok = false }
        allowed.set(p, ok)
      }
      if (!ok) continue
      let s = 0
      for (let k = 0, o = i * DIM; k < DIM; k++) s += vecs[o + k]! * qv![k]!
      scored.push({ path: p, score: s, text: texts[i]! })
    }
    scored.sort((a, b) => b.score - a.score)
    // one chunk per file first so a long document doesn't fill the list, then the next best chunks
    const firsts = new Set<string>()
    const top: SemanticHit[] = []
    for (const h of scored) { if (top.length >= limit) break; if (!firsts.has(h.path)) { firsts.add(h.path); top.push(h) } }
    for (const h of scored) { if (top.length >= limit) break; if (!top.includes(h)) top.push(h) }
    return top
    })
  }
}
