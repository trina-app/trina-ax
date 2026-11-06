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
  createRoom: {
    build: (c) => c.post('/api/rooms', { kind: 'dm', userId: 'frank' }), scope: 'self',
    // a group chat needs two other active people of this team; a body that names more is refused
    check: async (r, w, who) => {
      if (r.status !== 201) return
      const one = await w.as[who].req('POST', '/api/rooms', { kind: 'group', userIds: ['frank'] })
      if (one.status !== 400) throw new Error(`a group chat with one other person was made: ${one.status}`)
      const spoof = await w.as[who].req('POST', '/api/rooms', { kind: 'group', userIds: ['frank', 'bob'], createdBy: 'dana' })
      if (spoof.status !== 400) throw new Error(`a body naming the maker was not refused: ${spoof.status}`)
    },
  },
  getRoom: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}`), scope: 'room-dm' },
  updateRoom: {
    build: (c, w) => c.patch(`/api/rooms/${w.ids.dmRoom}`, { muted: false }), scope: 'room-dm',
    // renaming: never a DM (403 for its members); a group chat's members may (its name stays the same here)
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const dm = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { name: 'renamed' })
      if (dm.status !== 403) throw new Error(`a DM was renamed: ${dm.status}`)
      const g = await w.as[who].req('PATCH', `/api/rooms/${w.ids.groupRoom}`, { name: C.groupName })
      if (g.status !== 200) throw new Error(`a group chat member could not rename it: ${g.status}`)
    },
  },
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
  // group chats (docs/DECISIONS.md "그룹 대화와 방 이름"): alice and erin are in it (frank too, held back by his
  // password change); the owner and the admin are not, so they get 404 like everyone outside it. Inviting someone who
  // is in it already changes nothing (the world stays as it is); a disabled or unknown id is refused alike.
  inviteRoomMembers: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.groupRoom}/members`, { userIds: ['frank'] }), scope: 'room-group',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      if (r.json.memberCount !== 3) throw new Error(`inviting someone already in it changed the room: ${r.json.memberCount}`)
      const unknown = await w.as[who].req('POST', `/api/rooms/${w.ids.groupRoom}/members`, { userIds: ['nobody-here'] })
      if (unknown.status !== 400) throw new Error(`an unknown person was not refused: ${unknown.status}`)
      // a DM keeps its two people: inviting there is refused for its members
      const dm = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/members`, { userIds: ['frank'] })
      if (dm.status !== 403) throw new Error(`inviting into a DM was not refused: ${dm.status}`)
    },
  },
  // the manager (alice, who made it) may take someone out, never herself; erin, a plain member, is refused. The target is
  // alice herself, so nobody is ever taken out of the shared world: alice gets 400 (that is leaving), erin 403, everyone
  // outside 404.
  removeRoomMember: {
    build: (c, w) => c.del(`/api/rooms/${w.ids.groupRoom}/members/alice`), scope: 'own-alice',
    check: async (r, w, who) => {
      if (who === 'memberIn' && r.status !== 400) throw new Error(`the manager took herself out: ${r.status}`)
      if (who === 'other') {
        if (r.status !== 403) throw new Error(`a plain member took out the manager: ${r.status}`)
      }
    },
  },
  // leaving: alice and erin each leave a group chat of their own (frank stays, so it is never archived under the others)
  leaveRoom: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.groupLeaveRoom}/leave`), scope: 'room-group',
    check: async (r, w, who) => {
      if (r.status !== 204) return
      const again = await w.as[who].req('GET', `/api/rooms/${w.ids.groupLeaveRoom}`)
      if (again.status !== 404) throw new Error(`the room is still there after leaving: ${again.status}`)
      // a DM is not left like that
      const dm = await w.as[who].req('POST', `/api/rooms/${w.ids.dmRoom}/leave`)
      if (dm.status !== 403) throw new Error(`leaving a DM was not refused: ${dm.status}`)
    },
  },
  uploadRoomFile: { build: (c, w) => c.req('POST', `/api/rooms/${w.ids.dmRoom}/files`, undefined, { form: form(), headers: { [CSRF_HEADER]: '1' } }), scope: 'room-dm' },
  // the AI in rooms: the DM's count and my own runs (both people), alice's preview and her question's turn (alice only;
  // erin, in the DM, is refused like everyone else), the sources of a message (both)
  getRoomAi: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/ai`), scope: 'room-dm' },
  stopRoomAi: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/ai/${w.ids.dmAiTurn}/stop`), scope: 'own-alice' },
  shareRoomMessage: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmAiPreview}/share`), scope: 'own-alice' },
  roomMessageSources: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/sources`), scope: 'room-dm' },
  roomFile: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files/${w.ids.dmFile}?download=1`), scope: 'room-dm',
    check: (r) => { if (r.status === 200 && !r.headers.get('content-disposition')?.includes(C.dmFileName)) throw new Error('the member did not get the room file') },
  },
}
