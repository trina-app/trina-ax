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
import { questionText, refusal, say as sayText } from '../../server/src/integrations/slack/text'
import { isWebAddress, plainOf, richBlocks, richText, slackAnswer } from '../../server/src/integrations/slack/rich-text'
import { slackManifest } from '../../server/src/integrations/slack/manifest'
import { roomsOf } from '../../server/src/rooms/service'
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
    // Slack does not say the bot's name while the tokens are saved
    fake.failNext['users.info'] = { error: 'internal_error', match: (a) => a.user === fake.botUserId }
    const saved = await call('dana', 'PUT', '/api/admin/slack/tokens', await tokens())
    expect(saved.status).toBe(200)
    // both tokens of one app (bots.info and the app token's prefix agree): the app id kept is that app's A… id
    expect(saved.json.appId).toBe('A0APP')
    // the bot's name as people find it in Slack: here the manifest's display name, never auth.test's user name `trinaax`
    expect(saved.json).toMatchObject({ enabled: false, tokens: true, workspace: { teamId: 'T0ACME', name: 'Acme' }, botName: 'trina-ax', linkOrigin: h.url, state: 'off' })
    // renamed in Slack's app settings: the connection reads the name Slack has now
    fake.botDisplayName = 'acme-helper'
    const on = await call('dana', 'POST', '/api/admin/slack/enabled', { enabled: true })
    expect(on.json.enabled).toBe(true)
    await fake.connected()
    expect(await waitFor(async () => (await call('dana', 'GET', '/api/admin/slack')).json.state === 'connected')).toBe(true)
    expect(await waitFor(async () => (await call('dana', 'GET', '/api/admin/slack')).json.botName === 'acme-helper')).toBe(true)
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

  test('blocks Slack refuses: the ephemeral answer and "Post to channel" go again as plain text, with the button and "Asked by"', async () => {
    const isAnswer = (a: Record<string, string>) => a.channel === 'C0REFUSE' && (a.blocks ?? '').includes('once, then plain')
    fake.failNext['chat.postEphemeral'] = { error: 'invalid_blocks', match: isAnswer }
    const root = mention('U0ALICE', say('**Refused** once, then plain.'), { channel: 'C0REFUSE' })
    const tries = await waitFor(() => { const all = ephemeralsTo('U0ALICE').filter((c) => isAnswer(c.args)); return all.length >= 2 ? all : null }, { timeoutMs: 30_000 })
    const [refused, again] = tries!
    expect(refused!.refused).toBe('invalid_blocks')
    expect((JSON.parse(refused!.args.blocks!) as any[])[0].elements[0].elements[0]).toEqual({ type: 'text', text: 'Refused', style: { bold: true } })
    const blocks = JSON.parse(again!.args.blocks!) as any[]
    expect(blocks[0]).toEqual({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Refused once, then plain.' }] }] })
    expect(blocks.map((b) => b.type)).toEqual(['rich_text', 'context', 'actions'])
    expect(again!.args.text).toBe('Refused once, then plain.')
    const value = blocks.find((b) => b.type === 'actions').elements[0].value as string
    // "Post to channel": refused once too, then posted as plain text under "Asked by", in the thread
    fake.failNext['chat.postMessage'] = { error: 'msg_blocks_too_long', match: isAnswer }
    const seen = fake.responses.length
    fake.action({
      type: 'block_actions', api_app_id: 'A0APP', user: { id: 'U0ALICE', team_id: 'T0ACME' }, team: { id: 'T0ACME' },
      container: { type: 'message', channel_id: 'C0REFUSE', is_ephemeral: true }, channel: { id: 'C0REFUSE' },
      actions: [{ action_id: 'trina_post', block_id: 'b', value, type: 'button', action_ts: '1' }], response_url: `${fake.url}/actions/U0ALICE/${seen}`,
    })
    const posts = await waitFor(() => { const all = fake.of('chat.postMessage').filter((c) => isAnswer(c.args)); return all.length >= 2 ? all : null }, { timeoutMs: 10_000 })
    expect(posts![0]!.refused).toBe('msg_blocks_too_long')
    const posted = JSON.parse(posts![1]!.args.blocks!) as any[]
    expect(posted.map((b) => b.type)).toEqual(['context', 'rich_text'])
    expect(posted[0].elements[0].text).toContain('Asked by alice.slack')
    expect(posted[1].elements[0].elements).toEqual([{ type: 'text', text: 'Refused once, then plain.' }])
    expect(posts![1]!.args.thread_ts).toBe(root)
    expect(await waitFor(() => fake.responses.slice(seen).some((r) => r.body.text === 'Posted to the thread.'))).toBe(true)
    expect(h.ctx.db.query('SELECT state FROM slack_requests WHERE id = ?').get(value)).toEqual({ state: 'posted' })
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

  test('a DM answer refused for its blocks goes again as plain text; that one timing out after reaching Slack is found by the retry, not posted twice', async () => {
    const ts = nextTs()
    const isAnswer = (a: Record<string, string>) => a.channel === 'D0ALICE4' && (a.blocks ?? '').includes('after a refusal')
    const answers = () => fake.of('chat.postMessage').filter((c) => isAnswer(c.args))
    const row = () => h.ctx.db.query("SELECT * FROM slack_requests WHERE channel_id = 'D0ALICE4'").get() as { attempts: number; state: string; not_before: string | null; progress_ts: string | null } | null
    const retryUntil = async (done: () => boolean) => {
      const end = Date.now() + 60_000
      while (!done() && Date.now() < end) {
        const nb = row()?.not_before
        if (nb && Date.parse(nb) > Date.now() + skew) skew = Date.parse(nb) - Date.now() + 1000
        await waitFor(done, { timeoutMs: 1000 })
      }
      return done()
    }
    try {
      // the blocks are refused; the plain one reaches Slack, but Slack's answer to it never comes back
      fake.failNext['chat.postMessage'] = [{ error: 'msg_blocks_too_long', match: isAnswer }, { hang: true, match: isAnswer }]
      fake.event({ type: 'message', channel_type: 'im', user: 'U0ALICE', text: say('**Plain** after a refusal.'), ts, channel: 'D0ALICE4', event_ts: ts })
      expect(await waitFor(() => (row()?.attempts ?? 0) > 0 && row()?.state === 'waiting', { timeoutMs: 30_000 })).toBe(true)
      expect(answers().map((c) => c.refused ?? 'reached')).toEqual(['msg_blocks_too_long', 'reached'])
      expect((JSON.parse(answers()[1]!.args.blocks!) as any[])[0].elements[0].elements).toEqual([{ type: 'text', text: 'Plain after a refusal.' }])
      const progress = row()!.progress_ts
      // tried again: the thread has it (the same notification text), so the working message goes and nothing is posted
      expect(await retryUntil(() => fake.of('chat.delete').some((c) => c.args.ts === progress))).toBe(true)
      expect(answers().length).toBe(2)
      expect(row()!.state).toBe('delivered')
    } finally { skew = 0; delete fake.failNext['chat.postMessage'] }
  })

  test('an answer\'s link to a page of the app opens at the team\'s address in Slack', async () => {
    mention('U0ALICE', say('[shared](/files/view?path=shared) 폴더는 지금 비어 있어요.'), { channel: 'C0LINKS' })
    const a = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => c.args.channel === 'C0LINKS' && blocksOf(c).includes('폴더는')), { timeoutMs: 30_000 })
    expect((JSON.parse(a!.args.blocks!) as any[])[0].elements[0].elements).toEqual([{ type: 'link', url: `${h.url}/files/view?path=shared`, text: 'shared' }, { type: 'text', text: ' 폴더는 지금 비어 있어요.' }])
    expect(blocksOf(a!)).not.toContain('[shared](')
    expect(a!.args.text).toBe('shared 폴더는 지금 비어 있어요.')
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
    const shown = (JSON.parse(answer!.args.blocks!) as any[]).find((b) => b.type === 'rich_text').elements[0].elements
    expect(shown).toEqual([{ type: 'text', text: 'Hello from the DM. <!here> https://bank.example (' }, { type: 'link', url: 'https://evil.example', text: 'evil.example' }, { type: 'text', text: ')' }])
    expect(JSON.stringify(shown)).not.toMatch(/"type":"(broadcast|user|channel)"/)
    expect(await waitFor(() => fake.of('chat.delete').some((c) => c.args.channel === 'D0ALICE'))).toBe(true)
    // the bot's own messages and edits in the DM are not questions
    fake.event({ type: 'message', channel_type: 'im', user: 'U0BOT', bot_id: 'B0BOT', text: 'Working on it…', ts: nextTs(), channel: 'D0ALICE' })
    fake.event({ type: 'message', channel_type: 'im', subtype: 'message_changed', user: 'U0ALICE', text: 'x', ts: nextTs(), channel: 'D0ALICE' })
    await Bun.sleep(200)
    expect((h.ctx.db.query("SELECT count(*) n FROM slack_threads WHERE channel_id = 'D0ALICE'").get() as { n: number }).n).toBe(1)
  })

  test('bold before a Korean particle and a file link arrive as rich text with a plain notification; blocks Slack refuses are sent again as plain text', async () => {
    const md = '**하나뿐**이에요. [budget-2027.txt](/files/view?path=groups%2Facme%2Fbudget-2027.txt)를 보세요.'
    const isAnswer = (a: Record<string, string>) => a.channel === 'D0ALICE3' && (a.blocks ?? '').includes('하나뿐')
    fake.failNext['chat.postMessage'] = { error: 'msg_blocks_too_long', match: isAnswer }
    const ts = nextTs()
    fake.event({ type: 'message', channel_type: 'im', user: 'U0ALICE', text: say(md), ts, channel: 'D0ALICE3', event_ts: ts })
    const tries = await waitFor(() => { const all = fake.of('chat.postMessage').filter((c) => isAnswer(c.args)); return all.length >= 2 ? all : null }, { timeoutMs: 30_000 })
    const [refused, again] = tries!
    expect((JSON.parse(refused!.args.blocks!) as any[])[0]).toEqual({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
      { type: 'text', text: '하나뿐', style: { bold: true } }, { type: 'text', text: '이에요. ' },
      { type: 'link', url: `${h.url}/files/view?path=groups%2Facme%2Fbudget-2027.txt`, text: 'budget-2027.txt' }, { type: 'text', text: '를 보세요.' },
    ] }] })
    expect(refused!.args.text).toBe('하나뿐이에요. budget-2027.txt를 보세요.')
    expect((JSON.parse(again!.args.blocks!) as any[])[0]).toEqual({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '하나뿐이에요. budget-2027.txt를 보세요.' }] }] })
    expect(again!.args.text).toBe(refused!.args.text)
    expect(fake.of('chat.postMessage').filter((c) => isAnswer(c.args)).length).toBe(2)
  })

  test('the same event id, or the same message as another event, runs once', async () => {
    const before = slackTurns()
    const ts = nextTs()
    const ev = { type: 'app_mention', user: 'U0ALICE', text: `<@U0BOT> ${say('once')}`, ts, channel: C, event_ts: ts }
    fake.event(ev, { eventId: 'EvSAME0001' })
    fake.event(ev, { eventId: 'EvSAME0001', retry: 1 })
    fake.event(ev, { eventId: 'EvOTHER001' })
    // its own answer (an earlier test's answer has "once" in it too): else it lands in the next test's quiet window
    await waitFor(() => ephemeralsTo('U0ALICE').some((c) => c.args.channel === C && c.args.text === 'once'), { timeoutMs: 30_000 })
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

describe('"Post to channel" checks what the answer used, against the whole team', () => {
  // alice is in marketing: groups/marketing is hers, erin's and the admins', not bob's; shared/ is everyone's
  const read = (file_path: string) => `@fake ${JSON.stringify({ tool: 'read', args: { file_path } })}`
  let n = 0
  /** a question in its own channel; the request id the answer's button carries */
  async function ask(lines: string[], text: string): Promise<{ id: string; channel: string }> {
    const channel = `C0CHECK${++n}`
    mention('U0ALICE', [...lines, say(text)].join('\n'), { channel })
    const a = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => c.args.channel === channel && blocksOf(c).includes(text) && blocksOf(c).includes('trina_post')), { timeoutMs: 30_000 })
    return { id: (JSON.parse(a!.args.blocks!) as any[]).find((b) => b.type === 'actions').elements[0].value as string, channel }
  }
  let tag = 0
  /** press a button of the asker's ephemeral message; Slack's answer through its response URL */
  async function press(action: string, value: string, channel: string, user = 'U0ALICE') {
    const path = `/actions/check-${++tag}`
    fake.action({ type: 'block_actions', api_app_id: 'A0APP', user: { id: user, team_id: 'T0ACME' }, team: { id: 'T0ACME' },
      container: { type: 'message', channel_id: channel, is_ephemeral: true }, actions: [{ action_id: action, value, type: 'button' }], response_url: `${fake.url}${path}` })
    const r = await waitFor(() => fake.responses.find((x) => x.path === path), { timeoutMs: 15_000 })
    return r!.body as { text: string; replace_original?: boolean; blocks?: any[] }
  }
  const postsTo = (channel: string) => fake.of('chat.postMessage').filter((c) => c.args.channel === channel)
  const buttonsOf = (body: { blocks?: any[] }) => (body.blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements) as { action_id: string; value: string }[]
  const stateOf = (id: string) => (h.ctx.db.query('SELECT state FROM slack_requests WHERE id = ?').get(id) as { state: string }).state
  const chatOf = (id: string) => (h.ctx.db.query('SELECT chat_id FROM slack_requests WHERE id = ?').get(id) as { chat_id: string }).chat_id

  test('an answer from what the whole team reads is posted at once, as before', async () => {
    const q = await ask([read('shared/glossary.md')], 'From the glossary.')
    // it did read the file (the check has something to look at)
    expect((h.ctx.db.query("SELECT path FROM message_sources s JOIN slack_requests r ON r.message_id = s.message_id WHERE r.id = ?").all(q.id) as { path: string }[]).map((s) => s.path)).toContain('shared/glossary.md')
    const body = await press('trina_post', q.id, q.channel)
    expect(body.text).toBe('Posted to the thread.')
    expect(postsTo(q.channel).length).toBe(1)
    expect(stateOf(q.id)).toBe('posted')
  })

  test('an answer from a group folder: a notice to the asker naming the folder, nothing posted; Cancel keeps it to them', async () => {
    const q = await ask([read('groups/marketing/campaigns/instagram-plan.md')], 'From the marketing plan.')
    const body = await press('trina_post', q.id, q.channel)
    expect(body.replace_original).toBe(true)
    const shown = JSON.stringify(body)
    expect(body.text).toBe('This answer used places not everyone on the team can see: groups/marketing/. Post it to the channel anyway?')
    // plain text, never markup; the folder, not the file; nothing of what is in it, nobody named
    expect(body.blocks![0]).toEqual({ type: 'section', text: { type: 'plain_text', text: body.text, emoji: false } })
    for (const no of ['instagram-plan', 'Target impressions', 'From the marketing plan', 'bob', 'Bob', 'erin']) expect(shown).not.toContain(no)
    // the link to the chat, and the two buttons
    expect(shown).toContain(`${h.url}/c/${chatOf(q.id)}`)
    const [anyway, cancel] = buttonsOf(body)
    expect(anyway).toMatchObject({ action_id: 'trina_post_anyway', text: { text: 'Post anyway' } })
    expect(anyway!.value.startsWith(`${q.id}.`)).toBe(true)
    expect(cancel).toMatchObject({ action_id: 'trina_post_cancel', value: q.id, text: { text: 'Cancel' } })
    expect(postsTo(q.channel)).toEqual([])
    expect(stateOf(q.id)).toBe('delivered')
    // Cancel: the answer back, to the asker only, with its button (pressing it asks again)
    const kept = await press('trina_post_cancel', cancel!.value, q.channel)
    expect(kept.replace_original).toBe(true)
    expect(JSON.stringify(kept.blocks)).toContain('From the marketing plan.')
    expect(JSON.stringify(kept.blocks)).toContain('Only you can see this answer')
    expect(buttonsOf(kept)).toEqual([expect.objectContaining({ action_id: 'trina_post', value: q.id })])
    expect(postsTo(q.channel)).toEqual([])
    expect(stateOf(q.id)).toBe('delivered')
    const again = await press('trina_post', q.id, q.channel)
    expect(again.text).toBe(body.text)
    expect(buttonsOf(again)[0]!.value).toBe(anyway!.value)
    expect(postsTo(q.channel)).toEqual([])
  })

  test('Post anyway posts once, audited as confirmed; replayed or forged values post nothing more', async () => {
    const q = await ask([read('groups/marketing/campaigns/naver-plan.md')], 'Naver plan summary.')
    const notice = await press('trina_post', q.id, q.channel)
    const anyway = buttonsOf(notice).find((b) => b.action_id === 'trina_post_anyway')!.value
    const key = anyway.slice(q.id.length + 1)
    // not the asker: nothing, whatever the value
    expect((await press('trina_post_anyway', anyway, q.channel, 'U0BOB')).text).toMatch(/can no longer be posted/)
    // the request id without the key, a key that is not this notice's, another button carrying the key: no post
    expect((await press('trina_post_anyway', q.id, q.channel)).text).toMatch(/can no longer be posted/)
    expect((await press('trina_post_anyway', `${q.id}.${'A'.repeat(key.length)}`, q.channel)).text).toBe(notice.text)
    expect((await press('trina_post_anyway', `${q.id}.${key}.x`, q.channel)).text).toBe(notice.text)
    expect((await press('trina_post', anyway, q.channel)).text).toMatch(/can no longer be posted/)
    // another request's notice key does not post this one
    const other = await ask([read('groups/marketing/campaigns/email-plan.md')], 'Email plan summary.')
    const otherKey = buttonsOf(await press('trina_post', other.id, other.channel)).find((b) => b.action_id === 'trina_post_anyway')!.value.slice(other.id.length + 1)
    expect((await press('trina_post_anyway', `${q.id}.${otherKey}`, q.channel)).text).toBe(notice.text)
    expect(postsTo(q.channel)).toEqual([])
    // the asker's yes to this notice: posted, once
    expect((await press('trina_post_anyway', anyway, q.channel)).text).toBe('Posted to the thread.')
    const posted = postsTo(q.channel)
    expect(posted.length).toBe(1)
    expect(blocksOf(posted[0]!)).toContain('Naver plan summary.')
    expect(blocksOf(posted[0]!)).toContain('Asked by alice.slack')
    expect(stateOf(q.id)).toBe('posted')
    const audits = (h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.posted' AND target = ?").all(chatOf(q.id)) as { detail: string }[]).map((a) => JSON.parse(a.detail))
    expect(audits).toEqual([{ channel: q.channel, confirmed: true }])
    // the same yes again, the first button again, Cancel after it: already posted, nothing more
    expect((await press('trina_post_anyway', anyway, q.channel)).text).toMatch(/already posted/)
    expect((await press('trina_post', q.id, q.channel)).text).toMatch(/already posted/)
    expect((await press('trina_post_cancel', q.id, q.channel)).text).toMatch(/already posted/)
    expect(postsTo(q.channel).length).toBe(1)
  })

  test('Post anyway asks Slack again: a channel shared since, or one Slack says nothing about, gets nothing', async () => {
    for (const [list, said] of [[fake.sharedChannels, 'shared with another organization'], [fake.unknownChannels, 'did not say whether']] as const) {
      const q = await ask([read('groups/marketing/brand-guidelines.docx')], `Brand summary ${said}.`)
      const anyway = buttonsOf(await press('trina_post', q.id, q.channel)).find((b) => b.action_id === 'trina_post_anyway')!.value
      list.add(q.channel)
      expect((await press('trina_post_anyway', anyway, q.channel)).text).toContain(said)
      expect(postsTo(q.channel)).toEqual([])
      expect(stateOf(q.id)).toBe('delivered')
    }
  })

  test('a team connection everyone may use, a personal connection, the browser and memories are not team-wide', async () => {
    const q = await ask([], 'Nothing read.')
    const chat = chatOf(q.id)
    const db = h.ctx.db
    const now = new Date().toISOString()
    db.query("INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, created_at, updated_at) VALUES ('int-crm', 'team', NULL, 'dana', 'mcp', 'Acme CRM', 'acme-crm', 'https://crm.acme.example/mcp', 'none', 'connected', ?, ?)").run(now, now)
    db.query("INSERT INTO integration_access (integration_id, subject_type, subject_id) VALUES ('int-crm', 'everyone', '')").run()
    const scope = (sources: unknown[]) => db.query('UPDATE chats SET session_read_scope = ? WHERE id = ?').run(JSON.stringify({ sources, v: 2, unlisted: [] }), chat)
    try {
      scope([{ type: 'integration', id: 'int-crm' }])
      expect((await press('trina_post', q.id, q.channel)).text).toBe('This answer used places not everyone on the team can see: Acme CRM. Post it to the channel anyway?')
      scope([{ type: 'user', id: 'alice', via: 'connection' }, { type: 'user', id: 'alice', via: 'browser' }])
      expect((await press('trina_post', q.id, q.channel)).text).toBe('This answer used places not everyone on the team can see: the in-app browser, your personal connections. Post it to the channel anyway?')
      scope([])
      db.query("INSERT INTO memories (id, user_id, text, source, created_at) VALUES ('mem-slack', 'alice', 'MEMORY-CANARY likes tea', 'user', '2020-01-01T00:00:00.000Z')").run()
      const m = await press('trina_post', q.id, q.channel)
      expect(m.text).toBe('This answer used places not everyone on the team can see: your memories. Post it to the channel anyway?')
      expect(JSON.stringify(m)).not.toContain('MEMORY-CANARY')
      expect(postsTo(q.channel)).toEqual([])
      // in Korean too (the asker's language)
      db.query("UPDATE users SET locale = 'ko' WHERE id = 'alice'").run()
      expect((await press('trina_post', q.id, q.channel)).text).toBe('이 답에는 팀 사람 모두가 볼 수는 없는 곳의 내용이 들어 있어요: 내 메모리. 그래도 채널에 올릴까요?')
    } finally {
      db.query("UPDATE users SET locale = 'en' WHERE id = 'alice'").run()
      db.query("DELETE FROM memories WHERE id = 'mem-slack'").run()
      db.query("DELETE FROM integrations WHERE id = 'int-crm'").run()
    }
    // nothing narrower left: posted at once
    scope([])
    expect((await press('trina_post', q.id, q.channel)).text).toBe('Posted to the thread.')
  })

  test('file names a listing or a glob showed count like reads (a Slack chat records them, as a room session does)', async () => {
    const tool = (name: string, args: Record<string, string>) => `@fake ${JSON.stringify({ tool: name, args, sayResult: true })}`
    const notice = 'This answer used places not everyone on the team can see: groups/marketing/. Post it to the channel anyway?'
    const listed = await ask([tool('list', { path: 'groups/marketing/campaigns' })], 'Listed the campaigns.')
    expect(ephemeralsTo('U0ALICE').some((c) => c.args.channel === listed.channel && blocksOf(c).includes('instagram-plan.md'))).toBe(true)
    expect((await press('trina_post', listed.id, listed.channel)).text).toBe(notice)
    const globbed = await ask([tool('glob', { pattern: '**/*.md', path: 'groups/marketing' })], 'Globbed marketing.')
    expect((await press('trina_post', globbed.id, globbed.channel)).text).toBe(notice)
    // the sub-folders a listing showed are names: shared/ shows none of marketing's
    const shared = await ask([tool('list', { path: 'shared' })], 'Listed shared.')
    expect((await press('trina_post', shared.id, shared.channel)).text).toBe('Posted to the thread.')
    for (const q of [listed, globbed]) expect(postsTo(q.channel)).toEqual([])
  })

  test('a key from before something changed (a new member) shows the notice again; an answer not all known says "other material"', async () => {
    const q = await ask([read('groups/marketing/campaigns/instagram-plan.md')], 'Before the new member.')
    const notice = await press('trina_post', q.id, q.channel)
    const anyway = buttonsOf(notice).find((b) => b.action_id === 'trina_post_anyway')!.value
    const db = h.ctx.db
    db.query("INSERT INTO users (id, username, name, role) VALUES ('newbie', 'newbie', 'New Member', 'member')").run()
    try {
      const again = await press('trina_post_anyway', anyway, q.channel)
      expect(again.text).toBe(notice.text)
      const fresh = buttonsOf(again).find((b) => b.action_id === 'trina_post_anyway')!.value
      expect(fresh).not.toBe(anyway)
      expect(postsTo(q.channel)).toEqual([])
      expect((await press('trina_post_anyway', fresh, q.channel)).text).toBe('Posted to the thread.')
    } finally { db.query("DELETE FROM users WHERE id = 'newbie'").run() }
    // an answer that ran dev environment commands: what it read there is not known
    const u = await ask([], 'Ran a command.')
    db.query(`UPDATE messages SET steps = '[{"id":"s1","kind":"tool","tool":"box_shell","label":"ls","status":"ok"}]' WHERE id = (SELECT message_id FROM slack_requests WHERE id = ?)`).run(u.id)
    expect((await press('trina_post', u.id, u.channel)).text).toBe('This answer used places not everyone on the team can see: other material. Post it to the channel anyway?')
  })

  test('nobody else on the team: the team folder posts at once, the asker\'s own folder still asks', async () => {
    const db = h.ctx.db
    const others = (db.query("SELECT id FROM users WHERE status = 'active' AND id <> 'alice'").all() as { id: string }[]).map((u) => u.id)
    const team = await ask([read('shared/glossary.md')], 'Alone, shared.')
    const own = await ask([read('users/alice/todo.md')], 'Alone, my todo.')
    db.query("UPDATE users SET status = 'disabled' WHERE status = 'active' AND id <> 'alice'").run()
    try {
      expect((await press('trina_post', own.id, own.channel)).text).toBe('This answer used places not everyone on the team can see: your folder. Post it to the channel anyway?')
      expect((await press('trina_post', team.id, team.channel)).text).toBe('Posted to the thread.')
    } finally { for (const id of others) db.query("UPDATE users SET status = 'active' WHERE id = ?").run(id) }
    expect(postsTo(own.channel)).toEqual([])
  })

  test('Cancel for a Slack account unlinked meanwhile sends nothing; a confidential conversation is never posted', async () => {
    const db = h.ctx.db
    const q = await ask([read('groups/marketing/campaigns/instagram-plan.md')], 'Unlinked before cancel.')
    const notice = await press('trina_post', q.id, q.channel)
    const anyway = buttonsOf(notice).find((b) => b.action_id === 'trina_post_anyway')!.value
    const link = db.query("SELECT * FROM slack_links WHERE user_id = 'alice'").get() as Record<string, string>
    db.query("DELETE FROM slack_links WHERE user_id = 'alice'").run()
    try {
      const kept = await press('trina_post_cancel', q.id, q.channel)
      expect(kept.text).toMatch(/no longer connected/)
      expect(JSON.stringify(kept)).not.toContain('Unlinked before cancel.')
      expect((await press('trina_post_anyway', anyway, q.channel)).text).toMatch(/no longer connected/)
    } finally {
      db.query('INSERT INTO slack_links (id, user_id, team_id, enterprise_id, slack_user_id, slack_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(link.id!, 'alice', link.team_id!, link.enterprise_id!, link.slack_user_id!, link.slack_name!, link.created_at!)
    }
    // a 1A conversation: refused, before or after the notice; the answer stays, to the asker, with the reason and no
    // button, and a later answer of that conversation comes without one
    const confidential = 'This is a confidential conversation, so its answers cannot be posted to the channel.'
    db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chatOf(q.id))
    try {
      for (const [action, value] of [['trina_post', q.id], ['trina_post_anyway', anyway]] as const) {
        const r = await press(action, value, q.channel)
        expect(r.text).toBe('Unlinked before cancel.')
        expect(JSON.stringify(r.blocks)).toContain(confidential)
        expect(buttonsOf(r)).toEqual([])
      }
      const root = (h.ctx.db.query('SELECT thread_ts FROM slack_requests WHERE id = ?').get(q.id) as { thread_ts: string }).thread_ts
      mention('U0ALICE', say('Confidential follow-up.'), { channel: q.channel, thread: root })
      const later = await waitFor(() => ephemeralsTo('U0ALICE').find((c) => c.args.channel === q.channel && blocksOf(c).includes('Confidential follow-up.')), { timeoutMs: 30_000 })
      expect(blocksOf(later!)).toContain(confidential)
      expect(blocksOf(later!)).not.toContain('trina_post')
    } finally { db.query('DELETE FROM safe_ops_chats WHERE chat_id = ?').run(chatOf(q.id)) }
    expect(postsTo(q.channel)).toEqual([])
    expect(stateOf(q.id)).toBe('delivered')
  })

  test('an answer that read a room with an old answer hidden from someone is never posted, not even after the notice', async () => {
    const db = h.ctx.db
    const rooms = roomsOf(h.ctx)
    const all = rooms.list('alice').find((r) => r.kind === 'all')!.id
    const m = rooms.send('alice', all, { body: 'Hello, everyone.', mentions: [], fileIds: [], clientMessageId: 'cm-slack-hidden-1' })
    expect(m.seq).toBeGreaterThan(0)
    const q = await ask([], 'Read the room.')
    db.query('UPDATE chats SET session_read_scope = ? WHERE id = ?').run(JSON.stringify({ sources: [{ type: 'room', id: all, fromSeq: m.seq }], v: 2, unlisted: [] }), chatOf(q.id))
    db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(all, 'bob', m.id, m.seq)
    try {
      const r = await press('trina_post', q.id, q.channel)
      expect(r.text).toBe('Read the room.')
      expect(JSON.stringify(r.blocks)).toContain('This answer cannot be posted: it used an earlier answer in a room that some people on the team cannot see.')
      expect(JSON.stringify(r)).not.toContain('bob')
      expect(buttonsOf(r)).toEqual([])
    } finally { db.query('DELETE FROM room_hidden_answers WHERE message_id = ?').run(m.id) }
    expect(postsTo(q.channel)).toEqual([])
    // nothing hidden any more: every member sees that room from there on, so it is posted at once
    expect((await press('trina_post', q.id, q.channel)).text).toBe('Posted to the thread.')
  })

  test('in a DM nothing changes: the answer comes in the thread, no button, no notice', async () => {
    const ts = nextTs()
    fake.event({ type: 'message', channel_type: 'im', user: 'U0ALICE', text: `${read('groups/marketing/campaigns/instagram-plan.md')}\n${say('DM marketing answer.')}`, ts, channel: 'D0CHECK', event_ts: ts })
    const a = await waitFor(() => fake.of('chat.postMessage').find((c) => c.args.channel === 'D0CHECK' && blocksOf(c).includes('DM marketing answer.')), { timeoutMs: 30_000 })
    expect(blocksOf(a!)).not.toContain('trina_post')
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

  test('a 200,000-character line is read in one pass: under 2 s on a busy runner (the quadratic version took about a minute), whatever markers it has', () => {
    const lines = {
      unpaired: '*a _b ~~c `d **e [f ***g ``h '.repeat(7_200),
      pairs: '**하나뿐**이에요 *b* ~~c~~ `d` [e](https://acme.example/e) '.repeat(4_000),
      heading: '# a' + ' '.repeat(200_000) + 'b',
      code: '` ' + 'a'.repeat(200_000) + '`',
      address: 'https://acme.example/' + ')'.repeat(200_000),
    }
    for (const [name, line] of Object.entries(lines)) {
      expect(line.length).toBeGreaterThanOrEqual(200_000)
      const t0 = performance.now()
      const r = slackAnswer(line, o, 4)
      const ms = performance.now() - t0
      expect(r.blocks.length).toBeGreaterThan(0)
      expect({ name, fast: ms < 2_000 }).toEqual({ name, fast: true })
    }
  })

  test('Slack markup to the question', () => {
    expect(questionText('<@U0BOT> look at <https://acme.example/a?b=1&amp;c=2|the doc> with <@U0BOB|bob> in <#C1|general> &lt;now&gt;', 'U0BOT'))
      .toBe('look at the doc (https://acme.example/a?b=1&c=2) with @bob in #general <now>')
  })

  // Answers go to Slack as rich text (rich-text.ts): styles are fields, so nothing depends on Slack's mrkdwn rule that
  // a closing `*` needs a space or punctuation after it (which broke bold before a Korean particle).
  const o = 'https://team.acme.example'
  const one = (md: string, origin: string | null = o) => { const els = richText(md, origin); expect(els.length).toBe(1); return (els[0] as { elements: unknown[] }).elements }
  const t = (text: string, style?: Record<string, true>): any => ({ type: 'text', text, ...(style ? { style } : {}) })
  const a = (url: string, text?: string, style?: Record<string, true>): any => ({ type: 'link', url, ...(text !== undefined ? { text } : {}), ...(style ? { style } : {}) })

  test('bold, italic, strikethrough and code right before Korean particles stay styled, no markers left', () => {
    expect(one('**하나뿐**이에요')).toEqual([t('하나뿐', { bold: true }), t('이에요')])
    expect(one('*기울임*이고 _이것도_예요')).toEqual([t('기울임', { italic: true }), t('이고 '), t('이것도', { italic: true }), t('예요')])
    expect(one('~~취소~~됐고 `npm run build`를 했어요')).toEqual([t('취소', { strike: true }), t('됐고 '), t('npm run build', { code: true }), t('를 했어요')])
    expect(one('***둘 다***예요 **"인용"**이에요')).toEqual([t('둘 다', { bold: true, italic: true }), t('예요 '), t('"인용"', { bold: true }), t('이에요')])
    expect(plainOf(richText('**하나뿐**이에요'))).toBe('하나뿐이에요')
    // no invisible characters anywhere (a zero-width space would be copied along with the text)
    expect(JSON.stringify(richText('**하나뿐**이에요 *기울임*이고 ~~취소~~됐고 `코드`예요'))).not.toMatch(/[​-‍⁠﻿]/)
  })

  test('mixed Korean and English; markers that do not pair, snake_case and arithmetic stay text', () => {
    expect(one('**Trina AX**는 *team* 단위로 동작해요. See [the docs](https://acme.example/docs) for **more**.')).toEqual([
      t('Trina AX', { bold: true }), t('는 '), t('team', { italic: true }), t(' 단위로 동작해요. See '), a('https://acme.example/docs', 'the docs'), t(' (acme.example) for '), t('more', { bold: true }), t('.'),
    ])
    expect(one('file_name_here 와 2 * 3 * 4, **안 닫힘, 1~3일, \\*별표\\*')).toEqual([t('file_name_here 와 2 * 3 * 4, **안 닫힘, 1~3일, *별표*')])
  })

  test('a file link of the app shows its name only; any other link shows its host, unless its text names that host', () => {
    const path = '/files/view?path=groups%2F%EC%9E%AC%EB%AC%B4%2Fbudget-2027.txt'
    expect(one(`[budget-2027.txt](${path})를 열어 보세요.`)).toEqual([a(o + path, 'budget-2027.txt'), t('를 열어 보세요.')])
    expect(JSON.stringify(richText(`[budget-2027.txt](${path})`, o))).not.toContain('(https://')
    expect(plainOf(richText(`[budget-2027.txt](${path})를 열어 보세요.`, o))).toBe('budget-2027.txt를 열어 보세요.')
    // an answer can carry words from a page or a file the AI read: a link's text is no proof of where it goes
    const evil = 'https://evil.example/login'
    for (const label of ['급여명세서.pdf', 'Log in at bank.example', 'bank.example 로그인', '토스.com', 'budget-2027.txt']) {
      expect(one(`[${label}](${evil})`)).toEqual([a(evil, label), t(' (evil.example)')])
    }
    expect(plainOf(richText(`[급여명세서.pdf](${evil})`, o))).toBe('급여명세서.pdf (evil.example)')
    // a text that names another address is not the link: the host is ("bank.example." with its sentence's full stop too)
    expect(one(`[bank.example.](${evil})`)).toEqual([t('bank.example. ('), a(evil, 'evil.example'), t(')')])
    expect(one('[https://bank.example](https://evil.example)')).toEqual([t('https://bank.example ('), a('https://evil.example', 'evil.example'), t(')')])
    expect(one(`[bank.example/login](${evil})`)).toEqual([t('bank.example/login ('), a(evil, 'evil.example'), t(')')])
    // a look-alike letter: the host as Slack shows it, in punycode
    const lookalike = new URL('https://аpple.example/login').hostname
    expect(lookalike).toStartWith('xn--')
    expect(one('[apple.example](https://аpple.example/login)')).toEqual([t('apple.example ('), a('https://аpple.example/login', lookalike), t(')')])
    // the text names the link's own host: nothing more; another site's file: its host
    expect(one('[acme.example](https://www.acme.example/refunds) [https://acme.example/docs](https://acme.example/docs)')).toEqual([
      a('https://www.acme.example/refunds', 'acme.example'), t(' '), a('https://acme.example/docs', 'https://acme.example/docs'),
    ])
    expect(one('[report.pdf](https://files.acme.example/r.pdf)')).toEqual([a('https://files.acme.example/r.pdf', 'report.pdf'), t(' (files.acme.example)')])
    // the team's address written out is the app's own too
    expect(one(`[budget.txt](${o}/files/view?path=b)`)).toEqual([a(`${o}/files/view?path=b`, 'budget.txt')])
    for (const f of ['budget-2027.txt', '보고서.hwpx', 'Q3 결산.xlsx', 'notes.md', 'setup.zip']) expect(isWebAddress(f)).toBe(false)
    for (const w of ['https://bank.example', 'www.bank.example', 'bank.example', 'bank.example/login', '10.0.0.1', 'files.acme.example:8443']) expect(isWebAddress(w)).toBe(true)
  })

  test('bold inside and around links; the app\'s own links open at the team\'s address; other kinds stay as written', () => {
    expect(one('[**budget-2027.txt**](/files/view?path=a) 와 **[보고서](https://acme.example/r)**를 [**굵게** 링크](https://acme.example/b)')).toEqual([
      a(o + '/files/view?path=a', 'budget-2027.txt', { bold: true }), t(' 와 '), a('https://acme.example/r', '보고서', { bold: true }), t(' (acme.example)', { bold: true }), t('를 '),
      a('https://acme.example/b', '굵게', { bold: true }), a('https://acme.example/b', ' 링크'), t(' (acme.example)'),
    ])
    expect(one('[`budget`](/files/view?path=b)')).toEqual([a(o + '/files/view?path=b', 'budget')])
    // & < > need no escaping in rich text: the label, the address and the text around are as written
    expect(one('a < b & [x<y & z>](/files/view?path=a&b=c) >')).toEqual([t('a < b & '), a(o + '/files/view?path=a&b=c', 'x<y & z>'), t(' >')])
    // no team address (or one that is not one): the text alone
    expect(one('[shared](/files/view?path=shared) 폴더', null)).toEqual([t('shared 폴더')])
    expect(one('[shared](/x)', 'javascript:alert(1)')).toEqual([t('shared')])
    // a protocol-relative link or another scheme: as written, no link
    expect(one('[x](//evil.example/p) [m](mailto:a@acme.example) [j](javascript:alert(1))')).toEqual([t('[x](//evil.example/p) [m](mailto:a@acme.example) [j](javascript:alert(1))')])
    // bare and <> addresses are links; Hangul and punctuation after them are not part of them
    expect(one('https://acme.example/a_(b)에서 (https://acme.example/x). <https://acme.example/y>')).toEqual([
      a('https://acme.example/a_(b)'), t('에서 ('), a('https://acme.example/x'), t('). '), a('https://acme.example/y'),
    ])
  })

  test('lists with bold, nested and numbered; headings, quotes, code; nothing mentions anyone', () => {
    const els = richText('## 요약\n- **하나**: 첫째\n- 둘째 **굵게**예요\n  - 안쪽 *기울임*\n    이어지는 줄\n1. 번호\n2. **둘**\n\n3. 셋\n\n끝 문단', o)
    expect(els).toEqual([
      { type: 'rich_text_section', elements: [t('요약', { bold: true })] },
      { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [
        { type: 'rich_text_section', elements: [t('하나', { bold: true }), t(': 첫째')] },
        { type: 'rich_text_section', elements: [t('둘째 '), t('굵게', { bold: true }), t('예요')] },
      ] },
      { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [{ type: 'rich_text_section', elements: [t('안쪽 '), t('기울임', { italic: true }), t('\n이어지는 줄')] }] },
      { type: 'rich_text_list', style: 'ordered', indent: 0, elements: [
        { type: 'rich_text_section', elements: [t('번호')] }, { type: 'rich_text_section', elements: [t('둘', { bold: true })] }, { type: 'rich_text_section', elements: [t('셋')] },
      ] },
      { type: 'rich_text_section', elements: [t('끝 문단')] },
    ])
    expect(plainOf(els)).toBe('요약\n• 하나: 첫째\n• 둘째 굵게예요\n  • 안쪽 기울임\n이어지는 줄\n1. 번호\n2. 둘\n3. 셋\n끝 문단')
    // a numbered list that starts later keeps its number
    expect(richText('3. 셋\n4. 넷')[0]).toMatchObject({ type: 'rich_text_list', style: 'ordered', offset: 2 })
    expect(richText('> 인용 **굵게**\n> - 항목\n\n```ts\n**x** [a](/files/view?path=a) <b>\n```\n`[shared](/files/view?path=shared)` 첫 줄\n둘째 줄\n\n셋째', o)).toEqual([
      { type: 'rich_text_quote', elements: [t('인용 '), t('굵게', { bold: true }), t('\n• 항목')] },
      { type: 'rich_text_preformatted', elements: [t('**x** [a](/files/view?path=a) <b>')] },
      { type: 'rich_text_section', elements: [t('[shared](/files/view?path=shared)', { code: true }), t(' 첫 줄\n둘째 줄\n\n셋째')] },
    ])
    expect(one('```npm test```로 확인해요')).toEqual([t('npm test', { code: true }), t('로 확인해요')])
    // Slack's markup in an answer is text: no broadcast, user or channel element, nothing escaped in the blocks
    expect(one('<!channel> <@U1> <#C1> & a < b')).toEqual([t('<!channel> <@U1> <#C1> & a < b')])
  })

  test('the notification text is plain: no markers, links as their text, Slack\'s &, <, > written out, about 300 characters', () => {
    const r = slackAnswer('**하나뿐**이에요. [budget-2027.txt](/files/view?path=x) 참고 <!here>\n- **항목** ~~옛~~', o, 4)
    expect(r.text).toBe('하나뿐이에요. budget-2027.txt 참고 &lt;!here&gt;\n• 항목 옛')
    expect(slackAnswer('가'.repeat(1000), o, 4).text.length).toBeLessThanOrEqual(302)
    // the plain version for blocks Slack refuses: one block, one text, no markers
    expect(r.plainBlocks).toEqual([{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [t('하나뿐이에요. budget-2027.txt 참고 <!here>\n• 항목 옛')] }] }])
    // a sentence of ours is not read as Markdown
    expect(slackAnswer('Could not answer. *stars* stay.', o, 1, false).blocks[0]!.elements).toEqual([{ type: 'rich_text_section', elements: [t('Could not answer. *stars* stay.')] }])
  })

  test('a long answer: blocks of at most 2,900 characters, at most `max`, the last ends with …; a list goes on with its numbers', () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i + 1}. 항목 **굵게** ${'가나다 '.repeat(10)}`).join('\n')
    const els = richText(long)
    const whole = plainOf(els)
    const r = richBlocks(els, 4)
    expect(r.cut).toBe(true)
    expect(plainOf(els)).toBe(whole) // the " …" is on the block's copy, not in the answer
    expect(r.blocks.length).toBe(4)
    const chars = (els: unknown) => JSON.stringify(els).match(/"text":"[^"]*"/g)!.reduce((n, x) => n + x.length - 9, 0)
    for (const b of r.blocks) expect(chars(b.elements)).toBeLessThanOrEqual(2900 + 2)
    expect(JSON.stringify(r.blocks.at(-1)!.elements.at(-1))).toContain('…')
    const first = r.blocks[0]!.elements[0] as { elements: unknown[] }
    expect(r.blocks[1]!.elements[0]).toMatchObject({ type: 'rich_text_list', style: 'ordered', offset: first.elements.length })
    // one paragraph longer than a block is cut at a space, never inside a word or a link
    const para = richBlocks(richText(`${'단어 '.repeat(2000)}[끝](https://acme.example/end)`), 10)
    expect(para.cut).toBe(false)
    expect(para.blocks.length).toBe(3)
    expect(JSON.stringify(para.blocks)).not.toContain('"text":""')
    const pieces = para.blocks.map((b) => plainOf(b.elements))
    for (const x of pieces.slice(0, -1)) expect(x.endsWith('단어')).toBe(true)
    for (const x of pieces.slice(1)) expect(x.startsWith('단어')).toBe(true)
    expect((para.blocks.at(-1)!.elements.at(-1) as { elements: unknown[] }).elements.slice(-2)).toEqual([a('https://acme.example/end', '끝'), t(' (acme.example)')])
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
