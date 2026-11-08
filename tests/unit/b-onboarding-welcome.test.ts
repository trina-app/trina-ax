// Onboarding wave 2 (welcome steps, docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"): the progress is one
// settings row of the team that the owner writes and owners and admins read, so the steps resume on another device. v5
// (docs/DECISIONS.md "W5"): 회사 소개, 내 스킬, 팀 파일 and the invite are counted, the first result is no step any more;
// v6 (docs/DECISIONS.md "W6"): 도구 연결 is counted too;
// a `team` step of an older row is kept, not read. The steps' marketing pack install is gone (docs/DECISIONS.md "DS3"):
// its route is not found, and a `pack` an older row holds is kept as it is and no longer read.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { recordShared, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { WelcomeProgress } from '@mycel/shared/api'

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
const installs = () => (h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onboarding.pack_install'").get() as { n: number }).n

test('nothing until the steps start; then each step is kept on the server and read back on any device', async () => {
  const { owner, ada, mia } = await setup()
  expect((await owner.call('GET', '/api/onboarding/welcome')).progress).toBeNull()

  // the first visit starts it, with the setup link's website (normalized)
  const started = (await owner.call('PATCH', '/api/onboarding/welcome', { site: 'www.acme.example' })).progress
  expect(started.steps).toEqual({ profile: null, result: null, skills: null, files: null, tools: null, invite: null })
  expect(started.site).toBe('https://www.acme.example/')
  expect(started.finishedAt).toBeNull()

  // the team type is no step: the line above the first step records it on its own
  await owner.call('PATCH', '/api/onboarding/welcome', { teamType: 'sales' })
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'skipped' } })

  // another device (a second session of the owner) and an admin read the same; the row holds exactly that
  const other = h.client()
  await other.login('olga', 'owner horse battery 42')
  const read = (await other.call('GET', '/api/onboarding/welcome')).progress
  expect(read.teamType).toBe('sales')
  expect(read.steps).toEqual({ profile: 'skipped', result: null, skills: null, files: null, tools: null, invite: null })
  expect((await ada.client.call('GET', '/api/onboarding/welcome')).progress).toEqual(read)
  // the row holds exactly that; the answer adds the facts read for the screens, never stored (docs/DECISIONS.md "W5")
  const { deckStarted, landingSkill, ...stored } = read
  expect({ deckStarted, landingSkill }).toEqual({ deckStarted: false, landingSkill: null })
  expect(WelcomeProgress.parse(getSetting(h.ctx.db, WELCOME_SETTING))).toEqual(stored)

  // members cannot read it; only the owner writes it
  expect((await mia.client.try('GET', '/api/onboarding/welcome')).status).toBe(403)
  expect((await ada.client.try('PATCH', '/api/onboarding/welcome', { dismissed: true })).status).toBe(403)
  // the steps' own pack install is gone, for everyone
  for (const c of [owner, ada.client]) expect((await c.try('POST', '/api/onboarding/welcome/pack')).status).toBe(404)
  expect((await mia.client.try('PATCH', '/api/onboarding/welcome', {})).status).toBe(403)
  // unknown fields are refused (a typo never silently records nothing)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { step: 'profile' })).status).toBe(400)
  // the team type is not a step any more
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { step: { id: 'team', state: 'done' } })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { finished: true })).status).toBe(400)
})

test('done stays done; the result chat must be the owner\'s own; finished once 회사 소개, 내 스킬, 팀 파일, 도구 연결 and the invite are each answered (W6)', async () => {
  const { owner, ownerId, mia } = await setup()
  const patch = async (b: unknown) => (await owner.call('PATCH', '/api/onboarding/welcome', b)).progress
  await patch({ step: { id: 'profile', state: 'skipped' } })
  // going back and saving it does count; putting it off again does not undo a done step
  await patch({ step: { id: 'profile', state: 'done' } })
  expect((await patch({ step: { id: 'profile', state: 'skipped' } })).steps.profile).toBe('done')

  // a chat of someone else, or none, is refused
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { resultChatId: chatOf(mia.id) })).status).toBe(404)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { resultChatId: 'no-such-chat' })).status).toBe(404)
  const chat = chatOf(ownerId)
  // the deck's chat counts once it holds a message (docs/DECISIONS.md "W5": a chat whose message never went is no deck)
  expect((await patch({ resultChatId: chat })).resultChatId).toBeNull()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, content, status, created_at) VALUES (?, ?, 'user', '/intro-deck', 'done', ?)").run(crypto.randomUUID(), chat, new Date().toISOString())
  expect((await patch({ resultChatId: chat })).resultChatId).toBe(chat)

  // the invite put off is not brought back by anything (the deck chat has no invite bar any more)
  expect((await patch({ step: { id: 'invite', state: 'skipped' } })).steps.invite).toBe('skipped')
  const shown = await patch({ inviteShown: true })
  expect(shown.inviteShownAt).not.toBeNull()
  expect((await patch({ inviteShown: true })).inviteShownAt).toBe(shown.inviteShownAt)
  // not finished while 내 스킬, 팀 파일 and 도구 연결 are open
  expect((await patch({ step: { id: 'invite', state: 'done' } })).finishedAt).toBeNull()
  expect((await patch({ step: { id: 'skills', state: 'skipped' } })).finishedAt).toBeNull()
  expect((await patch({ step: { id: 'files', state: 'done' } })).finishedAt).toBeNull()
  const done = await patch({ step: { id: 'tools', state: 'skipped' } })
  expect(done.finishedAt).not.toBeNull()

  // the end screen shows once
  const f = await patch({ doneShown: true })
  expect(f.doneShownAt).not.toBeNull()
  expect((await patch({ doneShown: true })).doneShownAt).toBe(f.doneShownAt)

  // hiding the Home entry and showing it again
  expect((await patch({ dismissed: true })).dismissedAt).not.toBeNull()
  expect((await patch({ dismissed: false })).dismissedAt).toBeNull()
})

