// The welcome steps start at setup (docs/decisions/20261119-welcome-steps-in-app.md): POST /api/setup makes the owner's
// welcome-progress row, with the setup link's company website, so an owner who goes on in the desktop app (/open-app,
// /app-signin) lands in the steps there and keeps the website. Before, the row was made only when /welcome opened once.
import { afterEach, expect, test } from 'bun:test'
import { addMember, harness, OWNER_PW, SETUP_TOKEN, type Harness } from './a-lib'
import { startWelcomeAtSetup, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { WelcomeProgress } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

const owner = { username: 'olga', name: 'Olga Owner', password: OWNER_PW }
async function setupWith(extra: Record<string, unknown> = {}) {
  const c = h.client()
  await c.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'en', owner, ...extra })
  return c
}

test('setup starts the steps: fresh, unfinished, the link\'s website normalized; the owner reads them at once', async () => {
  h = await harness('b-welcome-at-setup-1')
  const c = await setupWith({ site: 'www.acme.example' })
  const row = WelcomeProgress.parse(getSetting<unknown>(h.ctx.db, WELCOME_SETTING))
  expect(row.steps).toEqual({ profile: null, result: null, skills: null, files: null, tools: null, invite: null })
  expect(row.site).toBe('https://www.acme.example/')
  expect(row.finishedAt).toBeNull()
  expect(row.dismissedAt).toBeNull()
  const p = (await c.call('GET', '/api/onboarding/welcome')).progress
  expect(p.site).toBe('https://www.acme.example/')
  expect(p.finishedAt).toBeNull()
  // the first visit of /welcome (its empty PATCH) keeps the row and its website
  const again = (await c.call('PATCH', '/api/onboarding/welcome', {})).progress
  expect(again.site).toBe('https://www.acme.example/')
  expect(again.startedAt).toBe(row.startedAt)
})

test('no website, or one that is not http(s): the steps start without one; setup never fails over it', async () => {
  h = await harness('b-welcome-at-setup-2')
  await setupWith({ site: 'javascript:alert(1)' })
  const row = WelcomeProgress.parse(getSetting<unknown>(h.ctx.db, WELCOME_SETTING))
  expect(row.site).toBeNull()
  expect(row.steps.profile).toBeNull()
  await h.close()
  h = await harness('b-welcome-at-setup-3')
  const c = await setupWith()
  expect((await c.call('GET', '/api/onboarding/welcome')).progress.site).toBeNull()
  // too long is a refused request (the field's limit), like every other field of the setup
  await h.close()
  h = await harness('b-welcome-at-setup-4')
  const r = await h.client().try('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'en', owner, site: `https://${'a'.repeat(400)}.example` })
  expect(r.status).toBe(400)
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toBeUndefined()
})

test('a refused setup (wrong token) starts nothing; members and admins are not given steps of their own', async () => {
  h = await harness('b-welcome-at-setup-5')
  const bad = await h.client().try('POST', '/api/setup', { setupToken: 'x'.repeat(32), teamName: 'Acme', locale: 'en', owner, site: 'acme.example' })
  expect(bad.status).toBe(403)
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toBeUndefined()
  const c = await setupWith({ site: 'acme.example' })
  const before = getSetting<unknown>(h.ctx.db, WELCOME_SETTING)
  const mia = await addMember(h, c, { username: 'mia' })
  const ada = await addMember(h, c, { username: 'ada', role: 'admin' })
  // a member cannot read the team's steps (owners and admins read them); nobody joining changes the row
  expect((await mia.client.try('GET', '/api/onboarding/welcome')).status).toBe(403)
  expect((await ada.client.call('GET', '/api/onboarding/welcome')).progress.site).toBe('https://acme.example/')
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toEqual(before)
})

test('startWelcomeAtSetup is idempotent and never touches a row that is there: finished steps stay finished', async () => {
  h = await harness('b-welcome-at-setup-6')
  await setupWith()
  const log = h.ctx.log
  // a finished team (a restored backup, a second call): kept as it is, its website too
  const done = { ...(getSetting<unknown>(h.ctx.db, WELCOME_SETTING) as Record<string, unknown>), finishedAt: '2026-11-01T00:00:00.000Z', site: 'https://old.example/' }
  setSetting(h.ctx.db, WELCOME_SETTING, done)
  startWelcomeAtSetup(h.ctx, 'new.example')
  startWelcomeAtSetup(h.ctx, null)
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toEqual(done)
  // a row without a website gets the one it lacks, nothing else changes
  const noSite = { ...done, site: null }
  setSetting(h.ctx.db, WELCOME_SETTING, noSite)
  startWelcomeAtSetup(h.ctx, 'new.example')
  const after = getSetting<unknown>(h.ctx.db, WELCOME_SETTING) as Record<string, unknown>
  expect(after.site).toBe('https://new.example/')
  expect(after.finishedAt).toBe('2026-11-01T00:00:00.000Z')
  startWelcomeAtSetup(h.ctx, 'other.example')
  expect((getSetting<unknown>(h.ctx.db, WELCOME_SETTING) as Record<string, unknown>).site).toBe('https://new.example/')
  // a row that is not an object is left alone (never replaced by a fresh one), and nothing throws
  setSetting(h.ctx.db, WELCOME_SETTING, 'broken')
  expect(() => startWelcomeAtSetup({ db: h.ctx.db, log }, 'acme.example')).not.toThrow()
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toBe('broken')
})
