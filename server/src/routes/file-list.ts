// Admin › Team settings › File list (shared/src/api/file-list.ts; server/src/file-list/). Registered by the files module
// (component C). Admins see counts, times and whose team AI account the runs use, never a file. There is no switch: the
// file list is always on (docs/DECISIONS.md "File list: always on"); only the host can turn it off (server.json).
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { fileListOf } from '../file-list/service'

export function registerFileListRoutes(kit: RouteKit, ctx: AppContext) {
  const fl = () => fileListOf(ctx)
  kit.handle(API.fileListStatus, () => fl().status())
  kit.handle(API.runFileList, ({ auth }) => {
    const f = fl()
    if (!f.on()) fail('conflict', undefined, { params: { reason: 'forced_off' } })
    if (f.start('now')) audit(ctx.db, { actor: auth.user.id, action: 'file_list.run' })
    return f.status()
  })
}
