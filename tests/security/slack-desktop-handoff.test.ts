// Security cases of the Slack desktop hand-off (docs/decisions/20261122-slack-desktop-handoff.md): "Sign in with Slack"
// started in the desktop app and answered in a browser with no session is held for the app on that computer
// (server/src/integrations/slack/service.ts holdFor/claim, routes/slack.ts, routes/drive.ts: the one claim address).
//
// The attack this must stop (as for #98 and #279): anyone can make a `client: 'desktop'` session with curl, start a
// sign-in for THEIR account and phish a victim with Slack's address. (A) a victim browser without a session, (B) a
// victim browser signed in as the victim: the victim's Slack account must never be linked to the attacker. The code
// goes only to the victim's own computer, whose app has the victim's session, not the attacker's.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { sealSecret } from '../../web/src/lib/seal'
import { credentialsOf } from '../../server/src/credentials/store'
import { slackOf } from '../../server/src/integrations/slack/service'
import { CLAIM_MS } from '../../server/src/integrations/google-drive/app-return'
import { startHarness, type Harness } from '../lib/b-harness'
import { startFakeSlack, type FakeSlack } from '../lib/fake-slack'

setDefaultTimeout(60_000)
let h: Harness
let fake: FakeSlack
let skew = 0
let n = 0

const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const seal = async (s: string) => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), s, 'slack.token')
const callback = (q: Record<string, string>) => `/api/integrations/slack/oauth/callback?${new URLSearchParams(q)}`
/** a system browser with no session at all */
const bare = (q: Record<string, string>) => h.req(null, callback(q), { redirect: 'manual' })
/** the one-time code on a return page: only ever in the app link's fragment */
const codeOf = (html: string) => /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)?.[1] ?? null
const claim = (user: string, client: 'desktop' | 'web', code: string, on = h) => on.req(user, '/api/integrations/google-drive/claim', { ...json('POST', { code }), client })
const linkOf = (user: string) => h.ctx.db.query('SELECT slack_user_id FROM slack_links WHERE user_id = ?').get(user) as { slack_user_id: string } | null
const exchanges = () => fake.of('openid.connect.token').length
/** `who` presses Sign in with Slack in the desktop app; Slack will sign the browser in as `slackUser` */
async function startDesk(who: string, slackUser: string) {
  const r = await h.req(who, '/api/slack/signin', { ...json('POST', {}), client: 'desktop' })
  expect(r.status).toBe(200)
  const p = Object.fromEntries(new URL(((await r.json()) as { authorizationUrl: string }).authorizationUrl).searchParams)
  const code = `code-sec-${++n}`
  fake.codes[code] = { user: slackUser, nonce: p.nonce! }
  return { state: p.state!, code }
}

beforeAll(async () => {
  fake = startFakeSlack()
  fake.users = {
    U0ALICE: { name: 'alice.slack', team_id: 'T0ACME', email: 'alice@acme.example' },
    U0BOB: { name: 'bob.slack', team_id: 'T0ACME', email: 'bob@acme.example' },
  }
  h = await startHarness({ name: 'sec-slack-desktop' })
  slackOf(h.ctx, { base: fake.url, pollMs: 30, retryMs: 50, timeoutMs: 2000, now: () => Date.now() + skew })
  const saved = await h.req('dana', '/api/admin/slack/tokens', json('PUT', { botToken: await seal(fake.botToken), appToken: await seal(fake.appToken), clientId: fake.clientId, clientSecret: await seal(fake.clientSecret) }))
  expect(saved.status).toBe(200)
  expect((await h.req('dana', '/api/admin/slack/enabled', json('POST', { enabled: true }))).status).toBe(200)
  h.ctx.db.query("UPDATE slack_config SET link_origin = 'https://team.acme.example'").run()
})
afterAll(async () => { await h?.close(); fake?.close() })

