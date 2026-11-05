// The Slack connector (docs/SLACK.md) against a fake Slack (tests/lib/fake-slack.ts): the owner saves the tokens and
// turns it on; an unlinked asker gets an ephemeral link; the one-time link (used once, 10 minutes, bound to the Slack
// account of the event, both names on the page); a linked person's question runs a turn as them (the fake engine) and
// is answered to them only in a channel, in the thread in a DM; "Post to channel" once, by the asker only; the same
// event or message twice runs once; Slack's refresh; the tokens nowhere in logs, rows or answers; a disabled account
// unlinked at once. No real Slack is contacted.
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { sealSecret } from '../../web/src/lib/seal'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { appIdOfToken, normEmail, slackOf } from '../../server/src/integrations/slack/service'
import { questionText, refusal, say as sayText, toMrkdwn } from '../../server/src/integrations/slack/text'
import { slackManifest } from '../../server/src/integrations/slack/manifest'
import { startHarness, type Harness } from '../lib/b-harness'
import { nextTs, startFakeSlack, type FakeSlack } from '../lib/fake-slack'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
let h: Harness
let fake: FakeSlack
const lines: string[] = []
const notices: { userId: string; ev: { type: string; data: { code?: string } } }[] = []
let skew = 0
const C = 'C0GENERAL'

const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
async function call(user: string, method: string, path: string, body?: unknown) {
  const r = await h.req(user, path, json(method, body))
  const text = await r.text()
  let j: any = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, json: j, text }
}
const seal = async (s: string, purpose: 'slack.token' | 'integration.secret' = 'slack.token') => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), s, purpose)
/** the four values of Admin › Slack's last step: the two tokens and the app's client id and secret */
const tokens = async (bot = fake.botToken, app = fake.appToken, o: { purpose?: 'slack.token' | 'integration.secret'; clientId?: string; clientSecret?: string } = {}) =>
  ({ botToken: await seal(bot, o.purpose), appToken: await seal(app), clientId: o.clientId ?? fake.clientId, clientSecret: await seal(o.clientSecret ?? fake.clientSecret) })
const blocksOf = (c: { args: Record<string, string> }) => JSON.stringify(JSON.parse(c.args.blocks ?? '[]'))
const ephemeralsTo = (user: string) => fake.of('chat.postEphemeral').filter((c) => c.args.user === user)
const linkTokenFrom = (c: { args: Record<string, string> }) => /\/slack\/link\?t=([A-Za-z0-9_-]{43})/.exec(blocksOf(c))?.[1] ?? null
const linksTo = (user: string) => ephemeralsTo(user).filter((x) => linkTokenFrom(x))
const say = (s: string) => `@fake ${JSON.stringify({ say: s })}`
const slackTurns = () => (h.ctx.db.query("SELECT count(*) n FROM turns WHERE client_kind = 'slack'").get() as { n: number }).n
function mention(user: string, text: string, o: { ts?: string; thread?: string; channel?: string; eventId?: string; userTeam?: string } = {}) {
  const ts = o.ts ?? nextTs()
  fake.event({ type: 'app_mention', user, text: `<@U0BOT> ${text}`, ts, channel: o.channel ?? C, event_ts: ts, ...(o.thread ? { thread_ts: o.thread } : {}), ...(o.userTeam ? { user_team: o.userTeam } : {}) }, o.eventId ? { eventId: o.eventId } : {})
  return ts
}
/** a new link prompt to this Slack user (one more than before), asked a few minutes after the last one (past the
 * "link sent a moment ago" wait), on the clock as it is then */
let linkClock = 0
async function newLink(user: string, text = 'hi') {
  const before = linksTo(user).length
  const base = skew
  skew = base + (linkClock += 3 * 60_000)
  try {
    mention(user, text)
    const c = await waitFor(() => { const all = linksTo(user); return all.length > before ? all.at(-1) : null })
    if (!c) throw new Error(`no link prompt for ${user}`)
    return linkTokenFrom(c)!
  } finally { skew = base }
}

beforeAll(async () => {
  fake = startFakeSlack()
  fake.users = {
    // Slack's address in another case and with spaces: still alice's
    U0ALICE: { name: 'alice.slack', team_id: 'T0ACME', real_name: 'Alice in Slack', email: ' Alice@ACME.example ' },
    U0BOB: { name: 'bob.slack', team_id: 'T0ACME', email: 'bob@acme.example' },
    U0MALLORY: { name: 'mallory', team_id: 'T0ACME', email: 'mallory@acme.example' },
    U0ERIN: { name: 'erin.slack', team_id: 'T0ACME', email: 'erin@acme.example' },
    U0CAROL: { name: 'carol.slack', team_id: 'T0ACME', email: 'carol@acme.example' },
    U0NOMAIL: { name: 'no.mail', team_id: 'T0ACME' },
    U0GUEST: { name: 'guest', team_id: 'T0OTHER', email: 'guest@other.example' },
    U0ROBOT: { name: 'robot', team_id: 'T0ACME', is_bot: true },
    U0GONE: { name: 'gone', team_id: 'T0ACME', email: 'gone@acme.example', deleted: true },
    // another workspace of the same Enterprise Grid organization: not ours either
    U0GRID: { name: 'grid', team_id: 'T0SISTER', email: 'grid@acme.example', enterprise_id: 'E0ORG' },
    U0FRANK: { name: 'frank.slack', team_id: 'T0ACME', email: 'frank@acme.example' },
  }
  h = await startHarness({ name: 'c-slack', log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  // the accounts' own e-mails (carol has none)
  for (const [id, email] of [['alice', 'alice@acme.example'], ['bob', 'bob@acme.example'], ['erin', 'erin@acme.example'], ['dana', 'dana@acme.example']]) h.ctx.db.query('UPDATE users SET email = ? WHERE id = ?').run(email, id)
  slackOf(h.ctx, { base: fake.url, pollMs: 30, retryMs: 50, timeoutMs: 2000, now: () => Date.now() + skew })
  // in-app notices, as published
  const publish = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = (userId: string, ev: Parameters<typeof publish>[1]) => { notices.push({ userId, ev: ev as { type: string; data: { code?: string } } }); return publish(userId, ev) }
})
afterAll(async () => { await h?.close(); fake?.close() })

describe('setup (the owner)', () => {
  test('nothing runs until the owner saves the tokens and turns it on; admins and members cannot', async () => {
    const first = await call('dana', 'GET', '/api/admin/slack')
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ enabled: false, tokens: false, state: 'off', workspace: null, linked: 0 })
    expect(JSON.parse(first.json.manifest)).toEqual(slackManifest())
    expect(first.json.createUrl).toStartWith('https://api.slack.com/apps?new_app=1&manifest_json=')
    expect(fake.calls).toEqual([])
    const body = await tokens()
    for (const who of ['carol', 'alice']) expect((await call(who, 'PUT', '/api/admin/slack/tokens', body)).status).toBe(403)
    expect((await call('carol', 'GET', '/api/admin/slack')).status).toBe(403)
    expect((await call('alice', 'POST', '/api/admin/slack/enabled', { enabled: true })).status).toBe(403)
    // turning it on without tokens is refused
    expect((await call('dana', 'POST', '/api/admin/slack/enabled', { enabled: true })).json.error.params.reason).toBe('no_tokens')
  })

  test('wrong tokens are refused with a reason; a seal for another purpose is refused', async () => {
    const swapped = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens(fake.appToken, fake.botToken))
    expect(swapped.status).toBe(400)
    expect(swapped.json.error.params.reason).toBe('not_bot_token')
    const revoked = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens('xoxb-999-999-' + 'z'.repeat(24)))
    expect(revoked.json.error.params.reason).toBe('invalid_auth')
    fake.scopes = ['chat:write']
    const scopes = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens())
    expect(scopes.json.error.params).toMatchObject({ reason: 'missing_scope', scopes: 'app_mentions:read, channels:read, groups:read, im:history, im:write, users:read, users:read.email' })
    // the app's credentials: a client id and a secret of their shape
    expect((await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens(fake.botToken, fake.appToken, { clientId: 'not-an-id' }))).json.error.params.reason).toBe('not_client_id')
    expect((await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens(fake.botToken, fake.appToken, { clientSecret: 'short' }))).json.error.params.reason).toBe('not_client_secret')
    fake.scopes = ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'im:write', 'users:read', 'users:read.email']
    const other = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens(fake.botToken, fake.appToken, { purpose: 'integration.secret' }))
    expect(other.status).toBe(400)
    // the app-level token of another app than the bot token's (its prefix names that app; the socket address's app_id
    // is a hash, as from real Slack, and says nothing)
    const otherApp = 'xapp-1-A0OTHERAPP-444-' + 'o'.repeat(32)
    fake.otherAppTokens.push(otherApp)
    const mixed = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens(fake.botToken, otherApp))
    expect(mixed.status).toBe(400)
    expect(mixed.json.error.params.reason).toBe('app_mismatch')
    // a token whose prefix names no app: no check here (the connection's hello names the app)
    expect(appIdOfToken('xapp-other-format')).toBeNull()
    expect(appIdOfToken(fake.appToken)).toBe('A0APP')
    expect(h.ctx.db.query('SELECT count(*) n FROM slack_config').get()).toEqual({ n: 0 })
  })

  test('saved and turned on: one Socket Mode connection, connected', async () => {
    const saved = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens())
    expect(saved.status).toBe(200)
    // both tokens of one app (bots.info and the app token's prefix agree): the app id kept is that app's A… id
    expect(saved.json.appId).toBe('A0APP')
    expect(saved.json).toMatchObject({ enabled: false, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme' }, botName: 'trina-ax', linkOrigin: h.url, state: 'off' })
    const on = await call('dana', 'POST', '/api/admin/slack/enabled', { enabled: true })
    expect(on.json.enabled).toBe(true)
    await fake.connected()
    expect(await waitFor(async () => (await call('dana', 'GET', '/api/admin/slack')).json.state === 'connected')).toBe(true)
    expect(fake.sockets()).toBe(1)
    const acts = (h.ctx.db.query("SELECT action FROM audit_log WHERE action LIKE 'slack.%' ORDER BY id").all() as { action: string }[]).map((r) => r.action)
    expect(acts).toEqual(['slack.tokens', 'slack.enabled'])
  })
})

