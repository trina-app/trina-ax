import { CSRF_HEADER } from '@mycel/shared/api'
import type { Spec } from './cases'
import { C, PNG } from './world'

// Team chat rooms (docs/DECISIONS.md "대화방 v1"). The world has a DM of alice (memberIn) and erin (other) with a
// message and an image only they may see (C.dmMsg, C.dmFileName): every room route aimed at it is 'room-dm', so the
// owner and the admin are refused like everyone else outside it (admins cannot read rooms they are not in). Editing and
// deleting are alice's own message only ('own-alice': erin, a member, is refused too). A body naming an author is
// refused for everyone (the schema is strict), checked on the allowed send.
const cm = () => 'cm-' + crypto.randomUUID()
const form = () => { const f = new FormData(); f.set('file', new File([PNG], 'room.png', { type: 'image/png' })); return f }
export const ROOM_SPECS: Record<string, Spec> = {
  listRooms: { build: (c) => c.get('/api/rooms'), scope: 'self' },
  // everyone opens their DM with frank (an active member); the DM itself is checked by the cases below
  createRoom: { build: (c) => c.post('/api/rooms', { kind: 'dm', userId: 'frank' }), scope: 'self' },
  getRoom: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}`), scope: 'room-dm' },
  updateRoom: { build: (c, w) => c.patch(`/api/rooms/${w.ids.dmRoom}`, { muted: false }), scope: 'room-dm' },
  listRoomMessages: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages`), scope: 'room-dm' },
  sendRoomMessage: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages`, { body: 'hello', clientMessageId: cm() }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 201) return
      if (r.json.author?.id !== (who === 'memberIn' ? 'alice' : 'erin')) throw new Error(`the message's author is not the caller: ${JSON.stringify(r.json.author)}`)
      const spoof = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/messages`, { body: 'spoof', authorId: 'dana', clientMessageId: cm() })
      if (spoof.status !== 400) throw new Error(`a body naming an author was not refused: ${spoof.status}`)
    },
  },
  editRoomMessage: { build: (c, w) => c.patch(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}`, { body: `${C.dmMsg} (edited)` }), scope: 'own-alice' },
  deleteRoomMessage: { build: (c, w) => c.del(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsgDel}`), scope: 'own-alice' },
  markRoomRead: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/read`, { seq: 1 }), scope: 'room-dm' },
  listRoomMembers: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/members`), scope: 'room-dm' },
  uploadRoomFile: { build: (c, w) => c.req('POST', `/api/rooms/${w.ids.dmRoom}/files`, undefined, { form: form(), headers: { [CSRF_HEADER]: '1' } }), scope: 'room-dm' },
  roomFile: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files/${w.ids.dmFile}?download=1`), scope: 'room-dm',
    check: (r) => { if (r.status === 200 && !r.headers.get('content-disposition')?.includes(C.dmFileName)) throw new Error('the member did not get the room file') },
  },
}
