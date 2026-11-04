// Onboarding wave 2 (welcome steps, docs/DECISIONS.md "W — Welcome steps"): the progress is one settings row of the
// team that the owner writes and owners and admins read, so the steps resume on another device; the marketing pack is
// installed once by these steps and never again by themselves (installing again would restore what someone deleted).
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { WELCOME_RESULT_SKILL, WelcomeProgress } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('b-onboarding-welcome')
  const owner = await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  return { owner, ownerId, ada, mia, root: h.ctx.files.fx.root }
}
const chatOf = (userId: string) => {
  const id = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(id, userId)
  return id
}
const readPack = () => (getSetting<any>(h.ctx.db, WELCOME_SETTING) ?? {}).pack ?? null
const installs = () => (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onboarding.pack_install'").get() as { n: number }).n

test('nothing until the steps start; then each step is kept on the server and read back on any device', async () => {
  const { owner, ada, mia } = await setup()
  expect((await owner.call('GET', '/api/onboarding/welcome')).progress).toBeNull()

  // the first visit starts it, with the setup link's website (normalized)
  const started = (await owner.call('PATCH', '/api/onboarding/welcome', { site: 'www.acme.example' })).progress
  expect(started.steps).toEqual({ team: null, profile: null, result: null, invite: null })
  expect(started.site).toBe('https://www.acme.example/')
  expect(started.finishedAt).toBeNull()

  await owner.call('PATCH', '/api/onboarding/welcome', { teamType: 'sales', step: { id: 'team', state: 'done' } })
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'skipped' } })

  // another device (a second session of the owner) and an admin read the same; the row holds exactly that
  const other = h.client()
  await other.login('olga', 'owner horse battery 42')
  const read = (await other.call('GET', '/api/onboarding/welcome')).progress
  expect(read.teamType).toBe('sales')
  expect(read.steps).toEqual({ team: 'done', profile: 'skipped', result: null, invite: null })
  expect((await ada.client.call('GET', '/api/onboarding/welcome')).progress).toEqual(read)
  expect(WelcomeProgress.parse(getSetting(h.ctx.db, WELCOME_SETTING))).toEqual(read)

  // members cannot read it; only the owner writes it
  expect((await mia.client.try('GET', '/api/onboarding/welcome')).status).toBe(403)
  expect((await ada.client.try('PATCH', '/api/onboarding/welcome', { dismissed: true })).status).toBe(403)
  expect((await ada.client.try('POST', '/api/onboarding/welcome/pack')).status).toBe(403)
  expect((await mia.client.try('PATCH', '/api/onboarding/welcome', {})).status).toBe(403)
  // unknown fields are refused (a typo never silently records nothing)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { step: 'team' })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { finished: true })).status).toBe(400)
})

test('done stays done, the first result must be the owner\'s own chat and brings a put-off invite back, then it is finished', async () => {
  const { owner, ownerId, mia } = await setup()
  const patch = async (b: unknown) => (await owner.call('PATCH', '/api/onboarding/welcome', b)).progress
  await patch({ step: { id: 'team', state: 'done' } })
  // going back and putting it off again does not undo it
  expect((await patch({ step: { id: 'team', state: 'skipped' } })).steps.team).toBe('done')
  await patch({ step: { id: 'profile', state: 'done' } })
  await patch({ step: { id: 'result', state: 'skipped' } })
  const offInvite = await patch({ step: { id: 'invite', state: 'skipped' } })
  expect(offInvite.finishedAt).toBeNull()

  // a chat of someone else, or none, is refused
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { resultChatId: chatOf(mia.id) })).status).toBe(404)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { resultChatId: 'no-such-chat' })).status).toBe(404)
  const chat = chatOf(ownerId)
  const ran = await patch({ step: { id: 'result', state: 'done' }, resultChatId: chat })
  expect(ran.resultChatId).toBe(chat)
  // the invite put off before there was a result is offered again (the bar on that chat)
  expect(ran.steps.invite).toBeNull()
  expect(ran.finishedAt).toBeNull()

  const shown = await patch({ inviteShown: true })
  expect(shown.inviteShownAt).not.toBeNull()
  expect((await patch({ inviteShown: true })).inviteShownAt).toBe(shown.inviteShownAt)
  const done = await patch({ step: { id: 'invite', state: 'done' } })
  expect(done.finishedAt).not.toBeNull()

  // hiding the Home entry and showing it again
  expect((await patch({ dismissed: true })).dismissedAt).not.toBeNull()
  expect((await patch({ dismissed: false })).dismissedAt).toBeNull()
})