let aliceToken = ''
describe('linking', () => {
  test('an unlinked mention gets an ephemeral link prompt, to the asker only; no turn', async () => {
    const before = fake.acks.length
    mention('U0ALICE', 'what is our refund policy?')
    const c = await waitFor(() => linksTo('U0ALICE')[0])
    expect(c).toBeTruthy()
    expect(c!.args.channel).toBe(C)
    expect(c!.args.thread_ts).toBeUndefined() // a top-level mention has no thread yet
    expect(fake.of('chat.postMessage')).toEqual([]) // nothing the channel sees
    expect(blocksOf(c!)).toContain(`${h.url}/slack/link?t=`)
    aliceToken = linkTokenFrom(c!)!
    // acknowledged at once (Slack waits 3 seconds)
    await waitFor(() => fake.acks.length > before)
    expect(fake.acks.at(-1)!.ms).toBeLessThan(3000)
    expect(slackTurns()).toBe(0)
    // the token is stored hashed only
    expect(JSON.stringify(h.ctx.db.query('SELECT * FROM slack_link_tokens').all())).not.toContain(aliceToken)
    // asking again right away does not make a second link
    const n = ephemeralsTo('U0ALICE').length
    mention('U0ALICE', 'hello?')
    await waitFor(() => ephemeralsTo('U0ALICE').length > n)
    expect(linkTokenFrom(ephemeralsTo('U0ALICE').at(-1)!)).toBeNull()
  })

  test('somebody else\'s link cannot bind: the Slack e-mail must be the account\'s own', async () => {
    // "send the victim my link": alice's Slack link opened by bob. The page names both accounts and says the e-mails
    // differ; confirming is refused and binds nothing, and the link still works for alice
    const asBob = await call('bob', 'POST', '/api/slack/link/preview', { token: aliceToken })
    expect(asBob.status).toBe(200)
    expect(asBob.json).toMatchObject({ workspace: 'Acme', slack: { userId: 'U0ALICE', name: 'alice.slack' }, me: { name: 'Bob Lee', username: 'bob' }, linkedElsewhere: false, emailCheck: 'mismatch' })
    const refused = await call('bob', 'POST', '/api/slack/link/confirm', { token: aliceToken })
    expect(refused.status).toBe(409)
    expect(refused.json.error.params.reason).toBe('email_mismatch')
    // bob reads the app in Korean
    expect(refused.json.error.message).toBe('이 Slack 계정의 이메일이 Trina AX 계정과 달라서 바로 연결할 수 없어요. Slack으로 로그인해서 연결해 주세요.')
    expect(h.ctx.db.query('SELECT count(*) n FROM slack_links').get()).toEqual({ n: 0 })
    expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.link_refused'").get()).toEqual({ detail: JSON.stringify({ slackUser: 'U0ALICE', reason: 'email_mismatch' }) })
  })

  test('no e-mail on either side refuses too', async () => {
    // a Slack account without an e-mail, opened by dana (who has one)
    const nomail = await newLink('U0NOMAIL')
    expect((await call('dana', 'POST', '/api/slack/link/preview', { token: nomail })).json.emailCheck).toBe('missing')
    const a = await call('dana', 'POST', '/api/slack/link/confirm', { token: nomail })
    expect(a.status).toBe(409)
    expect(a.json.error.params.reason).toBe('email_missing')
    // carol's own Slack account, but carol's account here has no e-mail
    const carol = await newLink('U0CAROL')
    const b = await call('carol', 'POST', '/api/slack/link/confirm', { token: carol })
    expect(b.json.error.params.reason).toBe('email_missing')
    expect(h.ctx.db.query('SELECT count(*) n FROM slack_links').get()).toEqual({ n: 0 })
  })

  test('the matching account sees both names; the link binds the Slack account it was sent to, once', async () => {
    expect((await call('alice', 'POST', '/api/slack/link/preview', { token: aliceToken })).json.emailCheck).toBe('match')
    // a malformed token never reaches the store; an unknown one is not found
    expect((await call('alice', 'POST', '/api/slack/link/preview', { token: 'short' })).status).toBe(400)
    expect((await call('alice', 'POST', '/api/slack/link/preview', { token: 'x'.repeat(43) })).status).toBe(404)
    const ok = await call('alice', 'POST', '/api/slack/link/confirm', { token: aliceToken })
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ available: true, workspace: 'Acme', link: { slackUserId: 'U0ALICE', slackName: 'alice.slack' } })
    // used once: neither alice again nor bob can use it now
    expect((await call('alice', 'POST', '/api/slack/link/confirm', { token: aliceToken })).status).toBe(404)
    expect((await call('bob', 'POST', '/api/slack/link/confirm', { token: aliceToken })).status).toBe(404)
    expect((await call('bob', 'GET', '/api/slack/me')).json.link).toBeNull()
    // Slack is told, to alice only, where she asked
    // the Slack account is told which account it now asks as
    expect(await waitFor(() => ephemeralsTo('U0ALICE').some((c) => (c.args.text ?? '').includes('Linked to the Trina AX account Alice Kim (@alice)')))).toBe(true)
    expect(h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'slack.linked'").all()).toEqual([{ target: 'alice', detail: JSON.stringify({ slackUser: 'U0ALICE', team: 'T0ACME' }) }])
  })

  test('a link of another Slack account cannot bind someone already linked; links expire; cancel uses one up', async () => {
    const bobToken = await newLink('U0BOB')
    // alice is linked to U0ALICE already: confirming bob's Slack link as alice is refused (unlink first)
    expect((await call('alice', 'POST', '/api/slack/link/preview', { token: bobToken })).json.linkedElsewhere).toBe(true)
    const refused = await call('alice', 'POST', '/api/slack/link/confirm', { token: bobToken })
    expect(refused.status).toBe(409)
    expect(refused.json.error.params.reason).toBe('linked_elsewhere')
    // after 10 minutes the link is gone for everyone
    skew = linkClock + 11 * 60_000
    expect((await call('bob', 'POST', '/api/slack/link/preview', { token: bobToken })).status).toBe(404)
    expect((await call('bob', 'POST', '/api/slack/link/confirm', { token: bobToken })).status).toBe(404)
    skew = 0
    // a fresh one, thrown away with cancel: it cannot be confirmed after
    const mt = await newLink('U0MALLORY')
    expect((await call('erin', 'POST', '/api/slack/link/cancel', { token: mt })).status).toBe(204)
    expect((await call('erin', 'POST', '/api/slack/link/confirm', { token: mt })).status).toBe(404)
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE slack_user_id IN ('U0BOB','U0MALLORY')").get()).toEqual({ n: 0 })
  })

  test('a person of another workspace (Slack Connect) is never offered a link', async () => {
    const n = fake.of('chat.postEphemeral').length
    mention('U0GUEST', 'hi', { userTeam: 'T0OTHER' })
    await waitFor(() => fake.of('chat.postEphemeral').length > n)
    const c = fake.of('chat.postEphemeral').at(-1)!
    expect(c.args.user).toBe('U0GUEST')
    expect(linkTokenFrom(c)).toBeNull()
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_link_tokens WHERE slack_user_id = 'U0GUEST'").get()).toEqual({ n: 0 })
  })
})

