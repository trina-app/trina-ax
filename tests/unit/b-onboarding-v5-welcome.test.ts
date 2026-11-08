// Onboarding v5, the owner's steps on the server (docs/DECISIONS.md "W5"; server/src/onboarding/welcome.ts,
// welcome-result.ts, goal.ts, auth/team-links.ts, credentials/access.ts, chat/skills.ts):
//   - the finish rule (docs/DECISIONS.md "W6"): 회사 소개 answered (saved or put off) and 내 스킬, 팀 파일, 도구 연결 and
//     the invite each done or put off, not while 내 스킬 waits for a computer; old rows (a)–(d); a finished row stays so;
//   - no deck starts any more (the first-result route is gone); a row whose deck started earlier keeps its fact
//     (deckStarted);
//   - the skill everything points at (landingSkill): the first shared skill, else none (docs/DECISIONS.md "DS3": no
//     pack skill stands in), never the intro deck; the goal card names it (focusSkill) unless another skill that is
//     not the deck has more people; without one, the skill most people ran, never one the steps ran themselves (the
//     owner's deck);
//   - old open invite links to the intro deck are pointed once at the landing skill (once used up only when it could act);
//   - what AI a person who joins through the link has (memberAi), and a skill's own example (SkillInfo.example).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, GENERAL_DECK_SKILL, skillExample, type WelcomeProgress } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { landingSkill, profileAnswered, readWelcome, recordShared, WELCOME_SETTING, welcomeFinished } from '../../server/src/onboarding/welcome'
import { focusSkill, goalProgress } from '../../server/src/onboarding/goal'
import { DECK_LINKS_CLEARED_KEY, DECK_LINKS_KEY, repointDeckLinks } from '../../server/src/auth/team-links'
import { newMemberAi } from '../../server/src/credentials/access'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/policy'
import { installPackSkill } from '../../server/src/onboarding/skill-packs'

