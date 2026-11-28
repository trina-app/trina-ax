// A Google app connected for the team through the hosting service's sign-in (the Drive broker with `app`, QA TC-6064,
// TC-6065). Covered: a team sign-in starts with purpose "share" (the hosting service's page words it as the team's,
// not "your own Gmail"); a control plane from before team app sign-ins refuses "share" with an app and the sign-in
// starts again as "personal", the same scopes, and only then (a closed app, app_unavailable, gets no second try); a Google answer without every scope comes back as scope_denied
// ("allow every access"), not "could not reach the hosting service"; Google failing is provider_unavailable; and a
// control plane 502 that Cloudflare turned into its own page is still broker_unavailable (why the contract moved
// provider_error to 503). Fake broker and fake library on 127.0.0.1 only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, PEOPLE, type CApp } from '../lib/c-app'
import { FakeLibrary, sessionRow } from '../lib/fake-google-apps'
import { FakeGoogleDrive } from '../lib/fake-google-drive'
import { FakeDriveBroker } from '../lib/fake-drive-broker'
import { googleAppsOf, type GoogleApps } from '../../server/src/integrations/google-apps/service'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { GOOGLE_USERINFO } from '../../server/src/integrations/google-drive/client'
import { DRIVE_BROKER_ERRORS, DRIVE_BROKER_PATHS, parseDriveBrokerStart } from '../../shared/src/cloud-protocol/drive-broker'

setDefaultTimeout(30_000)

let A: CApp, lib: FakeLibrary, broker: FakeDriveBroker, apps: GoogleApps, n = 0
const browser = (who: string) => ({ userId: who, sessionId: `${who}-session` })

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  A = await makeCApp('gapps-team-broker-' + ++n)
  ;(A.ctx.config as any).tunnel = { host: 'team.example.test' }
  ;(A.ctx.config as any).deployment = 'hosted'
  for (const p of PEOPLE) sessionRow(A.ctx.db, p)
  broker = new FakeDriveBroker(new FakeGoogleDrive())
  broker.onAccess = (token, who) => lib.tokens.set(token, who)
  const fetcher = async (raw: string, init: RequestInit = {}) => {
    if (raw === GOOGLE_USERINFO) {
      const who = lib.tokens.get(new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '')
      return who ? Response.json({ sub: `sub-${who}`, name: who, email: `${who}@acme.example` }) : Response.json({}, { status: 401 })
    }
    return broker.fetch(raw, init)
  }
  const drive = googleDriveOf(A.ctx, { config: null, fetch: fetcher, broker: broker.options() })
  apps = googleAppsOf(A.ctx, { fetch: fetcher })
  expect(await drive.checkBroker()).toBe(true)
})
afterEach(async () => { await A?.close() })

const starts = () => broker.requests.filter((r) => r.path === DRIVE_BROKER_PATHS.start).map((r) => JSON.parse(r.body))
const reason = (id: string) => (A.ctx.db.query('SELECT reason FROM google_app_flows WHERE id=?').get(id) as { reason: string | null }).reason

test('contract: an app may start as the team\'s ("share"); scope_denied and provider_error pass Cloudflare', () => {
  const b = { v: 1, returnState: 'a'.repeat(43), codeChallenge: 'b'.repeat(43), app: 'gmail' }
  expect(parseDriveBrokerStart({ ...b, purpose: 'share' })).toMatchObject({ purpose: 'share', app: 'gmail' })
  expect(parseDriveBrokerStart({ ...b, purpose: 'personal' })).toMatchObject({ purpose: 'personal', app: 'gmail' })
  expect(parseDriveBrokerStart({ ...b, purpose: 'team' })).toBeNull()
  // Cloudflare replaces an origin's 502 and 504 with its own page: no error the team server must read may use them
  for (const status of Object.values(DRIVE_BROKER_ERRORS)) expect([502, 504]).not.toContain(status)
  expect(DRIVE_BROKER_ERRORS.scope_denied).toBe(400)
})