describe('Enterprise Grid', () => {
  test('a person of another workspace of the same organization is not ours: no link', async () => {
    const n = ephemeralsTo('U0GRID').length
    mention('U0GRID', 'hi')
    await waitFor(() => ephemeralsTo('U0GRID').length > n)
    expect(linkTokenFrom(ephemeralsTo('U0GRID').at(-1)!)).toBeNull()
    expect(ephemeralsTo('U0GRID').at(-1)!.args.text).toContain('Only members of this workspace')
  })
})

describe('Sign in with Slack: the person proves the Slack account, no e-mail needed', () => {
  const start = (who: string) => call(who, 'POST', '/api/slack/signin', {})
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams)
  /** Slack sends the browser back: that person's browser with a session (or `null`: a browser with none). The page it
   * is sent to. */
  const backTo = async (who: string | null, q: Record<string, string>) => {
    const r = await h.req(who, `/api/integrations/slack/oauth/callback?${new URLSearchParams(q)}`, { redirect: 'manual' })
    expect(r.status).toBe(303)
    return r.headers.get('location')!
  }
  const back = async (who: string | null, q: Record<string, string>) => new URL(await backTo(who, q), 'http://x').searchParams.get('slack')
  /** start as `who`, Slack signs them in as `slackUser` (or with the claims given), the browser comes back */
  const signIn = async (who: string, slackUser: string, o: { team?: string; nonce?: string; aud?: string; iss?: string; exp?: number; browser?: string } = {}) => {
    const p = params((await start(who)).json.authorizationUrl)
    const code = `code-${crypto.randomUUID()}`
    fake.codes[code] = { user: slackUser, team: o.team, nonce: o.nonce ?? p.nonce!, aud: o.aud, iss: o.iss, exp: o.exp }
    return back(o.browser ?? who, { state: p.state!, code })
  }

  test('it needs the app\'s credentials and the team\'s https address; then the button is offered', async () => {
    // saved from http://127.0.0.1 (the harness): no https address, so no redirect URL
    expect((await call('dana', 'GET', '/api/admin/slack')).json).toMatchObject({ signIn: true, redirectUrl: null })
    expect((await call('carol', 'GET', '/api/slack/me')).json.signIn).toBe(false)
    const refused = await start('carol')
    expect(refused.status).toBe(409)
    expect(refused.json.error.params.reason).toBe('https_needed')
    // the team's https address (where people sign in)
    h.ctx.db.query("UPDATE slack_config SET link_origin = 'https://team.acme.example'").run()
    const admin = (await call('dana', 'GET', '/api/admin/slack')).json
    expect(admin.redirectUrl).toBe('https://team.acme.example/api/integrations/slack/oauth/callback')
    expect(JSON.parse(admin.manifest).oauth_config.redirect_urls).toEqual(['https://team.acme.example/api/integrations/slack/oauth/callback'])
    // no user scopes in the app: Sign in with Slack asks for its own in its own flow
    expect(JSON.parse(admin.manifest).oauth_config.scopes.user).toBeUndefined()
    expect((await call('carol', 'GET', '/api/slack/me')).json.signIn).toBe(true)
    const url = new URL((await start('carol')).json.authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize')
    expect(params(url.href)).toMatchObject({ response_type: 'code', scope: 'openid profile', client_id: fake.clientId, team: 'T0ACME', redirect_uri: 'https://team.acme.example/api/integrations/slack/oauth/callback' })
    // stored hashed only
    expect(JSON.stringify(h.ctx.db.query('SELECT * FROM slack_signin_flows').all())).not.toContain(params(url.href).state!)
  })

  test('carol, whose account has no e-mail, signs in to Slack and is linked; the Slack account is told; the user token is not kept', async () => {
    const p = params((await start('carol')).json.authorizationUrl)
    const code = 'code-carol-0001'
    fake.codes[code] = { user: 'U0NOMAIL', nonce: p.nonce! }
    expect(await back('carol', { state: p.state!, code })).toBe('linked')
    expect(h.ctx.db.query("SELECT slack_user_id FROM slack_links WHERE user_id = 'carol'").get()).toEqual({ slack_user_id: 'U0NOMAIL' })
    expect((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.linked' AND target = 'carol'").get() as { detail: string }).detail).toContain('"via":"slack_signin"')
    expect(fake.of('openid.connect.token').at(-1)!.token).toBeNull()
    expect(fake.of('auth.revoke').at(-1)!.token).toBe('xoxp-user-U0NOMAIL')
    const dm = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === 'D0NOMAIL'))
    expect(dm!.args.text).toContain('Carol Park (@carol)')
    expect(JSON.stringify(h.ctx.db.query('SELECT * FROM slack_links').all())).not.toContain('xoxp-')
    // the same state again: used
    expect(await back('carol', { state: p.state!, code: 'code-again-0001' })).toBe('signin_expired')
    // signed in again with the same Slack account: linked, nothing new recorded or said
    const audits = (h.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action = 'slack.linked' AND target = 'carol'").get() as { n: number }).n
    const dms = fake.of('chat.postMessage').filter((c) => c.args.channel === 'D0NOMAIL').length
    expect(await signIn('carol', 'U0NOMAIL')).toBe('linked')
    expect((h.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action = 'slack.linked' AND target = 'carol'").get() as { n: number }).n).toBe(audits)
    expect(fake.of('chat.postMessage').filter((c) => c.args.channel === 'D0NOMAIL').length).toBe(dms)
    // and carol asks from Slack as herself
    mention('U0NOMAIL', say('carol asks'))
    expect(await waitFor(() => h.ctx.db.query("SELECT 1 FROM turns WHERE user_id = 'carol' AND client_kind = 'slack'").get(), { timeoutMs: 10_000 })).toBeTruthy()
  })

  test('what Slack says is checked: nonce, audience, issuer, time, workspace, a person', async () => {
    const links = () => (h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id = 'erin'").get() as { n: number }).n
    expect(await signIn('erin', 'U0ERIN', { nonce: 'not-the-one' })).toBe('signin_failed')
    expect(await signIn('erin', 'U0ERIN', { aud: '9999.9999' })).toBe('signin_failed')
    expect(await signIn('erin', 'U0ERIN', { iss: 'https://evil.example' })).toBe('signin_failed')
    expect(await signIn('erin', 'U0ERIN', { exp: Math.floor(Date.now() / 1000) - 3600 })).toBe('signin_failed')
    expect(await signIn('erin', 'U0ERIN', { team: 'T0OTHER' })).toBe('outsider')
    expect(await signIn('erin', 'U0GRID')).toBe('outsider')
    expect(await signIn('erin', 'U0ROBOT')).toBe('outsider')
    expect(links()).toBe(0)
    // too late: 10 minutes
    const p = params((await start('erin')).json.authorizationUrl)
    fake.codes['late'] = { user: 'U0ERIN', nonce: p.nonce! }
    skew = 11 * 60_000
    expect(await back('erin', { state: p.state!, code: 'late' })).toBe('signin_expired')
    skew = 0
    // cancelled at Slack
    const p2 = params((await start('erin')).json.authorizationUrl)
    expect(await back('erin', { state: p2.state!, error: 'access_denied' })).toBe('signin_cancelled')
    expect(links()).toBe(0)
  })

  test('back in a browser with no session (the desktop or phone app): sign in there, then it goes on and links', async () => {
    const p = params((await h.req('erin', '/api/slack/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', client: 'desktop' }).then((r) => r.json()) as { authorizationUrl: string }).authorizationUrl)
    const code = 'code-erin-0001'
    fake.codes[code] = { user: 'U0ERIN', nonce: p.nonce! }
    // no session: to the sign-in page, whose next page is the fixed return page with only the state and the code;
    // other parameters of the request go nowhere
    const loc = await backTo(null, { state: p.state!, code, next: 'https://evil.example/', return: '//evil.example' })
    expect(loc).toBe(`/login?next=${encodeURIComponent(`/slack/signin-return?state=${p.state}&code=${code}`)}`)
    expect((h.ctx.db.query("SELECT state FROM slack_signin_flows WHERE user_id = 'erin' ORDER BY created_at DESC").get() as { state: string }).state).toBe('pending')
    // signed in, the return page sends the browser to the callback again: linked, and the end page is the one for an app
    const done = await backTo('erin', { state: p.state!, code })
    expect(done).toBe('/slack/done?slack=linked')
    expect(h.ctx.db.query("SELECT slack_user_id FROM slack_links WHERE user_id = 'erin'").get()).toEqual({ slack_user_id: 'U0ERIN' })
    // used: the same address again (another tab, after signing in again) changes nothing
    expect(await back('erin', { state: p.state!, code })).toBe('signin_expired')
    expect((await call('erin', 'DELETE', '/api/slack/me')).json.link).toBeNull()
  })

  test('signed in as somebody else, or too late after signing in: refused; a code that is not one goes nowhere', async () => {
    let p = params((await start('erin')).json.authorizationUrl)
    fake.codes['code-erin-0002'] = { user: 'U0ERIN', nonce: p.nonce! }
    expect(await back(null, { state: p.state!, code: 'code-erin-0002' })).toBeNull() // sent to sign in
    // ... and signs in as bob: refused, and the flow ends
    expect(await back('bob', { state: p.state!, code: 'code-erin-0002' })).toBe('signin_other_user')
    expect(await back('erin', { state: p.state!, code: 'code-erin-0002' })).toBe('signin_expired')
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id IN ('erin', 'bob')").get()).toEqual({ n: 0 })
    // signing in took more than the 10 minutes
    p = params((await start('erin')).json.authorizationUrl)
    fake.codes['code-erin-0003'] = { user: 'U0ERIN', nonce: p.nonce! }
    expect(await back(null, { state: p.state!, code: 'code-erin-0003' })).toBeNull()
    skew = 11 * 60_000
    expect(await back('erin', { state: p.state!, code: 'code-erin-0003' })).toBe('signin_expired')
    skew = 0
    // a "code" that is an address or a path: no sign-in page with it, the flow ends
    p = params((await start('erin')).json.authorizationUrl)
    const loc = await backTo(null, { state: p.state!, code: 'https://evil.example/x' })
    expect(loc).toBe('/settings/connectors?slack=signin_failed')
    expect(await back('erin', { state: p.state!, code: 'code-erin-0004' })).toBe('signin_expired')
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id = 'erin'").get()).toEqual({ n: 0 })
  })

  test('the user token is revoked even when the id_token is not one', async () => {
    const p = params((await start('erin')).json.authorizationUrl)
    fake.codes['code-erin-0005'] = { user: 'U0ERIN', nonce: p.nonce!, badIdToken: true }
    const n = fake.of('auth.revoke').length
    expect(await back('erin', { state: p.state!, code: 'code-erin-0005' })).toBe('signin_failed')
    expect(await waitFor(() => fake.of('auth.revoke').length > n)).toBe(true)
    expect(fake.of('auth.revoke').at(-1)!.token).toBe('xoxp-user-U0ERIN')
  })

  test('a Slack account linked to someone else, or an account linked to another Slack account: refused', async () => {
    expect(await signIn('bob', 'U0ALICE')).toBe('slack_taken')
    expect(await signIn('alice', 'U0BOB')).toBe('linked_elsewhere')
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id = 'bob'").get()).toEqual({ n: 0 })
  })
  // the tests after these read links that open at the harness's own address
  afterAll(() => { h.ctx.db.query('UPDATE slack_config SET link_origin = ?').run(h.url) })
})

describe('an e-mail someone else set', () => {
  test('is no proof for 7 days: the member is told, the page shows it, refused until they set it themselves', async () => {
    // carol (in no fixture group: the harness's fixture groups have ids the contract refuses in an answer, which real
    // groups never have; tests/unit/c-slack-email-routes.test.ts does the same with a real group on a real server)
    // links her own Slack account later; first she gives up the one she signed in with
    expect((await call('carol', 'DELETE', '/api/slack/me')).status).toBe(200)
    // an admin sets carol's e-mail in Admin › Members
    const byAdmin = await call('dana', 'PATCH', '/api/admin/users/carol', { email: 'carol@acme.example' })
    expect(byAdmin.status).toBe(200)
    expect(byAdmin.json).toMatchObject({ id: 'carol', email: 'carol@acme.example' })
    expect(await waitFor(() => notices.some((n) => n.userId === 'carol' && n.ev.data.code === 'slack_email_changed'))).toBe(true)
    expect((await call('carol', 'GET', '/api/slack/me')).json.emailSetByOther).toBe(true)
    const t1 = await newLink('U0CAROL')
    const p = await call('carol', 'POST', '/api/slack/link/preview', { token: t1 })
    expect(p.json).toMatchObject({ emailCheck: 'recent', email: 'carol@acme.example' })
    const refused = await call('carol', 'POST', '/api/slack/link/confirm', { token: t1 })
    expect(refused.json.error.params.reason).toBe('email_recent')
    // carol sets it herself in Settings › Profile: hers again
    await Bun.sleep(1100)
    const own = await call('carol', 'PATCH', '/api/me', { email: 'Carol@acme.example' })
    expect(own.status).toBe(200)
    expect(own.json.user).toMatchObject({ id: 'carol', email: 'Carol@acme.example' })
    expect((await call('carol', 'POST', '/api/slack/link/preview', { token: t1 })).json.emailCheck).toBe('match')
    expect((await call('carol', 'GET', '/api/slack/me')).json.emailSetByOther).toBe(false)
  })

  test('an account an admin created with an e-mail: no proof for its first 7 days', async () => {
    const made = await call('dana', 'POST', '/api/admin/users', { username: 'frank', name: 'Frank Oh', email: 'frank@acme.example', role: 'member' })
    expect(made.status).toBe(201)
    const frank = h.ctx.db.query("SELECT id FROM users WHERE username = 'frank'").get() as { id: string }
    expect(made.json.user.id).toBe(frank.id)
    // (signed in once and the temporary password changed; the e-mail stays the admin's)
    h.ctx.db.query('UPDATE users SET must_change_password = 0 WHERE id = ?').run(frank.id)
    const t = await newLink('U0FRANK')
    expect((await slackOf(h.ctx).preview(frank.id, t)).emailCheck).toBe('recent')
    expect(slackOf(h.ctx).mine(frank.id).emailSetByOther).toBe(true)
  })
})

let requestId = ''
let chatId = ''
let rootTs = ''
describe('asking', () => {
  test('a linked person in a channel: a turn as them, the answer to them only with one button', async () => {
    const posts = fake.of('chat.postMessage').length
    rootTs = mention('U0ALICE', say('Refunds take 7 days.'))
    const turn = await waitFor(() => h.ctx.db.query("SELECT * FROM turns WHERE client_kind = 'slack' AND user_id = 'alice' ORDER BY started_at DESC LIMIT 1").get() as { user_id: string; chat_id: string } | null, { timeoutMs: 10_000 })
    expect(turn!.user_id).toBe('alice')
    chatId = turn!.chat_id
    expect((h.ctx.db.query('SELECT user_id FROM chats WHERE id = ?').get(chatId) as { user_id: string }).user_id).toBe('alice')
    // "working…" to alice only, with the link to the chat
    const working = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => /Working/.test(c.args.text ?? '')))
    expect(blocksOf(working!)).toContain(`${h.url}/c/${chatId}`)
    expect(blocksOf(working!)).toContain('Answering as Alice Kim (@alice).')
    const answer = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => blocksOf(c).includes('Refunds take 7 days.')), { timeoutMs: 30_000 })
    expect(answer).toBeTruthy()
    expect(answer!.args.channel).toBe(C)
    const blocks = JSON.parse(answer!.args.blocks!) as any[]
    const button = blocks.find((b) => b.type === 'actions').elements[0]
    expect(button).toMatchObject({ action_id: 'trina_post', text: { text: 'Post to channel' } })
    requestId = button.value
    expect(blocksOf(answer!)).toContain(`${h.url}/c/${chatId}`)
    // nothing was posted where the channel sees it
    expect(fake.of('chat.postMessage').length).toBe(posts)
    // the full answer is in the chat here
    const msgs = (await call('alice', 'GET', `/api/chats/${chatId}/messages`)).json.items as { role: string; content: string }[]
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]!.content).toContain('Refunds take 7 days.')
    // bob cannot see alice's chat
    expect((await call('bob', 'GET', `/api/chats/${chatId}`)).status).toBe(404)
  })

  test('"Post to channel": the answer alone in the thread, asked by the asker, once; nobody else can post it', async () => {
    const action = (user: string, value = requestId) => fake.action({
      type: 'block_actions', api_app_id: 'A0APP', user: { id: user, team_id: 'T0ACME' }, team: { id: 'T0ACME' },
      container: { type: 'message', channel_id: C, is_ephemeral: true }, channel: { id: C },
      actions: [{ action_id: 'trina_post', block_id: 'b', value, type: 'button', action_ts: '1' }], response_url: `${fake.url}/actions/${user}/${fake.responses.length}`,
    })
    // another Slack user replaying the button's value: nothing posted
    action('U0BOB')
    await waitFor(() => fake.responses.length >= 1)
    expect(fake.responses.at(-1)!.body.text).toMatch(/can no longer be posted/)
    expect(fake.of('chat.postMessage').filter((c) => c.args.channel === C)).toEqual([])
    action('U0ALICE')
    const post = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === C))
    expect(post!.args.thread_ts).toBe(rootTs)
    expect(blocksOf(post!)).toContain('Refunds take 7 days.')
    expect(blocksOf(post!)).toContain('Asked by alice.slack')
    // no link to the chat, no steps
    expect(blocksOf(post!)).not.toContain('/c/')
    await waitFor(() => fake.responses.some((r) => r.body.text === 'Posted to the thread.'))
    expect(fake.responses.find((r) => r.body.text === 'Posted to the thread.')!.body.replace_original).toBe(true)
    // again: already posted
    action('U0ALICE')
    await waitFor(() => fake.responses.some((r) => /already posted/.test(String(r.body.text))))
    expect(fake.of('chat.postMessage').filter((c) => c.args.channel === C).length).toBe(1)
    expect(h.ctx.db.query("SELECT count(*) n FROM audit_log WHERE action = 'slack.posted'").get()).toEqual({ n: 1 })
  })

  test('a channel shared with another organization: the answer to the asker, with no button and the reason', async () => {
    const ts = nextTs()
    fake.event({ type: 'app_mention', user: 'U0ALICE', text: `<@U0BOT> ${say('Shared channel answer.')}`, ts, channel: 'C0SHARED', event_ts: ts }, { extShared: true })
    const answer = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => blocksOf(c).includes('Shared channel answer.')), { timeoutMs: 30_000 })
    expect(blocksOf(answer!)).not.toContain('trina_post')
    expect(blocksOf(answer!)).toContain('shared with another organization')
    // a replayed button for it posts nothing
    const r = h.ctx.db.query("SELECT id FROM slack_requests WHERE channel_id = 'C0SHARED'").get() as { id: string }
    const n = fake.responses.length
    fake.action({ type: 'block_actions', api_app_id: 'A0APP', user: { id: 'U0ALICE', team_id: 'T0ACME' }, team: { id: 'T0ACME' }, container: { type: 'message', channel_id: 'C0SHARED', is_ephemeral: true },
      actions: [{ action_id: 'trina_post', value: r.id, type: 'button' }], response_url: `${fake.url}/actions/shared` })
    await waitFor(() => fake.responses.length > n)
    expect(fake.of('chat.postMessage').filter((c) => c.args.channel === 'C0SHARED')).toEqual([])
  })

  test('"Post to channel" asks Slack again: a channel shared since, or one Slack says nothing about, gets nothing', async () => {
    const ask = async (channel: string, text: string) => {
      mention('U0ALICE', say(text), { channel })
      const a = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => blocksOf(c).includes(text) && blocksOf(c).includes('trina_post')), { timeoutMs: 30_000 })
      return (JSON.parse(a!.args.blocks!) as any[]).find((b) => b.type === 'actions').elements[0].value as string
    }
    const press = (channel: string, value: string, tag: string) => fake.action({ type: 'block_actions', api_app_id: 'A0APP', user: { id: 'U0ALICE', team_id: 'T0ACME' }, team: { id: 'T0ACME' },
      container: { type: 'message', channel_id: channel, is_ephemeral: true }, actions: [{ action_id: 'trina_post', value, type: 'button' }], response_url: `${fake.url}/actions/${tag}` })
    const v1 = await ask('C0LATER', 'Later shared.')
    fake.sharedChannels.add('C0LATER')
    press('C0LATER', v1, 'later')
    await waitFor(() => fake.responses.some((r) => r.path === '/actions/later'))
    expect(fake.responses.find((r) => r.path === '/actions/later')!.body.text).toContain('shared with another organization')
    const v2 = await ask('C0UNKNOWN', 'Unknown channel.')
    fake.unknownChannels.add('C0UNKNOWN')
    press('C0UNKNOWN', v2, 'unknown')
    await waitFor(() => fake.responses.some((r) => r.path === '/actions/unknown'))
    expect(fake.responses.find((r) => r.path === '/actions/unknown')!.body.text).toContain('did not say whether')
    expect(fake.of('chat.postMessage').filter((c) => c.args.channel === 'C0LATER' || c.args.channel === 'C0UNKNOWN')).toEqual([])
  })

  test('"Asked by" without a Slack name is "a teammate", never a mention', async () => {
    mention('U0ALICE', say('Nameless answer.'), { channel: 'C0NONAME' })
    const a = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => blocksOf(c).includes('Nameless answer.')), { timeoutMs: 30_000 })
    const value = (JSON.parse(a!.args.blocks!) as any[]).find((b) => b.type === 'actions').elements[0].value as string
    const name = (h.ctx.db.query("SELECT slack_name FROM slack_links WHERE user_id = 'alice'").get() as { slack_name: string }).slack_name
    h.ctx.db.query("UPDATE slack_links SET slack_name = NULL WHERE user_id = 'alice'").run()
    fake.action({ type: 'block_actions', api_app_id: 'A0APP', user: { id: 'U0ALICE', team_id: 'T0ACME' }, team: { id: 'T0ACME' },
      container: { type: 'message', channel_id: 'C0NONAME', is_ephemeral: true }, actions: [{ action_id: 'trina_post', value, type: 'button' }], response_url: `${fake.url}/actions/noname` })
    const post = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === 'C0NONAME'))
    expect(blocksOf(post!)).toContain('Asked by a teammate')
    expect(blocksOf(post!)).not.toContain('<@')
    h.ctx.db.query("UPDATE slack_links SET slack_name = ? WHERE user_id = 'alice'").run(name)
  })

  test('Slack\'s Retry-After is kept per answer: not sent again before it', async () => {
    const text = 'After the wait.'
    mention('U0ALICE', `@fake ${JSON.stringify({ sleep: 600 })}\n${say(text)}`, { channel: 'C0RATE' })
    await waitFor(() => ephemeralsTo('U0ALICE').some((c) => c.args.channel === 'C0RATE' && /Working/.test(c.args.text ?? '')))
    fake.failNext['chat.postEphemeral'] = { status: 429, retryAfter: 40 }
    const req = await waitFor(() => h.ctx.db.query("SELECT state, attempts, not_before FROM slack_requests WHERE channel_id = 'C0RATE' AND attempts > 0").get() as { state: string; attempts: number; not_before: string } | null, { timeoutMs: 30_000 })
    expect(req!.state).toBe('waiting')
    expect(Date.parse(req!.not_before) - Date.now()).toBeGreaterThan(35_000)
    // the refused try is the only one so far
    const tries = () => ephemeralsTo('U0ALICE').filter((c) => blocksOf(c).includes(text)).length
    await Bun.sleep(300)
    expect(tries()).toBe(1)
    skew = 41_000
    try { expect(await waitFor(() => tries() === 2, { timeoutMs: 10_000 })).toBe(true) } finally { skew = 0 }
  })

  test('a DM answer whose post timed out is not posted again when it reached Slack; an older answer with the same words does not count', async () => {
    // Every step waits for the thing itself to happen, never for an amount of time: the answer's post is held by
    // the fake Slack until the server's own time limit gives up on it, and the clock only moves past the row's own
    // not-before time. (Before: the fake was armed after "some post to the DM", which under load could be the answer
    // itself, and every call had 400 ms, which ordinary calls lost under load.)
    const ts = nextTs()
    const dm = (thread?: string) => fake.event({ type: 'message', channel_type: 'im', user: 'U0ALICE', text: `@fake ${JSON.stringify({ sleep: 300 })}\n${say('Same words.')}`, ts: thread ? nextTs() : ts, channel: 'D0ALICE2', ...(thread ? { thread_ts: thread } : {}) })
    const isAnswer = (a: Record<string, string>) => a.channel === 'D0ALICE2' && (a.blocks ?? '').includes('Same words.')
    const answers = () => fake.of('chat.postMessage').filter((c) => isAnswer(c.args))
    const row = (n: number) => h.ctx.db.query("SELECT * FROM slack_requests WHERE channel_id = 'D0ALICE2' ORDER BY created_at, id LIMIT 1 OFFSET ?").get(n) as { attempts: number; state: string; not_before: string | null; progress_ts: string | null } | null
    /** Move the clock past the row's not-before time each time it is set again, until `done` holds */
    const retryUntil = async (n: number, done: () => boolean) => {
      const end = Date.now() + 60_000
      while (!done() && Date.now() < end) {
        const nb = row(n)?.not_before
        if (nb && Date.parse(nb) > Date.now() + skew) skew = Date.parse(nb) - Date.now() + 1000
        await waitFor(done, { timeoutMs: 1000 })
      }
      return done()
    }
    try {
      // armed before the question: only the answer's post is held, whenever it comes
      fake.failNext['chat.postMessage'] = { hang: true, match: isAnswer }
      dm()
      expect(await waitFor(() => answers().length === 1, { timeoutMs: 30_000 })).toBe(true) // it reached Slack
      expect(await waitFor(() => (row(0)?.attempts ?? 0) > 0 && row(0)?.state === 'waiting', { timeoutMs: 30_000 })).toBe(true) // the server gave up on it
      const progress = row(0)!.progress_ts
      // tried again: the thread is read first, the answer is found, the working message goes
      expect(await retryUntil(0, () => fake.of('chat.delete').some((c) => c.args.ts === progress))).toBe(true)
      expect(fake.of('conversations.replies').length).toBeGreaterThan(0)
      expect(answers().length).toBe(1)
      expect(row(0)!.state).toBe('delivered')
      // the same words again in the thread: this post is lost on the way, so it is sent again
      fake.failNext['chat.postMessage'] = { hang: true, lost: true, match: isAnswer }
      dm(ts)
      expect(await waitFor(() => (row(1)?.attempts ?? 0) > 0 && row(1)?.state === 'waiting', { timeoutMs: 30_000 })).toBe(true)
      expect(answers().length).toBe(1)
      expect(await retryUntil(1, () => answers().length === 2)).toBe(true)
    } finally { skew = 0; delete fake.failNext['chat.postMessage'] }
  })

  test('an answer\'s link to a page of the app opens at the team\'s address in Slack', async () => {
    mention('U0ALICE', say('[shared](/files/view?path=shared) 폴더는 지금 비어 있어요.'), { channel: 'C0LINKS' })
    const a = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => c.args.channel === 'C0LINKS' && blocksOf(c).includes('폴더는')), { timeoutMs: 30_000 })
    expect(blocksOf(a!)).toContain(`<${h.url}/files/view?path=shared|shared> 폴더는 지금 비어 있어요.`)
    expect(blocksOf(a!)).not.toContain('[shared](')
  })

  test('a follow-up in the thread continues the same chat', async () => {
    const n = slackTurns()
    mention('U0ALICE', say('And exchanges too.'), { thread: rootTs })
    await waitFor(() => ephemeralsTo('U0ALICE').some((c) => blocksOf(c).includes('And exchanges too.')), { timeoutMs: 30_000 })
    const last = ephemeralsTo('U0ALICE').find((c) => blocksOf(c).includes('And exchanges too.'))!
    expect(last.args.thread_ts).toBe(rootTs) // asked inside the thread: the answer is shown there
    expect(slackTurns()).toBe(n + 1)
    const msgs = (await call('alice', 'GET', `/api/chats/${chatId}/messages`)).json.items as { role: string }[]
    expect(msgs.length).toBe(4)
  })

  test('in a DM the answer comes as a new message in the DM thread and the working message goes', async () => {
    const ts = nextTs()
    fake.event({ type: 'message', channel_type: 'im', user: 'U0ALICE', text: say('Hello from the DM. &lt;!here&gt; [https://bank.example](https://evil.example)'), ts, channel: 'D0ALICE', event_ts: ts })
    const working = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === 'D0ALICE'))
    expect(working!.args.thread_ts).toBe(ts)
    const answer = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === 'D0ALICE' && blocksOf(c).includes('Hello from the DM.')), { timeoutMs: 30_000 })
    expect(answer!.args.thread_ts).toBe(ts)
    // no button in a DM: it is the asker's own conversation
    expect(blocksOf(answer!)).not.toContain('trina_post')
    // nothing in the blocks or the notification text mentions anyone or hides where a link goes
    expect(answer!.args.text).toContain('&lt;!here&gt;')
    expect(answer!.args.text).not.toContain('<!here>')
    expect(blocksOf(answer!)).toContain('https://bank.example (<https://evil.example>)')
    expect(await waitFor(() => fake.of('chat.delete').some((c) => c.args.channel === 'D0ALICE'))).toBe(true)
    // the bot's own messages and edits in the DM are not questions
    fake.event({ type: 'message', channel_type: 'im', user: 'U0BOT', bot_id: 'B0BOT', text: 'Working on it…', ts: nextTs(), channel: 'D0ALICE' })
    fake.event({ type: 'message', channel_type: 'im', subtype: 'message_changed', user: 'U0ALICE', text: 'x', ts: nextTs(), channel: 'D0ALICE' })
    await Bun.sleep(200)
    expect((h.ctx.db.query("SELECT count(*) n FROM slack_threads WHERE channel_id = 'D0ALICE'").get() as { n: number }).n).toBe(1)
  })

  test('the same event id, or the same message as another event, runs once', async () => {
    const before = slackTurns()
    const ts = nextTs()
    const ev = { type: 'app_mention', user: 'U0ALICE', text: `<@U0BOT> ${say('once')}`, ts, channel: C, event_ts: ts }
    fake.event(ev, { eventId: 'EvSAME0001' })
    fake.event(ev, { eventId: 'EvSAME0001', retry: 1 })
    fake.event(ev, { eventId: 'EvOTHER001' })
    await waitFor(() => ephemeralsTo('U0ALICE').some((c) => blocksOf(c).includes('once')), { timeoutMs: 30_000 })
    await Bun.sleep(300)
    expect(slackTurns()).toBe(before + 1)
    // every envelope was still acknowledged, at once
    expect(fake.acks.filter((a) => a.ms < 3000).length).toBe(fake.acks.length)
  })

  test('events of another workspace or app, and malformed ones, are dropped', async () => {
    const before = fake.calls.length
    fake.event({ type: 'app_mention', user: 'U0ALICE', text: '<@U0BOT> hi', ts: nextTs(), channel: C }, { team: 'T0OTHER' })
    fake.event({ type: 'app_mention', user: 'U0ALICE', text: '<@U0BOT> hi', ts: nextTs(), channel: C }, { appId: 'A0OTHER' })
    fake.event({ type: 'app_mention', text: '<@U0BOT> hi', ts: nextTs(), channel: C })
    fake.event({ type: 'app_mention', user: 'U0ALICE; DROP', text: '<@U0BOT> hi', ts: nextTs(), channel: C })
    await Bun.sleep(300)
    expect(fake.calls.length).toBe(before)
  })

  test('an answer is not sent to a Slack account unlinked while it was being written', async () => {
    const n = fake.calls.length
    mention('U0ALICE', `@fake ${JSON.stringify({ sleep: 1200 })}\n${say('secret plans')}`)
    const req = await waitFor(() => h.ctx.db.query("SELECT id FROM slack_requests WHERE state = 'waiting'").get() as { id: string } | null, { timeoutMs: 10_000 })
    const link = h.ctx.db.query("SELECT * FROM slack_links WHERE user_id = 'alice'").get() as Record<string, unknown>
    h.ctx.db.query("DELETE FROM slack_links WHERE user_id = 'alice'").run()
    await waitFor(() => (h.ctx.db.query('SELECT state FROM slack_requests WHERE id = ?').get(req!.id) as { state: string }).state !== 'waiting', { timeoutMs: 30_000 })
    expect((h.ctx.db.query('SELECT state FROM slack_requests WHERE id = ?').get(req!.id) as { state: string }).state).toBe('failed')
    expect(fake.calls.slice(n).some((c) => JSON.stringify(c.args).includes('secret plans'))).toBe(false)
    // linked again for the tests after this one
    h.ctx.db.query('INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(link.id as string, 'alice', link.team_id as string, link.enterprise_id as string, link.slack_user_id as string, link.slack_name as string, link.created_at as string)
  })

  test('no link when Slack cannot say who is asking', async () => {
    const before = linksTo('U0BOB').length
    skew = linkClock + 30 * 60_000
    fake.failNext['users.info'] = { error: 'internal_error' }
    const n = ephemeralsTo('U0BOB').length
    mention('U0BOB', 'hi')
    await waitFor(() => ephemeralsTo('U0BOB').length > n)
    skew = 0
    expect(linksTo('U0BOB').length).toBe(before)
  })

  test('Slack refreshes the connection: a new one is opened and events still arrive', async () => {
    const opens = fake.opens
    fake.disconnect('refresh_requested')
    await waitFor(() => fake.opens > opens)
    await waitFor(() => fake.sockets() === 1, { timeoutMs: 5000 })
    expect(fake.sockets()).toBe(1)
    mention('U0ALICE', say('after refresh'))
    expect(await waitFor(() => ephemeralsTo('U0ALICE').some((c) => blocksOf(c).includes('after refresh')), { timeoutMs: 30_000 })).toBe(true)
  })
})

