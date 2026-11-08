// Onboarding v5, the owner's steps on the server (docs/DECISIONS.md "W5"; server/src/onboarding/welcome.ts,
// welcome-result.ts, goal.ts, auth/team-links.ts, credentials/access.ts, chat/skills.ts):
//   - the finish rule: 회사 소개 answered (put off; or saved with the deck started or a row's first result answered) and
//     내 스킬, 팀 파일 and the invite each done or put off, not while 내 스킬 waits for a computer; old rows (a)–(d);
//   - the intro deck starts once per team: its chat is kept for it and counts (resultChatId, deckStarted) only once its
//     message is in; a second start is then refused (409 deck_started) before anything is written; two at once get one
//     chat and their sends one message; a chat made whose message never went is handed out again;
//   - the skill everything points at (landingSkill): the first shared skill, else none (docs/DECISIONS.md "DS3": no
//     pack skill stands in), never the intro deck; the goal card names it (focusSkill) unless another skill that is
//     not the deck has more people; without one, the skill most people ran, never one the steps ran themselves (the
//     owner's deck);
//   - old open invite links to the intro deck are pointed once at the landing skill (once used up only when it could act);
//   - what AI a person who joins through the link has (memberAi), and a skill's own example (SkillInfo.example).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, deckMessageId, GENERAL_DECK_SKILL, skillExample, type WelcomeProgress } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { landingSkill, profileAnswered, readWelcome, recordShared, WELCOME_SETTING, welcomeFinished } from '../../server/src/onboarding/welcome'
import { focusSkill, goalProgress } from '../../server/src/onboarding/goal'
import { DECK_LINKS_KEY, repointDeckLinks } from '../../server/src/auth/team-links'
import { newMemberAi } from '../../server/src/credentials/access'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/policy'

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
  const all = { skills: 'done', files: 'skipped', invite: 'done' } as const
  test('회사 소개 answered: put off, or saved with the deck started or a first result answered; (a) a saved profile without either is open', () => {
    expect(profileAnswered(progress({ steps: { profile: 'skipped', result: null, ...all } }))).toBe(true)
    expect(profileAnswered(progress({ steps: { profile: 'done', result: null, ...all }, resultChatId: 'c1' }))).toBe(true)
    // (a) an old row: the profile saved, the first result never ran: 회사 소개's "저장하고 계속" starts the deck there
    expect(profileAnswered(progress({ steps: { profile: 'done', result: null, ...all } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: null, ...all } }))).toBe(false)
    // (b) the first result done with another chat (the card news): nothing special
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: 'done', ...all }, resultChatId: 'cardnews' }))).toBe(true)
    // (d) the first result put off: answered, no deck
    expect(welcomeFinished(progress({ steps: { profile: 'done', result: 'skipped', ...all } }))).toBe(true)
    expect(profileAnswered(progress({ steps: { profile: null, result: null, ...all } }))).toBe(false)
  })
  test('(c) recount: 내 스킬, 팀 파일 and the invite each answered; never while 내 스킬 waits for a computer', () => {
    const base = { profile: 'skipped', result: null } as const
    expect(welcomeFinished(progress({ steps: { ...base, skills: null, files: 'done', invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: undefined, invite: 'done' } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'done', files: 'done', invite: null } }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'skipped', files: 'done', invite: 'skipped' }, skillsLater: true }))).toBe(false)
    expect(welcomeFinished(progress({ steps: { ...base, skills: 'skipped', files: 'done', invite: 'skipped' } }))).toBe(true)
  })
  test('over the API: an old row (a) stays open until a deck starts; (d) finishes without one', async () => {
    const chat = (await h.api('dana').call(API.createChat, { body: {} })).id
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: null, skills: 'done', files: 'done', invite: null }, resultChatId: null, finishedAt: null })
    expect((await patch({ step: { id: 'invite', state: 'done' } })).finishedAt).toBeNull()
    // a chat that holds no message is no deck yet (the review of PR #100: recorded before the send, a closed tab or a
    // failed send left 회사 소개 answered with no deck)
    expect(await patch({ resultChatId: chat })).toMatchObject({ resultChatId: null, finishedAt: null })
    await send('dana', chat, `/intro-deck Make our company profile\n${fake({ say: 'Done.' })}`)
    expect((await patch({ resultChatId: chat })).finishedAt).not.toBeNull()
    // (a) put off on 회사 소개 ("나중에 하기"): the profile stays saved, the deck is put off (d), the step is answered
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: null, skills: null, files: null, invite: null }, resultChatId: null, finishedAt: null })
    const later = await patch({ step: { id: 'profile', state: 'skipped' } })
    expect(later.steps).toMatchObject({ profile: 'done', result: 'skipped' })
    expect(profileAnswered(later)).toBe(true)
    // a new row: 나중에 on 회사 소개 is the step put off, nothing else
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: null, result: null, skills: null, files: null, invite: null }, resultChatId: null, finishedAt: null })
    expect((await patch({ step: { id: 'profile', state: 'skipped' } })).steps).toMatchObject({ profile: 'skipped', result: null })
    setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: '2026-11-01T00:00:00.000Z', steps: { profile: 'done', result: 'skipped', skills: 'skipped', files: 'skipped', invite: null }, resultChatId: null, finishedAt: null })
    // the invite put off before is not brought back by anything any more
    const done = await patch({ step: { id: 'invite', state: 'skipped' } })
    expect(done).toMatchObject({ steps: { invite: 'skipped' }, resultChatId: null })
    expect(done.finishedAt).not.toBeNull()
    setSetting(h.ctx.db, WELCOME_SETTING, {})
  })
})