setDefaultTimeout(90_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-onboarding-v5-welcome' }) })
afterAll(async () => { await h?.close() })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const send = async (user: string, chatId: string, content: string) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(r.turnId) as { status: string }).status !== 'running', { timeoutMs: 30_000 })
  return r.turnId as string
}
const post = (user: string, p: string, body: unknown) => h.req(user, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = async (b: unknown) => (await h.api('dana').call(API.updateWelcome, { body: b as never })).progress!
const chatsOf = (user: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ?').get(user) as { n: number }).n
const progress = (o: Partial<WelcomeProgress> & { steps: WelcomeProgress['steps'] }): WelcomeProgress => ({
  startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', teamType: null, resultChatId: null, inviteShownAt: null,
  site: null, dismissedAt: null, finishedAt: null, ...o,
})

describe('the finish rule and old rows', () => {
  const all = { skills: 'done', files: 'skipped', tools: 'skipped', invite: 'done' } as const
  test('회사 소개 answered: saved or put off (docs/DECISIONS.md "W6": no deck is waited for); (a) a saved profile without a deck is answered too', () => {
    expect(profileAnswered(progress({ steps: { profile: 'skipped', result: null, ...all } }))).toBe(true)
    expect(profileAnswered(progress({ steps: { profile: 'done', result: null, ...all }, resultChatId: 'c1' }))).toBe(true)
    // (a) an old row: the profile saved, the first result never ran: answered now, and finished with the rest
    expect(profileAnswered(progress({ steps: { profile: 'done', result: null, ...all } }))).toBe(true)
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: null, ...all } }))).toBe(true)
    // (b) the first result done with another chat (the card news): nothing special
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: 'done', ...all }, resultChatId: 'cardnews' }))).toBe(true)
    // (d) the first result put off: answered, no deck
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: 'skipped', ...all } }))).toBe(true)
    expect(profileAnswered(progress({ steps: { profile: null, result: null, ...all } }))).toBe(false)
  })
  test('(c) recount: 내 스킬, 팀 파일, 도구 연결 and the invite each answered; never while 내 스킬 waits for a computer', () => {
    const base = { profile: 'skipped', result: null } as const
    expect(welcomeFinished(progress({ steps: { ...base, skills: null, files: 'done', tools: 'done', invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: undefined, tools: 'done', invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: 'done', tools: 'done', invite: null } }))).toBe(false)
    // 도구 연결 open (a row from before it reads it so): not finished
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: 'done', invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: 'done', tools: null, invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'skipped', files: 'done', tools: 'skipped', invite: 'skipped' }, skillsLater: true }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'skipped', files: 'done', tools: 'skipped', invite: 'skipped' } }))).toBe(true)
  })
  test('over the API: an old row (a) finishes once 도구 연결 and the invite are answered; a row finished before 도구 연결 stays finished', async () => {
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: null }, resultChatId: null, finishedAt: null })
    // a row from before 도구 연결 reads it as open
    expect((await h.api('dana').call(API.getWelcome)).progress!.steps.tools).toBeNull()
    expect((await patch({ step: { id: 'invite', state: 'done' } })).finishedAt).toBeNull()
    expect((await patch({ step: { id: 'tools', state: 'skipped' } })).finishedAt).not.toBeNull()
    // done stays done: putting 도구 연결 off after it was done does not undo it
    expect((await patch({ step: { id: 'tools', state: 'done' } })).steps.tools).toBe('done')
    expect((await patch({ step: { id: 'tools', state: 'skipped' } })).steps.tools).toBe('done')
    // (a) put off on 회사 소개 ("나중에 하기") after the save: the profile stays saved, nothing else is written
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: null, skills: null, files: null, invite: null }, resultChatId: null, finishedAt: null })
    expect((await patch({ step: { id: 'profile', state: 'skipped' } })).steps).toMatchObject({ profile: 'done', result: null })
    // a row finished before 도구 연결 existed: finished stays finished (its finishedAt), nothing reopens it
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: 'skipped', skills: 'skipped', files: 'skipped', invite: 'done' }, resultChatId: null, finishedAt: '2026-11-02T00:00:00.000Z' })
    expect(await patch({ dismissed: false })).toMatchObject({ finishedAt: '2026-11-02T00:00:00.000Z', steps: { tools: null } })
    setSetting(h.ctx.db, WELCOME_SETTING, {})
  })
  test('the first result is gone (docs/DECISIONS.md "W6"): POST …/welcome/first-result is no route; 회사 소개 starts no chat', async () => {
    await patch({})
    const before = chatsOf('dana')
    expect((await post('dana', '/api/onboarding/welcome/first-result', { files: [] })).status).toBe(404)
    await h.api('dana').call(API.welcomeBrand, { body: { files: [] } }).catch(() => null)
    expect(chatsOf('dana')).toBe(before)
    expect(readWelcome(h.ctx)!.resultChatId).toBeNull()
    setSetting(h.ctx.db, WELCOME_SETTING, {})
  })
})

describe('a row whose deck started on an earlier version', () => {
  test('deckStarted is a fact: the chat that holds "/intro-deck" is a deck; a first result of a row from before (a card news chat) is not; a deck build in the chat is', async () => {
    await patch({})
    // the team's start (the group the tests below use) and a saved profile, as the steps leave them; a row whose deck
    // started earlier has the intro deck skill (that version installed it)
    await h.api('dana').call(API.setupWelcomeTeam)
    installPackSkill(h.ctx, 'dana', 'general', 'intro-deck')
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: [] } })
    const deck = (await h.api('dana').call(API.createChat, { body: {} })).id
    await send('dana', deck, `/intro-deck Make our company profile\n${fake({ say: 'Done.' })}`)
    const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!
    // kept by the earlier version until its message was in: settled as the deck now
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, steps: { profile: 'done', result: null, skills: null, files: null, invite: null }, resultChatId: null, deckChatId: deck })
    expect((await h.api('dana').call(API.getWelcome)).progress).toMatchObject({ resultChatId: deck, deckStarted: true })
    const cardNews = (await h.api('dana').call(API.createChat, { body: {} })).id
    // (a plain message: a real /card-news run would count for the goal card below)
    await send('dana', cardNews, `Card news of our company\n${fake({ say: 'Cards.' })}`)
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, steps: { profile: 'done', result: 'done', skills: 'done', files: 'done', invite: 'done' }, resultChatId: cardNews, deckChatId: undefined })
    expect((await h.api('dana').call(API.getWelcome)).progress).toMatchObject({ resultChatId: cardNews, deckStarted: false })
    h.ctx.db.query("INSERT INTO intro_deck_builds (id, chat_id, user_id, status, plan, state, started_at) VALUES (?, ?, 'dana', 'building', '{}', '{}', ?)").run(crypto.randomUUID(), cardNews, new Date().toISOString())
    expect((await h.api('dana').call(API.getWelcome)).progress!.deckStarted).toBe(true)
    h.ctx.db.query('DELETE FROM intro_deck_builds WHERE chat_id = ?').run(cardNews)
    setSetting(h.ctx.db, WELCOME_SETTING, raw)
  })
})