describe('Enterprise Grid: one link per Slack user, whatever the enterprise id', () => {
  test('a link made by signing in carries the workspace\'s enterprise id; questions with it are answered; no second link for the same Slack user', async () => {
    // the workspace is part of an organization: the tokens are saved again (same workspace: the links stay)
    fake.enterpriseId = 'E0ORG'
    expect((await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens())).status).toBe(200)
    expect(await waitFor(async () => (await call('dana', 'GET', '/api/admin/slack')).json.state === 'connected', { timeoutMs: 10_000 })).toBe(true)
    h.ctx.db.query("UPDATE slack_config SET link_origin = 'https://team.acme.example'").run()
    try {
      // a one-time link for that Slack user, from before (its event had no enterprise id)
      const t = await newLink('U0MALLORY')
      const p = Object.fromEntries(new URL((await call('bob', 'POST', '/api/slack/signin', {})).json.authorizationUrl).searchParams)
      fake.codes['code-bob-grid-01'] = { user: 'U0MALLORY', nonce: p.nonce! } // the id_token says nothing of the organization
      const r = await h.req('bob', `/api/integrations/slack/oauth/callback?${new URLSearchParams({ state: p.state!, code: 'code-bob-grid-01' })}`, { redirect: 'manual' })
      expect(r.headers.get('location')).toBe('/settings/connectors?slack=linked')
      expect(h.ctx.db.query("SELECT enterprise_id FROM slack_links WHERE user_id = 'bob'").get()).toEqual({ enterprise_id: 'E0ORG' })
      // a question from that Slack user, with the organization in the event: answered as bob
      const ts = nextTs()
      fake.event({ type: 'app_mention', user: 'U0MALLORY', text: `<@U0BOT> ${say('grid answer')}`, ts, channel: C, event_ts: ts }, { enterprise: 'E0ORG' })
      expect(await waitFor(() => h.ctx.db.query("SELECT 1 FROM turns WHERE user_id = 'bob' AND client_kind = 'slack'").get(), { timeoutMs: 15_000 })).toBeTruthy()
      // the one-time link of the same Slack user, confirmed by another account with the same e-mail: used up by the link
      h.ctx.db.query("UPDATE users SET email = 'mallory@acme.example' WHERE id = 'carol'").run()
      expect((await call('carol', 'POST', '/api/slack/link/confirm', { token: t })).status).toBe(404)
      // one still open (made in the same instant): the same check as signing in, so refused
      const open = 'G'.repeat(43)
      h.ctx.db.query("INSERT INTO slack_link_tokens (token_hash, team_id, enterprise_id, slack_user_id, slack_name, expires_at, created_at) VALUES (?, 'T0ACME', '', 'U0MALLORY', 'mallory', ?, ?)")
        .run(createHash('sha256').update(open).digest('hex'), new Date(Date.now() + 600_000).toISOString(), new Date().toISOString())
      const refused = await call('carol', 'POST', '/api/slack/link/confirm', { token: open })
      expect(refused.status).toBe(409)
      expect(refused.json.error.params.reason).toBe('slack_taken')
      expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE slack_user_id = 'U0MALLORY'").get()).toEqual({ n: 1 })
    } finally {
      h.ctx.db.query('UPDATE slack_config SET link_origin = ?').run(h.url)
      h.ctx.db.query("UPDATE users SET email = 'Carol@acme.example' WHERE id = 'carol'").run()
    }
  })
})

