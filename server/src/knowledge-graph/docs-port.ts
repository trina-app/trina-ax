// What the knowledge graph's service (service.ts) asks of the document index (knowledge-graph/documents/): the
// documents of each indexed folder as searchable passages, and the links between documents. The service decides which
// files, reads their bytes itself (the file tools' rules: no links, one link to the file, not quarantined, the very
// file it listed) and filters every answer by the asker's access; the index never opens a team path and never decides
// who may see what. rootId is the folder's team path ("projects/web-app"); relPath is relative to it.
import type { SourceLoc } from '@mycel/shared/api'

export interface DocFileState { size: number; mtimeMs: number; failed: string | null }
export interface DocHit { rootId: string; relPath: string; loc: SourceLoc | null; snippet: string; score: number }
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
  search(query: string, o: { rootIds: string[]; limit: number }): Promise<DocHit[]> | DocHit[]
  related(rootId: string, relPath: string, o: { rootIds: string[]; limit: number }): Promise<DocLink[]> | DocLink[]
  stats(rootId: string): DocStats
  diskBytes(): number
  close(): void
  /** off: everything on disk deleted */
  destroy(): void
}

export interface DocIndexOptions {
  /** text of a document (the server's converters, isolated, below people's work) */
  extract: (name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string>
  /** names of the team's members, for "people" links */
  people: () => string[]
}
export type OpenDocIndex = (dir: string, o: DocIndexOptions) => DocIndexPort
