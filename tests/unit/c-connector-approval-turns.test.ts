// The write card's outside-content rule in real chat turns (fake engine, tests/lib/b-harness.ts; QA TC-328 and the
// independent review of #583). A team HTTP API set to "Run without asking":
// - a clean chat sends its first change with no card (the own chat's room_outside mark, set before any connection
//   tool runs, is not something read: chat/turn.ts noteRoomTool);
// - after web_fetch the change asks, with Send / Don't send only, and no sends nothing;
// - after a first change's reply (a connection's answer is outside content, the owner's strict rule) a second change
//   in the same chat asks; so does a change after a read.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { API_KEY, FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(60_000)

let h: Harness, fake: FakeServices
const published: { userId: string; ev: any }[] = []
const fakeLines = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

beforeAll(async () => {
  h = await startHarness({ name: 'c-approval-turns', askUserTimeoutMs: 6000, turnTimeoutMs: 60_000 })
  const hub = h.rt().hub
  const publish = hub.publish.bind(hub), publishTo = hub.publishTo.bind(hub)
  hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  hub.publishTo = (userId, w, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); return publishTo(userId, w, ev) }
  fake = new FakeServices()
  integrationsOf(h.ctx, { net: fake.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'http', name: 'Guest API', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY, writePolicy: 'allow', access: { everyone: false, groups: [], users: ['alice'] } } })
  expect(team.status).toBe('connected')
})
afterAll(async () => { fake?.stop(); await h?.close() })

const POST = (title: string) => ({ tool: 'api_request', args: { connection: 'team_guestapi', method: 'POST', path: '/tasks', body: { title } }, sayResult: true })
const GET = { tool: 'api_request', args: { connection: 'team_guestapi', method: 'GET', path: '/tasks' }, sayResult: true }
const posted = () => fake.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/api/v1')).length

/** One turn of alice with these calls; every card is answered with its last answer (the quiet "no"). Returns the
 * cards of Guest API and the other cards. */
async function turn(...calls: Record<string, unknown>[]) {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fakeLines(...calls), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const answered = new Set<string>()
  const cards: any[] = []
  const answer = setInterval(() => {
    for (const p of published) {
      if (p.ev.type !== 'turn.request' || p.ev.data.turnId !== r.turnId) continue
      const q = p.ev.data.request
      if (answered.has(q.requestId)) continue
      answered.add(q.requestId)
      cards.push(q)
      const last = q.options?.at(-1)?.value
      if (last) void h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: q.requestId, answer: last } }).catch(() => {})
    }
  }, 20)
  const done = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === r.assistantMessage.id), { timeoutMs: 40_000, what: 'message.done' }).finally(() => clearInterval(answer))
  expect(done).toBeTruthy()
  const ours = cards.filter((c) => typeof c.question === 'string' && c.question.includes('Guest API'))
  const marks = h.ctx.db.query('SELECT session_tainted AS t, room_outside AS o FROM chats WHERE id = ?').get(chat.id) as { t: number; o: number }
  const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'api_request' ORDER BY id").all(r.turnId) as { summary: string }[]
  return { cards: ours, others: cards.filter((c) => !ours.includes(c)), marks, events: events.map((e) => e.summary) }
}

describe('outside content in real turns (TC-328, review of #583)', () => {
  test('a clean chat: the first change goes with no card', async () => {
    const n = posted()
    const t = await turn(POST('clean'))
    expect(t.cards).toEqual([])
    expect(posted()).toBe(n + 1)
    expect(t.events[0]).toContain('POST /api/v1/tasks -> 201')
    // the own chat's "used a tool" mark (set before the call) is there; the reply then marks the chat as outside
    expect(t.marks).toEqual({ t: 1, o: 1 })
  })

  test('after web_fetch: the change asks with Send / Don\'t send only, and no sends nothing', async () => {
    const n = posted()
    const t = await turn({ tool: 'web_fetch', args: { url: 'https://example.com/guest-notes' }, sayResult: true }, POST('from the page'))
    expect(t.cards).toHaveLength(1)
    expect(t.cards[0].question).toStartWith('This chat has read something from outside')
    expect(t.cards[0].options.map((o: { label: string }) => o.label)).toEqual(['Send', 'Don’t send'])
    expect(posted()).toBe(n)
  })

  test('after a first change\'s reply (strict rule) the second change asks; a read then a change asks too', async () => {
    const n = posted()
    const t = await turn(POST('first'), POST('second'))
    expect(t.cards).toHaveLength(1)
    expect(posted()).toBe(n + 1)
    const r = await turn(GET, POST('after a read'))
    expect(r.cards).toHaveLength(1)
    expect(posted()).toBe(n + 1)
  })
})
