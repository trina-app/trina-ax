// Route module "chats" — owner: component B (docs/WORKPLAN.md).
// Implements: CHATS (chats, messages, stop, regenerate, edit, branch, turns/:id/answer, projects)
// Contract: shared/src/api/chats.ts
import type { RouteModule } from './module'

export const chatsRoutes: RouteModule = {
  name: 'chats',
  owner: 'B',
  register(_kit, _ctx) {
    // Component B registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
