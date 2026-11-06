// Knowledge graph (server/src/knowledge-graph/, docs/KNOWLEDGE-GRAPH.md): a code map of the team folders that hold code,
// made by CodeGraph (an optional tool installed on the server) and kept up to date when files change. The AI asks it
// with knowledge_explore; every answer is filtered by the person's folder access. Admins turn it on or off, see what is
// indexed and rebuild it. Owner: C (server/src/routes/knowledge-graph.ts).
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
})
export type KnowledgeGraphStatus = z.infer<typeof KnowledgeGraphStatus>

export const UpdateKnowledgeGraphBody = z.object({
  enabled: z.boolean().optional(),
  /** the whole list of added folders (team paths of existing folders, outside users/) */
  added: z.array(z.string().min(1).max(500)).max(50).optional(),
}).strict()

export const RebuildKnowledgeGraphBody = z.object({
  /** one indexed folder; absent: all of them */
  path: z.string().min(1).max(500).optional(),
}).strict()

export const KNOWLEDGE_GRAPH = {
  knowledgeGraphStatus: endpoint({ method: 'GET', path: '/api/admin/knowledge-graph', auth: 'admin', owner: 'C', response: KnowledgeGraphStatus, summary: 'The knowledge graph: whether CodeGraph is here, on or off, the indexed folders with file and symbol counts, disk use.' }),
  updateKnowledgeGraph: endpoint({ method: 'PATCH', path: '/api/admin/knowledge-graph', auth: 'admin', owner: 'C', body: UpdateKnowledgeGraphBody, response: KnowledgeGraphStatus, summary: 'Turn the knowledge graph on or off (off deletes the indexes) and set the added folders; audited.' }),
  rebuildKnowledgeGraph: endpoint({ method: 'POST', path: '/api/admin/knowledge-graph/rebuild', auth: 'admin', owner: 'C', status: 202, body: RebuildKnowledgeGraphBody, response: KnowledgeGraphStatus, summary: 'Make the index of one folder or of all again from the files, in the background; audited.' }),
} as const