test('the pack is installed once: a second choice, a resume or another window does not install again', async () => {
  const { owner, root } = await setup()
  const first = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(first.outcome).toBe('installed')
  expect(first.install.pack).toBe('marketing')
  expect(first.install.skills.find((s: any) => s.name === 'ad-copy')).toEqual({ name: 'ad-copy', path: WELCOME_RESULT_SKILL, status: 'created' })
  expect(first.progress.pack).toMatchObject({ id: 'marketing', skillPath: WELCOME_RESULT_SKILL })
  expect(fs.existsSync(path.join(root, WELCOME_RESULT_SKILL))).toBe(true)
  expect(installs()).toBe(1)

  // someone deletes a pack skill on purpose; the steps run again (same choice, another device): nothing comes back
  fs.rmSync(path.join(root, 'skills/marketing/seo-brief'), { recursive: true })
  const second = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(second.outcome).toBe('already')
  expect(second.install).toBeNull()
  expect(second.progress.pack).toEqual(first.progress.pack)
  const [a, b] = await Promise.all([owner.call('POST', '/api/onboarding/welcome/pack'), owner.call('POST', '/api/onboarding/welcome/pack')])
  expect([a.install, b.install]).toEqual([null, null])
  expect(installs()).toBe(1)
  expect(fs.existsSync(path.join(root, 'skills/marketing/seo-brief'))).toBe(false)
  // the record survives the other changes
  const later = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'team', state: 'done' }, teamType: 'marketing' })).progress
  expect(later.pack).toEqual(first.progress.pack)
})

test('when another team skill already has the name, the first result points at the one "/ad-copy" runs', async () => {
  const { owner, root } = await setup()
  fs.mkdirSync(path.join(root, 'skills/ours/ad-copy'), { recursive: true })
  fs.writeFileSync(path.join(root, 'skills/ours/ad-copy/SKILL.md'), '---\nname: ad-copy\ndescription: our own ad copy\n---\nWrite ads.\n')
  const r = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(r.install.skills.find((s: any) => s.name === 'ad-copy')).toMatchObject({ status: 'blocked', sameNameAs: 'skills/ours/ad-copy/SKILL.md' })
  expect(r.progress.pack.skillPath).toBe('skills/ours/ad-copy/SKILL.md')
})

test('a stored row a later release changed: read field by field, the pack never reset, nothing installed again', async () => {
  const { owner, ada } = await setup()
  // a step this release does not know, a pack in another shape, a field it never heard of
  setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: 'marketing',
    steps: { team: 'done', profile: 'later', result: null, invite: null, goal: 'done' },
    pack: { id: 'marketing', version: 2, installedAt: '2026-11-04T00:00:00.000Z' }, goal: { people: 3 },
  })
  const read = (await ada.client.call('GET', '/api/onboarding/welcome')).progress
  expect(read.steps).toEqual({ team: 'done', profile: null, result: null, invite: null })
  expect(read.pack).toEqual({ id: 'marketing', at: '', skillPath: WELCOME_RESULT_SKILL })
  expect(read.site).toBeNull()

  // a write changes only its own field and keeps the rest of the row as it was
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' } })
  const row = getSetting<any>(h.ctx.db, WELCOME_SETTING)
  expect(row.pack).toEqual({ id: 'marketing', version: 2, installedAt: '2026-11-04T00:00:00.000Z' })
  expect(row.goal).toEqual({ people: 3 })
  expect(row.steps).toEqual({ team: 'done', profile: 'done', result: null, invite: null, goal: 'done' })
  // the pack counts as installed: nothing runs
  const again = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(again.outcome).toBe('already')
  expect(installs()).toBe(0)
  expect(getSetting<any>(h.ctx.db, WELCOME_SETTING).pack).toEqual(row.pack)
})

test('a stored row that is not an object: shown as none, and writes refuse instead of starting over', async () => {
  const { owner } = await setup()
  for (const bad of ['not json', '"text"', '[1,2]']) {
    h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(WELCOME_SETTING, bad)
    expect((await owner.call('GET', '/api/onboarding/welcome')).progress).toBeNull()
    expect((await owner.try('PATCH', '/api/onboarding/welcome', {})).status).toBe(409)
    expect((await owner.try('POST', '/api/onboarding/welcome/pack')).status).toBe(409)
    expect((h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(WELCOME_SETTING) as { value: string }).value).toBe(bad)
  }
  expect(installs()).toBe(0)
})

test('the first-result skill blocked by what is in the way: nothing recorded, the answer says blocked', async () => {
  const { owner, root } = await setup()
  // a file where the pack's folder goes: every pack skill is blocked
  fs.writeFileSync(path.join(root, 'skills/marketing'), 'not a folder')
  const r = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(r.outcome).toBe('blocked')
  expect(r.install.skills.every((s: any) => s.status === 'blocked')).toBe(true)
  expect(r.progress.pack).toBeNull()
  expect(readPack()).toBeNull()
  // once the way is clear, the next choice installs (nothing was recorded)
  fs.rmSync(path.join(root, 'skills/marketing'))
  const ok = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(ok.outcome).toBe('installed')
  expect(ok.progress.pack.skillPath).toBe(WELCOME_RESULT_SKILL)
})

test('the pack already installed from the Skills page: recorded without installing, a deleted skill stays deleted', async () => {
  const { owner, root } = await setup()
  expect((await owner.call('POST', '/api/onboarding/packs/marketing/install')).skills.length).toBe(7)
  fs.rmSync(path.join(root, 'skills/marketing/seo-brief'), { recursive: true })
  expect((await owner.call('GET', '/api/onboarding/welcome')).progress).toBeNull()

  const r = await owner.call('POST', '/api/onboarding/welcome/pack')
  expect(r.outcome).toBe('already')
  expect(r.install).toBeNull()
  expect(r.progress.pack).toMatchObject({ id: 'marketing', skillPath: WELCOME_RESULT_SKILL })
  expect(installs()).toBe(1) // the Skills page's own
  expect(fs.existsSync(path.join(root, 'skills/marketing/seo-brief'))).toBe(false)
})