describe('the intro deck starts once per team', () => {
  const sendDeck = async (chatId: string, user = 'dana') => {
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content: `/intro-deck Make our company profile\n${fake({ say: 'Done.' })}`, clientMessageId: deckMessageId(chatId), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(r.turnId) as { status: string }).status !== 'running', { timeoutMs: 30_000 })
    return r
  }
  test('the start keeps its chat for the deck; it counts (resultChatId, deckStarted) only once its message is in; a second start then: 409 deck_started, nothing written', async () => {
    await patch({})
    await h.api('dana').call(API.setupWelcomeTeam)
    await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: [] } })
    const before = chatsOf('dana')
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    // kept, not counted: no message went yet
    expect(readWelcome(h.ctx)!.resultChatId).toBeNull()
    expect(getSetting<{ deckChatId?: string }>(h.ctx.db, WELCOME_SETTING)!.deckChatId).toBe(r.chatId)
    expect((await h.api('dana').call(API.getWelcome)).progress).toMatchObject({ resultChatId: null, deckStarted: false })
    // the page closed before the message went: the same chat again, with the same files to attach
    const again = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    expect(again.chatId).toBe(r.chatId)
    expect(again.files).toEqual(r.files)
    expect(chatsOf('dana')).toBe(before + 1)
    await sendDeck(r.chatId)
    // its message is in: the deck is recorded, and the end screen's fact says so
    expect(readWelcome(h.ctx)!.resultChatId).toBe(r.chatId)
    expect((await h.api('dana').call(API.getWelcome)).progress).toMatchObject({ resultChatId: r.chatId, deckStarted: true })
    // the deck started: saving 회사 소개 again only saves; the refusal comes before the team's start, pictures or files
    const intro = path.join(h.team, r.files[0]!)
    fs.rmSync(intro)
    const refused = await post('dana', '/api/onboarding/welcome/first-result', { files: [] })
    expect(refused.status).toBe(409)
    const body = await refused.json() as { error: { message: string; params: { reason: string } } }
    expect(body.error.params.reason).toBe('deck_started')
    expect(body.error.message).toMatch(/이미 만들기 시작했어요|already started/)
    expect(fs.existsSync(intro)).toBe(false)
    expect(chatsOf('dana')).toBe(before + 1)
  })
  test('two tabs at once: one chat, and their two sends one message (the same client message id: no generic conflict, no second deck); a third start: 409 deck_started', async () => {
    h.ctx.db.query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), readWelcome(h.ctx)!.resultChatId)
    const before = chatsOf('dana')
    const [a, b] = await Promise.all([h.api('dana').call(API.startFirstResult, { body: { files: [] } }), h.api('dana').call(API.startFirstResult, { body: { files: [] } })])
    expect(a.chatId).toBe(b.chatId)
    expect(chatsOf('dana')).toBe(before + 1)
    // the deleted deck is no deck any more; the new one counts once its message is in
    expect(readWelcome(h.ctx)!.resultChatId).toBeNull()
    const one = await h.api('dana').call(API.sendMessage, { params: { id: a.chatId }, body: { content: `/intro-deck A\n${fake({ say: 'Done.' })}`, clientMessageId: deckMessageId(a.chatId), attachmentIds: [] } })
    const two = await h.api('dana').call(API.sendMessage, { params: { id: b.chatId }, body: { content: `/intro-deck B\n${fake({ say: 'Done.' })}`, clientMessageId: deckMessageId(b.chatId), attachmentIds: [] } })
    expect(two.turnId).toBe(one.turnId)
    await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(one.turnId) as { status: string }).status !== 'running', { timeoutMs: 30_000 })
    expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'user'").get(a.chatId) as { n: number }).n).toBe(1)
    expect(readWelcome(h.ctx)!.resultChatId).toBe(a.chatId)
    const third = await post('dana', '/api/onboarding/welcome/first-result', { files: [] })
    expect(third.status).toBe(409)
    expect(((await third.json()) as { error: { params: { reason: string } } }).error.params.reason).toBe('deck_started')
  })

  test('old row (a), the tab closed or the send failed after 저장하고 계속: 회사 소개 stays open and not finished; the next start hands out the same chat; a row recorded the old way is read the same', async () => {
    const all = { skills: 'done', files: 'done', invite: 'done' } as const
    setSetting(h.ctx.db, WELCOME_SETTING, { ...getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!, steps: { profile: 'done', result: null, ...all }, resultChatId: null, deckChatId: undefined, finishedAt: null })
    const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
    // nothing was sent: any later save of the steps leaves them open, and the profile unanswered
    const p = await patch({ step: { id: 'invite', state: 'done' } })
    expect(p).toMatchObject({ resultChatId: null, finishedAt: null, deckStarted: false })
    expect(profileAnswered(p)).toBe(false)
    expect((await h.api('dana').call(API.startFirstResult, { body: { files: [] } })).chatId).toBe(r.chatId)
    // a row the earlier build wrote (the empty chat recorded as resultChatId) reads the same: open, the chat kept
    setSetting(h.ctx.db, WELCOME_SETTING, { ...getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!, resultChatId: r.chatId, deckChatId: undefined, finishedAt: null })
    expect(readWelcome(h.ctx)).toMatchObject({ resultChatId: null, finishedAt: null })
    expect(profileAnswered(readWelcome(h.ctx)!)).toBe(false)
    expect((await h.api('dana').call(API.startFirstResult, { body: { files: [] } })).chatId).toBe(r.chatId)
    // its message goes in: the next save finishes the steps
    await sendDeck(r.chatId)
    expect((await patch({ step: { id: 'invite', state: 'done' } })).finishedAt).not.toBeNull()
  })

  test('deckStarted is a fact: a first result of a row from before (a card news chat) is no deck; a deck build in the chat is', async () => {
    const raw = getSetting<Record<string, unknown>>(h.ctx.db, WELCOME_SETTING)!
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
  test('the goal card without a landing skill: never the owner\'s deck (nor any skill the steps\' first-result chat ran), so no skill until another one is run', async () => {
    expect(landingSkill(h.ctx)).toBeNull()
    // dana ran the deck above (in the steps\' own chat); carol runs it too: two people on the deck, nothing else run
    await send('carol', (await h.api('carol').call(API.createChat, { body: {} })).id, `/intro-deck\n${fake({ say: 'A deck' })}`)
    expect(focusSkill(h.ctx, goalProgress(h.ctx.db)!)).toBeNull()
    expect((await goal()).skill).toBeNull()
    // a skill run in the steps' first-result chat (an old row's card news) is the owner's onboarding run too
    const chat = readWelcome(h.ctx)!.resultChatId!
    expect(chat).toBeTruthy()
    skill('skills/cards/SKILL.md', 'cards', 'Cards')
    await send('dana', chat, `/cards\n${fake({ say: 'Cards' })}`)
    expect((await goal()).skill).toBeNull()
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
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_KEY)
    expect(repointDeckLinks(h.ctx)).toBe(1)
    const after = await h.api('dana').call(API.getTeamLink)
    expect(after.link!.url).toBe(made.link!.url)
    expect(after.link!.skill).toMatchObject({ path: 'skills/notes/SKILL.md' })
    expect(h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'team_link.update' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ actor_id: null })
    // once: the owner points it at the deck again on purpose, it stays
    await h.api('dana').call(API.updateTeamLink, { body: { skillPath: GENERAL_DECK_SKILL } })
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
    // a link to another skill is never touched; a landing skill a newcomer cannot open: the link stays
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_KEY)
    const tasks = path.join(h.team, 'skills/notes/SKILL.md')
    const text = fs.readFileSync(tasks)
    fs.rmSync(tasks)
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: GENERAL_DECK_SKILL })
    // no landing skill at that start: the once is not used up, the next start tries again (the review of PR #100: the
    // links stayed on the deck for good)
    expect(getSetting(h.ctx.db, DECK_LINKS_KEY)).toBeFalsy()
    fs.writeFileSync(tasks, text)
    expect(repointDeckLinks(h.ctx)).toBe(1)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: 'skills/notes/SKILL.md' })
    expect(getSetting(h.ctx.db, DECK_LINKS_KEY)).toBeTruthy()
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(DECK_LINKS_KEY)
    await h.api('dana').call(API.updateTeamLink, { body: { skillPath: 'skills/quote/SKILL.md' } })
    expect(repointDeckLinks(h.ctx)).toBe(0)
    expect((await h.api('dana').call(API.getTeamLink)).link!.skill).toMatchObject({ path: 'skills/quote/SKILL.md' })
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
