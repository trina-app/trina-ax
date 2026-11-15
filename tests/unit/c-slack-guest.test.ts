// A guest never uses the team's Slack connection (docs/DECISIONS.md "Guests never use Slack", QA TC-2950), against
// the fake Slack (tests/lib/fake-slack.ts): a guest whose e-mail is a Slack member's is never linked by it and no turn
// runs as them. Unlinked, their Slack account is never matched by e-mail: it gets the same connect prompt as anyone's
// (so nothing tells whether an address is a guest's), and the link page and Sign in with Slack refuse the guest. A link
// row of a guest (made by hand) counts for nothing and the next question, in a channel or a DM, gets one plain line that
// says nothing about the account. This harness signs people in with test sessions, so the guest is
// marked as the invite accept marks one: users.guest = 1 and its guests row. No real Slack is contacted.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { sealSecret } from '../../web/src/lib/seal'
import { credentialsOf } from '../../server/src/credentials/store'
import { slackOf } from '../../server/src/integrations/slack/service'
import { say as sayText } from '../../server/src/integrations/slack/text'
import { startHarness, type Harness } from '../lib/b-harness'
import { nextTs, startFakeSlack, type FakeSlack } from '../lib/fake-slack'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
let h: Harness
let fake: FakeSlack
const C = 'C0GENERAL'
const LOCALES = ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const
const NOT_HERE = LOCALES.map((l) => sayText('notHere', l))

const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
async function call(user: string, method: string, path: string, body?: unknown) {
  const r = await h.req(user, path, json(method, body))
  const text = await r.text()
  let j: any = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, json: j }
}
const seal = async (s: string) => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), s, 'slack.token')
const blocksOf = (c: { args: Record<string, string> }) => JSON.stringify(JSON.parse(c.args.blocks ?? '[]'))
const ephemeralsTo = (user: string) => fake.of('chat.postEphemeral').filter((c) => c.args.user === user)
const linkTokenFrom = (c: { args: Record<string, string> }) => /\/slack\/link\?t=([A-Za-z0-9_-]{43})/.exec(blocksOf(c))?.[1] ?? null
const slackTurns = () => (h.ctx.db.query("SELECT count(*) n FROM turns WHERE client_kind = 'slack'").get() as { n: number }).n
const linkTokens = (slackUser: string) => (h.ctx.db.query('SELECT count(*) n FROM slack_link_tokens WHERE slack_user_id = ?').get(slackUser) as { n: number }).n
const linkOfErin = () => h.ctx.db.query("SELECT * FROM slack_links WHERE user_id = 'erin'").get()
function mention(user: string, text: string) {
  const ts = nextTs()
  fake.event({ type: 'app_mention', user, text: `<@U0BOT> ${text}`, ts, channel: C, event_ts: ts })
}
function dm(user: string, text: string) {
  const ts = nextTs()
  fake.event({ type: 'message', channel_type: 'im', user, text, ts, channel: `D0${user.slice(2)}`, event_ts: ts })
}
/** the next ephemeral to this Slack user after `n` of them, and a short wait for any second one */
async function nextEphemeral(user: string, n: number) {
  const c = await waitFor(() => ephemeralsTo(user)[n])
  await Bun.sleep(300)
  return c
}
/** the guest got exactly one plain line: no button, no link, no word about a guest */
function plainLine(user: string, n: number) {
  const all = ephemeralsTo(user).slice(n)
  expect(all.length).toBe(1)
  expect(NOT_HERE).toContain(all[0]!.args.text)
  expect(all[0]!.args.blocks).toBeUndefined()
  expect(linkTokenFrom(all[0]!)).toBeNull()
  expect(all[0]!.args.text!.toLowerCase()).not.toContain('guest')
}

let erinToken = ''
let signinState = ''
beforeAll(async () => {
  fake = startFakeSlack()
  fake.users = {
    U0ALICE: { name: 'alice.slack', team_id: 'T0ACME', email: 'alice@acme.example' },
    // Slack's address in another case: still the guest's
    U0ERIN: { name: 'erin.slack', team_id: 'T0ACME', email: ' Erin@ACME.example ' },
    U0BOB: { name: 'bob.slack', team_id: 'T0ACME', email: 'bob@acme.example' },
  }
  h = await startHarness({ name: 'c-slack-guest' })
  for (const [id, email] of [['alice', 'alice@acme.example'], ['erin', 'erin@acme.example'], ['bob', 'bob@acme.example']]) h.ctx.db.query('UPDATE users SET email = ? WHERE id = ?').run(email, id)
  slackOf(h.ctx, { base: fake.url, pollMs: 30, retryMs: 50, timeoutMs: 2000 })
  const saved = await call('dana', 'PUT', '/api/admin/slack/tokens', { botToken: await seal(fake.botToken), appToken: await seal(fake.appToken), clientId: fake.clientId, clientSecret: await seal(fake.clientSecret) })
  expect(saved.status).toBe(200)
  expect((await call('dana', 'POST', '/api/admin/slack/enabled', { enabled: true })).json.enabled).toBe(true)
  await fake.connected()
  // while erin is still a member: a connect link of their Slack account, and a Sign in with Slack started (https needed)
  mention('U0ERIN', 'hi')
  erinToken = linkTokenFrom((await waitFor(() => ephemeralsTo('U0ERIN').find((c) => linkTokenFrom(c))))!)!
  expect(erinToken).toBeTruthy()
  h.ctx.db.query("UPDATE slack_config SET link_origin = 'https://team.acme.example'").run()
  const started = await call('erin', 'POST', '/api/slack/signin', {})
  expect(started.status).toBe(200)
  signinState = new URL(started.json.authorizationUrl).searchParams.get('state')!
  // then erin becomes a guest (as the invite accept marks one)
  h.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
  h.ctx.db.query("INSERT INTO guests (user_id, place_kind, place_id, ai, created_at) VALUES ('erin', 'room', 'r-1', 'none', ?)").run(new Date().toISOString())
})
afterAll(async () => { await h?.close(); fake?.close() })

