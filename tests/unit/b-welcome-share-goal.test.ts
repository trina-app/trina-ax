// The first result's [팀에 공유] shares the skill that made it, never a copy (docs/DECISIONS.md "W2 — AI connection
// first"; the bar is web/src/components/onboarding/WelcomeInviteBar.tsx): the 7-day goal counts runs per team skill
// PATH (server/src/onboarding/goal.ts), so the owner's first result and a member's run through the invite must run the
// same file. End to end on the real server with the fake engine: the owner's card news (the real first-result start,
// "/card-news …" with the intro attached, as pages/Welcome.tsx sends it), the link the invite makes in advance (the
// card news skill, the team's group), a member who joins with it, lands on its form and runs it; the goal says 2/3.
// A copy of the skill under another path counts on its own (why the first result no longer drafts one).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, GENERAL_CARDNEWS_SKILL, isChoice, type SkillInfo } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(90_000)

let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-welcome-share-goal' }) })
afterAll(async () => { await h?.close() })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** one message in a chat of `user`, waited for until its turn ended (the goal reads finished turns) */
const send = async (user: string, chatId: string, content: string, attachmentIds: string[] = []) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds } })
  await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(r.turnId) as { status: string }).status !== 'running', { timeoutMs: 30_000 })
  return r.turnId as string
}
const runs = (turnId: string) => h.ctx.db.query('SELECT skill_path AS path, source FROM turn_skill_runs WHERE turn_id = ?').all(turnId)
/** what a skill form sends (web/src/lib/skillForm.ts composeSkillMessage): "/name", then each filled field */
const formMessage = (s: SkillInfo) => [`/${s.name}`, ...(s.inputs ?? []).flatMap((i) => (isChoice(i) && i.default ? [`${i.label}: ${i.options.find((o) => o.value === i.default)!.label}`] : []))].join('\n')

test('the owner\'s first result and a member\'s run through the invite are the same skill: the goal says 2/3', async () => {
  // the welcome steps up to the first result (the owner, dana): the team's start and a confirmed profile
  await h.api('dana').call(API.updateWelcome, { body: {} })
  const team = (await h.api('dana').call(API.setupWelcomeTeam)).progress.teamGroup!
  await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: [] } })
  const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
  expect(r.skillPath).toBe(GENERAL_CARDNEWS_SKILL)
  const attached = await Promise.all(r.files.map((p) => h.api('dana').call(API.attachTeamFile, { body: { chatId: r.chatId, path: p } })))
  const owner = await send('dana', r.chatId, `/card-news Make five promo cards for our company\n${fake({ say: 'Five cards' })}`, attached.map((a) => a.id))
  expect(runs(owner)).toEqual([{ path: GENERAL_CARDNEWS_SKILL, source: 'command' }])
  // the answer's receipt names that path: the bar under it shares exactly this file
  const answer = (await h.api('dana').call(API.listMessages, { params: { id: r.chatId } })).items.find((m) => m.role === 'assistant')!
  expect(answer.receipt?.skill.path).toBe(GENERAL_CARDNEWS_SKILL)

  // a copy of the skill (what "팀 스킬로 저장" drafted before) is another path: a run of it is another skill's run
  const copy = 'skills/general/promo-cards-copy/SKILL.md'
  const text = fs.readFileSync(path.join(h.team, GENERAL_CARDNEWS_SKILL), 'utf8').replace('name: card-news', 'name: promo-cards-copy')
  fs.mkdirSync(path.join(h.team, path.dirname(copy)), { recursive: true })
  fs.writeFileSync(path.join(h.team, copy), text)
  const bobChat = (await h.api('bob').call(API.createChat, { body: {} })).id
  expect(runs(await send('bob', bobChat, `/promo-cards-copy\n${fake({ say: 'Five cards' })}`))).toEqual([{ path: copy, source: 'command' }])
  let goal = (await h.api('dana').call(API.getTeamGoal)).goal!
  expect(goal.skill).toMatchObject({ runners: 1 })

  // [팀에 공유]: the link the invite makes in advance carries the skill that ran, and the team's own group
  const made = await h.api('dana').call(API.createTeamLink, { body: { groupIds: [team.id], expiresInDays: 14, skillPath: answer.receipt!.skill.path } })
  expect(made.link!.skill).toMatchObject({ path: GENERAL_CARDNEWS_SKILL })
  const token = new URL(made.link!.url!).hash.replace(/^#t=/, '')
  const joined = await h.req(null, '/api/team-link/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, username: 'minji', name: 'Minji', password: 'tulip meadow 2026' }) })
  expect(joined.status).toBe(201)
  const j = await joined.json() as { me: { user: { id: string } }; next: string | null; starter: unknown; skillBy: string | null }
  // the member lands on the pack skill's form: no files with the link, no maker (a starter pack's own text)
  expect(j.next).toBe(`/skills?run=${encodeURIComponent(GENERAL_CARDNEWS_SKILL)}`)
  expect(j.starter).toBeNull()
  expect(j.skillBy).toBeNull()
  addTestPerson('minji', { id: j.me.user.id, name: 'Minji', role: 'member', locale: 'en' })
  // the form of that skill as the member's list has it, run the way the form runs it, in a new chat of theirs
  const skill = (await h.api('minji').call(API.listSkills)).items.find((s) => s.path === GENERAL_CARDNEWS_SKILL)!
  expect(skill.inputs?.length).toBeGreaterThan(0)
  const memberChat = (await h.api('minji').call(API.createChat, { body: {} })).id
  const member = await send('minji', memberChat, `${formMessage(skill)}\n${fake({ say: 'Five cards' })}`)
  expect(runs(member)).toEqual([{ path: GENERAL_CARDNEWS_SKILL, source: 'command' }])

  // the goal: the card news, the owner and the member (the copy's run stays its own)
  goal = (await h.api('dana').call(API.getTeamGoal)).goal!
  expect(goal.state).toBe('open')
  expect(goal.skill).toEqual({ path: GENERAL_CARDNEWS_SKILL, name: 'Promo cards', runners: 2, people: ['Dana Choi', 'Minji'] })
  expect(`${goal.skill!.runners}/${goal.target}`).toBe('2/3')
})
