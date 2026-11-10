// What the knowledge graph's service (service.ts) asks of the document index (knowledge-graph/documents/): the
// documents of each indexed folder as searchable passages, and the links between documents. The service decides which
// files, reads their bytes itself (the file tools' rules: no links, one link to the file, not quarantined, the very
// file it listed) and filters every answer by the asker's access; the index never opens a team path and never decides
// who may see what. rootId is the folder's team path ("projects/web-app"); relPath is relative to it.
import type { SourceLoc } from '@mycel/shared/api'

export interface DocFileState { size: number; mtimeMs: number; failed: string | null }
/** snippet: about 300 characters around the match, on one line. passage: when the search asked for one, up to that many
 * characters of the piece around the match with its line breaks, to answer from (an index without it: the snippet).
 * byMeaning: found by meaning only, not by the keyword search; its strength is at most weak (service.ts docPassages). */
export interface DocHit { rootId: string; relPath: string; loc: SourceLoc | null; snippet: string; passage?: string; score: number; byMeaning?: boolean }
export interface DocSearchOptions {
  rootIds: string[]
  limit: number
  /** also a passage of up to this many characters per hit */
  passage?: number
  /** only files under this folder of the root (relative to it); only given when rootIds is that one root. A narrowing
   * for speed: the caller still filters every hit by its own path. */
  prefix?: string
  /** a Date.now() time: an answer not ready by then is not waited for ([] instead), and one not started is not run
   * (none: the search worker's DEFAULT_DEADLINE_MS) */
  due?: number
  /** search by meaning too, when the index holds vectors for these folders: its closest pieces are fused with the
   * keyword pieces by rank, and left out when not ready before `due` (documents/search-worker.ts). Without it, or
   * without vectors, the keyword search alone, exactly as before. */
  meaning?: boolean
}
/** why two documents are linked: kind is folder · mention · link · terms · people · code; detail is made only from the
 * two documents' own names and text */
export interface DocLink { rootId: string; relPath: string; reason: { kind: string; detail: string } }
export interface DocStats { documents: number; failed: { relPath: string; reason: string }[]; lastUpdatedAt: string | null }

export interface DocIndexPort {
  /** file types it indexes (by name) */
  accepts(name: string): boolean
  /** what it holds for a folder: for change detection */
  files(rootId: string): Map<string, DocFileState>
  /** index one file. bytes null: over the service's read limit (recorded as too_big). Never throws for a bad file:
   * records it as failed with a short reason (too_big, timeout, unreadable, unsupported, empty, error). */
  update(rootId: string, relPath: string, file: { bytes: Uint8Array | null; size: number; mtimeMs: number }, o?: { signal?: AbortSignal }): Promise<{ ok: true; chunks: number } | { ok: false; reason: string }>
  remove(rootId: string, relPath: string): void
  dropRoot(rootId: string): void
  /** off the main thread when it can be (documents/search-worker.ts): a search must never hold the server */
  search(query: string, o: DocSearchOptions): Promise<DocHit[]> | DocHit[]
  /** `due`: an epoch-ms deadline after which a worker-backed index answers [] (the in-process index ignores it) */
  related(rootId: string, relPath: string, o: { rootIds: string[]; limit: number; due?: number }): Promise<DocLink[]> | DocLink[]
  stats(rootId: string): DocStats
  diskBytes(): number
  close(): void
  /** off: everything on disk deleted */
  destroy(): void
  // search by meaning (meaning/indexer.ts); an index without them has no vectors
  /** up to `limit` pieces without a vector yet, the most recently indexed first */
  pendingVectors?(limit: number): PendingPiece[]
  /** vectors of pieces, in one transaction; a piece no longer what its vector was made from is skipped. How many were
   * written. */
  writeVectors?(rows: readonly PieceVector[]): number
  /** pieces with a vector and pieces still without one */
  vectorCounts?(): { done: number; pending: number }
}
/** a piece that needs its vector: what passageText (meaning/vectors.ts) makes its text from */
export interface PendingPiece { id: number; name: string; heading: string | null; text: string }
/** a piece's vector: the passage text it was made from and its int8 bytes (meaning/vectors.ts vecToBlob); empty for a
 * piece that could not be embedded (never asked again, no vector in the search) */
export interface PieceVector { id: number; passage: string; vec: Uint8Array }

export interface DocIndexOptions {
  /** text of a document (the server's converters, isolated, below people's work) */
  extract: (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string>
  /** names of the team's members, for "people" links */
  people: () => string[]
  /** a problem worth a log line (the search worker died, or could not start) */
  warn?: (msg: string, x?: Record<string, unknown>) => void
  /** search by meaning is on: the search worker loads its vectors and model as soon as it starts */
  meaning?: () => boolean
}
export type OpenDocIndex = (dir: string, o: DocIndexOptions) => DocIndexPort
