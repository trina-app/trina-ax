import type { Spec } from './cases'
import type { World } from './world'

// Conversation categories (docs/decisions/20261120-shared-chat-categories.md, server/src/rooms/categories.ts): the
// team's own list, read by every signed-in person; every change is an admin endpoint (the owner and admins; a member is
// refused by the auth level). Filing a room also needs the caller in it: the everyone room has everybody, so the owner
// and an admin pass and file it (out again: null), members are refused for the role.
const fresh = async (w: World) => (await w.as.owner.ok('POST', '/api/room-categories', { name: `Cat ${crypto.randomUUID().slice(0, 8)}` })).id as string

export const ROOM_CATEGORY_SPECS: Record<string, Spec> = {
  listRoomCategories: { build: (c) => c.get('/api/room-categories'), scope: 'byLevel' },
  createRoomCategory: {
    build: (c) => c.post('/api/room-categories', { name: `New ${crypto.randomUUID().slice(0, 8)}` }), scope: 'byLevel',
    // a made one is cleaned up so the 50 per team are never used up by the matrix
    check: async (r, w) => { if (r.status === 201) await w.as.owner.ok('DELETE', `/api/room-categories/${r.json.id}`) },
  },
  updateRoomCategory: { build: async (c, w) => c.req('PATCH', `/api/room-categories/${await fresh(w)}`, { name: `Renamed ${crypto.randomUUID().slice(0, 8)}` }), scope: 'byLevel' },
  deleteRoomCategory: { build: async (c, w) => c.req('DELETE', `/api/room-categories/${await fresh(w)}`), scope: 'byLevel' },
  orderRoomCategories: { build: (c) => c.req('PUT', '/api/room-categories/order', { ids: [] }), scope: 'byLevel' },
  setRoomCategory: { build: (c, w) => c.req('PUT', `/api/rooms/${w.ids.allRoom}/category`, { categoryId: null }), scope: 'byLevel' },
}
