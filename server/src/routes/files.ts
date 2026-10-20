// Route module "files" — owner: component C (docs/WORKPLAN.md).
// Implements: FILES (tree, content, save, download, upload, mkdir, move, delete, history, restore, trash, attachments, upload sessions)
// Contract: shared/src/api/files.ts
import type { RouteModule } from './module'

export const filesRoutes: RouteModule = {
  name: 'files',
  owner: 'C',
  register(_kit, _ctx) {
    // Component C registers its endpoints here with _kit.handle(API.<name>, handler).
  },
}
