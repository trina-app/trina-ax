// Search by meaning in the knowledge graph (docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, wave 2):
// the contract the meaning index and the combined search share. One model, one vector format, one embedder interface.
//
// - Model: multilingual-e5-small (MIT), 384 dimensions. e5 wants the prefixes "query: " and "passage: ".
// - A piece of a document is embedded as "passage: <file name> · <heading>\n<text>", so the file name and the heading
//   count toward its meaning (the 2026-11-01 lesson: pieces without them lost to generic text).
// - Vectors are L2-normalized and stored as int8 (384 bytes) in documents.db, chunks.vec (NULL until embedded). About
//   38 MB per 100,000 pieces when held in memory; int8 keeps about 97% of the quality.
// - Meaning results are never used alone: the search fuses them with the keyword results by rank (RRF).

export const MEANING_MODEL = 'Xenova/multilingual-e5-small'
export const MEANING_DIMS = 384

/** Turns texts into L2-normalized vectors. `kind` picks the e5 prefix ("query: " or "passage: "), added inside. */
export interface Embedder {
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>
  dispose(): void | Promise<void>
}

/** a heading and a whole passage at most this long: the model reads 512 tokens anyway, and an over-long one (a sheet
 * name of thousands of characters) was refused by the embedding process every time and stopped the indexing for good
 * (review of wave 2) */
export const PASSAGE_HEADING_MAX = 120
export const PASSAGE_MAX = 2000

/** The text a piece is embedded with (the "passage: " prefix is the embedder's): the file name and heading in front,
 * each cut to a sane length, the whole at most PASSAGE_MAX characters. */
export function passageText(fileName: string, heading: string | null, text: string): string {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)
  const head = heading ? ` · ${cut(heading, PASSAGE_HEADING_MAX)}` : ''
  return cut(`${cut(fileName, PASSAGE_HEADING_MAX)}${head}\n${text}`, PASSAGE_MAX)
}

/** An L2-normalized float vector as int8 (each value times 127, rounded, kept within -127..127). */
export function quantize(v: Float32Array): Int8Array {
  const out = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)))
  return out
}

/** The dot product of two int8 vectors of the same length (higher is closer; at most 127 * 127 * dims). */
export function dot8(a: Int8Array, b: Int8Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** An int8 vector as the bytes stored in chunks.vec, and back (null for a missing or wrong-sized value). */
export const vecToBlob = (v: Int8Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
export function blobToVec(b: Uint8Array | null | undefined): Int8Array | null {
  if (!b || b.byteLength !== MEANING_DIMS) return null
  return new Int8Array(b.buffer, b.byteOffset, b.byteLength)
}

/** Reciprocal rank fusion: each list adds 1 / (k + rank) for each id, rank from 1; the usual k is 60. */
export function rrf(lists: readonly (readonly number[])[], k = 60): Map<number, number> {
  const out = new Map<number, number>()
  for (const list of lists) list.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)))
  return out
}
