// The Slack connector with the hosting service's official app (docs/SLACK.md "The official app") against a fake broker
// (tests/lib/fake-slack-broker.ts: signatures, PKCE-bound handoffs, the sealed bot token, the long poll) and the fake
// Slack (tests/lib/fake-slack.ts, the Web API the team server calls itself). "Add to Slack" is offered only while the
// hosting service serves this server, to the owner and admins only; only the browser of the one who pressed it finishes it; Slack must confirm
// the token is of the install's workspace and bot; envelopes from the long poll go through the same workspace and app
// checks as one from our own socket; "Sign in with Slack" through the broker; removed in Slack, a lost token fetched
// again, the broker down or not serving, Remove taking the app off the workspace; the bot token nowhere in logs, rows
// or answers. No real Slack or hosting service is contacted.
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { sealSecret } from '../../web/src/lib/seal'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { slackOf } from '../../server/src/integrations/slack/service'
import { startHarness, type Harness } from '../lib/b-harness'
import { nextTs, startFakeSlack, type FakeSlack } from '../lib/fake-slack'
import { startFakeBroker, type FakeBroker } from '../lib/fake-slack-broker'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
let h: Harness
let fake: FakeSlack
let broker: FakeBroker
const lines: string[] = []
const answers: string[] = []
const handoffs: string[] = []
const team = crypto.generateKeyPairSync('ed25519')
const identity = () => ({ key: team.privateKey, publicKey: (team.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64') })
const C = 'C0GENERAL'

const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
async function call(user: string, method: string, path: string, body?: unknown) {
  const r = await h.req(user, path, json(method, body))
  const text = await r.text()
  answers.push(text)
  let j: any = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, json: j, text }
}
const cfg = () => h.ctx.db.query('SELECT * FROM slack_config WHERE id = 1').get() as Record<string, any> | null
const admin = async () => (await call('dana', 'GET', '/api/admin/slack')).json
/** the browser comes back to a callback of the team server: where it is sent next */
async function open(who: string | null, path: string) {
  const h0 = new URL(path, 'http://x').searchParams.get('handoff')
  if (h0) handoffs.push(h0)
  const r = await h.req(who, path, { redirect: 'manual' })
  expect(r.status).toBe(303)
  return r.headers.get('location')!
}
const outcome = (location: string) => new URL(location, 'http://x').searchParams.get('slack')
/** the owner presses "Add to Slack" and Slack sends the browser back through the broker */
async function add(o: { as?: string } = {}) {
  const started = await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })
  expect(started.status).toBe(200)
  return open(o.as ?? 'dana', broker.slackReturn('install'))
}
function envelope(user: string, o: { team?: string; appId?: string; eventId?: string; ts?: string } = {}) {
  const ts = o.ts ?? nextTs()
  return { type: 'event_callback', team_id: o.team ?? 'T0ACME', api_app_id: o.appId ?? 'A0APP', event_id: o.eventId ?? `Ev${crypto.randomBytes(6).toString('hex')}`, event_time: Math.floor(Date.now() / 1000),
    event: { type: 'app_mention', user, text: '<@U0BOT> hi', ts, channel: C, event_ts: ts } }
}
const ephemeralsTo = (user: string) => fake.of('chat.postEphemeral').filter((c) => c.args.user === user)
const links = () => (h.ctx.db.query('SELECT count(*) n FROM slack_links').get() as { n: number }).n

beforeAll(async () => {
  fake = startFakeSlack()
  fake.users = {
    U0ALICE: { name: 'alice.slack', team_id: 'T0ACME', email: 'alice@acme.example' },
    U0BOB: { name: 'bob.slack', team_id: 'T0ACME', email: 'bob@acme.example' },
    U0ERIN: { name: 'erin.slack', team_id: 'T0ACME', email: 'erin@acme.example' },
    U0FRANK: { name: 'frank.slack', team_id: 'T0ACME' },
    U0GUEST: { name: 'guest', team_id: 'T0OTHER' },
  }
  h = await startHarness({ name: 'c-slack-official', log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) })
  broker = startFakeBroker({ servedKey: identity().publicKey, botToken: fake.botToken, teamOrigin: () => h.url })
  slackOf(h.ctx, { base: fake.url, pollMs: 30, retryMs: 50, timeoutMs: 2000, pollWaitMs: 150, broker: { origin: broker.url, identity } })
})
afterAll(async () => { await h?.close(); fake?.close(); broker?.close() })

