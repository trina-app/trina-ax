// The AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md): pairing (PKCE), the
// extension's WebSocket, which turns reach it, the site card loop, revocation and the upload tickets.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { API, CHROME_WS_PATH, CHROME_WS_PROTOCOL, type BrowserCall, type ChromeServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { BrowserUploads } from '../../server/src/realtime/browser-uploads'
import { CHROME_WINDOW_PREFIX } from '../../server/src/realtime/call-relay'

setDefaultTimeout(30_000)
const cm = () => 'cm-' + crypto.randomUUID()
const step = (tool: string, args: Record<string, unknown>) => '@fake ' + JSON.stringify({ tool, args, sayResult: true }).replace(/\//g, '\\u002f')
const secret = () => crypto.randomBytes(32).toString('base64url')
const challengeOf = (v: string) => crypto.createHash('sha256').update(v).digest('base64url')
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'chrome-link', askUserTimeoutMs: 5000, relay: { windowGoneMs: 600, sweepMs: 100 } }) })
afterAll(async () => { await h.close() })

class Ext {
  frames: ChromeServerFrame[] = []
  closed: { code: number } | null = null
  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => this.frames.push(JSON.parse(String(e.data))))
    ws.addEventListener('close', (e) => { this.closed = { code: e.code } })
  }
  send(f: unknown) { this.ws.send(JSON.stringify(f)) }
  async until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T> {
    const end = Date.now() + ms
    for (;;) { const v = get(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(20) }
  }
  calls(): BrowserCall[] { return this.frames.filter((f) => f.type === 'browser.call').map((f) => (f as { call: BrowserCall }).call) }
}
async function ext(token: string | null, origin: string = EXT): Promise<Ext> {
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}${CHROME_WS_PATH}`, { headers: { origin }, protocols: [CHROME_WS_PROTOCOL] } as unknown as string[])
  const e = new Ext(ws)
  await new Promise<void>((res) => { ws.addEventListener('open', () => res()); ws.addEventListener('close', () => res()); ws.addEventListener('error', () => res()) })
  if (token && ws.readyState === WebSocket.OPEN) e.send({ type: 'auth', token, version: '0.1.0' })
  return e
}
async function link(user: string, label = 'Chrome on Mac', previous?: string): Promise<{ token: string; linkId: string }> {
  // the per-person limit on codes (10 per 15 minutes) is the route's own; tests link more than that
  h.ctx.db.query('DELETE FROM login_attempts').run()
  const verifier = secret()
  const { code } = await h.api(user).call(API.chromePair, { body: { challenge: challengeOf(verifier) } })
  const r = await h.req(null, API.chromeRedeem.path, { method: 'POST', headers: { 'content-type': 'application/json', origin: EXT }, body: JSON.stringify({ code, verifier, label, version: '0.1.0', ...(previous ? { previous } : {}) }) })
  expect(r.status).toBe(200)
  return await r.json() as { token: string; linkId: string }
}
const unlinkAllOf = (user: string) => h.ctx.db.query('DELETE FROM chrome_links WHERE user_id = ?').run(user)
/** a profile that answers every call: `answer` decides the result */
function serve(e: Ext, answer: (c: BrowserCall) => Record<string, unknown>) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const c of e.calls()) {
      if (done.has(c.callId)) continue
      done.add(c.callId)
      e.send({ type: 'browser.ack', callId: c.callId })
      e.send({ type: 'browser.result', result: { callId: c.callId, ok: true, content: [{ type: 'text', text: 'ok' }], ...answer(c) } })
    }
  }, 20)
  return () => clearInterval(timer)
}
const fakeLines = (...steps: Record<string, unknown>[]) => steps.map((x) => '@fake ' + JSON.stringify({ ...x, sayResult: true })).join('\n')

describe('pairing', () => {
  test('a code is spent with the verifier only; a copied code without it is useless, even later with it', async () => {
    const verifier = secret()
    const { code } = await h.api('alice').call(API.chromePair, { body: { challenge: challengeOf(verifier) } })
    const post = (v: string) => h.req(null, API.chromeRedeem.path, { method: 'POST', headers: { 'content-type': 'application/json', origin: EXT }, body: JSON.stringify({ code, verifier: v, label: 'x', version: '1' }) })
    expect((await post(secret())).status).toBe(410)
    expect((await post(verifier)).status).toBe(410)
  })

  test('only the person\'s own browser session makes a code (not a bearer token)', async () => {
    const r = await h.req(null, API.chromePair.path, { method: 'POST', headers: { authorization: 'Bearer test-alice', 'content-type': 'application/json' }, body: JSON.stringify({ challenge: challengeOf(secret()) }) })
    expect(r.status).toBe(403)
  })

  test('each profile is its own link; a re-link of the same install renews its own row; the 21st is refused', async () => {
    unlinkAllOf('alice')
    const a = await link('alice', 'Work')
    const first = await ext(a.token)
    const hello = await first.until(() => first.frames.find((f) => f.type === 'hello'))
    expect(hello).toMatchObject({ type: 'hello', user: { username: 'alice' } })
    const b = await link('alice', 'Personal')
    expect(first.closed).toBeNull()
    const again = await link('alice', 'Work 2', a.token)
    expect(again.linkId).toBe(a.linkId)
    await first.until(() => first.closed)
    const links = await h.api('alice').call(API.chromeLinks, {})
    expect(links.links.map((l) => [l.id, l.label])).toEqual([[a.linkId, 'Work 2'], [b.linkId, 'Personal']])
    for (let i = 0; i < 18; i++) await link('alice', `P${i}`)
    const verifier = secret()
    const { code } = await h.api('alice').call(API.chromePair, { body: { challenge: challengeOf(verifier) } })
    const r = await h.req(null, API.chromeRedeem.path, { method: 'POST', headers: { 'content-type': 'application/json', origin: EXT }, body: JSON.stringify({ code, verifier, label: 'one too many', version: '1' }) })
    expect(r.status).toBe(409)
    expect((await h.api('alice').call(API.chromeLinks, {})).links.length).toBe(20)
    unlinkAllOf('alice')
  })
})

describe('the extension\'s connection', () => {
  test('an unknown token, a page origin or a missing auth frame is refused', async () => {
    const bad = await ext(secret())
    await bad.until(() => bad.closed)
    expect(bad.closed!.code).toBe(4401)
    const { token } = await link('bob')
    const page = await ext(token, 'https://evil.example')
    await page.until(() => page.closed)
    expect(page.frames.length).toBe(0)
  })

  test('Disconnect in Settings closes it at once; the list shows it online before', async () => {
    const { token, linkId } = await link('bob')
    const e = await ext(token)
    await e.until(() => e.frames.find((f) => f.type === 'hello'))
    expect((await h.api('bob').call(API.chromeLinks, {})).links.find((l) => l.id === linkId)).toMatchObject({ id: linkId, online: true })
    await h.api('bob').call(API.chromeUnlink, { params: { id: linkId } })
    await e.until(() => e.closed)
    expect(e.closed!.code).toBe(4401)
    // someone else's link: 404
    const other = await link('alice')
    const r = await h.req('bob', `/api/chrome/links/${other.linkId}`, { method: 'DELETE' })
    expect(r.status).toBe(404)
  })

  test('the person\'s sessions all ending ends their links', async () => {
    const { token } = await link('erin')
    const e = await ext(token)
    await e.until(() => e.frames.find((f) => f.type === 'hello'))
    h.rt().hub.disconnectUser('erin', 'logout_all' as never)
    await e.until(() => e.closed)
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM chrome_links WHERE user_id = 'erin'").get() as { n: number }).n).toBe(0)
  })
})

describe('turns', () => {
  test('a web turn drives the person\'s profile; a site nobody allowed gets the chat\'s card, kept for that profile only', async () => {
    unlinkAllOf('alice')
    const { token, linkId } = await link('alice', 'Work')
    const e = await ext(token)
    await e.until(() => e.frames.find((f) => f.type === 'hello'))
    const win = await h.ws('alice', { windowId: 'win-web-aaaa1' })
    await win.next('hello')
    const stop = serve(e, (c) => (c.sites ?? []).includes('example.org') ? {} : { ok: false, content: [], error: 'site_needed: news.example.org', needSite: { host: 'news.example.org' } })
    try {
      const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
      const r = await h.api('alice', { window: 'win-web-aaaa1', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: fakeLines({ tool: 'navigate', args: { url: 'https://news.example.org/' } }), clientMessageId: cm(), attachmentIds: [] } })
      const card = await win.next('turn.request', (f) => f.data.turnId === r.turnId && (f.data.request as { kind: string }).kind === 'browser_site', 15_000)
      const req = card.data.request as { requestId: string; chrome?: boolean; site?: string; profile?: string }
      expect(req).toMatchObject({ chrome: true, site: 'example.org', profile: 'Work' })
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'browser_site', requestId: req.requestId, decision: 'always' } })
      await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      const calls = e.calls().filter((c) => c.turnId === r.turnId)
      expect(calls.length).toBe(2)
      expect(calls[1]!.sites).toContain('example.org')
      expect(calls[1]!.run).toEqual({ id: chat, title: expect.any(String) })
      expect((await h.api('alice').call(API.chromeLinks, {})).links.find((l) => l.id === linkId)!.sites).toEqual(['example.org'])
      // the person-wide list is not touched (an Always in a profile is that profile's)
      expect(h.ctx.db.query("SELECT 1 FROM user_allowed_sites WHERE user_id = 'alice' AND site = 'example.org'").get()).toBeNull()
      expect(win.frames.some((f) => f.type === 'browser.call')).toBe(false)
    } finally { stop(); win.close(); e.ws.close() }
  })

  test('one run switches profiles per call (profile by name), and a call without one stays in the last', async () => {
    unlinkAllOf('alice')
    const work = await link('alice', 'Work mail')
    const pers = await link('alice', 'Personal')
    const ew = await ext(work.token), ep = await ext(pers.token)
    await ew.until(() => ew.frames.find((f) => f.type === 'hello'))
    await ep.until(() => ep.frames.find((f) => f.type === 'hello'))
    h.ctx.db.query("INSERT INTO chrome_link_sites (link_id, site, created_at) VALUES (?, 'example.org', '2026-11-28'), (?, 'example.com', '2026-11-28')").run(work.linkId, pers.linkId)
    const win = await h.ws('alice', { windowId: 'win-web-aaaa2' })
    await win.next('hello')
    const s1 = serve(ew, () => ({})), s2 = serve(ep, () => ({}))
    try {
      const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
      const content = fakeLines(
        { tool: 'navigate', args: { url: 'https://example.com/', profile: 'Personal' } },
        { tool: 'navigate', args: { url: 'https://example.org/', profile: 'work mail' } },
        { tool: 'read_page', args: {} },
        { tool: 'tabs_context', args: { profile: pers.linkId } },
      )
      const r = await h.api('alice', { window: 'win-web-aaaa2', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
      await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      const inW = ew.calls().filter((c) => c.turnId === r.turnId).map((c) => c.tool)
      const inP = ep.calls().filter((c) => c.turnId === r.turnId).map((c) => c.tool)
      expect(inP).toEqual(['navigate', 'tabs_context'])
      expect(inW).toEqual(['navigate', 'read_page'])
      // what reaches the extension never carries `profile`, and each profile hears only its own sites
      for (const c of [...ew.calls(), ...ep.calls()]) expect('profile' in c.args).toBe(false)
      expect(ew.calls().every((c) => !(c.sites ?? []).includes('example.com'))).toBe(true)
      // the prompt lists both profiles
      const sys = await h.api('alice', { window: 'win-web-aaaa2', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: '@fake {"echo":"system"}', clientMessageId: cm(), attachmentIds: [] } })
      const done = await win.next('message.done', (f) => f.data.messageId === sys.assistantMessage.id, 20_000)
      expect(done.data.message.content).toContain('"Work mail"')
      expect(done.data.message.content).toContain('"Personal"')
    } finally { s1(); s2(); win.close(); ew.ws.close(); ep.ws.close() }
  })

  test('several profiles open and no pin: the AI is told to name one; a named profile that is closed is never swapped', async () => {
    unlinkAllOf('alice')
    const a = await link('alice', 'A'), b = await link('alice', 'B')
    await link('alice', 'Closed one')
    const ea = await ext(a.token), eb = await ext(b.token)
    await ea.until(() => ea.frames.find((f) => f.type === 'hello'))
    await eb.until(() => eb.frames.find((f) => f.type === 'hello'))
    const win = await h.ws('alice', { windowId: 'win-web-aaaa3' })
    await win.next('hello')
    try {
      const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
      const r = await h.api('alice', { window: 'win-web-aaaa3', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: fakeLines({ tool: 'navigate', args: { url: 'https://example.net/' } }, { tool: 'navigate', args: { url: 'https://example.net/', profile: 'Closed one' } }), clientMessageId: cm(), attachmentIds: [] } })
      const done = await win.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(done.data.message.content).toContain('Several browser profiles are open')
      expect(done.data.message.content).toContain('is not open now')
      expect([...ea.calls(), ...eb.calls()].filter((c) => c.turnId === r.turnId).length).toBe(0)
    } finally { win.close(); ea.ws.close(); eb.ws.close() }
  })

  test('another member\'s turn never reaches my Chrome, and my page window cannot answer my Chrome\'s call', async () => {
    unlinkAllOf('alice')
    const { token, linkId } = await link('alice')
    const e = await ext(token)
    await e.until(() => e.frames.find((f) => f.type === 'hello'))
    const bobWin = await h.ws('bob', { windowId: 'win-web-bbbb1' })
    await bobWin.next('hello')
    try {
      const chat = (await h.api('bob').call(API.createChat, { body: {} })).id
      const r = await h.api('bob', { window: 'win-web-bbbb1', client: 'web' }).call(API.sendMessage, { params: { id: chat }, body: { content: step('navigate', { url: 'https://example.org/' }), clientMessageId: cm(), attachmentIds: [] } })
      await bobWin.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(e.calls().some((c) => c.turnId === r.turnId)).toBe(false)
    } finally { bobWin.close() }
    const relay = h.rt().relay
    const done = relay.call({ userId: 'alice', windowId: `${CHROME_WINDOW_PREFIX}${linkId}`, turnId: crypto.randomUUID(), chatId: crypto.randomUUID(), tool: 'tabs_context', args: {}, run: { id: 'r1', title: 't' } })
    const c = await e.until(() => e.calls().at(-1))
    expect(relay.result('alice', { callId: c.callId, ok: true, content: [{ type: 'text', text: 'forged' }] }, 'win-web-aaaa1')).toBe(false)
    expect(relay.result('alice', { callId: c.callId, ok: true, content: [{ type: 'text', text: 'forged' }] })).toBe(false)
    e.send({ type: 'browser.result', result: { callId: c.callId, ok: true, content: [{ type: 'text', text: 'real' }] } })
    expect((await done).content[0]).toEqual({ type: 'text', text: 'real' })
    // a Chrome call without a run is never sent
    const noRun = await relay.call({ userId: 'alice', windowId: `${CHROME_WINDOW_PREFIX}${linkId}`, turnId: crypto.randomUUID(), chatId: crypto.randomUUID(), tool: 'tabs_context', args: {} })
    expect(noRun.ok).toBe(false)
    e.ws.close()
  })
})

describe('upload tickets', () => {
  test('a Chrome ticket is taken only by that Chrome; a desktop ticket only through the page session', () => {
    const u = new BrowserUploads()
    const base = { userId: 'alice', callId: 'c1', name: 'a.pdf', bytes: Buffer.from('x'), sha256: '0'.repeat(64), expiresAt: Date.now() + 60_000, recheck: () => true }
    const [chromeT] = u.issue([{ ...base, windowId: 'chrome:L1' }])!
    expect(u.take(chromeT!, 'alice')).toBeNull()
    expect(u.take(chromeT!, 'alice', 'chrome:L2')).toBeNull()
    expect(u.take(chromeT!, 'bob', 'chrome:L1')).toBeNull()
    expect(u.take(chromeT!, 'alice', 'chrome:L1')).not.toBeNull()
    const [deskT] = u.issue([{ ...base, windowId: 'win-desk' }])!
    expect(u.take(deskT!, 'alice', 'chrome:L1')).toBeNull()
    expect(u.take(deskT!, 'alice')).not.toBeNull()
  })
})
