import { CSRF_HEADER } from '@mycel/shared/api'
import type { Spec } from './cases'
import { C, PNG } from './world'

// Team chat rooms (docs/DECISIONS.md "대화방 v1"). The world has a DM of alice (memberIn) and erin (other) with a
// message and an image only they may see (C.dmMsg, C.dmFileName): every room route aimed at it is 'room-dm', so the
// owner and the admin are refused like everyone else outside it (admins cannot read rooms they are not in). Editing and
// deleting are alice's own message only ('own-alice': erin, a member, is refused too). A body naming an author is
// refused for everyone (the schema is strict), checked on the allowed send. Threads and reactions are 'room-dm' too.
const cm = () => 'cm-' + crypto.randomUUID()
const form = () => { const f = new FormData(); f.set('file', new File([PNG], 'room.png', { type: 'image/png' })); return f }
export const ROOM_SPECS: Record<string, Spec> = {
  listRooms: { build: (c) => c.get('/api/rooms'), scope: 'self' },
  // "이 방에서는 항상 허용" (rooms/ai-grants.ts): each person lists their own; an id that is not theirs answers like one that
  // is not there (another person's grant: tests/unit/b-room-ai-grants.test.ts)
  listAiAllowances: { build: (c) => c.get('/api/ai-allowances'), scope: 'self' },
  deleteAiAllowance: { build: (c) => c.del('/api/ai-allowances/019a0000-0000-7000-8000-00000000a11f'), scope: 'nobody' },
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
      // my own notification level for the room (docs/DECISIONS.md "대화방 알림 설정"): a member sets it, back to the default
      for (const notifyLevel of ['mentions', null]) {
        const n = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { notifyLevel })
        if (n.status !== 200) throw new Error(`a member could not set their level: ${n.status}`)
      }
      const both = await w.as[who].req('PATCH', `/api/rooms/${w.ids.dmRoom}`, { notifyLevel: 'off', muted: true })
      if (both.status !== 400) throw new Error(`muted with notifyLevel was taken: ${both.status}`)
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
  // threads and reactions (docs/DECISIONS.md "스레드와 반응"): the DM's message as a thread's root. Reading the thread
  // and my place in it, and a reaction, are the DM's two people's only; a body naming another person is refused
  listRoomThread: { build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/thread`), scope: 'room-dm' },
  markRoomThreadRead: { build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/thread/read`, { seq: 1 }), scope: 'room-dm' },
  reactRoomMessage: {
    build: (c, w) => c.req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '👍', on: true }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      if (!r.json.reactions?.some((x: { emoji: string; mine: boolean }) => x.emoji === '👍' && x.mine)) throw new Error(`the reaction is not the caller's: ${JSON.stringify(r.json)}`)
      const spoof = await w.as[who].req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '👍', on: true, userId: 'dana' })
      if (spoof.status !== 400) throw new Error(`a body naming a person was not refused: ${spoof.status}`)
      // any one emoji, never text or markup
      const odd = await w.as[who].req('PUT', `/api/rooms/${w.ids.dmRoom}/messages/${w.ids.dmMsg}/reactions`, { emoji: '<b>👍</b>', on: true })
      if (odd.status !== 400) throw new Error(`a reaction that is not one emoji was taken: ${odd.status}`)
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
  // hiding a conversation from my own lists (docs/DECISIONS.md "대화 숨기기"): the DM's two people, each for themselves.
  // The check shows it again first (the world stays as it was), then: the other person's view is untouched, a group
  // chat is left rather than hidden (403 for its members), a body naming anyone or nothing is refused (strict)
  setRoomHidden: {
    build: (c, w) => c.put(`/api/rooms/${w.ids.dmRoom}/hidden`, { hidden: true }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const me = w.as[who]
      const back = await me.put(`/api/rooms/${w.ids.dmRoom}/hidden`, { hidden: false })
      if (r.json?.id !== w.ids.dmRoom || r.json?.hidden !== true) throw new Error(`the DM was not hidden for the caller: ${r.text.slice(0, 200)}`)
      if (back.status !== 200 || back.json?.hidden !== undefined) throw new Error(`the DM was not shown again: ${back.status} ${back.text.slice(0, 200)}`)
      const peer = await w.as[who === 'memberIn' ? 'other' : 'memberIn'].get(`/api/rooms/${w.ids.dmRoom}`)
      if (peer.status !== 200 || peer.json?.hidden !== undefined) throw new Error(`hiding changed the other person's view: ${peer.status} ${peer.text.slice(0, 200)}`)
      const group = await me.put(`/api/rooms/${w.ids.groupRoom}/hidden`, { hidden: true })
      if (group.status !== 403) throw new Error(`a group chat was hidden: ${group.status}`)
      for (const body of [{ hidden: true, userId: 'dana' }, {}]) {
        const bad = await me.put(`/api/rooms/${w.ids.dmRoom}/hidden`, body)
        if (bad.status !== 400) throw new Error(`a body ${JSON.stringify(body)} was not refused: ${bad.status}`)
      }
      const still = await me.get(`/api/rooms/${w.ids.dmRoom}`)
      if (still.json?.hidden !== undefined) throw new Error('the DM is left hidden for the caller')
    },
  },
  // pinning a conversation to the top of my own list (docs/DECISIONS.md "Pinned conversations"): the DM's two people,
  // each for themselves. The check takes the pin off again (the world stays as it was), and the other person's view is
  // untouched
  pinRoom: {
    build: (c, w) => c.post(`/api/rooms/${w.ids.dmRoom}/pin`), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const me = w.as[who]
      if (r.json?.id !== w.ids.dmRoom || typeof r.json?.pinnedAt !== 'string') throw new Error(`the DM was not pinned for the caller: ${r.text.slice(0, 200)}`)
      const peer = await w.as[who === 'memberIn' ? 'other' : 'memberIn'].get(`/api/rooms/${w.ids.dmRoom}`)
      if (peer.status !== 200 || peer.json?.pinnedAt !== undefined) throw new Error(`pinning changed the other person's view: ${peer.status} ${peer.text.slice(0, 200)}`)
      const back = await me.req('DELETE', `/api/rooms/${w.ids.dmRoom}/pin`)
      if (back.status !== 200 || back.json?.pinnedAt !== undefined) throw new Error(`the DM was not unpinned: ${back.status} ${back.text.slice(0, 200)}`)
    },
  },
  unpinRoom: { build: (c, w) => c.del(`/api/rooms/${w.ids.dmRoom}/pin`), scope: 'room-dm' },
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
  // a Hangul file's pages (the HWP Preview plugin): the room file's checks first, so the DM's two people pass them and
  // are told the picture is no Hangul file (503 unsupported, never the plugin's state); everyone else, the owner and
  // the admin included, gets 404 as for the file itself
  roomFileHwpPreview: {
    build: (c, w) => c.get(`/api/rooms/${w.ids.dmRoom}/files/${w.ids.dmFile}/hwp-preview?page=1`), scope: 'room-dm',
    check: (r, _w, who) => {
      const status = who === 'anon' ? 401 : who === 'pwchange' ? 403 : who === 'memberIn' || who === 'other' ? 503 : 404
      if (r.status !== status) throw new Error(`${who} roomFileHwpPreview status: ${r.status}`)
      if (status === 503 && r.json?.error?.params?.reason !== 'unsupported') throw new Error(`${who}: expected unsupported, got ${r.text.slice(0, 200)}`)
    },
  },
}
