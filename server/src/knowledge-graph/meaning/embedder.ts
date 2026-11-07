// The embedder of search by meaning (contract: meaning/vectors.ts): multilingual-e5-small run on this server with
// transformers.js and onnxruntime. Document text never leaves the server.
//
// - The model files are pinned to one revision and checked against their SHA-256 before anything loads them
//   (MODEL_FILES). They are downloaded into the team's own model folder (<data>/models) when missing or wrong, or
//   taken from a host's read-only shared folder ($MYCEL_MODELS_DIR/semantic) when every file there matches. The
//   library's own download is off (allowRemoteModels = false): it only ever loads the checked files.
// - e5 wants "query: " in front of a question and "passage: " in front of a piece of a document; the prefix is added
//   here. The vectors are mean-pooled over the tokens and L2-normalized (normalized again here, so a loader that
//   returns raw vectors still gives unit vectors).
// - `threads`: ONNX threads. One for the background indexing (meaning/indexer.ts), a few for a person's query.
//
// The same pinned files as the older search by meaning (search/semantic.ts, removed in wave 3), so a server that had
// it downloaded already has the model.
import fs from 'node:fs'
import path from 'node:path'
import { MEANING_DIMS, MEANING_MODEL, type Embedder } from './vectors'

/** The model files at a fixed revision with their SHA-256: downloaded and checked before anything loads them. */
export const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
export const MODEL_FILES: Readonly<Record<string, string>> = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
}

/** A loaded model: pooled vectors for texts that already carry their e5 prefix (any length; normalized here). */
export interface LoadedModel {
  run(texts: string[]): Promise<Float32Array[]>
  dispose(): void | Promise<void>
}

export interface EmbedderOptions {
  /** the team's own model folder (<data>/models): files downloaded there and checked against their pinned hashes */
  modelDir: string
  /** a read-only model folder shared by the teams of a host ($MYCEL_MODELS_DIR/semantic), used when its files match */
  sharedDir?: string | null
  /** ONNX threads (one for indexing in the background, a few for a person's query) */
  threads?: number
  /** false: never download; a missing or wrong file is an error (default true) */
  download?: boolean
  /** tests: the download (default fetch) */
  fetchFn?: typeof fetch
  /** tests: loads the model from a folder whose files were checked (default transformers.js) */
  load?: (dir: string, threads: number | undefined) => Promise<LoadedModel>
}

const sha256File = async (p: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(p).arrayBuffer()).digest('hex')
const modelPath = (dir: string, rel: string) => path.join(dir, ...MEANING_MODEL.split('/'), ...rel.split('/'))

/** Every model file in `dir` is a regular file that matches its hash. Nothing is written. */
export async function modelFilesOk(dir: string): Promise<boolean> {
  for (const [rel, want] of Object.entries(MODEL_FILES)) {
    const f = modelPath(dir, rel)
    try { if (!fs.lstatSync(f).isFile()) return false } catch { return false }
    if (await sha256File(f) !== want) return false
  }
  return true
}

/** <modelDir>/<model>/… with every file present and matching its hash: what is missing or wrong is downloaded from
 * huggingface.co at the pinned revision, checked, and only then put in place. Throws when a file cannot be had. */
export async function ensureModel(modelDir: string, fetchFn: typeof fetch = fetch): Promise<void> {
  for (const [rel, want] of Object.entries(MODEL_FILES)) {
    const dst = modelPath(modelDir, rel)
    if (fs.existsSync(dst) && fs.lstatSync(dst).isFile() && await sha256File(dst) === want) continue
    const res = await fetchFn(`https://huggingface.co/${MEANING_MODEL}/resolve/${MODEL_REVISION}/${rel}`)
    if (!res.ok) throw new Error(`model download ${rel}: HTTP ${res.status}`)
    const tmp = `${dst}.part`
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
    // bytes, not Bun.write(tmp, res): writing the redirected (CDN) response straight to a file hung at 100% CPU
    fs.writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 })
    const got = await sha256File(tmp)
    if (got !== want) { fs.rmSync(tmp, { force: true }); throw new Error(`model file ${rel}: SHA-256 ${got}, expected ${want}`) }
    fs.renameSync(tmp, dst)
  }
}

/** The model in transformers.js, from checked files only: no download by the library, no other folder. */
async function loadTransformers(dir: string, threads: number | undefined): Promise<LoadedModel> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = dir
  env.localModelPath = dir
  env.allowRemoteModels = false
  env.allowLocalModels = true
  // ONNX's CPU memory arena off: it kept the largest batch's buffers (measured on an M-series Mac, one thread, batches
  // of 4 pieces of 512 tokens: about 110 MB less resident memory, 550 instead of 660 MB, and no slower)
  const session_options = { enableCpuMemArena: false, enableMemPattern: false, ...(threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {}) }
  const extractor = await pipeline('feature-extraction', MEANING_MODEL, { dtype: 'q8', session_options })
  return {
    run: async (texts) => {
      // mean pooling over the tokens (padding left out), then L2 normalization; texts longer than the model's 512
      // tokens are cut there by the tokenizer
      const t = await extractor(texts, { pooling: 'mean', normalize: true })
      const flat = t.data as Float32Array
      return texts.map((_, i) => flat.slice(i * MEANING_DIMS, (i + 1) * MEANING_DIMS))
    },
    dispose: () => extractor.dispose(),
  }
}

/** v scaled to length 1 (a zero vector stays zero) */
export function l2normalize(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  const n = Math.sqrt(s)
  if (!n || !Number.isFinite(n)) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n
  return out
}

/** Opens the embedder: the model files ready (checked, downloaded when missing) and loaded. Throws when it cannot. */
export async function openEmbedder(o: EmbedderOptions): Promise<Embedder> {
  let dir: string
  if (o.sharedDir && await modelFilesOk(o.sharedDir)) dir = o.sharedDir
  else {
    if (o.download === false) { if (!await modelFilesOk(o.modelDir)) throw new Error('meaning embedder: the model files are missing or do not match their hashes') }
    else await ensureModel(o.modelDir, o.fetchFn)
    dir = o.modelDir
  }
  const threads = o.threads && o.threads > 0 ? Math.floor(o.threads) : undefined
  return wrapModel(await (o.load ?? loadTransformers)(dir, threads))
}

/** The Embedder of a loaded model: the e5 prefix in front of each text, the shape checked, each vector L2-normalized. */
export function wrapModel(model: LoadedModel): Embedder {
  let disposed = false
  return {
    async embed(texts, kind) {
      if (disposed) throw new Error('meaning embedder: disposed')
      if (!texts.length) return []
      const out = await model.run(texts.map((t) => `${kind}: ${t}`))
      if (out.length !== texts.length || out.some((v) => v.length !== MEANING_DIMS)) throw new Error('meaning embedder: the model gave vectors of another shape')
      return out.map(l2normalize)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await model.dispose()
    },
  }
}
