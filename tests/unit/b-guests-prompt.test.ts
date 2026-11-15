// What a guest's AI is told (docs/DECISIONS.md "The AI tells a guest the truth"): a guest asked "can I connect apps?"
// and was told about the team drive, Admin > Plugins and the desktop app's browser, and to ask a team admin. Real
// runtime, fake engine: the instructions and every tool description a guest's turn gets carry the guest section (their
// place by name, who to ask) and none of the team-wide words; a member's turn keeps them as before.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Room } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { guestToolDescription } from '../../server/src/chat/guest-tools'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
let erin: TestSocket, alice: TestSocket
let projectId = '', roomId = '', dmId = ''
/** the instructions without the guest section itself (which names what a guest cannot do, Admin among them) */
const outsideGuest = (system: string) => system.replace(/## Guest\n[\s\S]*?(?=\n\n|$)/, '')

beforeAll(async () => {
  h = await startHarness({ name: 'b-guests-prompt' })
  const db = h.ctx.db
  // a team project alice made with erin as its one outside person
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Quote prep', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: '' } })).id
  // a group chat alice made with erin, before erin is a guest (a guest is in one place only)
  roomId = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'bob'], name: 'Client talk' } }) as Room).id
  // bob and erin's 1:1 chat (bob shares erin's group chat): a guest's AI reads none of it
  dmId = (await h.api('bob').call(API.createRoom, { body: { kind: 'dm', userId: 'erin' } }) as Room).id
  await h.api('bob').call(API.sendRoomMessage, { params: { id: dmId }, body: { body: 'DM-SECRET-55', clientMessageId: 'cm-' + crypto.randomUUID(), fileIds: [] } })
  db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
  const team = (db.query("SELECT id FROM engine_credentials WHERE kind = 'anthropic-api-key' AND owner_user_id IS NULL").get() as { id: string }).id
  db.query("INSERT INTO guests (user_id, place_kind, place_id, ai, team_credential_id, invited_by, created_at) VALUES ('erin', 'project', ?, 'team', ?, 'alice', ?)").run(projectId, team, new Date().toISOString())
  db.query("INSERT INTO budgets (id, subject_type, subject_id, period, limit_usd, action) VALUES ('b-erin', 'user', 'erin', 'month', 5, 'block')").run()
  erin = await h.ws('erin', { windowId: 'win-erin' }); await erin.next('hello')
  alice = await h.ws('alice', { windowId: 'win-alice' }); await alice.next('hello')
})
afterAll(async () => { erin?.close(); alice?.close(); await h?.close() })

/** what the engine was given: its instructions, and each tool's description by name */
async function given(user: 'erin' | 'alice', socket: TestSocket, body: Record<string, unknown> = {}) {
  const chat = await h.api(user).call(API.createChat, { body: { engine: 'claude-code', ...body } })
  const system = String((await ask(h, socket, user, chat.id, fake({ echo: 'system' }))).done.content)
  const chat2 = await h.api(user).call(API.createChat, { body: { engine: 'claude-code', ...body } })
  const tools = JSON.parse(String((await ask(h, socket, user, chat2.id, fake({ echo: 'toolDescriptions' }))).done.content).trim()) as Record<string, string>
  return { system, tools }
}

// team-wide words a guest's turn must never carry (the owner's report, 2026-11-15)
const MEMBER_WORDS = [/team drive/i, /shared drive/i, /\bAdmin\b/, /plugin/i, /connect_service|connectors?\b|connected services/i, /## Team skills|find_skills|skills\//i, /desktop app has a browser|## Browser/i, /ask (a|the) team admin|an admin can/i]

test("a guest's turn: the guest section with their place and inviter, and no team-wide words in the instructions or tools", async () => {
  const { system, tools } = await given('erin', erin, { projectId })
  expect(system).toContain('## Guest')
  expect(system).toContain('The user is a guest from outside the team. Their places in the team: the project "Quote prep".')
  expect(system).toContain('they can ask Alice Kim, the person who invited them')
  for (const w of MEMBER_WORDS) expect({ w: String(w), hit: w.test(outsideGuest(system)) }).toEqual({ w: String(w), hit: false })
  // the tool list is the guest list, and no description talks about what only members have
  expect(Object.keys(tools)).toContain('make_file')
  for (const no of ['find_skills', 'skill', 'connect_service', 'web_fetch', 'post_to_room', 'room_read']) expect(Object.keys(tools)).not.toContain(no)
  expect(system).not.toContain('GUEST_ROOMS_RULE')
  expect(system).not.toContain('The group chat the user was invited to is readable')
  // a project guest's own chat (not the project's shared one): no room tools either, and no word of reading rooms
  const own = await given('erin', erin)
  for (const no of ['room_read', 'room_file', 'rooms']) expect(Object.keys(own.tools)).not.toContain(no)
  expect(own.system).not.toContain('room_read')
  // ...while what each tool does stays (review: a sentence filter once dropped these with the member-only words)
  expect(tools.make_file).toContain('pptx: ')
  expect(tools.make_file).not.toContain('under skills/')
  expect(tools.list).toContain('List a folder of the team files.')
  expect(tools.move_files).toMatch(/^Move /)
  for (const [name, d] of Object.entries(tools)) for (const w of MEMBER_WORDS) expect({ name, w: String(w), hit: w.test(d) }).toEqual({ name, w: String(w), hit: false })
})

test("a guest's room side chat reads their room: the side-panel section, room_read and room_file, no rooms list or posting", async () => {
  const db = h.ctx.db
  db.query("UPDATE guests SET place_kind = 'room', place_id = ? WHERE user_id = 'erin'").run(roomId)
  try {
    const { system, tools } = await given('erin', erin, { sideRoomId: roomId })
    expect(system).toContain('Their places in the team: the group chat "Client talk".')
    expect(system).toContain('You can read the group chat "Client talk" with room_read, and a file sent there with room_file')
    expect(system).toContain(`Read it with room_read (room "${roomId}")`)
    expect(system).not.toContain('save_room_file')
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['room_read', 'room_file']))
    for (const no of ['rooms', 'save_room_file', 'post_to_room']) expect(Object.keys(tools)).not.toContain(no)
    expect(tools.room_file).not.toContain('save_room_file')
    for (const w of MEMBER_WORDS) expect({ w: String(w), hit: w.test(outsideGuest(system)) }).toEqual({ w: String(w), hit: false })
  } finally {
    db.query("UPDATE guests SET place_kind = 'project', place_id = ? WHERE user_id = 'erin'").run(projectId)
  }
})

