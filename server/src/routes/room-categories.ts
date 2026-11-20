// Route module "room-categories". Implements: ROOM_CATEGORIES (shared/src/api/room-categories.ts: the team's
// conversation categories). Logic: server/src/rooms/categories.ts. Reading is for everyone; every change is auth 'admin'
// (admins and the owner), checked by the endpoint itself.
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { createRoomCategory, deleteRoomCategory, listRoomCategories, orderRoomCategories, renameRoomCategory, setRoomCategory } from '../rooms/categories'

export const roomCategoriesRoutes: RouteModule = {
  name: 'room-categories',
  owner: 'B',
  register(kit, ctx) {
    kit.handle(API.listRoomCategories, ({ c }) => { c.header('Cache-Control', 'no-store'); return { items: listRoomCategories(ctx.db) } })
    kit.handle(API.createRoomCategory, ({ c, auth, body }) => createRoomCategory(ctx, auth.user.id, body.name, c.get('locale')))
    kit.handle(API.updateRoomCategory, ({ c, params, body }) => renameRoomCategory(ctx, params.id, body.name, c.get('locale')))
    kit.handle(API.deleteRoomCategory, ({ params }) => { deleteRoomCategory(ctx, params.id) })
    kit.handle(API.orderRoomCategories, ({ body }) => ({ items: orderRoomCategories(ctx, body.ids) }))
    kit.handle(API.setRoomCategory, ({ c, auth, params, body }) => setRoomCategory(ctx, auth.user.id, params.id, body.categoryId, c.get('locale')))
  },
}
