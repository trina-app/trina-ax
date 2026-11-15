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
let projectId = '', roomId = ''
/** the instructions without the guest section itself (which names what a guest cannot do, Admin among them) */
const outsideGuest = (system: string) => system.replace(/## Guest\n[\s\S]*?(?=\n\n|$)/, '')

beforeAll(async () => {
  h = await startHarness({ name: 'b-guests-prompt' })
  const db = h.ctx.db
  // a team project alice made with erin as its one outside person
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Quote prep', participants: [{ subjectType: 'user', subjectId: 'erin' }], instructions: '' } })).id
  // a group chat alice made with erin, before erin is a guest (a guest is in one place only)
  roomId = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['erin', 'bob'], name: 'Client talk' } }) as Room).id
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
  // ...while what each tool does stays (review: a sentence filter once dropped these with the member-only words)
  expect(tools.make_file).toContain('pptx: ')
  expect(tools.make_file).not.toContain('under skills/')
  expect(tools.list).toContain('List a folder of the team files.')
  expect(tools.move_files).toMatch(/^Move /)
  for (const [name, d] of Object.entries(tools)) for (const w of MEMBER_WORDS) expect({ name, w: String(w), hit: w.test(d) }).toEqual({ name, w: String(w), hit: false })
})

test("a guest's room side chat says it cannot read the room, and never names room_read", async () => {
  const db = h.ctx.db
  // erin's place becomes the group chat for this test
  const room = { id: roomId }
  db.query("UPDATE guests SET place_kind = 'room', place_id = ? WHERE user_id = 'erin'").run(room.id)
  try {
    const { system } = await given('erin', erin, { sideRoomId: room.id })
    expect(system).toContain('Their places in the team: the group chat "Client talk".')
    expect(system).toContain('You cannot read that room\'s messages or files from here')
    expect(system).not.toContain('room_read')
    for (const w of MEMBER_WORDS) expect({ w: String(w), hit: w.test(outsideGuest(system)) }).toEqual({ w: String(w), hit: false })
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
