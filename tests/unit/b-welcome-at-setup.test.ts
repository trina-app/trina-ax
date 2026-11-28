// The welcome steps start at setup (docs/decisions/20261119-welcome-steps-in-app.md): POST /api/setup makes the owner's
// welcome-progress row, with the setup link's company website, so an owner who goes on in the desktop app (/open-app,
// /app-signin) lands in the steps there and keeps the website. Before, the row was made only when /welcome opened once.
import { afterEach, expect, test } from 'bun:test'
import { addMember, harness, OWNER_PW, SETUP_TOKEN, type Harness } from './a-lib'
import fs from 'node:fs'
import path from 'node:path'
import { recordShared, startWelcomeAtSetup, updateWelcome, WELCOME_SETTING, welcomeOpened, welcomeUnfinishedFor } from '../../server/src/onboarding/welcome'
import { recordJoin, welcomeAnswer, welcomeOf } from '../../server/src/onboarding/member-welcome'
import { mergeWaits } from '../../server/src/skills/share-merge'
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
  // too long, or not text: dropped too, the team is made all the same
  for (const [i, site] of [`https://${'a'.repeat(400)}.example`, 42].entries()) {
    await h.close()
    h = await harness(`b-welcome-at-setup-4${i}`)
    const r = await h.client().try('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'en', owner, site })
    expect(r.status).toBe(201)
    expect(WelcomeProgress.parse(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).site).toBeNull()
  }
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

test('a row the setup made is not opened: nothing from outside the steps changes it until the owner opens them (security matrix teamFilesLanded)', async () => {
  h = await harness('b-welcome-at-setup-7')
  const c = await setupWith()
  expect(welcomeOpened(h.ctx)).toBe(false)
  const file = path.join(h.ctx.files.fx.root, 'shared', 'budget.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# budget')
  // an upload's record and a pack install change nothing yet; no team group is made for a skill install
  expect((await c.call('POST', '/api/onboarding/files/landed', { path: 'shared/budget.md' })).recorded).toBe(false)
  await c.call('POST', '/api/onboarding/packs/general/install')
  const before = (await c.call('GET', '/api/onboarding/welcome')).progress
  expect(before.steps.skills).toBeNull()
  expect(before.steps.files).toBeNull()
  expect(before.teamGroup).toBeUndefined()
  expect(welcomeUnfinishedFor(h.ctx, (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id)).toBe(false)
  // the owner's first move in the steps opens them; then the upload records 팀 파일
  await c.call('PATCH', '/api/onboarding/welcome', {})
  expect(welcomeOpened(h.ctx)).toBe(true)
  expect((await c.call('POST', '/api/onboarding/files/landed', { path: 'shared/budget.md' })).recorded).toBe(true)
  // a row from before (no openedAt field) is opened
  const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!
  delete raw.openedAt
  setSetting(h.ctx.db, WELCOME_SETTING, raw)
  expect(welcomeOpened(h.ctx)).toBe(true)
})

test('the steps\' page opens the row: the team start (POST /api/onboarding/welcome/team) marks it', async () => {
  h = await harness('b-welcome-at-setup-8')
  const c = await setupWith()
  await c.call('POST', '/api/onboarding/welcome/team')
  expect(welcomeOpened(h.ctx)).toBe(true)
})

const ownerIdOf = () => (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
function newSharedFile(name: string) {
  const file = path.join(h.ctx.files.fx.root, 'shared', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# x')
  return `shared/${name}`
}

test('a ✕ on "Continue setup" alone does not open the steps: an upload records nothing, a pack install makes no team group', async () => {
  h = await harness('b-welcome-at-setup-9')
  const c = await setupWith()
  const p = (await c.call('PATCH', '/api/onboarding/welcome', { dismissed: true })).progress
  expect(p.dismissedAt).not.toBeNull()
  expect(welcomeOpened(h.ctx)).toBe(false)
  expect((await c.call('POST', '/api/onboarding/files/landed', { path: newSharedFile('a.md') })).recorded).toBe(false)
  await c.call('POST', '/api/onboarding/packs/general/install')
  const after = (await c.call('GET', '/api/onboarding/welcome')).progress
  expect(after.teamGroup).toBeUndefined()
  expect(after.steps.skills).toBeNull()
  // its undo alone neither
  await c.call('PATCH', '/api/onboarding/welcome', { dismissed: false })
  expect(welcomeOpened(h.ctx)).toBe(false)
  // any other change opens them (the first visit's empty start, the AI step on screen)
  await c.call('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'skipped' } })
  expect(welcomeOpened(h.ctx)).toBe(true)
})

test('unopened: no shared skill recorded, merges not held, an admin\'s "sort the team\'s files" row off, an admin\'s upload records nothing', async () => {
  h = await harness('b-welcome-at-setup-10')
  const c = await setupWith()
  const ownerId = ownerIdOf()
  const ada = await addMember(h, c, { username: 'ada', role: 'admin' })
  recordJoin(h.ctx, { userId: ada.id, via: 'invite', invitedBy: ownerId })
  recordShared(h.ctx, ownerId, [{ path: 'skills/weekly/SKILL.md', title: 'Weekly', recommended: true }])
  expect((getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING) as Record<string, unknown>).shared).toBeUndefined()
  // a merge chosen now does not wait for steps nobody opened (as with no row: it goes at once)
  expect(welcomeUnfinishedFor(h.ctx, ownerId)).toBe(false)
  expect(mergeWaits(h.ctx.db, ownerId)).toBe(false)
  expect((welcomeAnswer(h.ctx, ada.id).organizeFiles ?? false)).toBe(false)
  expect((await ada.client.call('POST', '/api/onboarding/files/landed', { path: newSharedFile('b.md') })).recorded).toBe(false)
  // opened: each of them as before
  updateWelcome(h.ctx, ownerId, {})
  expect(mergeWaits(h.ctx.db, ownerId)).toBe(true)
  expect((welcomeAnswer(h.ctx, ada.id).organizeFiles ?? false)).toBe(true)
  recordShared(h.ctx, ownerId, [{ path: 'skills/weekly/SKILL.md', title: 'Weekly', recommended: true }])
  expect((getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING) as { shared?: { landing: string } }).shared?.landing).toBe('skills/weekly/SKILL.md')
  expect((await ada.client.call('POST', '/api/onboarding/files/landed', { path: newSharedFile('c.md') })).recorded).toBe(true)
})

test('the brand action from the steps (POST /api/onboarding/welcome/brand) opens the row', async () => {
  h = await harness('b-welcome-at-setup-11')
  const c = await setupWith()
  await c.try('POST', '/api/onboarding/welcome/brand', { files: [] })
  expect(welcomeOpened(h.ctx)).toBe(true)
})

test('a row from before this change (no openedAt) behaves as opened: an upload records 팀 파일, merges wait', async () => {
  h = await harness('b-welcome-at-setup-12')
  const c = await setupWith()
  const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!
  delete raw.openedAt
  setSetting(h.ctx.db, WELCOME_SETTING, raw)
  expect(mergeWaits(h.ctx.db, ownerIdOf())).toBe(true)
  expect((await c.call('POST', '/api/onboarding/files/landed', { path: newSharedFile('d.md') })).recorded).toBe(true)
  expect((await c.call('GET', '/api/onboarding/welcome')).progress.steps.files).toBe('done')
})

test('a setup row nobody opened (a server we set up for a customer): the owner\'s first read is the owner card, setupOpen true, and it opens nothing', async () => {
  h = await harness('b-welcome-at-setup-late-card')
  const c = await setupWith()
  expect(welcomeOpened(h.ctx)).toBe(false)
  const w = (await c.call('GET', '/api/me/welcome')).welcome
  expect(w).toMatchObject({ kind: 'owner', setupOpen: true, allSet: false })
  // reading the card is not a move in the steps
  expect(welcomeOpened(h.ctx)).toBe(false)
  // a server made without the steps (account create-owner): the card, with no setup to continue
  h.ctx.db.query("DELETE FROM settings WHERE key = ?").run(WELCOME_SETTING)
  const again = (await c.call('GET', '/api/me/welcome')).welcome
  expect(again).toMatchObject({ kind: 'owner' })
  expect(again.setupOpen).toBeUndefined()
})
