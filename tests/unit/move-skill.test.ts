// Moving a skill between levels (server/src/skills/move.ts, docs/DECISIONS.md "Project skills"): the AI's move_skill
// and the Skills page's 옮기기… (GET / POST /api/skills/move). Write on both places, no skill of that name at the target,
// a SKILL.md folder for a project, no wider skill of the name for a project; counts of who gains and who loses it; the
// AI only narrows, after a card that lists every file, its yes bound to every file's hash; refused in scheduled runs, not
// offered in rooms or shared chats; "not a project yet" for a plain folder; audited with both levels and the counts.
//
// Fixture (tests/lib/fixtures.ts): projects/falcon is alice's (write) and finance's (bob, read). alice + erin =
// marketing, bob = finance, carol = admin, dana = owner. Everyone reads skills/, admins write it.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { levelsOf, moveOptions, planMove, runMove, skillAt } from '../../server/src/skills/move'
import { ROOM_TOOLS, SHARED_TOOLS } from '../../server/src/rooms/ai-tools'
import { PARENT_ONLY_TOOLS } from '../../server/src/chat/subagents'

setDefaultTimeout(60_000)

const FALCON = '01900000-0000-7000-8000-00000000f002'
const md = (name: string, description: string, body = 'steps') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

function setup(db: import('bun:sqlite').Database, team: string) {
  for (const g of ['marketing', 'finance']) db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?').run(`groups/${g}`, g)
  db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(FALCON, 'Falcon', 'projects/falcon', 'alice', new Date().toISOString())
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(team, rel)), { recursive: true }); fs.writeFileSync(path.join(team, rel), text) }
  put('skills/ops/SKILL.md', md('ops', 'team ops runbook', 'OPS-BODY-CANARY'))
  put('skills/ops/references/checklist.md', '- check\n')
  put('skills/quote/SKILL.md', md('quote', 'team quote'))
  put('groups/marketing/skills/brief/SKILL.md', md('brief', 'marketing brief', 'BRIEF-BODY-CANARY'))
  put('projects/falcon/skills/launch/SKILL.md', md('launch', 'falcon launch'))
  put('users/alice/skills/launch/SKILL.md', md('launch', 'my launch'))
  put('users/alice/skills/quote/SKILL.md', md('quote', 'my quote'))
  put('users/alice/skills/memo.md', md('Memo', 'a single file'))
  put('users/bob/skills/notes/SKILL.md', md('notes', 'bob notes'))
  fs.mkdirSync(path.join(team, 'shared/plans'), { recursive: true })
}

describe('the plan: where it may go, who gains and who loses it', () => {
  const e = makeEnv('move-skill')
  setup(e.db, e.fx.team)
  afterAll(() => e.db.close())
  const ctx = { db: e.db, files: e.files } as never
  const who = (id: string) => e.files.principal(id)
  const to = (user: string, level: string) => levelsOf(ctx, who(user)).find((l) => l.level === level)!
  const plan = (user: string, rel: string, level: string) => planMove(ctx, who(user), skillAt(ctx, who(user), rel)!, to(user, level), 'en')

  test('write is needed on both sides', () => {
    // bob reads the project only: his own skill cannot go in
    expect(plan('bob', 'users/bob/skills/notes/SKILL.md', 'project').blocked).toEqual({ key: 'moveNoWrite', vars: { where: 'Falcon project chats' } })
    // alice may not write skills/: a team skill cannot leave it by her hand
    expect(plan('alice', 'skills/ops/SKILL.md', 'personal').blocked).toEqual({ key: 'moveNoWrite', vars: { where: 'whole team' } })
    // carol (admin) writes both
    expect(plan('carol', 'skills/ops/SKILL.md', 'project').blocked).toBeNull()
  })

  test('a name already at the target is refused; a project gets SKILL.md folders only, and never a name a wider one has', () => {
    expect(plan('alice', 'users/alice/skills/launch/SKILL.md', 'project').blocked).toEqual({ key: 'moveTaken', vars: { to: 'Falcon project chats', name: 'launch' } })
    expect(plan('alice', 'users/alice/skills/memo.md', 'project').blocked?.key).toBe('moveNotFolder')
    // the team has "quote": in the project it would never run
    expect(plan('alice', 'users/alice/skills/quote/SKILL.md', 'project').blocked).toEqual({ key: 'moveHidden', vars: { name: 'quote', where: 'the whole team' } })
  })

  test('the counts: who gets it at each level, who gains and who loses it', () => {
    const p = plan('carol', 'skills/ops/SKILL.md', 'project')
    const readers = ['alice', 'bob', 'carol', 'dana', 'erin'].filter((u) => e.files.rules().access(who(u), ['projects', 'falcon']) !== 'none')
    expect(p.fromPeople).toBe(5)
    expect(p.toPeople).toBe(readers.length)
    expect(p.gained).toBe(0)
    expect(p.lost).toBe(5 - readers.length)
    expect(p.files.map((f) => f.path)).toEqual(['skills/ops/SKILL.md', 'skills/ops/references/checklist.md'])
    // the group's skill to the whole team: more people
    const wider = plan('alice', 'groups/marketing/skills/brief/SKILL.md', 'team')
    expect(wider.gained).toBe(3)
  })

  test('GET /api/skills/move: every other level, the whole text, a token only where it may go', () => {
    const o = moveOptions(ctx, 'carol', 'skills/ops/SKILL.md', 'en')
    expect(o.from).toEqual({ label: 'whole team', people: 5, level: 'team' })
    expect(o.text).toContain('OPS-BODY-CANARY')
    expect(o.targets.map((x) => x.to.level).sort()).toEqual(['personal', 'project'])
    for (const x of o.targets) expect(!!x.token).toBe(!x.blocked)
    // a skill the caller does not have: not found (no oracle)
    expect(() => moveOptions(ctx, 'bob', 'users/alice/skills/launch/SKILL.md', 'en')).toThrow()
  })
})