test("security: a guest's AI reads only their own group chat, never another room or their 1:1 chat, even by its id", async () => {
  const db = h.ctx.db
  // rooms erin is not in: a group chat of alice and bob, and the marketing team room
  const other = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'carol'], name: 'Pricing inside' } }) as Room).id
  await h.api('alice').call(API.sendRoomMessage, { params: { id: other }, body: { body: 'SECRET-PRICE-991', clientMessageId: 'cm-' + crypto.randomUUID(), fileIds: [] } })
  await h.api('alice').call(API.sendRoomMessage, { params: { id: roomId }, body: { body: 'HELLO-ERIN-17', clientMessageId: 'cm-' + crypto.randomUUID(), fileIds: [] } })
  const team = (db.query("SELECT id FROM rooms WHERE kind = 'team' AND archived_at IS NULL LIMIT 1").get() as { id: string }).id
  const everyone = (db.query("SELECT id FROM rooms WHERE kind = 'all' LIMIT 1").get() as { id: string } | null)?.id
  // a guest is in their one group chat only (the harness made erin a member first: her other rooms go, as an invite has none)
  db.query('DELETE FROM room_members WHERE user_id = ? AND room_id NOT IN (?, ?)').run('erin', roomId, dmId)
  db.query("UPDATE guests SET place_kind = 'room', place_id = ? WHERE user_id = 'erin'").run(roomId)
  try {
    const side = await h.api('erin').call(API.createChat, { body: { engine: 'claude-code', sideRoomId: roomId } })
    const read = (room: string) => fake({ tool: 'room_read', args: { room }, sayResult: true })
    const own = String((await ask(h, erin, 'erin', side.id, read(roomId))).done.content)
    expect(own).toContain('HELLO-ERIN-17')
    const file = await h.api('erin').call(API.createChat, { body: { engine: 'claude-code', sideRoomId: roomId } })
    const viaFile = String((await ask(h, erin, 'erin', file.id, fake({ tool: 'room_file', args: { room: other, file: 'plan.pdf' }, sayResult: true }))).done.content)
    expect(viaFile).toContain('Only the group chat the user was invited to can be read')
    for (const ref of [other, team, ...(everyone ? [everyone] : []), dmId, 'Pricing inside', 'Marketing', 'everyone', 'Bob Lee']) {
      const chat = await h.api('erin').call(API.createChat, { body: { engine: 'claude-code', sideRoomId: roomId } })
      const r = String((await ask(h, erin, 'erin', chat.id, read(ref))).done.content)
      expect({ ref, leaked: r.includes('SECRET-PRICE-991') || r.includes('DM-SECRET-55') || r.includes('<room_messages') }).toEqual({ ref, leaked: false })
      // and the AI is not sent to a rooms tool a guest does not have
      expect({ ref, rooms: r.includes('Call rooms') }).toEqual({ ref, rooms: false })
    }
  } finally {
    db.query("UPDATE guests SET place_kind = 'project', place_id = ? WHERE user_id = 'erin'").run(projectId)
  }
})

test("a member's turn is unchanged: no guest section, the team's words and tools stay", async () => {
  const { system, tools } = await given('alice', alice, { projectId })
  expect(system).not.toContain('## Guest')
  expect(system).toContain("working in the team's shared drive")
  expect(system).toContain('## Where you run')
  expect(system).toContain('Everything you save goes to the team drive')
  expect(system).toContain('skills/ (')
  expect(Object.keys(tools)).toContain('find_skills')
  expect(tools.make_file).toContain('Admin > Plugins')
})

test('guestToolDescription rewrites the member-only parts and keeps the rest', () => {
  const d = 'Create a Word file. Hangul (.hwp/.hwpx) documents cannot be made or filled here: when the person asks for one, say in one plain sentence that an admin can turn on the Hangul plugin (Admin > Plugins, "HWP Preview"), and to a person who is not an admin say to ask an admin; offer a Word file meanwhile. pptx: each slide starts with ##. `template`: a .docx/.pptx under skills/ for styles. Move files of the team drive. A future line about Admin > Plugins. Limits: 30 slides.'
  expect(guestToolDescription(d)).toBe('Create a Word file. Hangul (.hwp/.hwpx) documents cannot be made or filled here: when the person asks for one, say so in one plain sentence and offer a Word file. pptx: each slide starts with ##. Move files of the team files. Limits: 30 slides.')
})
