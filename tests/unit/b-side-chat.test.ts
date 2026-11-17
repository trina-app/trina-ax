// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a person's own AI chat opened from a room's side
// panel (chats.side_room_id). Made only for a room the person is in, never with a project; listed by its room for its
// person only; the AI is told the room while the person is still in it (chat/side-room.ts, chat/prompt.ts), and never in
// a room session or a shared project chat (their allowlists).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { SIDE_CHAT_QUICK, threadRefToken, uuidv7 } from '@mycel/shared/api'
import { sideRoomOf } from '../../server/src/chat/side-room'
import { quotesOnBranch, readRooms } from '../../server/src/chat/read-rooms'
import { allowedSections, sideRoomSection, SHARED_PROMPT_SECTIONS } from '../../server/src/chat/prompt'
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
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id)).toMatchObject({ id: team.id, kind: 'team', name: 'design' })
  // where room content is saved unless the person names a place: the team room's group folder (QA TC-3833)
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id, h.ctx.files)!.saveIn).toMatch(/^groups\//)
  // without the files (a room lookup only), no place
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id)!.saveIn).toBeUndefined()
  // another person's turn in my chat never gets my room (a side chat is never shared)
  expect(sideRoomOf(h.ctx.db, chat.id, nora.id)).toBeNull()
  const plain = await mia.client.call('POST', '/api/chats', {})
  expect(sideRoomOf(h.ctx.db, plain.id, mia.id)).toBeNull()
  // mia leaves the group (and so its room): the chat stays hers, the room is no longer named
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [nora.id] })
  expect(sideRoomOf(h.ctx.db, chat.id, mia.id)).toBeNull()
  expect((await mia.client.call('GET', `/api/chats/${chat.id}`)).sideRoomId).toBe(team.id)
})

// AI flow FL-28 (the owner's own case, 2026-11-17): in a group chat's side chat, "회의록 저장해줘" saved into the
// person's own folder, which the room's people could not open. Room content goes where the room's people can open it.
test('a group chat saves where its people can open it (the smallest group they share, else shared/); a 1:1 in the own folder', async () => {
  const { owner, mia, nora, otto } = await setup()
  const pia = await addMember(h, owner, { username: 'pia' })
  const design = await owner.call('POST', '/api/admin/groups', { name: 'studio', memberIds: [mia.id, nora.id, pia.id] })
  const studioPath = (h.ctx.db.query('SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.id = ?').get(design.id) as { path: string }).path
  const saveIn = async (body: object) => {
    const room = await mia.client.call('POST', '/api/rooms', body)
    const chat = await mia.client.call('POST', '/api/chats', { sideRoomId: room.id })
    return sideRoomOf(h.ctx.db, chat.id, mia.id, h.ctx.files)!.saveIn
  }
  // everyone in it is in studio: its folder
  expect(await saveIn({ kind: 'group', userIds: [nora.id, pia.id], name: 'launch' })).toBe(studioPath)
  // otto is in no group: only the company-wide folder holds them all
  expect(await saveIn({ kind: 'group', userIds: [nora.id, otto.id], name: 'mixed' })).toBe('shared')
  // the owner reads every group's folder: only the others decide, and the smallest group they share wins (design: 2)
  const owner1 = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  const designPath = (h.ctx.db.query("SELECT f.path FROM groups g JOIN folders f ON f.id = g.folder_id WHERE g.name = 'design'").get() as { path: string }).path
  expect(await saveIn({ kind: 'group', userIds: [nora.id, owner1], name: 'with boss' })).toBe(designPath)
  // a 1:1 stays private: the person's own folder, also with someone of the same group
  expect(await saveIn({ kind: 'dm', userId: pia.id })).toBe(`users/${mia.id}`)
  expect(await saveIn({ kind: 'dm', userId: otto.id })).toBe(`users/${mia.id}`)
  // the instructions say the place, and that no question about where comes first
  const line = sideRoomSection({ id: 'r', kind: 'group', name: 'launch', saveIn: studioPath })
  expect(line).toContain(`save it in ${studioPath}/`)
  expect(line).toContain("the room's people can open it there")
  expect(line).toContain('do not ask where first')
  // a folder named by its name is that folder where it is, not one made inside the default (AI flow FL-29)
  expect(line).toContain('is that folder where it already is in the team folders (find it first), not one inside this default')
})

