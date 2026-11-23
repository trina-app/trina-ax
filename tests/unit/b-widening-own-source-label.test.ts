// The save card's "where it came from" for a place the asker opened themselves (owner, 2026-11-22, 0.7.0; docs/decisions/
// 20261121-widening-false-positive-project.md). In a team project chat of exactly two people, the asker's own call to a
// team connection the other member may not use, then a save into the project folder: the card still comes ("1 of them
// can't see where it came from": the other member may not use that connection) and now names the connection with its
// count. It said "a place someone else opened in this chat" (chat/turn.ts seesSource had no case for a connection).
// The other member's save after that read still gets "a place someone else opened" (they may not use it), and a team
// connection everyone may use asks nothing. A room part in the chat's read scope is named to a member who sees it, and
// not to one from whom a later answer there is hidden (judged with the chat's reader, its creator: security review of #281). Fake engine through the real launcher and gate; fake MCP services.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { addSources, readScope } from '../../server/src/chat/read-scope'
import { tr } from '../../server/src/chat/i18n'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
/** the label for a place the person cannot see, in alice's (English) and bob's (Korean) words */
const OTHER = tr('sharedScopeOther', 'en')
/** the card's line for sources the asker cannot see, in bob's Korean words (#283: widenWhyHidden, "…{m}명은 열 수 없는 곳에서…") */
const HIDDEN_KO = (m: number) => tr('widenWhyHidden', 'ko', { m: String(m) })

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-widening-own-source-label', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
  // carol (admin) connects two team services: one only alice may use, one for everyone
  const only = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Deck Images', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: ['alice'] } } as never })
  expect(only.status).toBe('connected')
  const all = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Open Search', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(all.status).toBe('connected')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

type Card = { requestId: string; question: string; options: { value: string }[] }
/** one answer of `user`; every card is answered with its first button (use / save); returns the cards' questions */
async function run(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  for (const end = Date.now() + 60_000; ;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && !cards.some((c) => c.requestId === (x.data.request as { requestId: string }).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: c.options[0]!.value } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { questions: cards.map((c) => c.question), content: done.data.message.content as string }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
/** a team project of alice with bob (two people) and alice's shared chat in it */
let n = 0
async function projectChat() {
  const p = await h.api('alice').call(API.createProject, { body: { name: `테스트 프로젝트 ${++n}`, participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
  const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id as string
  fs.mkdirSync(path.join(h.ctx.files.fx.root, p.folderPath, 'svg_output'), { recursive: true })
  return { folder: p.folderPath as string, chat }
}
const save = (file: string) => fake({ tool: 'write', args: { file_path: file, content: '<svg/>' }, sayResult: true })
const saved = (file: string) => fs.existsSync(path.join(h.ctx.files.fx.root, file))

test('the asker\'s own team connection that the other member may not use: the card still asks, and names it', async () => {
  const { folder, chat } = await projectChat()
  const used = await run('alice', chat, fake({ tool: 'team_deckimages__search_tasks', args: { query: 'logo' }, sayResult: true }))
  expect(used.questions).toHaveLength(1)
  expect(readScope(h.ctx.db, chat)?.map((s) => s.type)).toEqual(['integration'])
  const target = `${folder}/svg_output/06_contact.svg`
  const r = await run('alice', chat, save(target))
  expect(r.questions).toHaveLength(1)
  const q = r.questions[0]!
  // the check is unchanged: two people see the folder, bob may not use Deck Images
  expect(q).toContain('Save 06_contact.svg to')
  expect(q).toContain('where 2 people can see it')
  // the place is alice's own: named in the "Trina made it from {source}" line, with how many cannot open it
  expect(q).toContain('Trina made it from Deck Images, which 1 of them can’t open.')
  expect(q).not.toContain(tr('widenSourceHidden', 'en'))
  expect(q).not.toContain(OTHER)
  expect(saved(target)).toBe(true)
})

test('the other member saving after that read: still asked, and the connection stays unnamed to them', async () => {
  const { folder, chat } = await projectChat()
  await run('alice', chat, fake({ tool: 'team_deckimages__search_tasks', args: { query: 'logo' }, sayResult: true }))
  const target = `${folder}/svg_output/07_bob.svg`
  const r = await run('bob', chat, save(target))
  expect(r.questions).toHaveLength(1)
  // (bob's screen language is Korean: "2명이 볼 수 있는 곳이에요. … 그중 1명은 열 수 없는 곳에서 …")
  expect(r.questions[0]).toContain('2명이 볼 수 있는 곳')
  expect(r.questions[0]).toContain(HIDDEN_KO(1))
  expect(r.questions[0]).not.toContain('Deck Images')
  expect(saved(target)).toBe(true)
})

test('a team connection both may use: no save card', async () => {
  const { folder, chat } = await projectChat()
  const used = await run('alice', chat, fake({ tool: 'team_opensearch__search_tasks', args: { query: 'logo' }, sayResult: true }))
  // (the one notice of a shared project, team connections too: docs/decisions/20261123-shared-connector-warning-once.md)
  expect(used.questions).toHaveLength(1)
  const target = `${folder}/svg_output/08_all.svg`
  const r = await run('alice', chat, save(target))
  expect(r.questions).toHaveLength(0)
  expect(saved(target)).toBe(true)
})

/** alice's project chat with bob, holding the read of a group room of alice, bob and erin from its first message
 * (as room_file or a read before the project would leave it); `hideFromBob`: a later answer there is hidden from bob */
async function roomChat(hideFromBob: boolean) {
  const { chat } = await projectChat()
  // a first answer (a chat's first message starts a new session, which clears its read scope)
  await run('alice', chat, fake({ echo: 'hi' }))
  const room = (await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob', 'erin'] } })).id as string
  const m = await h.api('alice').call(API.sendRoomMessage, { params: { id: room }, body: { body: 'launch plan', clientMessageId: cm(), mentions: [], fileIds: [] } })
  if (hideFromBob) h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(room, 'bob', m.id, m.seq)
  addSources(h.ctx.db, chat, [{ type: 'room', id: room, fromSeq: m.seq }])
  return chat
}

test('a room part bob sees: named on his card (shared/ has more readers than the room, so it asks)', async () => {
  const chat = await roomChat(false)
  const target = `shared/label-room-${++n}.svg`
  const r = await run('bob', chat, save(target))
  expect(r.questions).toHaveLength(1)
  expect(r.questions[0]).not.toContain(HIDDEN_KO(1))
  expect(r.questions[0]).toContain('Erin')
})

test('a room part with a later answer hidden from bob: not named to him', async () => {
  const chat = await roomChat(true)
  const target = `shared/label-room-${++n}.svg`
  const r = await run('bob', chat, save(target))
  expect(r.questions).toHaveLength(1)
  expect(r.questions[0]).toContain(tr('widenWhyHidden', 'ko', { m: '3' }))
  expect(r.questions[0]).not.toContain('Erin')
})
