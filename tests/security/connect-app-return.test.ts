// Security cases of tests/unit/c-connect-app-return.test.ts (login-CSRF, replay, expiry, wrong session or person,
// another team). An app connection's sign-in started in the desktop app finishes in the app, never by signing in again in the system
// browser (owner 2026-11-21: "The sign-in could not be completed … sign in to the same team account in this browser"):
// server/src/integrations/connections/service.ts hold/claim, routes/integrations.ts (the page), routes/drive.ts (the one
// claim address the desktop app posts every code to). docs/decisions/20261121-connect-browser-handoff.md.
//
// The attack this must stop (security review of trina-ax #98, google-drive/app-return.ts): anyone can make a
// `client: 'desktop'` session with curl, start a sign-in on THEIR connection and phish a victim with the service's
// address. (A) a victim browser without a session, (B) a victim browser signed in as the victim: the victim's account
// must never land on the attacker's connection. The code goes only to the victim's own computer, whose app has the
// victim's session, not the attacker's.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from '../unit/a-lib'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { CLAIM_MS } from '../../server/src/integrations/google-drive/app-return'
import { createLogger } from '../../server/src/log'
import { say } from '../../server/src/integrations/connections/text'

setDefaultTimeout(30_000)

let h: Harness, olga: Client, desk: Client, bob: { client: Client; password: string }, fake: FakeServices
let logs: string[] = []
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  logs = []
  h = await harness('sec-app-return-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  desk = await session('olga', OWNER_PW, 'desktop')
  bob = await addMember(h, olga, { username: 'bob', role: 'member' })
  fake.now = Date.now(); fake.refreshCount = 0; fake.revoked = []; fake.delayRefresh = null; fake.seen.length = 0
  integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

/** a session as an app makes it — or as anyone with curl may: the login says which app it is */
async function session(username: string, password: string, client: 'desktop' | 'mobile' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username, password, client, tokenMode: client === 'mobile' ? 'bearer' : 'cookie' })
  return c
}
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
/** a system browser with no session at all */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
/** the one-time code on a return page: only ever in the app link's fragment */
function codeOf(html: string): string | null {
  const m = /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)
  return m ? m[1]! : null
}
const claim = (c: Client, code: string) => c.try('POST', '/api/integrations/google-drive/claim', { code })
const create = (by: Client, name = 'Board') => by.call('POST', '/api/integrations', { kind: 'mcp', name, url: `${fake.base}/mcp-oauth?n=${name}`, auth: 'oauth' })
const statusOf = async (by: Client, id: string) => (await by.call('GET', '/api/integrations')).items.find((i: any) => i.id === id)
const tokenCalls = () => fake.seen.filter((s) => s.path === '/as/token').length
async function start(by: Client, owner: Client = olga) {
  const c = await create(owner)
  const f = await by.call('POST', `/api/integrations/${c.id}/authorize`, {})
  return { id: c.id as string, flow: f, cb: fake.authorize(f.authorizationUrl) }
}

test('replay: a used code is refused; the same return opened again gives no new code and finishes nothing', async () => {
  const { id, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  const again = await bare(callback(cb))
  expect(again.status).toBe(400)
  const html = await again.text()
  expect(codeOf(html)).toBeNull()
  expect(html).toContain(say('callbackHanded', 'ko'))
  // the starter's own browser bringing the state again: still no code, nothing finished
  const own = await olga.raw('GET', callback(cb))
  expect(own.status).toBe(400)
  expect(codeOf(await own.text())).toBeNull()
  expect(tokenCalls()).toBe(1)
  expect((await claim(desk, code)).status).toBe(200)
  expect((await claim(desk, code)).status).toBe(400)
  expect(await statusOf(olga, id)).toMatchObject({ status: 'connected' })
})


test('attack A: a curl desktop session phishes a victim whose browser has no session; the victim\'s app cannot finish it', async () => {
  // bob (the attacker) makes a desktop session himself and starts a sign-in on his own connection
  const attacker = await session('bob', bob.password, 'desktop')
  const { id, cb } = await start(attacker, bob.client)
  // the victim opens the address and signs in at the service; the page hands the code to the victim's own app
  const code = codeOf(await (await bare(callback(cb))).text())!
  expect((await claim(desk, code)).status).toBe(400)
  expect(await statusOf(bob.client, id)).toMatchObject({ status: 'needs_auth', hasSecret: false })
  // nor any other session of the victim
  const web = await session('olga', OWNER_PW, 'web')
  expect((await claim(web, code)).status).toBe(400)
  expect(await statusOf(bob.client, id)).toMatchObject({ hasSecret: false })
})


test('attack B: the victim\'s browser is signed in as the victim: refused, nothing exchanged, no code, nothing connected', async () => {
  const attacker = await session('bob', bob.password, 'desktop')
  const { id, flow, cb } = await start(attacker, bob.client)
  const page = await olga.raw('GET', callback(cb))
  expect(page.status).toBe(400)
  const html = await page.text()
  expect(codeOf(html)).toBeNull()
  expect(html).toContain(say('callbackOtherAccount', 'ko'))
  // the service's code is never exchanged: no victim tokens exist to hold or to revoke
  expect(tokenCalls()).toBe(0)
  expect(await statusOf(bob.client, id)).toMatchObject({ hasSecret: false })
  expect((await attacker.call('GET', `/api/integrations/flows/${flow.flowId}`)).state).toBe('pending')
})

test('only the session that started it: the same person\'s other desktop session is refused', async () => {
  const { id, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  const other = await session('olga', OWNER_PW, 'desktop')
  expect((await claim(other, code)).status).toBe(400)
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
  expect((await claim(desk, code)).status).toBe(200)
})


test('a late code is refused and ends its flow; the held tokens are revoked', async () => {
  const { id, flow, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  fake.now += CLAIM_MS + 1
  expect((await claim(desk, code)).status).toBe(400)
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
  expect((await desk.call('GET', `/api/integrations/flows/${flow.flowId}`)).state).toBe('expired')
  await Bun.sleep(50)
  expect(fake.revoked.length).toBeGreaterThan(0)
})


test('a code nobody knows, or of the wrong shape, is the same refusal', async () => {
  expect((await claim(desk, 'A'.repeat(43))).status).toBe(400)
  expect((await claim(desk, 'short')).status).toBe(400)
})

test('another team: a code from one team\'s return page is refused by any other team\'s server', async () => {
  const { cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  const h2 = await harness('int-app-return-other-' + seq)
  try {
    await withOwner(h2)
    const other = h2.client()
    await other.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client: 'desktop' })
    expect((await other.try('POST', '/api/integrations/google-drive/claim', { code })).status).toBe(400)
  } finally { await h2.close() }
  // still good for the session that started it here
  expect((await claim(desk, code)).status).toBe(200)
})
