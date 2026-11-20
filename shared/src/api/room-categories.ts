// Conversation categories (team-wide). Owner: B (server/src/rooms/categories.ts, registered by
// server/src/routes/room-categories.ts; migration 429).
//
// An admin or the owner makes categories for the Chats list and puts channels in them (a team room, the everyone room
// or a named group room: never a 1:1 or an unnamed group chat, which are personal). Everyone on the team sees the same
// categories in the same order, each holding the channels of it they are in; a channel they are not in stays out of
// their list as before. A category holds no files or permissions and never changes who is in a channel. Deleting one
// only lets its channels go back to Channels. They replace the personal "Conversation folders" on screen.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { endpoint, empty } from './endpoint'
import { NavFolderName } from './nav-folders'
import { Room } from './rooms'

/** Categories per team (409 room_categories_full). */
export const ROOM_CATEGORIES_MAX = 50

export const RoomCategory = z.object({
  id: Uuid7,
  name: z.string(),
  /** its place in the list, 0 first */
  position: z.number().int().nonnegative(),
})
export type RoomCategory = z.infer<typeof RoomCategory>

export const RoomCategoryList = z.object({ items: z.array(RoomCategory) })
export type RoomCategoryList = z.infer<typeof RoomCategoryList>

/** A category name as typed: the folder names' rule (1–40 characters after trimming, something visible). */
export const RoomCategoryName = NavFolderName

export const CreateRoomCategoryBody = z.strictObject({ name: RoomCategoryName })
export type CreateRoomCategoryBody = z.infer<typeof CreateRoomCategoryBody>
export const UpdateRoomCategoryBody = z.strictObject({ name: RoomCategoryName })
export type UpdateRoomCategoryBody = z.infer<typeof UpdateRoomCategoryBody>
/** the ids given first, in that order, then the rest in their order before; unknown ids are ignored */
export const OrderRoomCategoriesBody = z.strictObject({ ids: z.array(Uuid7).max(200) })
export type OrderRoomCategoriesBody = z.infer<typeof OrderRoomCategoriesBody>
/** null: out of its category */
export const SetRoomCategoryBody = z.strictObject({ categoryId: Uuid7.nullable() })
export type SetRoomCategoryBody = z.infer<typeof SetRoomCategoryBody>

export const ROOM_CATEGORIES = {
  listRoomCategories: endpoint({ method: 'GET', path: '/api/room-categories', auth: 'user', owner: 'B', response: RoomCategoryList,
    summary: 'The team\'s conversation categories in their order. The same for everyone (a guest included, read only); which channels are in each comes with each room (Room.categoryId).' }),
  createRoomCategory: endpoint({ method: 'POST', path: '/api/room-categories', auth: 'admin', owner: 'B', status: 201, body: CreateRoomCategoryBody, response: RoomCategory,
    summary: 'A new category at the end of the list (admins and the owner). At most 50 (409 room_categories_full); a name the team already uses (any letter case): 409 room_category_name_taken. Everyone\'s windows hear it (roomCategories.changed).' }),
  updateRoomCategory: endpoint({ method: 'PATCH', path: '/api/room-categories/:id', auth: 'admin', owner: 'B', body: UpdateRoomCategoryBody, response: RoomCategory,
    summary: 'Rename a category (admins and the owner). Everyone\'s windows hear it.' }),
  deleteRoomCategory: endpoint({ method: 'DELETE', path: '/api/room-categories/:id', auth: 'admin', owner: 'B', response: empty, status: 204,
    summary: 'Delete a category (admins and the owner). Only the category goes: its channels go back to Channels for everyone.' }),
  orderRoomCategories: endpoint({ method: 'PUT', path: '/api/room-categories/order', auth: 'admin', owner: 'B', body: OrderRoomCategoriesBody, response: RoomCategoryList,
    summary: 'Put the categories in this order (admins and the owner): the ids given first, then the rest in their order before.' }),
  setRoomCategory: endpoint({ method: 'PUT', path: '/api/rooms/:id/category', auth: 'admin', owner: 'B', body: SetRoomCategoryBody, response: Room,
    summary: 'Put a channel I am in in a category, or take it out (null), for every member (admins and the owner). A 1:1 or an unnamed group chat: 409 room_category_personal. A room I am not in or an archived one: 404.' }),
} as const
