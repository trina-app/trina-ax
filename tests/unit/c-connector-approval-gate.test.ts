// The write card of every connection (server/src/integrations/connections/tools.ts gate, docs/DECISIONS.md "Connector
// write cards: outside content asks, Always allow for every connector"):
// - QA TC-328 (security): after the chat read something someone else wrote (a connection's answer, a web page, a room
//   …) a change asks on the card even where it would go without asking: a team connection set to "Run without asking",
//   a person's own Always allow, a member's own Always allow on a team connection. The card says why and offers no
//   Always allow there. Reads never ask. A declined card sends nothing.
// - QA TC-130: every connection's card offers Send once, Always allow and Don't send. Always allow is the caller's own:
//   their own connection's write rule, or a row of their own for a team connection (never the team's rule), shown in
//   the list and turned back there; it holds in the person's own scheduled run (owner 2026-11-14), after a room read, and not once the connection moved
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

/** `live` (default on): the person watches the turn in their own app (TurnPerson.allSitesHere); off: a Slack question */
function turn(user: Person, o: { person?: Asker; scheduled?: boolean; chat?: string; roomsSeen?: boolean; live?: boolean } = {}) {
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
      allSitesHere: () => o.live !== false && !o.scheduled,
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
const OUTSIDE_LINE = 'This chat has read something from outside'

// docs/DECISIONS.md "Always allow on every card" (the owner, 2026-11-13: "항상 허용을 눌렀으면 안해야하는거 아니야?"): a
// connection that sends without asking for this person does so also after outside content or a room read
describe('TC-328 (since 2026-11-13): "without asking" holds after outside content too', () => {
  test('a team connection set to "Run without asking": no card in a clean chat, and none after a read from the same service', async () => {
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
    const w = await t.call('team_guestboard__create_task', { title: 'after a read' })
    expect(w.isError).toBe(false)
    expect(p.cards).toEqual([])
    expect(created()).toBe(n0 + 2)
  })

  test('a web page or other outside words, or a room\'s messages, in the chat: no card either; reads never ask', async () => {
    for (const col of ['session_tainted', 'rooms_seen'] as const) {
      const p = asker('no')
      const t = turn('alice', { person: p })
      outside(t.chat, col)
      const n = created()
      expect((await t.call('team_guestboard__create_task', { title: col })).isError, col).toBe(false)
      expect(p.cards, col).toEqual([])
      expect(created(), col).toBe(n + 1)
    }
    // room_outside is set in the person's own chat before any connection tool runs (chat/turn.ts noteRoomTool), this
    // one included: it says a tool was used, not that something was read (review of #583)
    const used = asker('no')
    const u = turn('alice', { person: used })
    outside(u.chat, 'room_outside')
    const n = created()
    expect((await u.call('team_guestboard__create_task', { title: 'used a tool' })).isError).toBe(false)
    expect(used.cards).toEqual([])
    expect(created()).toBe(n + 1)
    // a read after outside content: no card
    const r = asker('no')
    const t = turn('alice', { person: r })
    outside(t.chat)
    expect((await t.call('team_guestboard__search_tasks', { query: 'x' })).isError).toBe(false)
    expect(r.cards).toEqual([])
  })

  test('an HTTP API set to "Run without asking": POST and GET go without a card after a web page too', async () => {
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
    expect(r.isError).toBe(false)
    expect(p.cards).toEqual([])
    expect(posted()).toBe(n0 + 2)
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
  test('the person\'s own connection: three answers; Always allow sets its rule, the next chat sends without a card (also after outside content), Settings turns it back', async () => {
    const first = asker('no')
    const n0 = created()
    expect((await turn('alice', { person: first }).call('my_tasks__create_task', { title: 'no' })).isError).toBe(true)
    expect(first.cards).toHaveLength(1)
    expect(first.cards[0]!.options).toEqual(SEND3)
    expect(first.cards[0]!.note).toContain('Always allow every change in Tasks, not only this one: from now on, in every chat, Trina sends, edits and deletes in Tasks without asking, even after reading web pages or files')
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
    // ...and after something from outside too
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    expect((await t.call('my_tasks__create_task', { title: 'from a page' })).isError).toBe(false)
    expect(p.cards).toEqual([])
    expect(created()).toBe(n0 + 4)
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
    // outside content and a room read: no card either; a scheduled run is refused as before
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    expect((await t.call('team_teamboard__create_task', { title: 'page' })).isError).toBe(false)
    expect(p.cards).toEqual([])
    const seen = asker('no')
    expect((await turn('alice', { person: seen, roomsSeen: true }).call('team_teamboard__create_task', { title: 'room' })).isError).toBe(false)
    expect(seen.cards).toEqual([])
    // her own run: her own Always allow holds there too (owner 2026-11-14), nobody is asked
    expect((await turn('alice', { scheduled: true }).call('team_teamboard__create_task', { title: 'run' })).isError).toBe(false)
    expect(created()).toBe(n0 + 5)
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

  test('a card shown in a chat that read something from outside offers Always allow too (the owner, 2026-11-13)', async () => {
    const p = asker('no')
    const t = turn('alice', { person: p })
    outside(t.chat)
    const n = created()
    expect((await t.call('team_teamboard__create_task', { title: 'page asked' })).isError).toBe(true)
    expect(p.cards).toHaveLength(1)
    expect(p.cards[0]!.options).toEqual(SEND3)
    expect(p.cards[0]!.question).not.toStartWith(OUTSIDE_LINE)
    expect(created()).toBe(n)
    expect(A.ctx.db.query('SELECT 1 FROM integration_user_allow WHERE integration_id = ?').all(teamAsk.id)).toEqual([])
  })


  test('the team\'s "never" wins over a member\'s own Always allow', async () => {
    const deny = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'mcp', name: 'Locked board', url: `${fake.base}/mcp-open?team=deny`, auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: ['alice'] } })).body
    try {
      expect((await turn('alice', { person: asker('always') }).call('team_lockedboard__create_task', { title: 'always' })).isError).toBe(false)
      expect(A.ctx.db.query('SELECT user_id FROM integration_user_allow WHERE integration_id = ?').all(deny.id)).toEqual([{ user_id: 'alice' }])
      expect((await json('carol', `/api/integrations/${deny.id}`, 'PATCH', { writePolicy: 'deny' })).status).toBe(200)
      const p = asker('yes')
      const n = created()
      const r = await turn('alice', { person: p }).call('team_lockedboard__create_task', { title: 'blocked' })
      expect(r.isError).toBe(true)
      expect(r.summary).toBe('team_lockedboard__create_task -> refused (write policy deny)')
      expect(p.cards).toEqual([])
      expect(created()).toBe(n)
    } finally { A.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(deny.id) }
  })

  test('a member\'s own Always allow goes when they lose access (it never comes back on its own), and they can clear it without access', async () => {
    const t = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'mcp', name: 'Gone board', url: `${fake.base}/mcp-open?team=gone`, auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: ['alice', 'bob'] } })).body
    const rows = () => (A.ctx.db.query('SELECT user_id FROM integration_user_allow WHERE integration_id = ? ORDER BY user_id').all(t.id) as { user_id: string }[]).map((r) => r.user_id)
    try {
      for (const who of ['alice', 'bob'] as const) expect((await turn(who, { person: asker('always') }).call('team_goneboard__create_task', { title: who })).isError).toBe(false)
      expect(rows()).toEqual(['alice', 'bob'])
      // the admin takes bob out of the rule: his choice goes, alice's stays
      expect((await json('carol', `/api/integrations/${t.id}`, 'PATCH', { access: { everyone: false, groups: [], users: ['alice'] } })).status).toBe(200)
      expect(rows()).toEqual(['alice'])
      // given access again, bob is asked again
      expect((await json('carol', `/api/integrations/${t.id}`, 'PATCH', { access: { everyone: false, groups: [], users: ['alice', 'bob'] } })).status).toBe(200)
      const bob = asker('no')
      expect((await turn('bob', { person: bob }).call('team_goneboard__create_task', { title: 'again' })).isError).toBe(true)
      expect(bob.cards).toHaveLength(1)
      // a row left behind (written directly) is cleared by its own person even without access: "not found", row gone
      A.ctx.db.query('INSERT INTO integration_user_allow (integration_id, user_id, url, created_at) VALUES (?, ?, ?, ?)').run(t.id, 'erin', t.url, new Date().toISOString())
      expect((await json('erin', `/api/integrations/${t.id}/always-allow`, 'DELETE')).status).toBe(404)
      expect(rows()).toEqual(['alice'])
    } finally { A.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(t.id) }
  })

  test('the user edit page: out of the group that gave access, or the account disabled, the member\'s own Always allow goes and does not come back', async () => {
    // a group with a real id (the user edit page takes ids of groups)
    const group = crypto.randomUUID().replace(/^(.{14})./, '$17')
    A.ctx.db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(group, 'Edit page group')
    A.ctx.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?), (?, ?)').run(group, 'erin', group, 'bob')
    const t = (await json('carol', '/api/admin/integrations', 'POST', { kind: 'mcp', name: 'Group board', url: `${fake.base}/mcp-open?team=group`, auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [group], users: [] } })).body
    const rows = () => (A.ctx.db.query('SELECT user_id FROM integration_user_allow WHERE integration_id = ? ORDER BY user_id').all(t.id) as { user_id: string }[]).map((r) => r.user_id)
    const groupsOf = (who: string) => (A.ctx.db.query('SELECT group_id FROM group_members WHERE user_id = ?').all(who) as { group_id: string }[]).map((r) => r.group_id).filter((g) => /^[0-9a-f-]{36}$/.test(g))
    try {
      for (const who of ['bob', 'erin'] as const) expect((await turn(who, { person: asker('always') }).call('team_groupboard__create_task', { title: who })).isError).toBe(false)
      expect(rows()).toEqual(['bob', 'erin'])
      // erin is taken out of the group on her own page: her choice goes, bob's stays
      const out = await json('carol', '/api/admin/users/erin', 'PATCH', { groupIds: groupsOf('erin').filter((g) => g !== group) })
      expect(out.status, JSON.stringify(out.body)).toBe(200)
      expect(rows()).toEqual(['bob'])
      // put back: she is asked again
      const back = await json('carol', '/api/admin/users/erin', 'PATCH', { groupIds: [...groupsOf('erin'), group] })
      expect(back.status, JSON.stringify(back.body)).toBe(200)
      const erin = asker('no')
      const again = await turn('erin', { person: erin }).call('team_groupboard__create_task', { title: 'again' })
      expect(again.isError, again.summary).toBe(true)
      expect(erin.cards).toHaveLength(1)
      // bob's account is disabled: his choice goes, and enabling it again does not bring it back (the fixture's groups
      // have no UUIDv7 ids, which the route's answer would refuse: he keeps only this group here)
      A.ctx.db.query("DELETE FROM group_members WHERE user_id = 'bob' AND group_id <> ?").run(group)
      expect((await json('carol', '/api/admin/users/bob', 'PATCH', { status: 'disabled' })).status).toBe(200)
      expect(rows()).toEqual([])
      expect((await json('carol', '/api/admin/users/bob', 'PATCH', { status: 'active' })).status).toBe(200)
      expect(rows()).toEqual([])
    } finally {
      A.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(t.id)
      A.ctx.db.query('DELETE FROM group_members WHERE group_id = ?').run(group)
      A.ctx.db.query('DELETE FROM groups WHERE id = ?').run(group)
      // the fixture's groups back as they were
      A.ctx.db.query("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('finance', 'bob'), ('marketing', 'erin')").run()
    }
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

