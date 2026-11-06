// The skill everything points at (docs/DECISIONS.md "W5"; before it "W2 — AI connection first" shared the first
// result's skill): the invite, the goal card and the end screen name the LANDING skill (onboarding/welcome.ts
// landingSkill: the first shared skill, else the general pack's 할 일 정리), never the intro deck, which is the owner's
// own first run. The 7-day goal counts runs per team skill PATH (server/src/onboarding/goal.ts), so the owner's run
// from the end screen and a member's run through the invite must run the same file. End to end on the real server
// with the fake engine: the owner's intro deck (the real first-result start, run once; a second start is refused), the
// goal naming the landing skill with nobody yet even though the deck has the owner's run, the link carrying the
// landing skill, a member who joins with it, lands on its form and runs it, the owner's own run; the goal says 2/3.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, GENERAL_DECK_SKILL, GENERAL_TASKS_SKILL, isChoice, type SkillInfo } from '@mycel/shared/api'
import { landingSkill } from '../../server/src/onboarding/welcome'
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

test('the owner\'s deck never takes the landing skill\'s place: the invite and the goal name 할 일 정리, the owner\'s and a member\'s runs make 2/3', async () => {
  // the welcome steps up to 회사 소개 (the owner, dana): the team's start and a confirmed profile
  await h.api('dana').call(API.updateWelcome, { body: {} })
  const team = (await h.api('dana').call(API.setupWelcomeTeam)).progress.teamGroup!
  await h.api('dana').call(API.saveCompanyProfile, { body: { website: 'https://www.acme.example/', name: 'Acme', oneLine: 'Quiet desk fans', products: 'Desk fans', audience: '', tone: [], avoid: '', sources: [], colors: [] } })
  // "저장하고 계속" starts the deck, as pages/Welcome.tsx sends it
  const r = await h.api('dana').call(API.startFirstResult, { body: { files: [] } })
  expect(r.skillPath).toBe(GENERAL_DECK_SKILL)
  const attached = await Promise.all(r.files.map((p) => h.api('dana').call(API.attachTeamFile, { body: { chatId: r.chatId, path: p } })))
  const owner = await send('dana', r.chatId, `/intro-deck Make our company profile\n${fake({ say: 'I made a company profile for Acme.' })}`, attached.map((a) => a.id))
  expect(runs(owner)).toEqual([{ path: GENERAL_DECK_SKILL, source: 'command' }])
  // saving 회사 소개 again starts no second deck
  const again = await h.req('dana', '/api/onboarding/welcome/first-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [] }) })
  expect(again.status).toBe(409)
  expect((await again.json() as { error: { params: { reason: string } } }).error.params.reason).toBe('deck_started')

  // nothing shared: the landing skill is 할 일 정리; the goal names it with nobody yet, not the deck the owner ran
  expect(landingSkill(h.ctx)).toBe(GENERAL_TASKS_SKILL)
  let goal = (await h.api('dana').call(API.getTeamGoal)).goal!
  expect(goal.skill).toMatchObject({ path: GENERAL_TASKS_SKILL, runners: 0 })

  // the invite (O5): the link carries the landing skill and the team's own group
  const made = await h.api('dana').call(API.createTeamLink, { body: { groupIds: [team.id], expiresInDays: 14, skillPath: GENERAL_TASKS_SKILL } })
  expect(made.link!.skill).toMatchObject({ path: GENERAL_TASKS_SKILL })
  const token = new URL(made.link!.url!).hash.replace(/^#t=/, '')
  const joined = await h.req(null, '/api/team-link/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, username: 'minji', name: 'Minji', password: 'tulip meadow 2026' }) })
  expect(joined.status).toBe(201)
  const j = await joined.json() as { me: { user: { id: string } }; next: string | null; starter: unknown; skillBy: string | null }
  // the member lands on the landing skill's form: no files with the link, no maker (a starter pack's own text)
  expect(j.next).toBe(`/skills?run=${encodeURIComponent(GENERAL_TASKS_SKILL)}`)
  expect(j.starter).toBeNull()
  addTestPerson('minji', { id: j.me.user.id, name: 'Minji', role: 'member', locale: 'en' })
  // the form of that skill as the member's list has it, run the way the form runs it, in a new chat of theirs
  const skill = (await h.api('minji').call(API.listSkills)).items.find((s) => s.path === GENERAL_TASKS_SKILL)!
  expect(skill.inputs?.length).toBeGreaterThan(0)
  const memberChat = (await h.api('minji').call(API.createChat, { body: {} })).id
  expect(runs(await send('minji', memberChat, `${formMessage(skill)}\n${fake({ say: 'Your tasks' })}`))).toEqual([{ path: GENERAL_TASKS_SKILL, source: 'command' }])
  goal = (await h.api('dana').call(API.getTeamGoal)).goal!
  expect(goal.skill).toMatchObject({ path: GENERAL_TASKS_SKILL, runners: 1 })

  // the owner's own run from the end screen ("'할 일 정리' 먼저 써 보기"): the same skill, the same path
  const own = (await h.api('dana').call(API.createChat, { body: {} })).id
  const danaSkill = (await h.api('dana').call(API.listSkills)).items.find((s) => s.path === GENERAL_TASKS_SKILL)!
  await send('dana', own, `${formMessage(danaSkill)}\n${fake({ say: 'Your tasks' })}`)
  goal = (await h.api('dana').call(API.getTeamGoal)).goal!
  expect(goal.state).toBe('open')
  expect(goal.skill).toMatchObject({ path: GENERAL_TASKS_SKILL, runners: 2, people: ['Minji', 'Dana Choi'] })
  expect(`${goal.skill!.runners}/${goal.target}`).toBe('2/3')
})
