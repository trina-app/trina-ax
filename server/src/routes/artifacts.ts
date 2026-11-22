// Route module "artifacts" — owner: component C (docs/WORKPLAN.md).
// Implements: ARTIFACTS (list a chat's artifacts, one version with content, a person's restore of a version).
// Contract: shared/src/api/artifacts.ts. The artifact tool itself is registered by the files module
// (server/src/tools/index.ts).
import { API } from '@mycel/shared/api'
import { componentC } from '../team-files/component'
import { getChatRuntime } from '../chat/runtime'
import { chatFor } from '../chat/shared'
import { fail } from '../http/errors'
import type { RouteModule } from './module'

export const artifactsRoutes: RouteModule = {
  name: 'artifacts',
  owner: 'C',
  register(kit, ctx) {
    const a = componentC(ctx).artifacts
    kit.handle(API.listChatArtifacts, ({ params, auth }) => a.list(auth.user.id, params.id))
    kit.handle(API.getArtifact, ({ params, auth }) => a.get(auth.user.id, params.id))
    // a restore is a change of the chat: whoever may continue it (chat/shared.ts chatFor 'continue': not in the trash,
    // not read-only while safe operations are on); the version must be one they see (Artifacts.restoreByPerson)
    kit.handle(API.restoreArtifact, ({ c, params, auth }) => {
      const row = ctx.db.query('SELECT chat_id FROM artifacts WHERE id = ?').get(params.id) as { chat_id: string } | null
      if (!row) return fail('not_found')
      chatFor(getChatRuntime(ctx), auth.user.id, row.chat_id, 'continue', { locale: c.get('locale') })
      return a.restoreByPerson(auth.user.id, params.id)
    })
  },
}
