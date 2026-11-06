// Admin › Team settings › Knowledge graph (shared/src/api/knowledge-graph.ts; server/src/knowledge-graph/). Registered by
// the files module (component C). Admins see the indexed folders with their counts, never a file of them; personal
// folders only as a total.
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { Denied } from '../policy/errors'
import { KgError, knowledgeGraphOf } from '../knowledge-graph/service'

export function registerKnowledgeGraphRoutes(kit: RouteKit, ctx: AppContext) {
  const kg = () => knowledgeGraphOf(ctx)
  kit.handle(API.knowledgeGraphStatus, () => kg().status())
  kit.handle(API.updateKnowledgeGraph, ({ auth, body }) => {
    const k = kg()
    if (body.enabled === true && !k.available()) fail('conflict', undefined, { params: { reason: 'unavailable' } })
    if (body.added !== undefined) {
      let list: string[] = []
      try { list = k.setAdded(body.added) } catch (e) {
        if (e instanceof KgError || e instanceof Denied) fail('validation', undefined, { fields: { 'body.added': e instanceof KgError ? e.code : 'not_found' }, params: { reason: e instanceof KgError ? e.code : 'not_found' } })
        throw e
      }
      audit(ctx.db, { actor: auth.user.id, action: 'knowledge_graph.folders', detail: { added: list } })
    }
    if (body.enabled !== undefined && body.enabled !== k.enabled()) {
      k.setEnabled(body.enabled)
      audit(ctx.db, { actor: auth.user.id, action: body.enabled ? 'knowledge_graph.on' : 'knowledge_graph.off' })
    }
    if (body.documents !== undefined && body.documents !== k.docsEnabled()) {
      k.setDocsEnabled(body.documents)
      audit(ctx.db, { actor: auth.user.id, action: body.documents ? 'knowledge_graph.documents_on' : 'knowledge_graph.documents_off' })
    }
    return k.status()
  })
  kit.handle(API.rebuildKnowledgeGraph, ({ auth, body }) => {
    const k = kg()
    const code = k.enabled() && body.part !== 'documents', docs = k.docsEnabled() && body.part !== 'code'
    if (!code && !docs) fail('conflict', undefined, { params: { reason: 'off' } })
    // one folder: one of the indexed folders outside personal folders, as the status lists them
    const s = k.status()
    if (body.path !== undefined && !s.roots.some((r) => r.path === body.path) && !s.documents.folders.some((r) => r.path === body.path)) fail('not_found')
    k.rebuild(body.path, body.part)
    audit(ctx.db, { actor: auth.user.id, action: 'knowledge_graph.rebuild', target: body.path ?? null, detail: body.part ? { part: body.part } : null })
    return k.status()
  })
}