describe('Add to Slack (the owner)', () => {
  test('offered only while the hosting service serves this server, to the owner and admins only', async () => {
    broker.serving = false
    expect(await admin()).toMatchObject({ mode: 'own', official: false, tokens: false })
    const refused = await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })
    expect(refused.status).toBe(409)
    expect(refused.json.error.params.reason).toBe('official_off')
    broker.serving = true
    await slackOf(h.ctx).checkBroker()
    expect(await admin()).toMatchObject({ mode: 'own', official: true, tokens: false, state: 'off' })
    expect((await call('alice', 'POST', '/api/admin/slack/official/install', { origin: h.url })).status).toBe(403)
    // a server with its own app saved keeps it: "Add to Slack" is refused until it is removed
    h.ctx.db.query("INSERT INTO slack_config (id, enabled, secret_enc, key_version, mode) VALUES (1, 0, 'sealed', 1, 'own')").run()
    expect((await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })).json.error.params.reason).toBe('own_app_saved')
    // an admin cannot replace the team's own app with it either
    expect((await call('carol', 'POST', '/api/admin/slack/official/install', { origin: h.url })).json.error.params.reason).toBe('own_app_saved')
    h.ctx.db.query('DELETE FROM slack_config').run()
  })

  test('Cancel in the app (or the wait ran out) ends the waiting install: the window left open adds nothing and says so; only this person\'s own (QA TC-1417)', async () => {
    const redeems = broker.of('redeem').length
    await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })
    // another admin's cancel is not this one's
    expect((await call('carol', 'DELETE', '/api/admin/slack/install/flow')).status).toBe(204)
    expect((h.ctx.db.query("SELECT state FROM slack_install_flows WHERE user_id = 'dana' ORDER BY created_at DESC").get() as { state: string }).state).toBe('pending')
    // a member may not
    expect((await call('alice', 'DELETE', '/api/admin/slack/install/flow')).status).toBe(403)
    expect((await call('dana', 'DELETE', '/api/admin/slack/install/flow')).status).toBe(204)
    expect(outcome(await open('dana', broker.slackReturn('install')))).toBe('install_cancelled_here')
    expect(broker.of('redeem').length).toBe(redeems)
    expect(cfg()?.secret_enc ?? null).toBeNull()
    // twice: nothing more; a new press works as before (next test)
    expect((await call('dana', 'DELETE', '/api/admin/slack/install/flow')).status).toBe(204)
  })

  test('only the owner\'s own browser finishes it; no session: sign in first; used once', async () => {
    const started = await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })
    const url = new URL(started.json.authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    const sent = broker.of('install').at(-1)!.body
    expect(sent).toMatchObject({ v: 1 })
    expect(String(sent.returnState)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(String(sent.codeChallenge)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // another person's browser: refused, and the flow is over for everyone
    const back = broker.slackReturn('install')
    expect(outcome(await open('alice', back))).toBe('signin_other_user')
    expect(outcome(await open('dana', back))).toBe('install_expired')
    expect(broker.of('redeem').length).toBe(0)
    // a browser with no session (the desktop app's system browser): sign in, then the fixed return page brings it back
    await call('dana', 'POST', '/api/admin/slack/official/install', { origin: h.url })
    const login = await open(null, broker.slackReturn('install'))
    expect(login).toStartWith('/login?next=')
    const resume = new URL(decodeURIComponent(login.slice('/login?next='.length)), 'http://x')
    expect(resume.pathname).toBe('/slack/signin-return')
    expect(resume.searchParams.get('to')).toBe('install')
    const callback = `/api/integrations/slack/official/callback?${new URLSearchParams({ state: resume.searchParams.get('state')!, handoff: resume.searchParams.get('handoff')! })}`
    expect(await open('dana', callback)).toBe('/admin/connectors/slack?slack=installed')
    // the same return again: used
    expect(outcome(await open('dana', callback))).toBe('install_expired')
    // Slack itself was asked whose token it is
    expect(fake.of('auth.test').at(-1)!.token).toBe(fake.botToken)
    const c = cfg()!
    expect(c).toMatchObject({ mode: 'official', enabled: 1, team_id: 'T0ACME', bot_user_id: 'U0BOT', app_id: 'A0APP', client_id: null, install_id: broker.install!.installId, link_origin: h.url })
    expect(c.secret_enc).not.toContain(fake.botToken)
    const view = await waitFor(async () => { const a = await admin(); return a.state === 'connected' ? a : null })
    expect(view).toMatchObject({ mode: 'official', tokens: true, enabled: true, workspace: { teamId: 'T0ACME', name: 'Acme' }, botName: 'trina-ax', lastError: null, signIn: true })
    // an install without the bot's two reading scopes (as installs from before them): it works, with reading off and
    // "Update Slack permissions" (Add to Slack again) for admins
    expect(view).toMatchObject({ readScopes: 'missing', missingScopes: ['channels:history', 'groups:history'] })
    expect(h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'slack.installed'").all()).toEqual([{ actor_id: 'dana', detail: expect.stringContaining('"via":"official"') }])
  })

  test('the own app\'s tokens are refused while the official app is added', async () => {
    const seal = async (s: string) => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), s, 'slack.token')
    const r = await call('dana', 'PUT', '/api/admin/slack/tokens', { botToken: await seal(fake.botToken), appToken: await seal(fake.appToken), clientId: fake.clientId, clientSecret: await seal(fake.clientSecret) })
    expect(r.status).toBe(409)
    expect(r.json.error.params.reason).toBe('official_saved')
    expect(cfg()!.mode).toBe('official')
  })
})

