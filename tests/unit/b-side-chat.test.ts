// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own AI chat opened from a room's side
// panel (chats.side_room_id). Made only for a room the person is in, never with a project; listed by its room for its
// person only; the AI is told the room while the person is still in it (chat/side-room.ts, chat/prompt.ts), and never in
// a room session or a shared project chat (their allowlists).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { sideRoomOf } from '../../server/src/chat/side-room'
import { allowedSections, sideRoomSection, ROOM_PROMPT_SECTIONS, SHARED_PROMPT_SECTIONS } from '../../server/src/chat/prompt'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('b-side-chat')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  return { owner, mia, nora, otto, group, team }
}

test('a side chat is made for a room I am in, never with a project, and listed by its room for me only', async () => {
  const { mia, nora, otto, team } = await setup()
  const chat = await mia.client.call('POST', '/api/chats', { sideRoomId: team.id })
  expect(chat).toMatchObject({ sideRoomId: team.id, projectId: null })
  // someone not in the room: the same 404 as a room that is not there
  expect(await otto.client.raw('POST', '/api/chats', { sideRoomId: team.id }).then((r) => r.status)).toBe(404)
  expect(await mia.client.raw('POST', '/api/chats', { sideRoomId: uuidv7() }).then((r) => r.status)).toBe(404)
  // a side chat is mine alone: never with a project
  const project = await mia.client.call('POST', '/api/projects', { name: 'p1' }).catch(() => null)
  if (project) expect(await mia.client.raw('POST', '/api/chats', { sideRoomId: team.id, projectId: project.id }).then((r) => r.status)).toBe(400)
  // an ordinary chat says nothing of a room
  const plain = await mia.client.call('POST', '/api/chats', {})
  expect(plain.sideRoomId).toBeUndefined()
  // the room's side chats: mine, newest first; nora's list of the same room has none of mine
  const list = await mia.client.call('GET', `/api/chats?sideRoomId=${team.id}`)
  expect(list.items.map((c: any) => c.id)).toEqual([chat.id])
  expect((await nora.client.call('GET', `/api/chats?sideRoomId=${team.id}`)).items).toEqual([])
  // in my chat list as an ordinary chat of mine
  expect((await mia.client.call('GET', '/api/chats')).items.map((c: any) => c.id)).toContain(chat.id)
})

test('the AI is told the room while I am in it; after I leave, or in a chat without a room, nothing', async () => {
  const { owner, mia, nora, group, team } = await setup()
  const chat = await mia.client.call('POST', '/api/chats', { sideRoomId: team.id })
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id)).toEqual({ id: team.id, kind: 'team', name: 'design' })
  // another person's turn in my chat never gets my room (a side chat is never shared)
  expect(sideRoomOf(h.ctx.db, chat.id, nora.id)).toBeNull()
  const plain = await mia.client.call('POST', '/api/chats', {})
  expect(sideRoomOf(h.ctx.db, plain.id, mia.id)).toBeNull()
  // mia leaves the group (and so its room): the chat stays hers, the room is no longer named
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [nora.id] })
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id)).toBeNull()
  expect((await mia.client.call('GET', `/api/chats/${chat.id}`)).sideRoomId).toBe(team.id)
})

test('the instructions name the room and its id, say the chat is private and that only "Share to room" posts', () => {
  const text = sideRoomSection({ id: '01a1b10f-4c39-7478-a2d8-f2d048b335aa', kind: 'team', name: 'design <x>' })
  expect(text).toContain('## Room side panel')
  expect(text).toContain('room id 01a1b10f-4c39-7478-a2d8-f2d048b335aa')
  expect(text).toContain('room_read (room "01a1b10f-4c39-7478-a2d8-f2d048b335aa")')
  expect(text).toContain('Share to room')
  expect(text).not.toContain('<x>')
  expect(sideRoomSection({ id: 'r', kind: 'dm', name: null })).toContain('a direct message room')
  // never in a room session's or a shared project chat's instructions
  expect(ROOM_PROMPT_SECTIONS.sideRoom).toBe(false)
  expect(SHARED_PROMPT_SECTIONS.sideRoom).toBe(false)
  expect(allowedSections([{ id: 'sideRoom', text }], 'room')).toEqual([])
  expect(allowedSections([{ id: 'sideRoom', text }], null)).toHaveLength(1)
})