describe('secrets and accounts', () => {
  test('the tokens are in no log line, row, audit entry or answer', async () => {
    const view = JSON.stringify((await call('dana', 'GET', '/api/admin/slack')).json)
    const rows = ['slack_config', 'slack_links', 'slack_link_tokens', 'slack_requests', 'slack_events', 'audit_log', 'messages', 'turns', 'chats', 'tool_events']
      .map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const secret of [fake.botToken, fake.appToken, fake.botToken.slice(5, 25), fake.appToken.slice(5, 25), fake.clientSecret]) {
      expect(view).not.toContain(secret)
      expect(rows).not.toContain(secret)
      expect(lines.join('\n')).not.toContain(secret)
    }
  })

  test('unlink from Settings; a disabled account is unlinked at once and gets a link prompt again', async () => {
    // erin links, then unlinks herself (past the "link sent a moment ago" wait of the test before)
    const et = await newLink('U0ERIN', 'hi again')
    expect((await call('erin', 'POST', '/api/slack/link/confirm', { token: et })).status).toBe(200)
    const off = await call('erin', 'DELETE', '/api/slack/me')
    expect(off.json.link).toBeNull()
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id = 'erin'").get()).toEqual({ n: 0 })
    // alice's account is disabled: her link goes with it (whoever disabled it), recorded in the audit log
    h.ctx.db.query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_links WHERE user_id = 'alice'").get()).toEqual({ n: 0 })
    expect(h.ctx.db.query("SELECT count(*) n FROM slack_threads WHERE user_id = 'alice'").get()).toEqual({ n: 0 })
    expect((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.unlinked' AND target = 'alice'").get() as { detail: string }).detail).toContain('account_disabled')
    const turns = (h.ctx.db.query("SELECT count(*) n FROM turns WHERE user_id = 'alice'").get() as { n: number }).n
    await newLink('U0ALICE', say('still me?'))
    expect((h.ctx.db.query("SELECT count(*) n FROM turns WHERE user_id = 'alice'").get() as { n: number }).n).toBe(turns)
    h.ctx.db.query("UPDATE users SET status = 'active' WHERE id = 'alice'").run()
  })

  test('turning it off closes the connection; removing it drops the tokens and every link', async () => {
    await call('dana', 'POST', '/api/admin/slack/enabled', { enabled: false })
    await waitFor(() => fake.sockets() === 0)
    expect(fake.sockets()).toBe(0)
    expect((await call('alice', 'GET', '/api/slack/me')).json.available).toBe(false)
    const gone = await call('dana', 'DELETE', '/api/admin/slack')
    expect(gone.json).toMatchObject({ enabled: false, tokens: false, workspace: null, linked: 0 })
    for (const t of ['slack_config', 'slack_links', 'slack_link_tokens', 'slack_threads']) expect(h.ctx.db.query(`SELECT count(*) n FROM ${t}`).get()).toEqual({ n: 0 })
  })
})

describe('text', () => {
  test('e-mails compare in NFC, trimmed, in lower case; a full-width look-alike is another address', () => {
    expect(normEmail(' Jose\u0301@Acme.Example ')).toBe(normEmail('jos\u00e9@acme.example'))
    expect(normEmail('ａｌｉｃｅ@acme.example')).not.toBe(normEmail('alice@acme.example'))
    expect(normEmail('')).toBeNull()
    expect(normEmail('no-at-sign')).toBeNull()
    expect(normEmail(null)).toBeNull()
  })

  test('the app\'s own links open at the team\'s address; other kinds stay text; code is left alone', () => {
    const o = 'https://team.acme.example'
    expect(toMrkdwn('[shared](/files/view?path=shared) 폴더는 지금 비어 있어요.', o)).toBe('<https://team.acme.example/files/view?path=shared|shared> 폴더는 지금 비어 있어요.')
    expect(toMrkdwn('[docs](https://acme.example/a?b=1&c=2)', o)).toBe('<https://acme.example/a?b=1&amp;c=2|docs>')
    // & < > in the label, the address and the text around
    expect(toMrkdwn('a < b & [x<y & z>](/files/view?path=a&b=c) >', o)).toBe('a &lt; b &amp; <https://team.acme.example/files/view?path=a&amp;b=c|x&lt;y &amp; z&gt;> &gt;')
    // no team address: the text alone; a protocol-relative or another scheme: as written, no link
    expect(toMrkdwn('[shared](/files/view?path=shared) 폴더', null)).toBe('shared 폴더')
    expect(toMrkdwn('[x](//evil.example/p) [m](mailto:a@acme.example) [j](javascript:alert(1))', o)).toBe('[x](//evil.example/p) [m](mailto:a@acme.example) [j](javascript:alert(1))')
    // code spans and blocks stay as they are (only Slack's &, <, > escaped)
    expect(toMrkdwn('`[shared](/files/view?path=shared)` and\n```md\n[shared](/files/view?path=shared) <b>\n```', o)).toBe('`[shared](/files/view?path=shared)` and\n```\n[shared](/files/view?path=shared) &lt;b&gt;\n```')
    // an origin that is not one is not used
    expect(toMrkdwn('[shared](/x)', 'javascript:alert(1)')).toBe('shared')
  })

  test('Slack markup to the question; the answer to mrkdwn without mentions or hidden links', () => {
    expect(questionText('<@U0BOT> look at <https://acme.example/a?b=1&amp;c=2|the doc> with <@U0BOB|bob> in <#C1|general> &lt;now&gt;', 'U0BOT'))
      .toBe('look at the doc (https://acme.example/a?b=1&c=2) with @bob in #general <now>')
    expect(toMrkdwn('# Title\n**bold** and [link](https://acme.example) <!channel> <@U1>\n- item\n```ts\na < b && c\n```'))
      .toBe('*Title*\n*bold* and <https://acme.example|link> &lt;!channel&gt; &lt;@U1&gt;\n• item\n```\na &lt; b &amp;&amp; c\n```')
  })

  test('a reason code is a plain sentence in Slack; a sentence stays; one wording for an outsider', () => {
    expect(sayText('failed', 'en', { reason: 'gone' })).toBe('Could not answer. The chat was deleted.')
    expect(sayText('failed', 'en', { reason: 'error' })).toBe('Could not answer. Something went wrong while answering.')
    expect(sayText('cannotStart', 'en', { reason: 'internal' })).toBe('Could not start the answer. Something went wrong on the server. Ask again in a moment.')
    expect(sayText('cannotStart', 'ko', { reason: 'forbidden' })).not.toContain('forbidden')
    expect(sayText('cannotStart', 'en', { reason: 'You used up this month\'s budget.' })).toBe('Could not start the answer. You used up this month\'s budget.')
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect(refusal('outsider', l)).toBe(sayText('outsider', l))
    expect(refusal('missing_scope', 'ko', { scopes: 'users:read' })).not.toContain('매니페스트')
  })
})