test('the team\'s Gmail signs in as "share" and connects; a personal one stays "personal"', async () => {
  const f = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(starts()).toEqual([expect.objectContaining({ purpose: 'share', app: 'gmail' })])
  expect(await apps.callbackOutcome(broker.browserReturn(f.authorizationUrl, 'teambox'), browser('carol'))).toEqual({ ok: true })
  expect(await apps.completeTeam('carol', 'carol-session', 'gmail', f.flowId)).toBeDefined()
  expect(A.ctx.db.query("SELECT count(*) n FROM integrations WHERE scope='team' AND google_app='gmail'").get()).toEqual({ n: 1 })
  await apps.authorize('alice', 'alice-session', 'gmail')
  expect(starts()[1]).toMatchObject({ purpose: 'personal', app: 'gmail' })
})

test('a control plane from before team app sign-ins refuses "share": the team sign-in starts again as "personal"', async () => {
  broker.shareAppsSupported = false
  const f = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  // the refusal could also be of the person's language (an older control plane does not know `locale` either): "share"
  // is asked once more without it, then "personal" (with it: this control plane takes the language)
  expect(starts().map((s) => [s.purpose, s.locale ?? null])).toEqual([['share', 'ko'], ['share', null], ['personal', 'ko']])
  expect(apps.view('carol', 'gmail')).toMatchObject({ available: true })
  expect(await apps.callbackOutcome(broker.browserReturn(f.authorizationUrl, 'teambox'), browser('carol'))).toEqual({ ok: true })
  // a control plane without apps at all: still "not available yet", after both tries
  broker.appsSupported = false
  await expect(apps.authorize('carol', 'carol-session', 'calendar', 'team')).rejects.toMatchObject({ reason: 'service_limited' })
})

test("an app sign-in names the person's language; a control plane without the field signs in without it", async () => {
  A.ctx.db.query("UPDATE users SET locale = 'ja', locale_follows_team = 0 WHERE id = 'alice'").run()
  await apps.authorize('alice', 'alice-session', 'gmail')
  expect(starts()).toEqual([expect.objectContaining({ purpose: 'personal', app: 'gmail', locale: 'ja' })])
  broker.localeSupported = false
  const f = await apps.authorize('alice', 'alice-session', 'calendar')
  expect(starts().slice(1).map((s) => s.locale ?? null)).toEqual(['ja', null])
  expect(await apps.callbackOutcome(broker.browserReturn(f.authorizationUrl, 'alice'), browser('alice'))).toEqual({ ok: true })
})

test('an app the hosting service closed (app_unavailable) is final: no second start as "personal"', async () => {
  broker.appsClosed = ['gmail']
  await expect(apps.authorize('carol', 'carol-session', 'gmail', 'team')).rejects.toMatchObject({ reason: 'service_limited' })
  expect(starts()).toEqual([expect.objectContaining({ purpose: 'share', app: 'gmail' })])
  expect(apps.view('carol', 'gmail')).toMatchObject({ available: false, reason: 'service_limited' })
})

test('TC-6064: Google left part of the access out: "allow every access", not "could not reach the hosting service"', async () => {
  broker.redeemFails = { code: 'scope_denied', status: 400 }
  const f = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callbackOutcome(broker.browserReturn(f.authorizationUrl, 'teambox'), browser('carol'))).toEqual({ ok: false, reason: 'scope_denied' })
  expect(reason(f.flowId)).toBe('scope_denied')
  expect(apps.flow('carol', 'carol-session', 'gmail', f.flowId, 'team')).toMatchObject({ state: 'failed', reason: 'scope_denied' })
  // Google failing (now 503, which Cloudflare passes on): Google's problem, not the hosting service's
  broker.redeemFails = { code: 'provider_error', status: 503 }
  const g = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callbackOutcome(broker.browserReturn(g.authorizationUrl, 'teambox'), browser('carol'))).toEqual({ ok: false, reason: 'provider_unavailable' })
  // what qa.trina.app saw: the control plane's 502 became Cloudflare's page, so the code was lost
  broker.redeemFails = 'cloudflare-502'
  const h = await apps.authorize('carol', 'carol-session', 'gmail', 'team')
  expect(await apps.callbackOutcome(broker.browserReturn(h.authorizationUrl, 'teambox'), browser('carol'))).toEqual({ ok: false, reason: 'broker_unavailable' })
})