test('attack A: a curl desktop session phishes a victim whose browser has no session; the victim\'s app cannot finish it', async () => {
  // alice (the attacker) starts; bob (the victim) signs in to Slack as himself in a browser with no session
  const s = await startDesk('alice', 'U0BOB')
  const code = codeOf(await (await bare(s)).text())!
  expect(code).toBeTruthy()
  // the page went to bob's computer: his app has his session, not the starter's
  expect((await claim('bob', 'desktop', code)).status).toBe(400)
  // the attacker has the state too, but a second return gives no code
  const again = await bare(s)
  expect(codeOf(await again.text())).toBeNull()
  expect(linkOf('alice')).toBeNull()
  expect(exchanges()).toBe(0)
  const started = h.ctx.db.query("SELECT session_id FROM slack_signin_flows WHERE user_id = 'alice' ORDER BY created_at DESC").get() as { session_id: string }
  slackOf(h.ctx).cancelFlows('signin', 'alice', started.session_id)
})

test('attack B: the victim\'s browser is signed in as the victim: refused, nothing exchanged, no code', async () => {
  const s = await startDesk('alice', 'U0BOB')
  const r = await h.req('bob', callback(s), { redirect: 'manual' })
  expect(r.status).toBe(303)
  expect(new URL(r.headers.get('location')!, 'http://x').searchParams.get('slack')).toBe('signin_other_user')
  expect(codeOf(await r.text())).toBeNull()
  expect(exchanges()).toBe(0)
  expect(linkOf('alice')).toBeNull()
})

test('replay and reload: a used code is refused; the same return opened again gives no new code', async () => {
  const s = await startDesk('alice', 'U0ALICE')
  const code = codeOf(await (await bare(s)).text())!
  for (const who of [null, 'alice']) {
    const r = await h.req(who, callback(s), { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(codeOf(await r.text())).toBeNull()
  }
  expect(exchanges()).toBe(0)
  expect((await claim('alice', 'desktop', code)).status).toBe(200)
  expect(linkOf('alice')).toEqual({ slack_user_id: 'U0ALICE' })
  expect((await claim('alice', 'desktop', code)).status).toBe(400)
  expect(exchanges()).toBe(1)
  h.ctx.db.query("DELETE FROM slack_links WHERE user_id = 'alice'").run()
})

test('only the session that started it: the same person\'s web session is refused', async () => {
  const s = await startDesk('alice', 'U0ALICE')
  const code = codeOf(await (await bare(s)).text())!
  expect((await claim('alice', 'web', code)).status).toBe(400)
  expect(linkOf('alice')).toBeNull()
  // still good for the starter's own session
  expect((await claim('alice', 'desktop', code)).status).toBe(200)
  h.ctx.db.query("DELETE FROM slack_links WHERE user_id = 'alice'").run()
})

test('a late code is refused and ends its flow; nothing is exchanged', async () => {
  const s = await startDesk('alice', 'U0ALICE')
  const code = codeOf(await (await bare(s)).text())!
  const before = exchanges()
  skew = CLAIM_MS + 1000
  try {
    const r = await claim('alice', 'desktop', code)
    if (r.status === 200) expect(await r.json()).toMatchObject({ state: 'failed' })
    expect(linkOf('alice')).toBeNull()
    expect((await claim('alice', 'desktop', code)).status).toBe(400)
  } finally { skew = 0 }
  expect(exchanges()).toBe(before)
})

test('a code nobody knows, or of the wrong shape, is the same refusal', async () => {
  expect((await claim('alice', 'desktop', 'x'.repeat(43))).status).toBe(400)
  expect((await claim('alice', 'desktop', 'short')).status).toBe(400)
})

test('another team: a code from one team\'s return page is refused by any other team\'s server', async () => {
  const s = await startDesk('alice', 'U0ALICE')
  const code = codeOf(await (await bare(s)).text())!
  const h2 = await startHarness({ name: 'sec-slack-desktop-other' })
  try {
    expect((await claim('alice', 'desktop', code, h2)).status).toBe(400)
  } finally { await h2.close() }
  expect((await claim('alice', 'desktop', code)).status).toBe(200)
  expect(linkOf('alice')).toEqual({ slack_user_id: 'U0ALICE' })
})
