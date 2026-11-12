// The write card of every connection (server/src/integrations/connections/tools.ts gate, docs/DECISIONS.md "Connector
// write cards: outside content asks, Always allow for every connector"):
// - QA TC-328 (security): after the chat read something someone else wrote (a connection's answer, a web page, a room
//   …) a change asks on the card even where it would go without asking: a team connection set to "Run without asking",
//   a person's own Always allow, a member's own Always allow on a team connection. The card says why and offers no
//   Always allow there. Reads never ask. A declined card sends nothing.
// - QA TC-130: every connection's card offers Send once, Always allow and Don't send. Always allow is the caller's own:
//   their own connection's write rule, or a row of their own for a team connection (never the team's rule), shown in
//   the list and turned back there; it never applies in a scheduled run, after a room read or once the connection moved
//   to another address. Fake services only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
let tasks: any, teamAllow: any, teamAsk: any, apiAllow: any, apiAsk: any
const json = (as: Person, p: string, method: string, body?: unknown) => A.json(p, { method, as, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

beforeAll(async () => {
  A = await makeCApp('c-connector-approval-gate')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
  const both = { everyone: false, groups: [], users: ['alice', 'bob'] }
  tasks = (await json('alice', '/api/integrations', 'POST', { kind: 'mcp', name: 'Tasks', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).body
  teamAllow = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'mcp', name: 'Guest board', url: `${fake.base}/mcp-open?team=allow`, auth: 'none', writePolicy: 'allow', access: both })).body
  teamAsk = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'mcp', name: 'Team board', url: `${fake.base}/mcp-open?team=ask`, auth: 'none', writePolicy: 'ask', access: both })).body
  apiAllow = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'http', name: 'Team API', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY, writePolicy: 'allow', access: both })).body
  apiAsk = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'http', name: 'Asking API', url: `${fake.base}/api/v1/ask`, auth: 'bearer', secret: API_KEY, writePolicy: 'ask', access: both })).body
  expect([tasks.status, teamAllow.status, teamAsk.status, apiAllow.status, apiAsk.status]).toEqual(['connected', 'connected', 'connected', 'connected', 'connected'])
})
afterAll(async () => { fake?.stop(); await A?.close() })

/** the person of a chat turn: what each card asked, the answers it offered and the line under them */
interface Card { question: string; options: string[]; note?: string }
interface Asker { answer: 'yes' | 'always' | 'no'; cards: Card[] }
const asker = (answer: Asker['answer']): Asker => ({ answer, cards: [] })

function turn(user: Person, o: { person?: Asker; scheduled?: boolean; chat?: string; roomsSeen?: boolean } = {}) {
  const chat = o.chat ?? A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: !!o.scheduled })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  if (o.person) {
    const p = o.person
    files.person = {
      locale: 'en',
      async confirm(question, allow, deny) { p.cards.push({ question, options: [allow, deny] }); return p.answer !== 'no' },
      async choose(question, options, extra) {
        p.cards.push({ question, options: options.map((x) => x.label), ...(extra?.note ? { note: extra.note } : {}) })
        // the card's values are the yes / no card's ('allow', 'deny') plus 'always'
        const want = p.answer === 'yes' ? 'allow' : p.answer === 'no' ? 'deny' : p.answer
        return options.some((x) => x.value === want) ? want : null
      },
      *turnUrls() {},
      ...(o.roomsSeen ? { roomsSeen: true } : {}),
      ...(o.scheduled ? { unattended: true } : {}),
    }
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError, summary: r.summary ?? '' }
  }
  return { chat, turnId, call }
}
/** what reached the services */
const created = () => fake.calls.filter((c) => c.name === 'create_task').length
const posted = () => fake.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/api/v1')).length
/** the chat read something someone else wrote, as chat/turn.ts marks it (web_fetch: noteTaint → taint) */
const outside = (chat: string, col: 'session_tainted' | 'room_outside' | 'rooms_seen' = 'session_tainted') => A.ctx.db.query(`UPDATE chats SET ${col} = 1 WHERE id = ?`).run(chat)
const SEND3 = ['Send once', 'Always allow', 'Don’t send']
const SEND2 = ['Send', 'Don’t send']
const OUTSIDE_LINE = 'This chat has read something from outside'

