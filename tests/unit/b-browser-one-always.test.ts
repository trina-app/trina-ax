// One site "Always allow" per person, also for the desktop app's browser (docs/decisions/20261125-one-site-always-desktop-
// browser.md). Measured on 0.18.1 (Mac and Windows desktop apps, the same account): the server's address card and the
// desktop app's own site card each asked about the same site, and an Always on the desktop card stayed on that computer.
// Each browser.call now carries what the person already allowed (sites for good, the address the card or their own
// message approved, office addresses), and an Always pressed on the desktop app's card comes back with the result and is
// kept as the person's own allowance.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, BrowserCall, BrowserResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { allowSiteFromDevice, personSites } from '../../server/src/tools/url-gate'

setDefaultTimeout(30_000)
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-desk-1aa1'
// the address is written so it is not typed in the message (as the AI's own choice would be)
const step = (tool: string, args: Record<string, unknown>) => '@fake ' + JSON.stringify({ tool, args, sayResult: true }).replace(/\//g, '\\u002f')

let h: Harness
let desk: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-browser-one-always', askUserTimeoutMs: 5000, relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
})
afterAll(async () => { desk?.close(); await h.close() })

type Call = { callId: string; tool: string; args: Record<string, unknown>; sites?: string[]; office?: string[] }
/** the desktop app: answers each browser.call with `answer`, keeps every call it got */
function serve(answer: (c: Call) => Partial<BrowserResult> = () => ({})) {
  const done = new Set<string>()
  const calls: Call[] = []
  // only calls sent from now on (the socket keeps the frames of earlier tests)
  const from = desk.frames.length
  const timer = setInterval(() => {
    for (const f of desk.frames.slice(from)) {
      if (f.type !== 'browser.call' || done.has(f.data.call.callId)) continue
      done.add(f.data.call.callId)
      calls.push(f.data.call)
      desk.send({ type: 'browser.ack', callId: f.data.call.callId })
      desk.send({ type: 'browser.result', result: { callId: f.data.call.callId, ok: true, content: [{ type: 'text', text: 'page' }], ...answer(f.data.call) } })
    }
  }, 20)
  return { calls, stop: () => clearInterval(timer) }
}
async function ask(content: string, chatId?: string) {
  const chat = chatId ?? (await h.api('alice').call(API.createChat, { body: {} })).id
  const r = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  return { chat, r }
}
const finished = (r: { assistantMessage: { id: string } }) => desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
const sitesOf = (user: string) => (h.ctx.db.query('SELECT site FROM user_allowed_sites WHERE user_id = ? ORDER BY site').all(user) as { site: string }[]).map((x) => x.site)
const allow = (user: string, site: string) => h.ctx.db.query('INSERT OR IGNORE INTO user_allowed_sites (user_id, site, chat_id, created_at) VALUES (?, ?, NULL, ?)').run(user, site, new Date().toISOString())

describe('the server tells the desktop app what the person already allowed', () => {
  test('a site kept for good on the server card goes with every call: the desktop app does not ask about it again', async () => {
    allow('alice', 'example.org')
    const s = serve()
    try {
      const { r } = await ask(step('navigate', { url: 'https://news.example.org/today' }))
      await finished(r)
      expect(desk.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toBe(false)
      expect(s.calls[0]!.sites).toContain('example.org')
    } finally { s.stop() }
  })

  test('an address the person typed goes with the call as its host name (no "www.", no port: every port, as the server\'s own allowance)', async () => {
    const s = serve()
    try {
      const { r } = await ask('https://www.typed-site.example:8443/a 이거 열어줘\n' + step('navigate', { url: 'https://www.typed-site.example:8443/a' }))
      await finished(r)
      expect(s.calls[0]!.sites).toContain('typed-site.example')
      expect(s.calls[0]!.sites!.some((k) => k.includes(':'))).toBe(false)
    } finally { s.stop() }
  })

  test('an address the person allowed once on the server card goes with that call (no second card on the desktop)', async () => {
    const s = serve()
    try {
      const { r } = await ask(step('navigate', { url: 'https://shop.once-site.example/p' }))
      const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'allow' } })
      await finished(r)
      expect(s.calls[0]!.sites).toContain('shop.once-site.example')
      // once is once: the site is not kept for good
      expect(sitesOf('alice')).not.toContain('once-site.example')
    } finally { s.stop() }
  })

  test('a learned link the person never named does not go with the call (the desktop app still asks)', async () => {
    const s = serve()
    try {
      const { r } = await ask(step('navigate', { url: 'https://unnamed.example/x' }))
      const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'deny' } })
      await finished(r)
      expect(s.calls.length).toBe(0)
    } finally { s.stop() }
  })

  test('an office address allowed on the server card goes with the call as an office address', async () => {
    const s = serve()
    try {
      const { r } = await ask(step('navigate', { url: 'http://192.168.40.5:8080/wiki' }))
      const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'browser_site', requestId: card.data.request.requestId, decision: 'once' } })
      await finished(r)
      expect(s.calls[0]!.office).toEqual(['192.168.40.5'])
    } finally { s.stop() }
  })
})

