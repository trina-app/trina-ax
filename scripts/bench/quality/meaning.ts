// Meaning mode of the search quality test: everything that depends on the wave 2 code that other agents build
// (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, steps 9–12), in one file, written against the
// contract (server/src/knowledge-graph/meaning/vectors.ts and embedder.ts):
// - the embedder: openEmbedder() (a stub that throws until the meaning index is merged)
// - the vectors: chunks.vec in documents.db, int8, made from passageText(file name, heading, text) with quantize and
//   vecToBlob; filled here with an UPDATE for every piece that has none
// - the search: DocumentIndex.search with the option `meaning: true` (the combined search adds it); the index is
//   opened with the embedder (`embedder` in its options) so it can embed the question
// When the merged API differs (another option name, the embedder given another way, a helper for the heading), change
// it here only. run.ts reports meaning mode as skipped, with the reason, when any part is missing, and flags combined
// results that never differ from keyword-only ones (the option was most likely ignored).
import { Database } from 'bun:sqlite'
import path from 'node:path'
import type { DocHit, DocumentIndexOptions, SearchOptions } from '../../../server/src/knowledge-graph/documents/index'
import { openEmbedder } from '../../../server/src/knowledge-graph/meaning/embedder'
import { MEANING_DIMS, passageText, quantize, vecToBlob, type Embedder } from '../../../server/src/knowledge-graph/meaning/vectors'

/** the search options of the combined search (wave 2 adds `meaning`) */
export type MeaningSearchOptions = SearchOptions & { meaning?: boolean }
/** the index options with the embedder for questions (the name `embedder` is this test's guess at the merged API) */
export type MeaningIndexOptions = DocumentIndexOptions & { embedder?: Embedder }
type SourceLoc = NonNullable<DocHit['loc']>

/** documents.db has the column the meaning index adds (chunks.vec) */
export function hasVecColumn(dbFile: string): boolean {
  const db = new Database(dbFile, { readonly: true })
  try { return (db.query('PRAGMA table_info(chunks)').all() as { name: string }[]).some((c) => c.name === 'vec') } finally { db.close() }
}

/** the embedder, or why there is none (not merged yet, no model, no network for the first download) */
export async function openMeaning(o: { modelDir: string; sharedDir?: string | null; threads: number }): Promise<{ ok: true; embedder: Embedder; ms: number } | { ok: false; reason: string }> {
  const t = performance.now()
  try {
    const embedder = await openEmbedder({ modelDir: o.modelDir, sharedDir: o.sharedDir ?? null, threads: o.threads })
    const [probe] = await embedder.embed(['probe'], 'query')
    if (!probe || probe.length !== MEANING_DIMS) throw new Error(`the embedder gave ${probe?.length ?? 0} dimensions, not ${MEANING_DIMS}`)
    return { ok: true, embedder, ms: performance.now() - t }
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 300) }
  }
}

/** the heading a piece is embedded with: a section's heading, a sheet's name; none for a page or a slide */
export function headingOf(loc: SourceLoc | null): string | null {
  if (!loc) return null
  if (loc.kind === 'heading') return loc.heading
  if (loc.kind === 'sheet') return loc.sheet
  return null
}

/** embeds every piece without a vector (passageText of its file name, heading and text) and stores it in chunks.vec */
export async function fillVectors(dbFile: string, embedder: Embedder, o: { batch: number; onProgress?: (done: number, total: number) => void }): Promise<{ pieces: number; already: number; ms: number }> {
  const db = new Database(dbFile)
  try {
    db.run('PRAGMA busy_timeout=5000')
    const already = (db.query('SELECT count(*) AS n FROM chunks WHERE vec IS NOT NULL').get() as { n: number }).n
    const rows = db.query('SELECT c.id, c.loc, c.text, d.rel FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.vec IS NULL AND d.failed IS NULL ORDER BY c.id')
      .all() as { id: number; loc: string | null; text: string; rel: string }[]
    const put = db.prepare('UPDATE chunks SET vec = ? WHERE id = ?')
    const t = performance.now()
    for (let i = 0; i < rows.length; i += o.batch) {
      const part = rows.slice(i, i + o.batch)
      const texts = part.map((r) => {
        let loc: SourceLoc | null = null
        try { loc = r.loc ? JSON.parse(r.loc) as SourceLoc : null } catch {}
        return passageText(path.posix.basename(r.rel), headingOf(loc), r.text)
      })
      const vecs = await embedder.embed(texts, 'passage')
      if (vecs.length !== part.length) throw new Error(`the embedder gave ${vecs.length} vectors for ${part.length} texts`)
      db.transaction(() => { part.forEach((r, k) => put.run(vecToBlob(quantize(vecs[k]!)), r.id)) })()
      o.onProgress?.(Math.min(i + o.batch, rows.length), rows.length)
    }
    return { pieces: rows.length, already, ms: performance.now() - t }
  } finally { db.close() }
}

/** how many pieces have a vector, of how many */
export function vectorCount(dbFile: string): { withVec: number; chunks: number } {
  const db = new Database(dbFile, { readonly: true })
  try {
    const r = db.query('SELECT count(*) AS chunks, count(vec) AS withVec FROM chunks').get() as { chunks: number; withVec: number }
    return r
  } finally { db.close() }
}
