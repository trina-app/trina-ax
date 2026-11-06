import type { Spec } from './cases'

// The knowledge graph's admin routes (Admin › Team settings › Knowledge graph; docs/KNOWLEDGE-GRAPH.md). Admins and the
// owner only. The status names indexed folders and counts, never a file, and personal folders only as a total: an
// allowed answer must not name a users/ path. The access filter of the AI's answers is tested in
// tests/unit/c-knowledge-graph.test.ts.
const noPersonalPaths = (r: { status: number; text: string }) => {
  if (r.status === 200 && r.text.includes('users/')) throw new Error('the knowledge graph status names a personal folder')
}
export const KNOWLEDGE_GRAPH_SPECS: Record<string, Spec> = {
  knowledgeGraphStatus: { build: (c) => c.get('/api/admin/knowledge-graph'), scope: 'byLevel', check: noPersonalPaths },
  // an empty change: answers the status, changes nothing
  updateKnowledgeGraph: { build: (c) => c.patch('/api/admin/knowledge-graph', {}), scope: 'byLevel', check: noPersonalPaths },
  // needs the knowledge graph on (CodeGraph installed): 409 on a server without it, so the allowed side is in the unit test
  rebuildKnowledgeGraph: { skipPositive: true, build: (c) => c.post('/api/admin/knowledge-graph/rebuild', {}), scope: 'byLevel' },
}