describe('an "Always allow" on the desktop app\'s card is the person\'s one Always', () => {
  test('kept as the site for good (the row the server card writes): the next call on any computer carries it, the server card does not ask', async () => {
    const s = serve((c) => (String(c.args.url).includes('stock.desk-site.example') ? { always: { sites: ['stock.desk-site.example'] } } : {}))
    try {
      const { r } = await ask('https://stock.desk-site.example/fx 열어줘\n' + step('navigate', { url: 'https://stock.desk-site.example/fx' }))
      await finished(r)
      expect(sitesOf('alice')).toContain('desk-site.example')
      const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'ai.always_allow' AND detail LIKE '%desk-site.example%'").get() as { detail: string } | null
      expect(audit).not.toBeNull()
      // another computer, another chat: an address of the same site the person never typed opens without any card
      const second = await ask(step('navigate', { url: 'https://news.desk-site.example/today' }))
      await finished(second.r)
      expect(desk.frames.some((f) => f.type === 'turn.request' && f.data.turnId === second.r.turnId)).toBe(false)
      expect(s.calls.at(-1)!.sites).toContain('desk-site.example')
    } finally { s.stop() }
  })

  test('an office Always on the desktop card is kept in the person\'s office grants (no server office card next time)', async () => {
    const s = serve((c) => (String(c.args.url).includes('192.168.40.9') ? { always: { office: ['192.168.40.9'] } } : {}))
    try {
      const { r } = await ask(step('navigate', { url: 'http://192.168.40.9/a' }))
      const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'browser_site', requestId: card.data.request.requestId, decision: 'once' } })
      await finished(r)
      expect(h.ctx.db.query("SELECT 1 FROM browser_site_grants WHERE user_id = 'alice' AND host = '192.168.40.9'").get()).not.toBeNull()
      // (an address the AI chose itself still gets the address card: that one is about the address, not the office)
      const again = await ask('http://192.168.40.9/b 열어줘\n' + step('navigate', { url: 'http://192.168.40.9/b' }))
      await finished(again.r)
      expect(desk.frames.some((f) => f.type === 'turn.request' && f.data.turnId === again.r.turnId)).toBe(false)
    } finally { s.stop() }
  })

  test('with the team\'s "Always allow" switch off nothing is kept and no site goes with the call', async () => {
    updateTeamSettings(h.ctx.db, { roomAlwaysAllow: false } as never)
    const s = serve(() => ({ always: { sites: ['off.switch-site.example'] } }))
    try {
      const { r } = await ask('https://off.switch-site.example/ 열어줘\n' + step('navigate', { url: 'https://off.switch-site.example/' }))
      await finished(r)
      expect(sitesOf('alice')).not.toContain('switch-site.example')
      expect(s.calls[0]!.sites ?? []).not.toContain('example.org')
    } finally {
      updateTeamSettings(h.ctx.db, { roomAlwaysAllow: true } as never)
      s.stop()
    }
  })

  test('a confidential chat keeps no Always and lists no site kept for good (it has no browser tools either)', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    h.ctx.db.query('INSERT OR IGNORE INTO safe_ops_chats (chat_id) VALUES (?)').run(chat)
    const person = { sitesForGood: () => true } as never
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, 'conf.secret-site.example', null)).toBeNull()
    expect(sitesOf('alice')).not.toContain('secret-site.example')
    expect(personSites(h.ctx.db, chat, 'alice', person)).toEqual([])
    // the same person in an ordinary chat: kept, by its site (subdomain and port dropped)
    const open = (await h.api('alice').call(API.createChat, { body: {} })).id
    expect(allowSiteFromDevice(h.ctx.db, open, 'alice', person, 'm.open-site.example:8443', null)).toBe('open-site.example')
    expect(personSites(h.ctx.db, open, 'alice', person)).toContain('open-site.example')
    // an address with no site to keep (an IP address, a public suffix): nothing
    expect(allowSiteFromDevice(h.ctx.db, open, 'alice', person, '203.0.113.9', null)).toBeNull()
    expect(allowSiteFromDevice(h.ctx.db, open, 'alice', person, 'github.io', null)).toBeNull()
  })

  test('only the person whose turn it is: another member\'s sites never go with alice\'s calls', async () => {
    allow('bob', 'bobs-site.example')
    const s = serve()
    try {
      const { r } = await ask(step('navigate', { url: 'https://news.example.org/b' }))
      await finished(r)
      expect(s.calls[0]!.sites).not.toContain('bobs-site.example')
    } finally { s.stop() }
  })
})

