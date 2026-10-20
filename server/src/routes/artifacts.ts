// Route module "artifacts" — owner: component C (docs/WORKPLAN.md).
// Implements: ARTIFACTS (list a chat's artifacts, one version with content). Contract: shared/src/api/artifacts.ts.
// The artifact tool itself is registered by the files module (server/src/tools/index.ts).
import { API } from '@mycel/shared/api'
import { componentC } from '../team-files/component'
import type { RouteModule } from './module'

export const artifactsRoutes: RouteModule = {
  name: 'artifacts',
  owner: 'C',
  register(kit, ctx) {
    const a = componentC(ctx).artifacts
    kit.handle(API.listChatArtifacts, ({ params, auth }) => a.list(auth.user.id, params.id))
    kit.handle(API.getArtifact, ({ params, auth }) => a.get(auth.user.id, params.id))
  },
}