test('a stored row a later release (or an earlier one) changed: read field by field, an old pack kept as stored and not read, nothing installed', async () => {
  const { owner, ada } = await setup()
  // a step this release does not know, a pack in another shape, a field it never heard of
  setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: 'marketing',
    steps: { team: 'done', profile: 'later', result: null, invite: null, goal: 'done' },
    pack: { id: 'marketing', version: 2, installedAt: '2026-11-04T00:00:00.000Z' }, goal: { people: 3 },
  })
  const read = (await ada.client.call('GET', '/api/onboarding/welcome')).progress
  expect(read.steps).toEqual({ profile: null, result: null, skills: null, files: null, tools: null, invite: null })
  expect(read.pack).toBeUndefined()
  expect(read.site).toBeNull()

  // a write changes only its own field and keeps the rest of the row as it was
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' } })
  const row = getSetting<any>(h.ctx.db, WELCOME_SETTING)
  expect(row.pack).toEqual({ id: 'marketing', version: 2, installedAt: '2026-11-04T00:00:00.000Z' })
  expect(row.goal).toEqual({ people: 3 })
  expect(row.steps).toEqual({ team: 'done', profile: 'done', result: null, invite: null, goal: 'done' })
  // nothing installs a pack because of it
  expect(installs()).toBe(0)
  expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'skills/marketing'))).toBe(false)
})

test('a stored row that is not an object: shown as none, and writes refuse instead of starting over', async () => {
  const { owner } = await setup()
  for (const bad of ['not json', '"text"', '[1,2]']) {
    h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(WELCOME_SETTING, bad)
    expect((await owner.call('GET', '/api/onboarding/welcome')).progress).toBeNull()
    expect((await owner.try('PATCH', '/api/onboarding/welcome', {})).status).toBe(409)
    expect((await owner.try('POST', '/api/onboarding/welcome/team')).status).toBe(409)
    expect((h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(WELCOME_SETTING) as { value: string }).value).toBe(bad)
  }
  expect(installs()).toBe(0)
})

test('a row from before (team step) finishes once its later steps are answered', async () => {
  const { owner, ownerId } = await setup()
  // a row written while the team type was a step: its `team` step is kept and no longer read
  setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: 'marketing',
    steps: { team: null, profile: 'done', result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
  })
  const patch = async (b: unknown) => (await owner.call('PATCH', '/api/onboarding/welcome', b)).progress
  await patch({ step: { id: 'result', state: 'done' }, resultChatId: chatOf(ownerId) })
  // v5 and v6 recount (docs/DECISIONS.md "W5", "W6"): 내 스킬, 팀 파일 and 도구 연결, absent from that row, are open until
  // answered
  expect((await patch({ step: { id: 'invite', state: 'skipped' } })).finishedAt).toBeNull()
  await patch({ step: { id: 'skills', state: 'skipped' } })
  expect((await patch({ step: { id: 'files', state: 'skipped' } })).finishedAt).toBeNull()
  const done = await patch({ step: { id: 'tools', state: 'skipped' } })
  expect(done.finishedAt).not.toBeNull()
  expect(getSetting<any>(h.ctx.db, WELCOME_SETTING).steps.team).toBeNull()
})

test('a row from the three-step version whose team step was put off: that "later" stands until a team type is picked', async () => {
  const { owner } = await setup()
  const row = (o: Record<string, unknown> = {}) => setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
    steps: { team: 'skipped', profile: null, result: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null, ...o,
  })
  const read = async () => (await owner.call('GET', '/api/onboarding/welcome')).progress
  row()
  // kept readable for those rows; nothing installs a pack because of it
  expect(await read()).toMatchObject({ teamType: null, teamSkipped: true })
  // a team type picked since answers the question: no longer skipped
  row({ teamType: 'marketing' })
  expect((await read()).teamSkipped).toBeUndefined()
  // a team step that was done (or never answered) is no skip either
  row({ steps: { team: 'done', profile: null, result: null, invite: null } })
  expect((await read()).teamSkipped).toBeUndefined()
  row({ steps: { profile: null, result: null, invite: null } })
  expect((await read()).teamSkipped).toBeUndefined()
  // the row is never rewritten for it
  expect(getSetting<any>(h.ctx.db, WELCOME_SETTING).teamSkipped).toBeUndefined()
})