describe('TC-328: outside content asks, whatever the rule', () => {
  test('a team connection set to "Run without asking": no card in a clean chat; after a read from the same service it asks, and no sends nothing', async () => {
    const clean = asker('no')
    const n0 = created()
    expect((await turn('alice', { person: clean }).call('team_guestboard__create_task', { title: 'clean' })).isError).toBe(false)
    expect(clean.cards).toEqual([])
    expect(created()).toBe(n0 + 1)
    // the hostile page: a read of the same service (its answer is outside content), then the change it asks for
    const p = asker('no')
    const t = turn('alice', { person: p })
    const read = await t.call('team_guestboard__search_tasks', { query: 'Project brief' })
    expect(read.isError).toBe(false)
    expect(p.cards).toEqual([])
    const w = await t.call('team_guestboard__create_task', { title: 'CANARY-B11 guest notes' })
    expect(w.isError).toBe(true)
    expect(w.summary).toBe('team_guestboard__create_task -> not allowed by the user')
    expect(created()).toBe(n0 + 1)
    // the card says why, and offers no Always allow (it is on already)
    expect(p.cards).toHaveLength(1)
    expect(p.cards[0]!.question).toStartWith(OUTSIDE_LINE)
    expect(p.cards[0]!.options).toEqual(SEND2)
    // a yes sends it
    const yes = asker('yes')
    const t2 = turn('alice', { person: yes, chat: t.chat })
    expect((await t2.call('team_guestboard__create_task', { title: 'after a yes' })).summary).toContain('confirmed by the user')
    expect(created()).toBe(n0 + 2)
  })

  test('a web page, a room\'s messages or other outside words in the chat: the change asks; reads still go without a card', async () => {
    for (const col of ['session_tainted', 'room_outside', 'rooms_seen'] as const) {
      const p = asker('no')
      const t = turn('alice', { person: p })
      outside(t.chat, col)
      expect((await t.call('team_guestboard__search_tasks', { query: 'x' })).isError).toBe(false)
      expect(p.cards, col).toEqual([])
      const n = created()
      expect((await t.call('team_guestboard__create_task', { title: col })).isError, col).toBe(true)
      expect(p.cards, col).toHaveLength(1)
      expect(created(), col).toBe(n)
    }
  })

  test('an HTTP API set to "Run without asking": POST asks after a web page, GET does not', async () => {
    const clean = asker('no')
    const n0 = posted()
    expect((await turn('alice', { person: clean }).call('api_request', { connection: 'team_teamapi', method: 'POST', path: '/tasks', body: { title: 'clean' } })).isError).toBe(false)
    expect(clean.cards).toEqual([])
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    expect((await t.call('api_request', { connection: 'team_teamapi', method: 'GET', path: '/tasks' })).isError).toBe(false)
    expect(p.cards).toEqual([])
    const r = await t.call('api_request', { connection: 'team_teamapi', method: 'POST', path: '/tasks', body: { title: 'from the page' } })
    expect(r.isError).toBe(true)
    expect(p.cards).toHaveLength(1)
    expect(p.cards[0]!.question).toStartWith(OUTSIDE_LINE)
    expect(posted()).toBe(n0 + 1)
  })

  test('a chat that is gone counts as outside: the change asks', async () => {
    const p = asker('no')
    const t = turn('alice', { person: p })
    // the turn stays; the chat row's marks cannot be read
    A.ctx.db.query('UPDATE chats SET session_tainted = 0 WHERE id = ?').run(t.chat)
    const { outsideSeen } = await import('../../server/src/integrations/connections/tools')
    expect(outsideSeen(A.ctx.db, 'no-such-chat')).toBe(true)
    expect(outsideSeen(A.ctx.db, t.chat)).toBe(false)
  })
})