test('the link page made before: the guest cannot preview or confirm it (server and route); nothing is linked', async () => {
  const s = slackOf(h.ctx)
  await expect(s.preview('erin', erinToken)).rejects.toMatchObject({ reason: 'link_expired' })
  await expect(s.confirm('erin', erinToken)).rejects.toMatchObject({ reason: 'link_expired' })
  for (const path of ['/api/slack/link/preview', '/api/slack/link/confirm']) {
    const r = await call('erin', 'POST', path, { token: erinToken })
    expect(r.status).toBeGreaterThanOrEqual(400)
  }
  expect(linkOfErin()).toBeNull()
  expect((h.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action = 'slack.linked'").get() as { n: number }).n).toBe(0)
})

test('Sign in with Slack: a new one is refused; the one started before they were a guest links nothing', async () => {
  await expect(slackOf(h.ctx).startSignIn('erin', 's-1')).rejects.toBeTruthy()
  const code = `code-${crypto.randomUUID()}`
  const nonce = 'n'.repeat(43)
  fake.codes[code] = { user: 'U0ERIN', nonce }
  const r = await h.req('erin', `/api/integrations/slack/oauth/callback?${new URLSearchParams({ state: signinState, code })}`, { redirect: 'manual' })
  expect(new URL(r.headers.get('location') ?? '/', 'http://x').searchParams.get('slack')).not.toBe('linked')
  expect(linkOfErin()).toBeNull()
})

test('an @mention and a DM from the guest\'s unlinked Slack account: the same prompt anyone unlinked gets, no turn, nothing linked', async () => {
  const turns = slackTurns()
  for (const ask of [mention, dm]) {
    // past the "link sent a moment ago" wait: each question makes a fresh link
    h.ctx.db.query("UPDATE slack_link_tokens SET used_at = created_at, created_at = '2000-01-01T00:00:00.000Z' WHERE slack_user_id = 'U0ERIN'").run()
    const n = ephemeralsTo('U0ERIN').length
    ask('U0ERIN', 'what is in the project?')
    const c = await nextEphemeral('U0ERIN', n)
    expect(ephemeralsTo('U0ERIN').length).toBe(n + 1)
    expect(c!.args.text).toBe(sayText('linkPrompt', 'en'))
    const token = linkTokenFrom(c!)!
    expect(token).toBeTruthy()
    // the guest cannot use it
    await expect(slackOf(h.ctx).confirm('erin', token)).rejects.toMatchObject({ reason: 'link_expired' })
    expect((await call('erin', 'POST', '/api/slack/link/confirm', { token })).status).toBeGreaterThanOrEqual(400)
  }
  expect(linkOfErin()).toBeNull()
  expect(slackTurns()).toBe(turns)
  expect(fake.of('chat.postMessage')).toEqual([])
})

test('a link row for the guest (made by hand or before): it counts for nothing, and the next question drops it with one plain line', async () => {
  h.ctx.db.query("INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES ('l-erin', 'erin', 'T0ACME', '', 'U0ERIN', 'erin.slack', ?)").run(new Date().toISOString())
  const s = slackOf(h.ctx)
  expect(s.linkOf('erin')).toBeNull()
  expect(s.readsSlack('erin')).toBe(false)
  const turns = slackTurns()
  for (const ask of [mention, dm]) {
    h.ctx.db.query("INSERT OR IGNORE INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES ('l-erin', 'erin', 'T0ACME', '', 'U0ERIN', 'erin.slack', ?)").run(new Date().toISOString())
    const n = ephemeralsTo('U0ERIN').length, tokens = linkTokens('U0ERIN')
    ask('U0ERIN', 'answer as me')
    expect(await nextEphemeral('U0ERIN', n)).toBeTruthy()
    plainLine('U0ERIN', n)
    expect(linkTokens('U0ERIN')).toBe(tokens)
    expect(linkOfErin()).toBeNull()
  }
  expect(slackTurns()).toBe(turns)
  expect(fake.of('chat.postMessage')).toEqual([])
  expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.unlinked' AND target = 'erin'").get()).toMatchObject({ detail: expect.stringContaining('"reason":"guest"') })
})

test('a member whose e-mail matches still gets the connect link (only guests are refused)', async () => {
  const n = ephemeralsTo('U0ALICE').length
  mention('U0ALICE', 'hi')
  const c = await waitFor(() => ephemeralsTo('U0ALICE')[n])
  expect(c && linkTokenFrom(c)).toBeTruthy()
})
