// Knowledge graph (server/src/knowledge-graph/, docs/KNOWLEDGE-GRAPH.md): the team folders' documents (a built-in text
// index with links between documents, on every server) and their code (a code map made by CodeGraph, an optional tool
// installed on the server), kept up to date when files change. The AI asks it with knowledge_explore; every answer is
// filtered by the person's folder access. Admins turn each part on or off, see what is indexed and rebuild it.
// Owner: C (server/src/routes/knowledge-graph.ts). The top-level fields are the code part; `documents` the documents.
import { z } from 'zod'
import { endpoint } from './endpoint'

/** pending: waiting for its turn · indexing: being made now · ready · error (last run failed; the last good index
 * stays in use) · too_big (more code than one index takes: not indexed) */
export const KnowledgeGraphRootStatus = z.enum(['pending', 'indexing', 'ready', 'error', 'too_big'])
export type KnowledgeGraphRootStatus = z.infer<typeof KnowledgeGraphRootStatus>

export const KnowledgeGraphRoot = z.object({
  /** team path of the folder (projects/web-app, shared, connected/nas) */
  path: z.string(),
  /** why it is indexed: a folder with code (auto) or one an admin added (added) */
  source: z.enum(['auto', 'added']),
  status: KnowledgeGraphRootStatus,
  files: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  lastSyncAt: z.string().nullable(),
})
export type KnowledgeGraphRoot = z.infer<typeof KnowledgeGraphRoot>

/** One indexed folder's documents. */
export const KnowledgeGraphDocFolder = z.object({
  path: z.string(),
  source: z.enum(['auto', 'added']),
  /** pending · indexing · ready · error (the last run failed; what was indexed stays) · too_big (not indexed) */
  status: KnowledgeGraphRootStatus,
  documents: z.number().int().nonnegative(),
  /** files of a supported type that could not be read (see `failed` for which) */
  failed: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
})
export type KnowledgeGraphDocFolder = z.infer<typeof KnowledgeGraphDocFolder>

/** A document that could not be indexed, and why: too_big · timeout · unreadable · unsupported · empty · error */
export const KnowledgeGraphFailedDoc = z.object({ path: z.string(), reason: z.string().max(40) })
export type KnowledgeGraphFailedDoc = z.infer<typeof KnowledgeGraphFailedDoc>

export const KnowledgeGraphDocuments = z.object({
  /** on (default) or off; needs nothing installed */
  enabled: z.boolean(),
  /** folders with documents, outside personal folders */
  folders: z.array(KnowledgeGraphDocFolder),
  /** personal folders only as a total: admins do not see what is in them */
  personal: z.object({ folders: z.number().int().nonnegative(), documents: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }),
  /** documents indexed in the folders above (personal folders not counted) */
  documents: z.number().int().nonnegative(),
  /** the documents that failed, outside personal folders (at most 100; failedCount has them all) */
  failed: z.array(KnowledgeGraphFailedDoc).max(100),
  failedCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
  /** bytes the document index uses in the server's data folder */
  diskBytes: z.number().int().nonnegative(),
  /** folders waiting for or in a run */
  busy: z.number().int().nonnegative(),
})
export type KnowledgeGraphDocuments = z.infer<typeof KnowledgeGraphDocuments>

export const KnowledgeGraphStatus = z.object({
  /** CodeGraph was found on this server (PATH, or knowledgeGraph.codegraph in server.json) */
  available: z.boolean(),
  /** its version (codegraph --version), when found */
  version: z.string().nullable(),
  /** on now (an admin's choice; not chosen: on when CodeGraph is available) */
  enabled: z.boolean(),
  /** the team folders indexed, outside personal folders */
  roots: z.array(KnowledgeGraphRoot),
  /** personal folders (users/<id>) are indexed too, but shown only as a total: admins do not see what is in them */
  personal: z.object({ folders: z.number().int().nonnegative(), files: z.number().int().nonnegative(), symbols: z.number().int().nonnegative() }),
  /** folders an admin asked for besides the automatic ones */
  added: z.array(z.string()),
  /** bytes the indexes and their copies of the code use in the server's data folder */
  diskBytes: z.number().int().nonnegative(),
  /** folders waiting for or in a run */
  busy: z.number().int().nonnegative(),
  /** the documents part (built in, on every server) */
  documents: KnowledgeGraphDocuments,
})
export type KnowledgeGraphStatus = z.infer<typeof KnowledgeGraphStatus>

export const UpdateKnowledgeGraphBody = z.object({
  /** the code part (needs CodeGraph) */
  enabled: z.boolean().optional(),
  /** the documents part; off deletes the document index */
  documents: z.boolean().optional(),
  /** the whole list of added folders (team paths of existing folders, outside users/) */
  added: z.array(z.string().min(1).max(500)).max(50).optional(),
}).strict()

export const RebuildKnowledgeGraphBody = z.object({
  /** one indexed folder; absent: all of them */
  path: z.string().min(1).max(500).optional(),
  /** only the code or only the documents; absent: both */
  part: z.enum(['code', 'documents']).optional(),
}).strict()

export const KNOWLEDGE_GRAPH = {
  knowledgeGraphStatus: endpoint({ method: 'GET', path: '/api/admin/knowledge-graph', auth: 'admin', owner: 'C', response: KnowledgeGraphStatus, summary: 'The knowledge graph: documents (folders, counts, failed files, last update) and code (whether CodeGraph is here, folders with file and symbol counts), on or off, disk use.' }),
  updateKnowledgeGraph: endpoint({ method: 'PATCH', path: '/api/admin/knowledge-graph', auth: 'admin', owner: 'C', body: UpdateKnowledgeGraphBody, response: KnowledgeGraphStatus, summary: 'Turn the code or documents part on or off (off deletes that index) and set the added folders; audited.' }),
  rebuildKnowledgeGraph: endpoint({ method: 'POST', path: '/api/admin/knowledge-graph/rebuild', auth: 'admin', owner: 'C', status: 202, body: RebuildKnowledgeGraphBody, response: KnowledgeGraphStatus, summary: 'Make the index of one folder or of all (code, documents or both) again from the files, in the background; audited.' }),
} as const