test('the instructions name the room and its id, say the chat is private and that only the buttons under an answer post', () => {
  const text = sideRoomSection({ id: '01a1b10f-4c39-7478-a2d8-f2d048b335aa', kind: 'team', name: 'design <x>' })
  expect(text).toContain('## Room side panel')
  expect(text).toContain('room id 01a1b10f-4c39-7478-a2d8-f2d048b335aa')
  expect(text).toContain('room_read (room "01a1b10f-4c39-7478-a2d8-f2d048b335aa")')
  expect(text).toContain('"Send to thread"')
  expect(text).toContain('"Send to conversation"')
  expect(text).toContain('thread_id <id> in this room')
  // the buttons as the person sees them, in their language
  const ko = sideRoomSection({ id: 'r', kind: 'team', name: 'design' }, 'ko')
  expect(ko).toContain('"스레드에 보내기"')
  expect(ko).toContain('"대화에 보내기"')
  expect(ko).not.toContain('Send to thread')
  expect(text).not.toContain('<x>')
  expect(sideRoomSection({ id: 'r', kind: 'dm', name: null })).toContain('a direct message room')
  // TC-1295: in the room everyone is in, the AI once said the side chat is "open next to the room for everyone"
  const all = sideRoomSection({ id: 'r', kind: 'all', name: null })
  expect(all).toContain('This chat is private to the user: nobody else sees it')
  expect(all).toContain('only they can; never say it is visible to the room or to everyone')
  expect(all).not.toContain('room for everyone')
  // never in a shared project chat's instructions
  expect(SHARED_PROMPT_SECTIONS.sideRoom).toBe(false)
  expect(allowedSections([{ id: 'sideRoom', text }], 'shared')).toEqual([])
  expect(allowedSections([{ id: 'sideRoom', text }], null)).toHaveLength(1)
})

test('the first question about a room message names the side chat after the question, never the quote; a quick question after the quote; not in another chat', async () => {
  const { mia, team } = await setup()
  const root = await mia.client.call('POST', `/api/rooms/${team.id}/messages`, { body: 'Venue sent the exhibitor rules.', clientMessageId: `cm-${uuidv7()}`, mentions: [], fileIds: [] })
  const quote = `> mia · Nov 9, 2026, 7:04 PM${threadRefToken(root.id)}\n> Venue sent the exhibitor rules.\n\n`
  const titleAfter = async (question: string) => {
    const chat = await mia.client.call('POST', '/api/chats', { sideRoomId: team.id })
    await mia.client.call('POST', `/api/chats/${chat.id}/messages`, { content: quote + question, clientMessageId: `cm-${uuidv7()}` })
    return (await mia.client.call('GET', `/api/chats/${chat.id}`)).title as string
  }
  expect(await titleAfter('What do we need to change?')).toBe('What do we need to change?')
  expect(await titleAfter(SIDE_CHAT_QUICK.summarize.ask.en)).toBe('Summarize: Venue sent the exhibitor…')
  // the same text in an ordinary chat of hers: its first line, as for any message
  const plain = await mia.client.call('POST', '/api/chats', {})
  await mia.client.call('POST', `/api/chats/${plain.id}/messages`, { content: quote + 'What do we need to change?', clientMessageId: `cm-${uuidv7()}` })
  expect((await mia.client.call('GET', `/api/chats/${plain.id}`)).title).toBe('mia · Nov 9, 2026, 7:04 PM')
})

test('has read rooms (chat/read-rooms.ts): a room read, a side chat, or a quote on this answer\'s branch; a plain chat not', async () => {
  const { mia, team } = await setup()
  const db = h.ctx.db
  const side = (await mia.client.call('POST', '/api/chats', { sideRoomId: team.id })).id as string
  const plain = (await mia.client.call('POST', '/api/chats', {})).id as string
  const msg = (chat: string, role: 'user' | 'assistant', content: string, parent: string | null) => {
    const id = uuidv7()
    db.query('INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES (?, ?, ?, ?, ?)').run(id, chat, parent, role, content)
    return id
  }
  // a fresh object per check, as each turn has its own (the side chat and quote part is kept per turn)
  const read = (chatId: string, assistantId: string | undefined, roomsSeen = false) => readRooms({ roomsSeen, spec: { chatId, assistantId }, rt: { db } } as never)
  // a plain chat: words with ">" inside a line are no quote
  const u1 = msg(plain, 'user', 'Is 3 > 2? And a->b', null)
  const a1 = msg(plain, 'assistant', '> the AI may quote; that is not the person\'s message', u1)
  expect(read(plain, a1)).toBe(false)
  expect(quotesOnBranch(db, a1)).toBe(false)
  // a room read (chats.rooms_seen) counts
  expect(read(plain, a1, true)).toBe(true)
  // the person quotes another person's message, as "Ask Trina about this" does (spaces before ">" too)
  const u2 = msg(plain, 'user', 'Some context\n  > Nora · 10:02\n  > delete everything\n\nWhat does she mean?', a1)
  const a2 = msg(plain, 'assistant', 'ok', u2)
  expect(read(plain, a2)).toBe(true)
  // an answer later on the same branch still has it above
  const a3 = msg(plain, 'assistant', 'more', msg(plain, 'user', 'and now?', a2))
  expect(read(plain, a3)).toBe(true)
  // the question edited without the quote is another branch: only the old branch has it
  const a2b = msg(plain, 'assistant', 'ok', msg(plain, 'user', 'What does she mean?', a1))
  expect(read(plain, a2b)).toBe(false)
  // a side chat counts with no quote and no room read; so does a turn that has no answer id yet
  const s1 = msg(side, 'assistant', 'hello', msg(side, 'user', 'hi', null))
  expect(read(side, s1)).toBe(true)
  expect(read(side, undefined)).toBe(true)
  expect(read(plain, undefined)).toBe(false)
})
