// The background process of search by meaning: it turns pieces of documents into vectors and does nothing else.
// meaning/indexer.ts starts it below people's work, sends it batches, writes the vectors into documents.db itself,
// watches its memory and ends it when there is nothing left to do.
//
// - Protocol: one JSON object per line. On stdout, first {"ready":true} once the model is loaded, or {"error":…} and
//   the process ends. On stdin, {"id":n,"texts":[…]} (passage texts, meaning/vectors.ts passageText); the answer is
//   {"id":n,"vecs":[…]} with each vector as base64 of its int8 bytes (quantize), or {"id":n,"error":…}.
// - One request at a time, in order. stdin closed (the server ended it, or the server itself is gone): the model is
//   unloaded and the process ends. As a safety it also ends after `idleMs` without a request.
// - Only protocol lines go to stdout: the libraries' console output goes to stderr.
// - Its settings come as one JSON argument (EmbedWorkerConfig), never from the environment.
//
// Built next to main.js as kg-embed-worker.js in the bundles (scripts/build-bundle.ts and scripts/build-office.ts
// ENTRIES); @huggingface/transformers is external there and resolves from the server's node_modules
// (scripts/vendor-semantic.ts). Run as TypeScript in a repository checkout.
import { openEmbedder } from './embedder'
import { quantize, type Embedder } from './vectors'

export interface EmbedWorkerConfig {
  modelDir: string
  sharedDir: string | null
  threads: number
  /** false: never download the model (tests) */
  download?: boolean
  /** end after this long without a request */
  idleMs?: number
}
export type WorkerRequest = { id: number; texts: string[] }
export type WorkerMessage = { ready: true } | { error: string } | { id: number; vecs: string[] } | { id: number; error: string }

/** texts per request and characters per text the worker takes (the indexer sends 4 pieces of at most ~1,700) */
export const REQUEST_TEXTS_MAX = 16
export const TEXT_CHARS_MAX = 8000

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300)

/** The worker's loop over request lines: the embedder opened first (its failure is the one message), then each
 * request answered in order. Ends when the lines end. */
export async function serveEmbed(lines: AsyncIterable<string>, send: (m: WorkerMessage) => void, open: () => Promise<Embedder>, onRequest: () => void = () => {}): Promise<void> {
  let emb: Embedder
  try { emb = await open() } catch (e) { send({ error: errText(e) }); return }
  send({ ready: true })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      onRequest()
      let req: WorkerRequest
      try { req = JSON.parse(line) } catch { continue }
      const id = Number(req?.id)
      if (!Number.isSafeInteger(id)) continue
      const texts = req.texts
      if (!Array.isArray(texts) || !texts.length || texts.length > REQUEST_TEXTS_MAX || texts.some((t) => typeof t !== 'string' || t.length > TEXT_CHARS_MAX)) {
        send({ id, error: 'bad request' })
        continue
      }
      try {
        const vecs = await emb.embed(texts, 'passage')
        send({ id, vecs: vecs.map((v) => { const q = quantize(v); return Buffer.from(q.buffer, q.byteOffset, q.byteLength).toString('base64') }) })
      } catch (e) { send({ id, error: errText(e) }) }
    }
  } finally { try { await emb.dispose() } catch {} }
}

async function* stdinLines(): AsyncIterable<string> {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { yield buf.slice(0, i); buf = buf.slice(i + 1) }
  }
  if (buf.trim()) yield buf
}

if (import.meta.main) {
  // stdout carries the protocol only
  console.log = console.info = console.debug = console.warn = console.error
  let cfg: EmbedWorkerConfig
  try { cfg = JSON.parse(process.argv[2] ?? '') } catch { process.stdout.write(JSON.stringify({ error: 'no settings' }) + '\n'); process.exit(2) }
  const idleMs = cfg.idleMs && cfg.idleMs > 0 ? cfg.idleMs : 10 * 60_000
  let idle: ReturnType<typeof setTimeout> | undefined
  const awake = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), idleMs) }
  awake()
  await serveEmbed(stdinLines(), (m) => { process.stdout.write(JSON.stringify(m) + '\n') }, async () => {
    const e = await openEmbedder({ modelDir: cfg.modelDir, sharedDir: cfg.sharedDir, threads: cfg.threads, download: cfg.download !== false })
    // loading parses the tokenizer (a 250,000-word vocabulary) and reads the model file into memory: that garbage goes
    // before the first batch, so the memory the indexer watches is the working set
    Bun.gc(true)
    return e
  }, awake)
  process.exit(0)
}