describe('TC-130: Send once, Always allow, Don\'t send on every card', () => {
  test('the person\'s own connection: three answers; Always allow sets its rule, the next clean chat sends without a card, outside content still asks, Settings turns it back', async () => {
    const first = asker('no')
    const n0 = created()
    expect((await turn('alice', { person: first }).call('my_tasks__create_task', { title: 'no' })).isError).toBe(true)
    expect(first.cards).toHaveLength(1)
    expect(first.cards[0]!.options).toEqual(SEND3)
    expect(first.cards[0]!.note).toContain('Always allow: from now on the AI sends to Tasks without asking')
    expect(created()).toBe(n0)
    // Send once: sent, nothing kept
    expect((await turn('alice', { person: asker('yes') }).call('my_tasks__create_task', { title: 'once' })).summary).toContain('confirmed by the user')
    expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id = ?').get(tasks.id) as { write_policy: string }).write_policy).toBe('ask')
    // Always allow: sent, and kept as her own rule (audited)
    expect((await turn('alice', { person: asker('always') }).call('my_tasks__create_task', { title: 'always' })).isError).toBe(false)
    expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id = ?').get(tasks.id) as { write_policy: string }).write_policy).toBe('allow')
    expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.update' AND target = ? AND detail LIKE '%\"via\":\"card\"%'").get(tasks.id)).toBeTruthy()
    const quiet = asker('no')
    expect((await turn('alice', { person: quiet }).call('my_tasks__create_task', { title: 'quiet' })).isError).toBe(false)
    expect(quiet.cards).toEqual([])
    expect(created()).toBe(n0 + 3)
    // ...but not after something from outside: it asks, says why, offers two answers
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    expect((await t.call('my_tasks__create_task', { title: 'from a page' })).isError).toBe(true)
    expect(p.cards[0]!.question).toStartWith(OUTSIDE_LINE)
    expect(p.cards[0]!.options).toEqual(SEND2)
    expect(created()).toBe(n0 + 3)
    // the list shows it; "Ask every time" (the form's write rule) turns it back
    expect((await json('alice', `/api/integrations/${tasks.id}`, 'PATCH', { writePolicy: 'ask' })).status).toBe(200)
    const again = asker('no')
    await turn('alice', { person: again }).call('my_tasks__create_task', { title: 'asks again' })
    expect(again.cards[0]!.options).toEqual(SEND3)
  })

  test('a team connection: Always allow is the member\'s own (never the team\'s rule), shown in the list, gone when the address moves, turned back by them', async () => {
    const n0 = created()
    expect((await turn('alice', { person: asker('always') }).call('team_teamboard__create_task', { title: 'always' })).isError).toBe(false)
    expect(created()).toBe(n0 + 1)
    expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id = ?').get(teamAsk.id) as { write_policy: string }).write_policy).toBe('ask')
    expect(A.ctx.db.query('SELECT user_id FROM integration_user_allow WHERE integration_id = ?').all(teamAsk.id)).toEqual([{ user_id: 'alice' }])
    expect(A.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'integration.always_allow' AND target = ?").get(teamAsk.id)).toEqual({ detail: JSON.stringify({ allow: true, via: 'card' }) })
    // alice: no card in a clean chat; bob, who may use it too, is still asked
    const quiet = asker('no')
    expect((await turn('alice', { person: quiet }).call('team_teamboard__create_task', { title: 'quiet' })).isError).toBe(false)
    expect(quiet.cards).toEqual([])
    const bob = asker('no')
    expect((await turn('bob', { person: bob }).call('team_teamboard__create_task', { title: 'bob' })).isError).toBe(true)
    expect(bob.cards[0]!.options).toEqual(SEND3)
    // the list: alice sees her own choice, bob does not
    const mine = (who: Person) => ((A.json('/api/integrations', { as: who }) as Promise<{ body: { items: any[] } }>).then((r) => r.body.items.find((i) => i.id === teamAsk.id)))
    expect((await mine('alice')).alwaysAllowedByMe).toBe(true)
    expect((await mine('bob')).alwaysAllowedByMe).toBe(false)
    // outside content, a room read, a scheduled run: it asks (or is refused) as before
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    expect((await t.call('team_teamboard__create_task', { title: 'page' })).isError).toBe(true)
    expect(p.cards[0]!.options).toEqual(SEND2)
    const seen = asker('no')
    expect((await turn('alice', { person: seen, roomsSeen: true }).call('team_teamboard__create_task', { title: 'room' })).isError).toBe(true)
    expect(seen.cards).toHaveLength(1)
    expect(seen.cards[0]!.options).toEqual(SEND2)
    expect((await turn('alice', { scheduled: true }).call('team_teamboard__create_task', { title: 'run' })).isError).toBe(true)
    expect(created()).toBe(n0 + 2)
    // an admin moves it to another address: her choice no longer counts
    expect((await json('carol', `/api/integrations/${teamAsk.id}`, 'PATCH', { url: `${fake.base}/mcp-open?team=ask-moved` })).status).toBe(200)
    const moved = asker('always')
    expect((await turn('alice', { person: moved }).call('team_teamboard__create_task', { title: 'moved' })).isError).toBe(false)
    expect(moved.cards).toHaveLength(1)
    // she turns it back in the list; the team's rule is untouched
    const back = await json('alice', `/api/integrations/${teamAsk.id}/always-allow`, 'DELETE')
    expect(back.status).toBe(200)
    expect(back.body.alwaysAllowedByMe).toBe(false)
    const again = asker('no')
    expect((await turn('alice', { person: again }).call('team_teamboard__create_task', { title: 'again' })).isError).toBe(true)
    expect(again.cards).toHaveLength(1)
    expect((A.ctx.db.query('SELECT write_policy FROM integrations WHERE id = ?').get(teamAsk.id) as { write_policy: string }).write_policy).toBe('ask')
    // someone who may not use it gets "not found", not a way to learn about it
    expect((await json('dana', `/api/integrations/${teamAsk.id}/always-allow`, 'DELETE')).status).toBe(404)
  })

  test('an HTTP API\'s card offers it too; a connection that already sends without asking offers no Always allow', async () => {
    const p = asker('always')
    expect((await turn('alice', { person: p }).call('api_request', { connection: 'team_askingapi', method: 'POST', path: '/tasks', body: { title: 'x' } })).isError).toBe(false)
    expect(p.cards[0]!.options).toEqual(SEND3)
    const quiet = asker('no')
    expect((await turn('alice', { person: quiet }).call('api_request', { connection: 'team_askingapi', method: 'POST', path: '/tasks', body: { title: 'y' } })).isError).toBe(false)
    expect(quiet.cards).toEqual([])
    await json('alice', `/api/integrations/${apiAsk.id}/always-allow`, 'DELETE')
  })
})