// review of #678: "Always allow" for connections only where it was chosen to work (TC-665, TC-666)
describe('Always allow on the connector card: the team\'s switch and a watched turn', () => {
  test('TC-666: a Slack question (not watched in the person\'s app): no Always allow offered; after outside content a stored one asks, as before', async () => {
    const slack = asker('no')
    await turn('alice', { person: slack, live: false }).call('team_teamboard__create_task', { title: 'slack' })
    expect(slack.cards).toHaveLength(1)
    expect(slack.cards[0]!.options).toEqual(['Send', 'Don’t send'])
    // the team connection that sends without asking, after outside content in a Slack question: asks with the reason
    const p = asker('no')
    const t = turn('alice', { person: p, live: false })
    outside(t.chat)
    const n = created()
    expect((await t.call('team_guestboard__create_task', { title: 'slack outside' })).isError).toBe(true)
    expect(p.cards[0]!.question).toStartWith(OUTSIDE_LINE)
    expect(created()).toBe(n)
  })

  test('TC-665: the team\'s switch off: no Always allow offered, a member\'s own Always allow is ignored; an admin\'s "send without asking" stays', async () => {
    const { updateTeamSettings } = await import('../../server/src/admin/settings')
    expect((await turn('alice', { person: asker('always') }).call('team_teamboard__create_task', { title: 'kept' })).isError).toBe(false)
    expect(A.ctx.db.query('SELECT 1 FROM integration_user_allow WHERE integration_id = ? AND user_id = ?').get(teamAsk.id, 'alice')).toBeTruthy()
    updateTeamSettings(A.ctx.db, { roomAlwaysAllow: false })
    try {
      const p = asker('no')
      const n = created()
      expect((await turn('alice', { person: p }).call('team_teamboard__create_task', { title: 'switch off' })).isError).toBe(true)
      expect(p.cards).toHaveLength(1)
      expect(p.cards[0]!.options).toEqual(['Send', 'Don’t send'])
      expect(created()).toBe(n)
      // the admin's own rule: a clean chat sends without a card
      const q = asker('no')
      expect((await turn('alice', { person: q }).call('team_guestboard__create_task', { title: 'admin rule' })).isError).toBe(false)
      expect(q.cards).toEqual([])
    } finally {
      updateTeamSettings(A.ctx.db, { roomAlwaysAllow: true })
      await json('alice', `/api/integrations/${teamAsk.id}/always-allow`, 'DELETE')
    }
  })
})