describe('review fixes: the kept site is the card\'s site, office grants by name', () => {
  test('an Always keeps only the site the address card would offer: none for a long or random name, a public suffix or an IP', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const person = { sitesForGood: () => true } as never
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, 'a'.repeat(24) + '.long-site.example', null)).toBeNull()
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, 'x7f3k9q2m8z4w1v6b5n0.rand-site.example', null)).toBeNull()
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, 'lovable.app', null)).toBeNull()
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, '[fd00::7]', null)).toBeNull()
    // a host under a private public suffix keeps itself, never the suffix's owner
    expect(allowSiteFromDevice(h.ctx.db, chat, 'alice', person, 'attacker.lovable.app', null)).toBe('attacker.lovable.app')
    expect(sitesOf('alice')).not.toContain('lovable.app')
    expect(sitesOf('alice')).not.toContain('long-site.example')
    expect(sitesOf('alice')).not.toContain('rand-site.example')
  })

  test('an office grant for a name this server does not see as an office address still goes with the call', async () => {
    h.ctx.db.query("INSERT OR IGNORE INTO browser_site_grants (user_id, host) VALUES ('alice', 'wiki.corp-name.example')").run()
    const s = serve()
    try {
      const { r } = await ask('https://wiki.corp-name.example/home 열어줘\n' + step('navigate', { url: 'https://wiki.corp-name.example/home' }))
      await finished(r)
      expect(s.calls[0]!.office).toContain('wiki.corp-name.example')
    } finally { s.stop() }
  })
})

describe('wire shape: old apps and old servers', () => {
  test('a call without sites parses (an older server); sites and office are bounded keys; a result with always parses', () => {
    const base = { callId: 'c1', turnId: '01a21200-0000-7000-8000-000000000001', chatId: '01a21200-0000-7000-8000-000000000002', tool: 'navigate', args: {}, deadline: 1 }
    expect(BrowserCall.safeParse(base).success).toBe(true)
    expect(BrowserCall.safeParse({ ...base, sites: ['naver.com', 'stock.naver.com:8443', '[fd00::5]'], office: ['192.168.0.2'] }).success).toBe(true)
    expect(BrowserCall.safeParse({ ...base, sites: ['Naver.com'] }).success).toBe(false)
    expect(BrowserCall.safeParse({ ...base, sites: ['a b'] }).success).toBe(false)
    expect(BrowserResult.safeParse({ callId: 'c1', ok: true, content: [], always: { sites: ['stock.naver.com'] } }).success).toBe(true)
    // an older desktop app's result has no `always`
    expect(BrowserResult.safeParse({ callId: 'c1', ok: true, content: [] }).success).toBe(true)
  })
})
