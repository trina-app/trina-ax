// Onboarding wave 2 (welcome steps, docs/DECISIONS.md "W — Welcome steps", "X — Lean onboarding"): the progress is one
// settings row of the team that the owner writes and owners and admins read, so the steps resume on another device; the
// marketing pack is installed once by these steps and never again by themselves (installing again would restore what
// someone deleted). v5 (docs/DECISIONS.md "W5"): 회사 소개, 내 스킬, 팀 파일 and the invite are counted, the first result
// is no step any more; a `team` step of an older row is kept, not read.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { recordShared, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { SKILL_PACKS } from '../../server/src/onboarding/skill-packs'
import { WELCOME_PACK_SKILLS, WELCOME_RESULT_SKILL, WelcomeProgress } from '@mycel/shared/api'

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
  expect(started.steps).toEqual({ profile: null, result: null, skills: null, files: null, invite: null })
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
  expect(read.steps).toEqual({ profile: 'skipped', result: null, skills: null, files: null, invite: null })
  expect((await ada.client.call('GET', '/api/onboarding/welcome')).progress).toEqual(read)
  // the row holds exactly that; the answer adds the facts read for the screens, never stored (docs/DECISIONS.md "W5")
  const { deckStarted, landingSkill, ...stored } = read
  expect({ deckStarted, landingSkill }).toEqual({ deckStarted: false, landingSkill: null })
  expect(WelcomeProgress.parse(getSetting(h.ctx.db, WELCOME_SETTING))).toEqual(stored)

  // members cannot read it; only the owner writes it
  expect((await mia.client.try('GET', '/api/onboarding/welcome')).status).toBe(403)
  expect((await ada.client.try('PATCH', '/api/onboarding/welcome', { dismissed: true })).status).toBe(403)
  expect((await ada.client.try('POST', '/api/onboarding/welcome/pack')).status).toBe(403)
  expect((await mia.client.try('PATCH', '/api/onboarding/welcome', {})).status).toBe(403)
  // unknown fields are refused (a typo never silently records nothing)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { step: 'profile' })).status).toBe(400)
  // the team type is not a step any more
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { step: { id: 'team', state: 'done' } })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { finished: true })).status).toBe(400)
})

test('done stays done; the result chat must be the owner\'s own; finished once 회사 소개, 내 스킬, 팀 파일 and the invite are each answered (v5)', async () => {
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
  // not finished while 내 스킬 and 팀 파일 are open
  expect((await patch({ step: { id: 'invite', state: 'done' } })).finishedAt).toBeNull()
  expect((await patch({ step: { id: 'skills', state: 'skipped' } })).finishedAt).toBeNull()
  const done = await patch({ step: { id: 'files', state: 'done' } })
  expect(done.finishedAt).not.toBeNull()

  // the end screen shows once
  const f = await patch({ doneShown: true })
  expect(f.doneShownAt).not.toBeNull()
  expect((await patch({ doneShown: true })).doneShownAt).toBe(f.doneShownAt)

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
  const later = (await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' }, teamType: 'marketing' })).progress
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
  expect(read.steps).toEqual({ profile: null, result: null, skills: null, files: null, invite: null })
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

test('"마케팅 스킬 7개": the number the first step says is the pack\'s own; a row from before (team step) finishes once its later steps are answered', async () => {
  for (const texts of Object.values(SKILL_PACKS.marketing.skills)) expect(Object.keys(texts!).length).toBe(WELCOME_PACK_SKILLS)
  const { owner, ownerId } = await setup()
  // a row written while the team type was a step: its `team` step is kept and no longer read
  setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: 'marketing',
    steps: { team: null, profile: 'done', result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
  })
  const patch = async (b: unknown) => (await owner.call('PATCH', '/api/onboarding/welcome', b)).progress
  await patch({ step: { id: 'result', state: 'done' }, resultChatId: chatOf(ownerId) })
  // v5 recounts (docs/DECISIONS.md "W5"): 내 스킬 and 팀 파일, absent from that row, are open until answered
  expect((await patch({ step: { id: 'invite', state: 'skipped' } })).finishedAt).toBeNull()
  await patch({ step: { id: 'skills', state: 'skipped' } })
  const done = await patch({ step: { id: 'files', state: 'skipped' } })
  expect(done.finishedAt).not.toBeNull()
  expect(getSetting<any>(h.ctx.db, WELCOME_SETTING).steps.team).toBeNull()
})

test('a row from the three-step version whose team step was put off: that "later" stands until a team type is picked', async () => {
  const { owner } = await setup()
  const row = (o: Record<string, unknown> = {}) => setSetting(h.ctx.db, WELCOME_SETTING, {
    startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
    steps: { team: 'skipped', profile: null, result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null, ...o,
  })
  const read = async () => (await owner.call('GET', '/api/onboarding/welcome')).progress
  row()
  // the client reads it as "do not install the pack by itself" (web/src/lib/welcome.ts wantsPack)
  expect(await read()).toMatchObject({ teamType: null, teamSkipped: true, pack: null })
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