describe('the skill everything points at', () => {
  const skill = (rel: string, name: string, title: string) => {
    fs.mkdirSync(path.join(h.team, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(h.team, rel), `---\nname: ${name}\ndescription: ${title} for the team\nmetadata:\n  title: ${title}\n---\n# ${title}\n`)
  }
  test('the first shared skill while it is there, else none, never the intro deck nor an old row\'s 할 일 정리; the progress carries the server\'s choice', async () => {
    const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!
    // nothing shared yet: none (the invite link lands on Home)
    expect(landingSkill(h.ctx)).toBeNull()
    expect((await h.api('dana').call(API.getWelcome)).progress!.landingSkill).toBeNull()
    skill('skills/weekly-report/SKILL.md', 'weekly-report', 'Weekly report')
    recordShared(h.ctx, 'dana', [{ path: 'skills/weekly-report/SKILL.md', title: 'Weekly report', recommended: true }])
    expect(landingSkill(h.ctx)).toBe('skills/weekly-report/SKILL.md')
    expect((await h.api('dana').call(API.getWelcome)).progress!.landingSkill).toBe('skills/weekly-report/SKILL.md')
    fs.rmSync(path.join(h.team, 'skills/weekly-report'), { recursive: true })
    expect(landingSkill(h.ctx)).toBeNull()
    // the web read `shared.landing` itself before and named the deleted skill; now every answer with the progress says
    // which skill the server points at (GET, PATCH)
    const got = (await h.api('dana').call(API.getWelcome)).progress!
    expect(got.shared!.landing).toBe('skills/weekly-report/SKILL.md')
    expect(got.landingSkill).toBeNull()
    expect((await patch({})).landingSkill).toBeNull()
    // a row pointing the landing at the deck (an old row) never makes it the landing skill
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, shared: { at: 'x', skills: [], landing: GENERAL_DECK_SKILL } })
    expect(landingSkill(h.ctx)).toBeNull()
    // an old row whose general pack recorded 할 일 정리, its file still there: never the landing skill now
    skill('skills/general/meeting-tasks/SKILL.md', 'meeting-tasks', '할 일 정리')
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, general: { ...(raw.general as object), tasksPath: 'skills/general/meeting-tasks/SKILL.md' } })
    expect(landingSkill(h.ctx)).toBeNull()
    fs.rmSync(path.join(h.team, 'skills/general/meeting-tasks'), { recursive: true })
    setSetting(h.ctx.db, WELCOME_SETTING, { ...raw, shared: got.shared })
    expect(landingSkill(h.ctx)).toBeNull()
  })
  const goal = async () => (await h.api('dana').call(API.getTeamGoal)).goal!
  test('the goal card without a landing skill: never the owner\'s deck, whose runs count nowhere in the goal, so no skill until another one is run', async () => {
    expect(landingSkill(h.ctx)).toBeNull()
    // dana ran the deck above (in the steps\' own chat); carol runs it too: two people on the deck, nothing else run
    await send('carol', (await h.api('carol').call(API.createChat, { body: {} })).id, `/intro-deck\n${fake({ say: 'A deck' })}`)
    expect(focusSkill(h.ctx, goalProgress(h.ctx.db)!)).toBeNull()
    expect((await goal()).skill).toBeNull()
    // nor do the deck's runs count anywhere else in the goal: not as the best skill, not as people who ran one
    const p = goalProgress(h.ctx.db)!
    expect(p.best).toBeNull()
    expect(p.runnerIds.has('carol')).toBe(false)
    expect(p.peopleWithRun).toBe(0)
    // another team skill: the one most people ran
    skill('skills/quote/SKILL.md', 'quote', 'Quote')
    await send('carol', (await h.api('carol').call(API.createChat, { body: {} })).id, `/quote\n${fake({ say: 'A quote' })}`)
    expect((await goal()).skill).toMatchObject({ path: 'skills/quote/SKILL.md', runners: 1 })
  })
  test('the goal card with a landing skill: it even with nobody yet unless another skill has more people; the deck runs never take its place', async () => {
    skill('skills/notes/SKILL.md', 'notes', 'Notes')
    recordShared(h.ctx, 'dana', [{ path: 'skills/notes/SKILL.md', title: 'Notes', recommended: true }])
    await patch({ landing: 'skills/notes/SKILL.md' })
    expect(landingSkill(h.ctx)).toBe('skills/notes/SKILL.md')
    // quote has carol, the landing skill nobody: quote wins, as before
    expect((await goal()).skill).toMatchObject({ path: 'skills/quote/SKILL.md', runners: 1 })
    // as many people on the landing skill: the landing skill
    await send('bob', (await h.api('bob').call(API.createChat, { body: {} })).id, `/notes\n${fake({ say: 'Notes' })}`)
    expect((await goal()).skill).toMatchObject({ path: 'skills/notes/SKILL.md', runners: 1 })
    // two people on the deck never outrank it
    expect(focusSkill(h.ctx, goalProgress(h.ctx.db)!)!.path).toBe('skills/notes/SKILL.md')
  })
})

