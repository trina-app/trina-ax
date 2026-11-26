// Shared chats do everything a private chat does (docs/decisions/20261126-shared-chat-everything.md; the owner, 11-26:
// "다 되는거 아니야?"), with the fake engine through the real launcher and gate. A team project's shared chat on
// groups/marketing: alice, erin, carol and dana see it (bob does not). Covered, per lifted block: the tools are offered
// to the asker (and a guest's own turn keeps its limits); the prompt no longer lists them as "not available"; a team
// room some people here are not in asks the asker on the read card first (no: nothing of it reaches the chat; yes: it
// does), a room everyone here is in reads with no card, the project's own room as before; another member's turn reads
// only with their own access; a team file goes to the trash behind the delete card; looking_at, my_folders and
// shared_with_me go through the read card; the Drive and Slack notices are kept and listed like the browser's.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { SHARED_MEMBER_ONLY_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { sharedSection } from '../../server/src/chat/prompt'
import { browserWarnSeen, dropBrowserWarned, keepBrowserWarnSeen, listBrowserWarned } from '../../server/src/chat/browser-notice'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-everything', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  // a team room's groupId is a UUIDv7 in the contract; the fixture's group ids are short
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.query("UPDATE users SET prefs = json_set(COALESCE(prefs, '{}'), '$.autoMemory', 'off')").run()
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'groups/marketing', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h?.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const done = async (user: string, chatId: string, messageId: string) => {
  const d = await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return d.data.message as Message
}
const textOf = (m: Message) => m.content
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  return { started, done: await done(user, chatId, started.assistantMessage.id) }
}
/** a turn whose cards are answered in order by `pick` until it ends; returns the cards */
async function askCards(user: string, chatId: string, content: string, pick: (card: { question: string; options: { label: string; value: string }[] }, i: number) => string) {
  const started = await send(user, chatId, content)
  const seen = new Set<string>()
  const cards: { question: string; options: { label: string; value: string }[] }[] = []
  const timer = setInterval(() => {
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request') continue
      const d = (f as { data: { turnId: string; request: { requestId: string; question: string; options: { label: string; value: string }[]; kind: string } } }).data
      if (d.turnId !== started.turnId || seen.has(d.request.requestId)) continue
      seen.add(d.request.requestId)
      cards.push(d.request)
      const answer = pick(d.request, cards.length - 1)
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: d.request.kind === 'confirm' ? 'confirm' : 'ask_user', requestId: d.request.requestId, answer } as never }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
const events = (turnId: string) => (db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[])
let groups = 0
/** a team room of these people (a new group, made by the owner); its first message says `body` */
async function teamRoom(memberIds: string[], body: string): Promise<string> {
  const g = await h.api('dana').call(API.createGroup, { body: { name: `everything-${++groups}`, memberIds } })
  const r = (await h.api(memberIds[0]!).call(API.listRooms)).items.find((x) => x.kind === 'team' && x.groupId === g.id)
  if (!r) throw new Error('no team room')
  await h.api(memberIds[0]!).call(API.sendRoomMessage, { params: { id: r.id }, body: { body, clientMessageId: cm(), mentions: [], fileIds: [] } })
  return r.id
}

describe('offered in a shared chat', () => {
  test('the tools that were off are in the allowlist; a guest\'s own turn keeps its limits', () => {
    for (const t of ['set_title', 'move_skill', 'change_project_members', 'change_folder_access', 'skill_files', 'connect_service', 'rooms', 'room_read', 'room_file', 'save_room_file', 'shared_with_me', 'looking_at', 'my_folders', 'drive_search', 'drive_list', 'drive_read', 'delete_files'])
      expect({ t, on: SHARED_TOOLS.has(t) }).toEqual({ t, on: true })
    for (const t of ['set_title', 'remember', 'forget']) expect(SHARED_MEMBER_ONLY_TOOLS.has(t)).toBe(true)
  })

  test('the asker\'s turn gets them, and the instructions list none of them as not available', async () => {
    const chat = await newShared()
    const r = await ask('alice', chat.id, fake({ echo: 'tools' }))
    const tools = textOf(r.done)
    for (const t of ['move_skill', 'rooms', 'room_read', 'room_file', 'save_room_file', 'shared_with_me', 'looking_at', 'my_folders', 'connect_service', 'delete_files', 'change_project_members', 'change_folder_access', 'skill_files'])
      expect({ t, on: tools.includes(t) }).toEqual({ t, on: true })
    const sys = textOf((await ask('alice', chat.id, fake({ echo: 'system' }))).done)
    expect(sys).not.toContain('Not available in a shared chat')
    expect(sys).toContain('Everything you do in a chat only')
  })

  test('the shared section: everything works for a member; a guest keeps the short list', () => {
    const member = sharedSection({ project: 'Falcon', audience: 4, asker: 'Alice Kim' }, 'en')
    expect(member).toContain('naming this chat (set_title)')
    expect(member).toContain('Google Drive, Slack and connecting a new service')
    expect(member).not.toContain('Not available in a shared chat')
    expect(sharedSection({ project: 'Falcon', audience: 4, asker: 'Gail' }, 'en', false, true)).toContain('Not available in a shared chat: memories about Gail')
  })
})

describe('the chat\'s title (item 1)', () => {
  test('the asker\'s AI names a new shared chat, and everyone in it sees the title', async () => {
    const chat = await newShared()
    await ask('alice', chat.id, fake({ tool: 'set_title', args: { title: 'Budget review' }, sayResult: true }))
    expect((await h.api('erin').call(API.getChat, { params: { id: chat.id } })).title).toBe('Budget review')
  })
})

describe('team chat rooms (item 7)', () => {
  test('a room some people here are not in: the read card first; a no keeps it out, a yes reads it', async () => {
    const room = await teamRoom(['alice', 'dana'], 'Budget line: PINEAPPLE-42')
    const chat = await newShared()
    const no = await askCards('alice', chat.id, fake({ tool: 'room_read', args: { room }, sayResult: true }), () => 'skip')
    expect(no.cards).toHaveLength(1)
    expect(no.cards[0]!.question).toContain('can\'t open')
    expect(textOf(no.done)).not.toContain('PINEAPPLE-42')
    expect(events(no.started.turnId).find((e) => e.tool === 'room_read')?.summary).toContain('not read (shared chat)')
    const chat2 = await newShared()
    const yes = await askCards('alice', chat2.id, fake({ tool: 'room_read', args: { room }, sayResult: true }), () => 'share')
    expect(yes.cards).toHaveLength(1)
    expect(textOf(yes.done)).toContain('PINEAPPLE-42')
  })

  test('a room everyone here is in reads with no card; the list of rooms too', async () => {
    const room = await teamRoom(['alice', 'erin', 'carol', 'dana'], 'All hands: MANGO-7')
    const chat = await newShared()
    const r = await askCards('alice', chat.id, fake({ tool: 'room_read', args: { room }, sayResult: true }), () => 'skip')
    expect(r.cards).toHaveLength(0)
    expect(textOf(r.done)).toContain('MANGO-7')
  })

  test('another member\'s turn reads only with their own access: erin is not in alice\'s room', async () => {
    const room = await teamRoom(['alice', 'dana'], 'Private plan: KIWI-9')
    const chat = await newShared()
    await ask('alice', chat.id, fake({ say: 'hello' }))
    const r = await askCards('erin', chat.id, fake({ tool: 'room_read', args: { room }, sayResult: true }), () => 'share')
    expect(r.cards).toHaveLength(0)
    expect(textOf(r.done)).not.toContain('KIWI-9')
    expect(textOf(r.done)).toContain('No room matching')
  })
})

describe('trash (item 8)', () => {
  test('another person\'s team file goes to the trash behind the delete card (no: it stays)', async () => {
    const rel = `groups/marketing/trash-${uuidv7().slice(-6)}.md`
    fs.writeFileSync(path.join(h.team, rel), 'erin wrote this\n')
    const chat = await newShared()
    const r = await askCards('alice', chat.id, fake({ tool: 'delete_files', args: { paths: [rel] }, sayResult: true }), () => 'skip')
    expect(r.cards.length).toBeGreaterThanOrEqual(1)
    expect(r.cards[0]!.question).toContain('trash')
    expect(fs.existsSync(path.join(h.team, rel))).toBe(true)
  })
})

describe('what the asker has open and their folders (item 6)', () => {
  test('my_folders: a folder some people here cannot see asks on the read card first', async () => {
    const chat = await newShared()
    // alice's own folder is in her list: nobody else here sees its name
    const r = await askCards('alice', chat.id, fake({ tool: 'my_folders', args: {}, sayResult: true }), () => 'skip')
    expect(r.cards).toHaveLength(1)
    expect(events(r.started.turnId).find((e) => e.tool === 'my_folders')?.summary).toContain('not shown (shared chat)')
  })

  test('a file shared with the asker one by one: read by its link after the read card (no: nothing of it), listed by shared_with_me behind the same card', async () => {
    const rel = `users/erin/plan-${uuidv7().slice(-6)}.md`
    fs.mkdirSync(path.join(h.team, 'users/erin'), { recursive: true })
    fs.writeFileSync(path.join(h.team, rel), 'ERIN-PLAN: launch on the 3rd\n')
    await h.api('erin').call(API.putFileShares, { body: { path: rel, add: [{ subjectType: 'user', subjectId: 'alice' }], remove: [] } })
    const link = ((await h.api('erin').call(API.fileLink, { body: { path: rel } })) as { id: string }).id
    const chat = await newShared()
    const no = await askCards('alice', chat.id, fake({ tool: 'read', args: { file_path: `/f/${link}` }, sayResult: true }), () => 'skip')
    expect(no.cards).toHaveLength(1)
    expect(textOf(no.done)).not.toContain('ERIN-PLAN')
    const chat2 = await newShared()
    const yes = await askCards('alice', chat2.id, fake({ tool: 'read', args: { file_path: `/f/${link}` }, sayResult: true }), () => 'share')
    expect(yes.cards).toHaveLength(1)
    expect(textOf(yes.done)).toContain('ERIN-PLAN')
    const chat3 = await newShared()
    const list = await askCards('alice', chat3.id, fake({ tool: 'shared_with_me', args: {}, sayResult: true }), () => 'skip')
    expect(list.cards).toHaveLength(1)
    expect(textOf(list.done)).not.toContain('plan-')
  })

  test('looking_at is offered and answers (nothing open: no card)', async () => {
    const chat = await newShared()
    const r = await askCards('alice', chat.id, fake({ tool: 'looking_at', args: {}, sayResult: true }), () => 'skip')
    expect(r.cards).toHaveLength(0)
    expect(textOf(r.done)).toContain('Nothing is known about what the user has open now')
    expect(textOf(r.done)).not.toContain('Not available here')
  })
})

describe('the kept notice of the asker\'s own Drive and Slack (items 3, 4)', () => {
  test('kept per person, service and place; Settings lists it and removing it asks again', () => {
    const place = `p:${projectId}`
    expect(browserWarnSeen(db(), 'alice', place, 'drive')).toBe(false)
    keepBrowserWarnSeen(db(), 'alice', place, null, 'drive')
    expect(browserWarnSeen(db(), 'alice', place, 'drive')).toBe(true)
    // the browser's and Slack's are their own
    expect(browserWarnSeen(db(), 'alice', place)).toBe(false)
    expect(browserWarnSeen(db(), 'alice', place, 'slack')).toBe(false)
    const row = listBrowserWarned(db(), 'alice', 'en').find((x) => x.id === `oseen:drive:${place}`)
    expect(row).toMatchObject({ connection: 'Google Drive', warned: 'Falcon', shared: true })
    expect(dropBrowserWarned(db(), 'bob', `oseen:drive:${place}`)).toBe(false)
    expect(dropBrowserWarned(db(), 'alice', `oseen:nope:${place}`)).toBe(false)
    expect(dropBrowserWarned(db(), 'alice', `oseen:drive:${place}`)).toBe(true)
    expect(browserWarnSeen(db(), 'alice', place, 'drive')).toBe(false)
  })
})