describe('events from the hosting service go through the same checks', () => {
  test('a question of the installed workspace is handled; another workspace\'s or app\'s goes nowhere; an event id once', async () => {
    const mine = broker.push('events_api', envelope('U0BOB'))
    await waitFor(() => ephemeralsTo('U0BOB').length === 1)
    // the link prompt to the asker only, posted by this server itself with the delivered bot token
    expect(ephemeralsTo('U0BOB')[0]!.token).toBe(fake.botToken)
    // another workspace's envelope, or another app's: nothing, though both are taken
    const other = broker.push('events_api', envelope('U0GUEST', { team: 'T0OTHER' }))
    const otherApp = broker.push('events_api', envelope('U0FRANK', { appId: 'A0OTHERAPP' }))
    // the same event id twice (the broker hands an unacknowledged event out again): once
    const env = envelope('U0ERIN', { eventId: 'Ev0SAMEEVENT1' })
    const one = broker.push('events_api', env), two = broker.push('events_api', env)
    // a button of another workspace
    const press = broker.push('interactive', { type: 'block_actions', api_app_id: 'A0APP', user: { id: 'U0GUEST', team_id: 'T0OTHER' }, team: { id: 'T0OTHER' }, actions: [{ action_id: 'trina_post', value: crypto.randomUUID(), type: 'button' }], response_url: `${fake.url}/actions/other` })
    await waitFor(() => [mine, other, otherApp, one, two, press].every((id) => broker.acks.includes(id)))
    await Bun.sleep(100)
    expect(ephemeralsTo('U0GUEST')).toEqual([])
    expect(ephemeralsTo('U0FRANK')).toEqual([])
    expect(ephemeralsTo('U0ERIN').length).toBe(1)
    expect(fake.responses.filter((r) => r.path === '/actions/other')).toEqual([])
  })
})