describe('old invite links to the intro deck', () => {
  test('pointed once at the landing skill, keeping the address; a link elsewhere stays; only once per server', async () => {
    const group = readWelcome(h.ctx)!.teamGroup!.id
    const made = await h.api('dana').call(API.createTeamLink, { body: { groupIds: [group], expiresInDays: 14, skillPath: GENERAL_DECK_SKILL } })
    expect(made.link!.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_CLEARED_KEY)
    expect(repointDeckLinks(h.ctx)).toBe(1)
    const after = await h.api('dana').call(API.getTeamLink)
    expect(after.link!.url).toBe(made.link!.url)
    expect(after.link!.skill).toMatchObject({ path: 'skills/notes/SKILL.md' })
    expect(h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'team_link.update' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ actor_id: null })
    // once: the owner points it at the deck again on purpose, it stays
    await h.api('dana').call(API.updateTeamLink, { body: { skillPath: GENERAL_DECK_SKILL } })
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
    // no landing skill (nothing shared, or the shared skill gone: an older version's welcome link to the deck after the
    // update, docs/DECISIONS.md "DS3"): the link names no skill any more, so people who join land on Home, keeping its
    // address; the run is recorded (never a link left on the deck for good)
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_CLEARED_KEY)
    const notes = path.join(h.team, 'skills/notes/SKILL.md')
    const text = fs.readFileSync(notes)
    fs.rmSync(notes)
    expect(landingSkill(h.ctx)).toBeNull()
    expect(repointDeckLinks(h.ctx)).toBe(1)
    const home = (await h.api('dana').call(API.getTeamLink)).link!
    expect(home.skill).toBeNull()
    expect(home.url).toBe(made.link!.url)
    expect(getSetting(h.ctx.db, DECK_LINKS_CLEARED_KEY)).toBeTruthy()
    expect(JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'team_link.update' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail))
      .toEqual({ skillPath: null, from: GENERAL_DECK_SKILL, reason: 'intro_deck_link' })
    // who joins now lands on Home, never on the deck's form
    const token = new URL(home.url!).hash.replace(/^#t=/, '')
    const joined = await h.req(null, '/api/team-link/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, username: 'deck-joiner', name: 'Deck Joiner', password: 'tulip meadow 2026' }) })
    expect(joined.status).toBe(201)
    expect(((await joined.json()) as { next: string | null }).next).toBeNull()
    // the next start: nothing again; the landing skill back: the owner's deck link from then on stays as it is
    fs.writeFileSync(notes, text)
    await h.api('dana').call(API.updateTeamLink, { body: { skillPath: GENERAL_DECK_SKILL } })
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_CLEARED_KEY)
    await h.api('dana').call(API.updateTeamLink, { body: { skillPath: 'skills/quote/SKILL.md' } })
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: 'skills/quote/SKILL.md' })
  })
  test('a server whose earlier release recorded the first run\'s mark (v0.4.0-beta.10) before its welcome steps made a deck link: the link is still cleared once, under its own mark', async () => {
    // beta.10 started with no deck link and recorded its mark; then the owner walked its welcome steps with nothing
    // shared, which made a link to the deck
    const old = '2026-11-06T00:00:00.000Z'
    setSetting(h.ctx.db, DECK_LINKS_KEY, old)
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_CLEARED_KEY)
    const notes = path.join(h.team, 'skills/notes/SKILL.md')
    const text = fs.readFileSync(notes)
    fs.rmSync(notes)
    try {
      expect(landingSkill(h.ctx)).toBeNull()
      await h.api('dana').call(API.updateTeamLink, { body: { skillPath: GENERAL_DECK_SKILL } })
      const before = (await h.api('dana').call(API.getTeamLink)).link!
      expect(before.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
      // the update's first start
      expect(repointDeckLinks(h.ctx)).toBe(1)
      const after = (await h.api('dana').call(API.getTeamLink)).link!
      expect(after.skill).toBeNull()
      expect(after.url).toBe(before.url)
      expect(h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'team_link.update' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ actor_id: null, target: after.id, detail: JSON.stringify({ skillPath: null, from: GENERAL_DECK_SKILL, reason: 'intro_deck_link' }) })
      expect(getSetting(h.ctx.db, DECK_LINKS_CLEARED_KEY)).toBeTruthy()
      // the old mark is left as it was; the next start does nothing
      expect(getSetting<string>(h.ctx.db, DECK_LINKS_KEY)).toBe(old)
      expect(repointDeckLinks(h.ctx)).toBe(0)
    } finally { fs.writeFileSync(notes, text) }
  })
})

