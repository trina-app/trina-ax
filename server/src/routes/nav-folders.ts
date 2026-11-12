// Route module "nav-folders" (docs/DECISIONS.md "List folders"). Implements: NAV_FOLDERS (shared/src/api/nav-folders.ts:
// a person's own folders in their Trina list and their 대화 list). Logic: server/src/chat/nav-folders.ts. Every handler
// takes the person from the session and acts on their own folders only: another person's folder id answers 404 like
// one that is not there, for owners and admins too.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { getChatRuntime } from '../chat/runtime'
import { createNavFolder, deleteNavFolder, listNavFolders, orderNavFolders, renameNavFolder, setChatFolder, setRoomFolder } from '../chat/nav-folders'

export const navFoldersRoutes: RouteModule = {
  name: 'nav-folders',
  owner: 'B',
  register(kit, ctx) {
    // after the chats module, which installs the chat runtime
    const rt = () => getChatRuntime(ctx)
    kit.handle(API.listNavFolders, ({ c, auth }) => { c.header('Cache-Control', 'no-store'); return { items: listNavFolders(rt(), auth.user.id) } })
    kit.handle(API.createNavFolder, ({ c, auth, body }) => createNavFolder(rt(), auth.user.id, body.kind, body.name, c.get('locale')))
    kit.handle(API.updateNavFolder, ({ c, auth, params, body }) => renameNavFolder(rt(), auth.user.id, params.id, body.name, c.get('locale')))
    kit.handle(API.deleteNavFolder, ({ auth, params }) => { deleteNavFolder(rt(), auth.user.id, params.id) })
    kit.handle(API.orderNavFolders, ({ auth, body }) => ({ items: orderNavFolders(rt(), auth.user.id, body.kind, body.ids) }))
    kit.handle(API.setChatFolder, ({ c, auth, params, body }) => setChatFolder(rt(), auth.user.id, params.id, body.folderId, c.get('locale')))
    kit.handle(API.setRoomFolder, ({ c, auth, params, body }) => setRoomFolder(ctx, auth.user.id, params.id, body.folderId, c.get('locale')))
  },
}