test('the AI step (docs/DECISIONS.md "W2"): absent until shown, skipped while needed, done stays done; it never holds back finishing; only the owner writes it', async () => {
  const { owner, ada, mia } = await setup()
  let p = (await owner.call('PATCH', '/api/onboarding/welcome', {})).progress
  // an owner whose AI answered from the start never has it
  expect(p.steps.ai).toBeUndefined()
  // only the owner records it (the steps are the owner's)
  expect((await ada.client.try('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'skipped' } })).status).toBe(403)
  expect((await mia.client.try('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'skipped' } })).status).toBe(403)
  p = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'skipped' } })).progress
  expect(p.steps.ai).toBe('skipped')
  p = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'done' } })).progress
  expect(p.steps.ai).toBe('done')
  p = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'ai', state: 'skipped' } })).progress
  expect(p.steps.ai).toBe('done')
  // finishing without files ("자료 없이 해 볼게요" of an older row) puts off the open steps, never the AI step
  const fresh = await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })
  expect(fresh.progress.steps).toMatchObject({ ai: 'done', profile: 'skipped', result: 'skipped', invite: 'skipped' })
  expect(fresh.progress.finishedAt).not.toBeNull()
  expect(WelcomeProgress.safeParse(fresh.progress).success).toBe(true)
})

// K — 내 스킬 가져오기 (docs/DECISIONS.md): two more counted steps after the first result; 내 스킬 put off on a phone waits
// for a computer (the steps are not finished meanwhile); the skills shared from it are recorded with the one the invite
// opens, which only the shared skills can be.
test('내 스킬 and 팀 파일: put off on a phone waits for a computer; the shared skills and the invite\'s landing skill', async () => {
  const { owner, ownerId, ada } = await setup()
  await owner.call('PATCH', '/api/onboarding/welcome', {})
  for (const id of ['profile', 'result'] as const) await owner.call('PATCH', '/api/onboarding/welcome', { step: { id, state: 'done' } })
  // the phone's "다음": skipped there, still waiting (finished never, even with the invite done)
  let p = (await owner.call('PATCH', '/api/onboarding/welcome', { skillsLater: true })).progress
  expect(p.steps.skills).toBe('skipped')
  expect(p.skillsLater).toBe(true)
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'files', state: 'done' } })
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'tools', state: 'skipped' } })
  p = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'invite', state: 'done' } })).progress
  expect(p.finishedAt).toBeNull()
  // the landing can only be a shared skill: none shared yet
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { landing: 'skills/x/SKILL.md' })).status).toBe(400)
  // the share (server/src/skills/share.ts apply) records what went in: an admin's share changes nothing here
  recordShared(h.ctx, ada.id, [{ path: 'skills/nope/SKILL.md', title: 'Nope', recommended: true }])
  expect((await owner.call('GET', '/api/onboarding/welcome')).progress.shared).toBeUndefined()
  recordShared(h.ctx, ownerId, [{ path: 'skills/dev-notes/SKILL.md', title: '개발 메모', recommended: false }, { path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고', recommended: true }])
  // a second share adds, each path once; the landing stays the first one set
  recordShared(h.ctx, ownerId, [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고', recommended: true }, { path: 'skills/quote-draft/SKILL.md', title: '견적서 초안', recommended: true }])
  p = (await owner.call('GET', '/api/onboarding/welcome')).progress
  expect(p.shared.skills.map((x: { path: string }) => x.path)).toEqual(['skills/dev-notes/SKILL.md', 'skills/weekly-report/SKILL.md', 'skills/quote-draft/SKILL.md'])
  expect(p.shared.landing).toBe('skills/weekly-report/SKILL.md')
  // 바꾸기 on the invite: another shared skill; never one that was not shared; only the owner
  expect((await owner.call('PATCH', '/api/onboarding/welcome', { landing: 'skills/quote-draft/SKILL.md' })).progress.shared.landing).toBe('skills/quote-draft/SKILL.md')
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { landing: 'skills/general/intro-deck/SKILL.md' })).status).toBe(400)
  expect((await ada.client.try('PATCH', '/api/onboarding/welcome', { landing: 'skills/weekly-report/SKILL.md' })).status).toBe(403)
  // done on a computer: no longer waiting, and the steps are finished
  p = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'skills', state: 'done' } })).progress
  expect(p.skillsLater).toBeUndefined()
  expect(p.finishedAt).not.toBeNull()
  expect(WelcomeProgress.parse(p)).toEqual(p)
})

test('a share recorded on a row that is not there, or not an object, changes nothing and never throws', async () => {
  const { ownerId } = await setup()
  recordShared(h.ctx, ownerId, [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고', recommended: true }])
  expect(getSetting(h.ctx.db, WELCOME_SETTING) ?? null).toBeNull()
  setSetting(h.ctx.db, WELCOME_SETTING, 'broken')
  recordShared(h.ctx, ownerId, [{ path: 'skills/weekly-report/SKILL.md', title: '주간 업무 보고', recommended: true }])
  expect(getSetting<unknown>(h.ctx.db, WELCOME_SETTING)).toBe('broken')
})