describe('Sign in with Slack through the hosting service', () => {
  const start = (who: string) => call(who, 'POST', '/api/slack/signin', {})

  test('links the Slack account the person signed in to; another session, another workspace, no session', async () => {
    expect((await call('alice', 'GET', '/api/slack/me')).json).toMatchObject({ available: true, signIn: true, link: null })
    const started = await start('alice')
    const url = new URL(started.json.authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize')
    expect(url.searchParams.get('team')).toBe('T0ACME')
    broker.signinAs = { slackUserId: 'U0ALICE', slackTeamId: 'T0ACME' }
    expect(await open('alice', broker.slackReturn('signin'))).toBe('/settings/connectors?slack=linked')
    expect(h.ctx.db.query('SELECT user_id, team_id, slack_user_id FROM slack_links').all()).toEqual([{ user_id: 'alice', team_id: 'T0ACME', slack_user_id: 'U0ALICE' }])
    // the Slack account is told which account it now asks as (its DM, with the delivered token)
    expect(fake.of('conversations.open').at(-1)).toMatchObject({ token: fake.botToken, args: { users: 'U0ALICE' } })
    // another person's session: refused
    await start('bob')
    expect(outcome(await open('alice', broker.slackReturn('signin')))).toBe('signin_other_user')
    // signed in to another workspace: the broker says outsider
    await start('bob')
    broker.signinAs = { slackUserId: 'U0GUEST', slackTeamId: 'T0OTHER' }
    expect(outcome(await open('bob', broker.slackReturn('signin')))).toBe('outsider')
    // no session in that browser: sign in first, and the return page brings the handoff back
    await start('bob')
    const login = await open(null, broker.slackReturn('signin'))
    const resume = new URL(decodeURIComponent(login.slice('/login?next='.length)), 'http://x')
    expect(resume.pathname).toBe('/slack/signin-return')
    expect(resume.searchParams.get('handoff')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(resume.searchParams.get('code')).toBeNull()
    broker.signinAs = { slackUserId: 'U0BOB', slackTeamId: 'T0ACME' }
    expect(await open('bob', `/api/integrations/slack/oauth/callback?${new URLSearchParams({ state: resume.searchParams.get('state')!, handoff: resume.searchParams.get('handoff')! })}`)).toBe('/settings/connectors?slack=linked')
    expect(links()).toBe(2)
  })
})

describe('removed, restored and removed by the owner', () => {
  test('removed in Slack: the token is forgotten, the links stay; Add to Slack again keeps them', async () => {
    // the broker forgets the install and tells its owner (the notice names that install)
    const held = broker.install!.installId
    broker.install = null
    const gone = broker.push('lifecycle', { event: 'tokens_revoked', installId: held })
    await waitFor(() => !cfg()!.secret_enc)
    expect(cfg()).toMatchObject({ mode: 'official', install_id: null, last_error: 'removed' })
    expect(await admin()).toMatchObject({ mode: 'official', official: true, tokens: false, state: 'off', lastError: 'removed' })
    expect(links()).toBe(2)
    expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.removed_in_slack'").all()).toEqual([{ detail: '{"reason":"tokens_revoked"}' }])
    // nothing is handled meanwhile
    const before = fake.of('chat.postEphemeral').length
    broker.push('events_api', envelope('U0FRANK'))
    await Bun.sleep(400)
    expect(fake.of('chat.postEphemeral').length).toBe(before)
    expect(outcome(await add())).toBe('installed')
    expect(links()).toBe(2)
    await waitFor(async () => (await admin()).state === 'connected')
    // the stopped feed acknowledged the event it took; handed out again anyway, it does not undo the new install
    expect(broker.acks).toContain(gone)
    broker.push('lifecycle', { event: 'tokens_revoked', installId: held }, gone)
    await waitFor(() => broker.acks.filter((a) => a === gone).length === 2)
    expect(cfg()!.secret_enc).toBeTruthy()
    // a notice without an install, or of another install, removes nothing
    const vague = broker.push('lifecycle', { event: 'removed' }), other = broker.push('lifecycle', { event: 'removed', installId: crypto.randomUUID() })
    await waitFor(() => broker.acks.includes(vague) && broker.acks.includes(other))
    expect(cfg()).toMatchObject({ install_id: broker.install!.installId, last_error: null })
    expect(cfg()!.secret_enc).toBeTruthy()
  })

  test('a token Slack refuses at a post is the same as Slack\'s own "removed"', async () => {
    fake.failNext['chat.postEphemeral'] = { error: 'token_revoked' }
    broker.push('events_api', envelope('U0FRANK'))
    await waitFor(() => !cfg()!.secret_enc)
    expect(cfg()!.last_error).toBe('removed')
    expect(outcome(await add())).toBe('installed')
  })

  test('the hosting service\'s "removed" of the earlier install, queued while the feed was stopped, does not undo the one added again', async () => {
    // a post refused (token_revoked): removed here, the feed stopped; meanwhile the hosting service hears Slack's own
    // app_uninstalled, forgets that install and queues its notice, which nobody takes now
    fake.failNext['chat.postEphemeral'] = { error: 'token_revoked' }
    broker.push('events_api', envelope('U0FRANK'))
    await waitFor(() => !cfg()!.secret_enc)
    const earlier = broker.install!.installId
    broker.install = null
    const stale = broker.push('lifecycle', { event: 'uninstalled', installId: earlier })
    await Bun.sleep(200)
    expect(broker.acks).not.toContain(stale)
    // the owner adds it again: a new install; the new feed's first poll gets the old notice, and it says nothing about it
    expect(outcome(await add())).toBe('installed')
    const fresh = broker.install!.installId
    expect(fresh).not.toBe(earlier)
    await waitFor(() => broker.acks.includes(stale))
    await Bun.sleep(100)
    expect(cfg()).toMatchObject({ mode: 'official', install_id: fresh, last_error: null })
    expect(cfg()!.secret_enc).toBeTruthy()
    await waitFor(async () => (await admin()).state === 'connected')
  })

  test('a token that no longer opens here (a restore on a new machine) is fetched again', async () => {
    h.ctx.db.query("UPDATE slack_config SET secret_enc = 'damaged'").run()
    await waitFor(() => broker.of('token').length > 0)
    await waitFor(() => cfg()!.secret_enc !== 'damaged')
    expect(cfg()).toMatchObject({ mode: 'official', install_id: broker.install!.installId, last_error: null })
  })

  test('the hosting service cannot give this server another workspace\'s bot: Slack is asked, and it is refused', async () => {
    broker.nextInstall = { botUserId: 'U0SOMEONEELSE' }
    expect(outcome(await add())).toBe('install_failed')
    broker.nextInstall = {}
    // the working install was kept (the same install id added again), nothing was replaced
    expect(cfg()).toMatchObject({ mode: 'official', bot_user_id: 'U0BOT' })
    broker.redeemError = 'workspace_taken'
    expect(outcome(await add())).toBe('workspace_taken')
    expect(cfg()!.bot_user_id).toBe('U0BOT')
    // the person who allowed it in Slack is not a workspace admin: the hosting service refuses it; said so here
    broker.redeemError = 'not_workspace_admin'
    expect(outcome(await add())).toBe('not_workspace_admin')
    expect(cfg()!.bot_user_id).toBe('U0BOT')
  })

  test('Slack cannot be asked when the install comes back: kept there (not removed), checked again, then on', async () => {
    expect((await call('dana', 'DELETE', '/api/admin/slack')).status).toBe(200)
    const uninstalls = broker.of('uninstall').length
    // auth.test gets no answer (Slack briefly unreachable)
    fake.failNext['auth.test'] = { hang: true }
    expect(outcome(await add())).toBe('install_pending')
    expect(broker.of('uninstall').length).toBe(uninstalls)
    expect(broker.install).not.toBeNull()
    // checked again shortly: Slack answers, the install is kept and on
    await waitFor(() => !!cfg()?.secret_enc, { timeoutMs: 8000 })
    expect(cfg()).toMatchObject({ mode: 'official', install_id: broker.install!.installId, bot_user_id: 'U0BOT', last_error: null })
    expect(broker.of('token').length).toBeGreaterThan(0)
    expect(broker.of('uninstall').length).toBe(uninstalls)
    await waitFor(async () => (await admin()).state === 'connected')
    // a definite no after the check (another workspace's bot) removes it there
    expect((await call('dana', 'DELETE', '/api/admin/slack')).status).toBe(200)
    fake.failNext['auth.test'] = { hang: true }
    expect(outcome(await add())).toBe('install_pending')
    broker.install = { ...broker.install!, botUserId: 'U0SOMEONEELSE' }
    await waitFor(() => broker.of('uninstall').length === uninstalls + 2, { timeoutMs: 8000 })
    expect(cfg()?.secret_enc ?? null).toBeNull()
    broker.nextInstall = {}
    expect(outcome(await add())).toBe('installed')
    await waitFor(async () => (await admin()).state === 'connected')
    // install flows a day past their time are swept
    h.ctx.db.query("UPDATE slack_install_flows SET expires_at = '2000-01-01T00:00:00.000Z'").run()
    ;(slackOf(h.ctx) as unknown as { sweep(): void }).sweep()
    expect((h.ctx.db.query('SELECT count(*) n FROM slack_install_flows').get() as { n: number }).n).toBe(0)
  })

  test('the hosting service down or not serving: the Slack page says so, and it comes back by itself', async () => {
    broker.serving = 'down'
    await waitFor(async () => (await admin()).lastError === 'broker_unreachable')
    expect((await admin()).state).toBe('error')
    broker.serving = true
    await waitFor(async () => (await admin()).state === 'connected')
    broker.serving = false
    await waitFor(async () => (await admin()).lastError === 'not_served', { timeoutMs: 8000 })
    broker.serving = true
  })

  test('Remove takes the app off the workspace there, then forgets everything here (also when it cannot be reached)', async () => {
    // wait out the not-served pause (a minute of retry steps here: 60 × 50 ms)
    await waitFor(async () => (await admin()).state === 'connected', { timeoutMs: 8000 })
    const removed = await call('dana', 'DELETE', '/api/admin/slack')
    expect(removed.status).toBe(200)
    expect(removed.json).toMatchObject({ mode: 'own', tokens: false, linked: 0 })
    expect(broker.of('uninstall').length).toBeGreaterThan(0)
    expect(cfg()).toBeNull()
    expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.removed'").all().at(-1)).toEqual({ detail: '{"via":"official","slack":"removed"}' })
    expect(outcome(await add())).toBe('installed')
    broker.serving = 'down'
    expect((await call('dana', 'DELETE', '/api/admin/slack')).status).toBe(200)
    expect(cfg()).toBeNull()
    expect(h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'slack.removed'").all().at(-1)).toEqual({ detail: '{"via":"official","slack":"unavailable"}' })
    broker.serving = true
  })

  test('an admin adds it, turns it off and on, and removes it, each audited as them; a member cannot; demoted meanwhile: not added', async () => {
    await waitFor(async () => (await admin()).official === true)
    const actorOf = (action: string) => (h.ctx.db.query('SELECT actor_id FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as { actor_id: string } | null)?.actor_id
    // a member: refused at every step
    for (const [m, p, b] of [['POST', '/api/admin/slack/official/install', { origin: h.url }], ['POST', '/api/admin/slack/enabled', { enabled: false }], ['DELETE', '/api/admin/slack', undefined], ['GET', '/api/admin/slack', undefined]] as const)
      expect((await call('alice', m, p, b)).status).toBe(403)
    // carol (an admin) presses Add to Slack and comes back signed in as herself
    expect((await call('carol', 'POST', '/api/admin/slack/official/install', { origin: h.url })).status).toBe(200)
    expect(outcome(await open('carol', broker.slackReturn('install')))).toBe('installed')
    expect(cfg()).toMatchObject({ mode: 'official', enabled: 1, updated_by: 'carol', team_id: 'T0ACME' })
    expect(actorOf('slack.installed')).toBe('carol')
    const seen = await waitFor(async () => { const r = await call('carol', 'GET', '/api/admin/slack'); return r.json.state === 'connected' ? r : null })
    expect(seen!.json).toMatchObject({ mode: 'official', tokens: true, enabled: true })
    expect(seen!.text).not.toContain(fake.botToken)
    // Turn off, Turn on (Reconnect is Add to Slack again, above)
    expect((await call('carol', 'POST', '/api/admin/slack/enabled', { enabled: false })).json.enabled).toBe(false)
    expect(actorOf('slack.disabled')).toBe('carol')
    expect((await call('carol', 'POST', '/api/admin/slack/enabled', { enabled: true })).json.enabled).toBe(true)
    expect(actorOf('slack.enabled')).toBe('carol')
    // the own app's tokens stay the owner's, also while the official app is added
    const seal = async (x: string) => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), x, 'slack.token')
    expect((await call('carol', 'PUT', '/api/admin/slack/tokens', { botToken: await seal(fake.botToken), appToken: await seal(fake.appToken), clientId: fake.clientId, clientSecret: await seal(fake.clientSecret) })).status).toBe(403)
    // Remove: taken off the workspace there, forgotten here
    const removed = await call('carol', 'DELETE', '/api/admin/slack')
    expect(removed.status).toBe(200)
    expect(cfg()).toBeNull()
    expect(actorOf('slack.removed')).toBe('carol')
    // an admin made a member before the browser came back: not added
    expect((await call('carol', 'POST', '/api/admin/slack/official/install', { origin: h.url })).status).toBe(200)
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
    try { expect(outcome(await open('carol', broker.slackReturn('install')))).toBe('install_failed') } finally { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'carol'").run() }
    expect(cfg()?.secret_enc ?? null).toBeNull()
    // demoted while the install waits for Slack's check: taken off there, not kept here
    const uninstalls = broker.of('uninstall').length
    fake.failNext['auth.test'] = { hang: true }
    expect((await call('carol', 'POST', '/api/admin/slack/official/install', { origin: h.url })).status).toBe(200)
    expect(outcome(await open('carol', broker.slackReturn('install')))).toBe('install_pending')
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
    try { await waitFor(() => broker.of('uninstall').length > uninstalls, { timeoutMs: 8000 }) } finally { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'carol'").run() }
    expect(cfg()?.secret_enc ?? null).toBeNull()
  })

  test('an admin\'s Remove of the official app never deletes an own app the owner saved while the hosting service was asked', async () => {
    broker.nextInstall = {}
    expect(outcome(await add())).toBe('installed')
    const svc = slackOf(h.ctx) as unknown as { broker: { uninstall(): Promise<string> } }
    const uninstall = svc.broker.uninstall
    // the owner's own app lands while the hosting service takes the official one off the workspace
    svc.broker.uninstall = async function (this: unknown) {
      const r = await uninstall.call(svc.broker)
      h.ctx.db.query("UPDATE slack_config SET mode = 'own', install_id = NULL, secret_enc = 'sealed-own', key_version = 1, enabled = 0").run()
      return r
    }
    try {
      const r = await call('carol', 'DELETE', '/api/admin/slack')
      expect(r.status).toBe(409)
      expect(r.json.error.params.reason).toBe('own_app_saved')
      expect(cfg()).toMatchObject({ mode: 'own', secret_enc: 'sealed-own' })
    } finally { svc.broker.uninstall = uninstall }
    h.ctx.db.query('DELETE FROM slack_config').run()
    slackOf(h.ctx).refresh()
  })

  test('the bot token, the handoffs and the verifiers are in no log line, row or answer', async () => {
    const all = lines.join('\n')
    expect(all).not.toContain(fake.botToken)
    for (const x of handoffs) expect(all).not.toContain(x)
    expect(answers.join('\n')).not.toContain(fake.botToken)
    for (const t of ['slack_config', 'slack_install_flows', 'slack_signin_flows', 'audit_log']) expect(JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).not.toContain(fake.botToken)
    expect(all).not.toMatch(/xoxb-/)
  })
})