describe('what a newcomer gets', () => {
  test('memberAi: ready with a team connection for them; connect_own when each signs in to their own; ask_owner when the team allows no own', async () => {
    // the harness answers with its engines' own sign-in (not managed): ready
    expect((await h.api('dana').call(API.getTeamLink)).link!.memberAi).toBe('ready')
    const managed = { db: h.ctx.db, config: { ...h.ctx.config, engine: { ...h.ctx.config.engine, authMode: 'managed' as const } } }
    const group = readWelcome(h.ctx)!.teamGroup!.id
    expect(newMemberAi(managed, [])).toBe('ready')
    // the team's connections only for another group: a newcomer of the team's group has none
    const other = (await h.api('dana').call(API.createGroup, { body: { name: 'Finance v5', memberIds: [] } })).id
    const creds = h.ctx.db.query('SELECT id FROM engine_credentials WHERE owner_user_id IS NULL').all() as { id: string }[]
    for (const c of creds) h.ctx.db.query("INSERT INTO engine_credential_assignments (credential_id, subject_type, subject_id) VALUES (?, 'group', ?)").run(c.id, other)
    try {
      expect(newMemberAi(managed, [group])).toBe('connect_own')
      expect(newMemberAi(managed, [other])).toBe('ready')
      setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
      expect(newMemberAi(managed, [group])).toBe('ask_owner')
    } finally {
      h.ctx.db.query('DELETE FROM engine_credential_assignments WHERE subject_id = ?').run(other)
      h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(MEMBER_OWN_KEY)
    }
  })
  test('a skill\'s own example (metadata example), one line; else the first request its description quotes', async () => {
    const write = (name: string, meta: string, description = `${name} — does the work. Ask "${name} 해 줘" to run it.`) => {
      fs.mkdirSync(path.join(h.team, `skills/${name}`), { recursive: true })
      fs.writeFileSync(path.join(h.team, `skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  title: ${name}\n${meta}---\n# x\n`)
    }
    write('with-example', '  example: 이번 주 회의록으로 내 할 일 정리해 줘\n')
    write('long-example', `  example: ${'가'.repeat(201)}\n`)
    write('list-example', '  example:\n    - a\n    - b\n')
    write('no-example', '')
    const items = (await h.api('bob').call(API.listSkills)).items
    const of = (n: string) => items.find((s) => s.name === n)
    expect(of('with-example')!.example).toBe('이번 주 회의록으로 내 할 일 정리해 줘')
    expect(of('long-example')!.example).toBeUndefined()
    // an example that is not text leaves the skill loading, without one
    expect(of('list-example')).toBeTruthy()
    expect(of('list-example')!.example).toBeUndefined()
    expect(skillExample(of('no-example')!)).toBe('no-example 해 줘')
    expect(skillExample(of('with-example')!)).toBe('이번 주 회의록으로 내 할 일 정리해 줘')
    // the general pack's intro deck quotes its requests
    expect(skillExample(items.find((s) => s.path === GENERAL_DECK_SKILL)!)).toBeTruthy()
  })
})