describe('in the app: the Skills page and the AI', () => {
  let h: Harness
  const socks: Record<string, TestSocket> = {}
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const cm = () => 'cm-' + crypto.randomUUID()
  const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { return (e as { status: number }).status } }
  beforeAll(async () => {
    h = await startHarness({ name: 'move-skill-app', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
    setup(h.ctx.db, h.team)
    for (const u of ['alice', 'carol', 'dana']) {
      socks[u] = await h.ws(u, { windowId: `win-ms-${u}` })
      await socks[u]!.next('hello')
    }
  })
  afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

  async function turn(user: string, content: string, o: { project?: boolean; answer?: string | null; meanwhile?: () => void } = {}) {
    const chat = await h.api(user).call(API.createChat, { body: o.project === false ? {} : { projectId: FALCON } })
    const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    let card = null as { question: string; details?: { label: string; text: string }[]; note?: string } | null
    if (o.answer !== undefined) {
      const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
      card = c.data.request as unknown as NonNullable<typeof card>
      o.meanwhile?.()
      if (o.answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: o.answer } })
    }
    const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string, card }
  }
  const moveCall = (args: Record<string, unknown>) => fake({ tool: 'move_skill', args, sayResult: true })

  test('the AI widens nothing: a move that gives the skill to anyone new is refused without a card', async () => {
    // alice's own skill to her group: erin would get it too
    const r = await turn('alice', moveCall({ skill: 'launch', to: 'group', group: 'Marketing' }))
    expect(r.content).toContain('You can only move a skill where fewer people get it')
    expect(r.content).toContain('Skills page')
    expect(fs.existsSync(path.join(h.team, 'users/alice/skills/launch/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'groups/marketing/skills/launch'))).toBe(false)
  })

  test('a plain folder is not a project yet; a name that is no group of the user is refused', async () => {
    const r = await turn('carol', moveCall({ skill: 'ops', to: 'project', project: 'shared/plans' }))
    expect(r.content).toContain('is not a project yet')
    expect(r.content).toContain('Do not make a skills folder, a README or a copy there instead')
    const g = await turn('carol', moveCall({ skill: 'ops', to: 'group', group: 'Finance' }))
    expect(g.content).toContain('is not one of the user\'s groups')
  })

  test('declined: nothing moves, and it is audited', async () => {
    const r = await turn('carol', moveCall({ skill: 'ops', to: 'project' }), { answer: 'skip' })
    // the card is in the person's language (the fixture's people read Korean)
    expect(r.card!.question).toMatch(/"ops" 스킬을 옮길까요\?\n\n팀 전체 5명 → Falcon 프로젝트 채팅 \d+명/)
    expect(r.content).toContain('did not allow moving')
    expect(fs.existsSync(path.join(h.team, 'skills/ops/SKILL.md'))).toBe(true)
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'skills.move_refused' AND target = 'skills/ops/SKILL.md'").get()).toEqual({ n: 1 })
  })

  test('the card is bound to every file: one changed after it is shown, nothing moves', async () => {
    const r = await turn('carol', moveCall({ skill: 'ops', to: 'project' }), { answer: 'move', meanwhile: () => fs.writeFileSync(path.join(h.team, 'skills/ops/references/checklist.md'), '- check\n- PLANTED\n') })
    expect(r.content).toContain('Not moved')
    expect(r.content).toContain('changed after the card was shown')
    expect(fs.existsSync(path.join(h.team, 'skills/ops/SKILL.md'))).toBe(true)
  })

  test('moved after yes: the card says who loses it and lists every file; audited with both levels and counts; announced', async () => {
    const r = await turn('carol', moveCall({ skill: 'ops', to: 'project' }), { answer: 'move' })
    const m = /팀 전체 5명 → Falcon 프로젝트 채팅 (\d+)명/.exec(r.card!.question)!
    const lost = 5 - Number(m[1])
    expect(r.card!.question).toContain(`${lost}명은 이 스킬을 더 쓰지 않아요.`)
    expect(r.card!.details![0]!.text).toContain('skills/ops/SKILL.md')
    expect(r.card!.details![0]!.text).toContain('skills/ops/references/checklist.md')
    // a narrower way, for a team skill: its folder's permissions
    expect(r.card!.note).toContain('skills/ops/')
    expect(r.content).toContain('Moved the skill "ops" from whole team (5 people) to Falcon project chats')
    expect(fs.existsSync(path.join(h.team, 'projects/falcon/skills/ops/SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'projects/falcon/skills/ops/references/checklist.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'skills/ops'))).toBe(false)
    const a = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'skills.move' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; target: string; detail: string }
    expect({ actor: a.actor_id, target: a.target }).toEqual({ actor: 'carol', target: 'projects/falcon/skills/ops/SKILL.md' })
    expect(JSON.parse(a.detail)).toMatchObject({ name: 'ops', from: { level: 'team', people: 5, path: 'skills/ops/SKILL.md' }, to: { level: 'project', project: { id: FALCON, name: 'Falcon' }, people: 5 - lost }, gained: 0, lost, files: 2, byAi: true })
    // each file's move is a skill change (where it went, with the project); the owner hears of it
    const change = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'skills.change' AND target LIKE 'projects/falcon/skills/ops%' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(change.detail)).toMatchObject({ change: 'move', byAi: true, project: { id: FALCON, name: 'Falcon' } })
    await socks.dana!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.message.includes('projects/falcon/skills/ops'))
    // in the project's chats now, as the project's
    expect((await h.api('alice').call(API.listSkills, { query: { projectId: FALCON } })).items.find((s) => s.name === 'ops')?.project?.id).toBe(FALCON)
  })

  test('the Skills page: the move as seen; a stale token or a blocked target is a 409', async () => {
    const o = await h.api('alice').call(API.skillMoveOptions, { query: { path: 'groups/marketing/skills/brief/SKILL.md' } })
    const team = o.targets.find((x) => x.to.level === 'team')!
    expect(team.blocked).toContain('You cannot write to whole team')
    const mine = o.targets.find((x) => x.to.level === 'personal')!
    expect(mine.token).toBeTruthy()
    expect(o.text).toContain('BRIEF-BODY-CANARY')
    // the file changes after the dialog showed it
    fs.appendFileSync(path.join(h.team, 'groups/marketing/skills/brief/SKILL.md'), 'more\n')
    expect(await status(h.api('alice').call(API.moveSkill, { body: { path: o.path, to: mine.to, token: mine.token! } }))).toBe(409)
    const again = await h.api('alice').call(API.skillMoveOptions, { query: { path: o.path } })
    const done = await h.api('alice').call(API.moveSkill, { body: { path: o.path, to: { level: 'personal' }, token: again.targets.find((x) => x.to.level === 'personal')!.token! } })
    expect(done.path).toBe('users/alice/skills/brief/SKILL.md')
    // a person's own folder is never named in the audit log
    const a = h.ctx.db.query("SELECT target, detail FROM audit_log WHERE action = 'skills.move' ORDER BY id DESC LIMIT 1").get() as { target: string; detail: string }
    expect(a.target).toBe('groups/marketing/skills/brief/SKILL.md')
    expect(JSON.parse(a.detail).to).toMatchObject({ level: 'personal', path: null })
    expect(await status(h.api('alice').call(API.moveSkill, { body: { path: 'skills/quote/SKILL.md', to: { level: 'personal' }, token: 'x' } }))).toBe(409)
  })

  test('refused in a scheduled run; not offered in rooms, shared chats or sub-agents', async () => {
    expect(ROOM_TOOLS.has('move_skill')).toBe(false)
    expect(SHARED_TOOLS.has('move_skill')).toBe(false)
    expect(PARENT_ONLY_TOOLS.has('move_skill')).toBe(true)
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('carol', { title: 'Tidy skills', prompt: moveCall({ skill: 'quote', to: 'personal' }), repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get('carol', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { content: string }
    expect(answer.content).toContain('a scheduled run has nobody to confirm the card')
    expect(fs.existsSync(path.join(h.team, 'skills/quote/SKILL.md'))).toBe(true)
  })

  test('the file tools refuse skill folders and point at move_skill', async () => {
    const r = await turn('carol', fake({ tool: 'move_files', args: { paths: ['skills/quote'], to_folder: 'projects/falcon/skills' }, sayResult: true }))
    expect(r.content).toContain('Skills do not move with files')
    expect(r.content).toContain('move_skill')
    expect(r.content).toContain('Never make a skills folder, a README or a copy')
  })
})
