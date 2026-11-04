// Onboarding stream G: the 7-day team goal (server/src/onboarding/goal.ts, shared/src/api/onboarding-goal.ts). What
// counts (successful answers, "/name" and the skill tool, never a plain read, never a personal skill, deleted people
// still, the 7-day window, no scheduled runs), the card's visibility for a new and an older team, the owners' notice
// once per member per skill, and the runs recorded by real turns with the fake engine.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, GOAL_PEOPLE } from '@mycel/shared/api'
import { makeEnv, WORK } from '../lib/env'
import { recordSkillRead, recordSkillUse } from '../../server/src/admin/skill-usage'
import { goalProgress, GOAL_SHOWN_KEY, noteGoalRun, REACHED_GRACE_MS, skillRunners } from '../../server/src/onboarding/goal'
import { skillTitle } from '../../server/src/onboarding/goal-names'
import { migrate, MIGRATIONS_DIR, openDb } from '../../server/src/db'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { startHarness, type Harness as ChatHarness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const DAY = 86_400_000
const START = '2026-11-01T00:00:00.000Z'
const at = (days: number) => new Date(Date.parse(START) + days * DAY).toISOString()

describe('counting', () => {
  const env = makeEnv('b-onboarding-goal-count')
  const db = env.db
  const AD = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy' }
  const SEO = { path: 'skills/marketing/seo-brief/SKILL.md', name: 'seo-brief' }
  let n = 0
  /** a turn of `user` with its status and start; `skill` run by "/name" (command), the skill tool or a plain read */
  const turn = (user: string, o: { status?: string; day?: number; skill?: typeof AD; source?: 'command' | 'tool' | 'read'; schedule?: boolean } = {}) => {
    const id = `goal-${++n}`
    db.query('INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'c', user, 'claude-code', o.status ?? 'done', at(o.day ?? 1), o.schedule ? 'sched-1' : null)
    if (o.skill) recordSkillUse(db, { turnId: id, userId: user, skill: o.skill, source: o.source ?? 'command' })
    return id
  }
  const progress = () => goalProgress(db)!
  beforeEach(() => {
    db.query("DELETE FROM turns WHERE id LIKE 'goal-%'").run()
    // the fixture's five people (alice, bob, erin members, carol admin, dana owner), all made at the team's start
    db.query("UPDATE users SET created_at = ?, status = 'active', deleted_at = NULL").run(START)
  })

  test('the window starts at the first account, deleted ones included, and lasts 7 days', () => {
    db.query("UPDATE users SET created_at = ? WHERE id = 'dana'").run(at(-2))
    db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = 'dana'").run(at(1))
    expect(progress()).toMatchObject({ startedAt: at(-2), endsAt: at(5) })
  })

  test('only successful answers count: an error, a stop or an interrupted answer do not', () => {
    turn('alice', { status: 'error', skill: AD })
    turn('bob', { status: 'stopped', skill: AD })
    turn('carol', { status: 'interrupted', skill: AD })
    turn('erin', { status: 'running', skill: AD })
    expect(progress()).toMatchObject({ best: null, reachedAt: null, peopleWithRun: 0, peopleAnswered: 0 })
    turn('alice', { skill: AD })
    expect(progress()).toMatchObject({ best: { path: AD.path, people: [{ userId: 'alice' }] }, peopleWithRun: 1, peopleAnswered: 1 })
  })

  test('"/name" and the skill tool are runs; a plain read of the file is not (Admin › Usage still sees all three)', () => {
    fs.mkdirSync(path.join(env.fx.team, path.dirname(AD.path)), { recursive: true })
    fs.writeFileSync(path.join(env.fx.team, AD.path), '---\nname: ad-copy\ndescription: 광고 문구 — 광고 문구 3안을 써요.\nmetadata:\n  title: 광고 문구\n---\nWrite.\n')
    const read = turn('alice')
    recordSkillRead(db, env.files, env.files.principal('alice'), read, AD.path)
    turn('bob', { skill: AD, source: 'read' })
    const tool = turn('carol', { skill: AD, source: 'tool' })
    const command = turn('dana', { skill: AD, source: 'command' })
    expect(skillRunners(db, START, at(7)).map((s) => s.people.map((p) => p.userId))).toEqual([['carol', 'dana']])
    expect(db.query('SELECT turn_id, source FROM turn_skill_runs ORDER BY turn_id').all()).toEqual([{ turn_id: tool, source: 'tool' }, { turn_id: command, source: 'command' }])
    // turn_skill_usage keeps its two sources: the skill tool is a 'read' there, as before
    expect(db.query("SELECT source, COUNT(*) AS n FROM turn_skill_usage WHERE turn_id LIKE 'goal-%' GROUP BY source ORDER BY source").all())
      .toEqual([{ source: 'command', n: 1 }, { source: 'read', n: 3 }])
    // people who answered at all: the plain readers too
    expect(progress().peopleAnswered).toBe(4)
  })

  test('personal skills are never runs, not even under a team skill\'s name', () => {
    turn('alice', { skill: { path: 'users/alice/skills/ad-copy/SKILL.md', name: 'ad-copy' } })
    turn('bob', { skill: { path: 'users/bob/skills/ad-copy/SKILL.md', name: 'ad-copy' }, source: 'tool' })
    expect(progress()).toMatchObject({ best: null, peopleWithRun: 0 })
  })

  test('two skills with two people each: not reached', () => {
    turn('alice', { skill: AD }); turn('bob', { skill: AD })
    turn('carol', { skill: SEO }); turn('dana', { skill: SEO, source: 'tool' })
    // the same person twice is one person
    turn('alice', { skill: AD, day: 2 })
    const p = progress()
    expect(p.reachedAt).toBeNull()
    expect(p.best?.people).toHaveLength(2)
    expect(p.peopleWithRun).toBe(4)
    // the tie goes to the skill that got to two people first
    expect(p.best?.path).toBe(AD.path)
  })

  test('three people with the same skill (the owner included): reached when the third one ran it', () => {
    turn('dana', { skill: AD, day: 0.5 })
    turn('alice', { skill: AD, day: 1 })
    turn('bob', { skill: SEO, day: 2 })
    turn('erin', { skill: AD, day: 3, source: 'tool' })
    const p = progress()
    expect(p.best?.people.map((x) => x.userId)).toEqual(['dana', 'alice', 'erin'])
    expect(p.reachedAt).toBe(at(3))
    expect(GOAL_PEOPLE).toBe(3)
  })

  test('people deleted later still count', () => {
    turn('alice', { skill: AD }); turn('bob', { skill: AD }); turn('erin', { skill: AD })
    db.query("UPDATE users SET status = 'disabled', deleted_at = ?, username = 'erin#deleted' WHERE id = 'erin'").run(at(4))
    expect(progress().reachedAt).not.toBeNull()
  })

  test('outside the 7 days, and scheduled runs, do not count', () => {
    turn('alice', { skill: AD }); turn('bob', { skill: AD })
    turn('carol', { skill: AD, day: 7 })
    turn('dana', { skill: AD, day: 3, schedule: true })
    expect(progress()).toMatchObject({ reachedAt: null, peopleWithRun: 2 })
    turn('erin', { skill: AD, day: 6.99 })
    expect(progress().reachedAt).toBe(at(6.99))
  })

  test('a skill\'s plain name: its metadata title, else its name (never guessed from the description)', () => {
    expect(skillTitle({ name: 'ad-copy', title: '광고 문구' })).toBe('광고 문구')
    expect(skillTitle({ name: 'Weekly report' })).toBe('Weekly report')
    expect(skillTitle({ name: 'x', title: '  ' })).toBe('x')
    // a skill written before titles, with the pack's "광고 문구 — …" description, shows its name
    expect(skillTitle({ name: 'ad-copy', ...{ description: '광고 문구 — 알릴 제품과 실을 곳을 받아 …' } })).toBe('ad-copy')
  })

  test('migration 223 brings earlier "/name" runs over from turn_skill_usage, never a read', () => {
    const dir = path.join(WORK, `b-onboarding-goal-mig-${process.pid}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, 'm'), { recursive: true })
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && Number(f.slice(0, 3)) < 223) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, 'm', f))
    const old = openDb(path.join(dir, 'app.db'), { migrationsDir: path.join(dir, 'm') })
    old.query("INSERT INTO users (id, username, name, role) VALUES ('olga', 'olga', 'Olga', 'owner')").run()
    for (const id of ['t1', 't2']) old.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'olga', 'claude-code', 'done')").run(id)
    old.query("INSERT INTO turn_skill_usage (turn_id, skill_path, skill_name, source) VALUES ('t1', ?, 'ad-copy', 'command'), ('t2', ?, 'ad-copy', 'read')").run(AD.path, AD.path)
    migrate(old)
    expect(old.query('SELECT turn_id, skill_path, source FROM turn_skill_runs').all()).toEqual([{ turn_id: 't1', skill_path: AD.path, source: 'command' }])
    old.close()
  })
})

describe('the card and the owners\' notice', () => {
  let h: Harness
  let owner: Client, admin: Client, member: Client
  let ids: { owner: string; admin: string; member: string; erin: string; finn: string }
  const AD = { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy' }
  const SEO = { path: 'skills/marketing/seo-brief/SKILL.md', name: 'seo-brief' }
  let n = 0
  const turn = (user: string, o: { status?: string; at?: string; skill?: typeof AD } = {}) => {
    const id = `card-${++n}`
    h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'c', user, 'claude-code', o.status ?? 'done', o.at ?? new Date().toISOString())
    if (o.skill) recordSkillUse(h.ctx.db, { turnId: id, userId: user, skill: o.skill, source: 'command' })
    return id
  }
  const goal = async (c: Client = owner) => (await c.call('GET', '/api/onboarding/goal')).goal
  const notices = async (c: Client = owner) => (await c.call('GET', '/api/notifications')).items.filter((i: { code: string }) => i.code === 'onboarding.first_run')
  /** move the team's start (every account made then) */
  const startedDaysAgo = (d: number) => h.ctx.db.query('UPDATE users SET created_at = ?').run(new Date(Date.now() - d * DAY).toISOString())

  beforeAll(async () => {
    h = await harness('b-onboarding-goal-card')
    owner = await withOwner(h)
    const a = await addMember(h, owner, { username: 'adam', role: 'admin' })
    const m = await addMember(h, owner, { username: 'mina' })
    const e = await addMember(h, owner, { username: 'erin' })
    const f = await addMember(h, owner, { username: 'finn' })
    admin = a.client; member = m.client
    ids = { owner: 'olga', admin: a.id, member: m.id, erin: e.id, finn: f.id }
    const abs = path.join(h.ctx.config.teamRoot, AD.path)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '---\nname: ad-copy\ndescription: 광고 문구 — 광고 문구 3안을 써요.\nmetadata:\n  title: 광고 문구\n---\nWrite.\n')
  })
  afterAll(async () => { await h.close() })
  beforeEach(() => {
    h.ctx.db.query("DELETE FROM turns WHERE id LIKE 'card-%'").run()
    h.ctx.db.query('DELETE FROM onboarding_goal_notices').run()
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(GOAL_SHOWN_KEY)
    h.ctx.db.query("UPDATE users SET status = 'active', deleted_at = NULL WHERE id = ?").run(ids.finn)
    startedDaysAgo(1)
  })

  test('a new team: owners and admins see the goal; members are refused; the card marks the team as having seen it', async () => {
    const g = await goal()
    expect(g).toMatchObject({ state: 'open', target: 3, days: 7, daysLeft: 6, skill: null, reachedAt: null })
    expect(Date.parse(g.endsAt) - Date.parse(g.startedAt)).toBe(7 * DAY)
    expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(GOAL_SHOWN_KEY)).not.toBeNull()
    expect((await goal(admin)).state).toBe('open')
    expect((await member.try('GET', '/api/onboarding/goal')).status).toBe(403)
  })

  test('progress: the top skill by its plain name and who ran it, first run first, never who did not', async () => {
    turn(ids.member, { skill: AD, at: new Date(Date.now() - 3600_000).toISOString() })
    turn(ids.owner, { skill: AD })
    turn(ids.erin, { skill: SEO })
    turn(ids.admin, { status: 'error', skill: AD })
    const g = await goal()
    expect(g).toMatchObject({ state: 'open', skill: { path: AD.path, name: '광고 문구', runners: 2, people: ['MINA', 'Olga Owner'] } })
    // who ran it: never who did not (adam's failed answer); adam is the one who joined and has not run it yet (Y)
    expect(g.skill.people).not.toContain('ADAM')
    expect(g.waiting).toEqual({ first: 'ADAM', more: 2 })
    // a third person: reached, and still shown while the window runs
    turn(ids.erin, { skill: AD })
    expect(await goal()).toMatchObject({ state: 'reached', skill: { runners: 3 } })
  })

  test('a deleted person counts but is not named', async () => {
    turn(ids.member, { skill: AD }); turn(ids.finn, { skill: AD })
    h.ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), ids.finn)
    expect((await goal()).skill).toMatchObject({ runners: 2, people: ['MINA'] })
  })

  // Y — Home shows one thing at a time: "민지님이 들어왔지만 '광고 문구'는 아직이에요" (one name and a count, never a list)
  test('while open: how many joined, and the first who joined and has not run the top skill by name, the rest counted', async () => {
    const seen = h.ctx.db.query('SELECT id, last_seen_at AS at FROM users').all() as { id: string; at: string | null }[]
    try {
      // nobody ran a team skill yet: everyone who joined waits (adam joined first); the owner is not someone who joined
      expect(await goal()).toMatchObject({ state: 'open', joined: 4, waiting: { first: 'ADAM', more: 3 } })
      // the viewer is never named to themselves
      expect(await goal(admin)).toMatchObject({ joined: 4, waiting: { first: 'MINA', more: 2 } })
      turn(ids.owner, { skill: AD }); turn(ids.admin, { skill: AD })
      // erin ran another skill: she has still not run the top one
      turn(ids.erin, { skill: SEO })
      const g = await goal()
      expect(g).toMatchObject({ skill: { path: AD.path, runners: 2 }, joined: 4, waiting: { first: 'MINA', more: 2 } })
      // one name only: the others who wait are a count
      expect(JSON.stringify(g)).not.toContain('ERIN')
      expect(JSON.stringify(g)).not.toContain('FINN')
      // an account made for someone who never signed in has not joined; a deleted one is gone
      h.ctx.db.query('UPDATE users SET last_seen_at = NULL WHERE id = ?').run(ids.member)
      h.ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), ids.finn)
      expect(await goal()).toMatchObject({ joined: 2, waiting: { first: 'ERIN', more: 0 } })
      // nobody else signed in: nobody joined, nobody waits
      h.ctx.db.query('UPDATE users SET last_seen_at = NULL WHERE id <> ?').run(ids.owner)
      expect(await goal()).toMatchObject({ joined: 0, waiting: null })
    } finally {
      for (const r of seen) h.ctx.db.query('UPDATE users SET last_seen_at = ? WHERE id = ?').run(r.at, r.id)
    }
  })

  test('reached, or after the window: neither who joined nor who waits', async () => {
    for (const u of [ids.owner, ids.member, ids.erin]) turn(u, { skill: AD })
    const g = await goal()
    expect(g.state).toBe('reached')
    expect('joined' in g || 'waiting' in g).toBe(false)
    // the window ended a day ago (reached in it, the card seen above): the "reached" time after it names nobody either
    h.ctx.db.query("DELETE FROM turns WHERE id LIKE 'card-%'").run()
    startedDaysAgo(8)
    for (const u of [ids.owner, ids.member, ids.erin]) turn(u, { skill: AD, at: new Date(Date.now() - 7.5 * DAY).toISOString() })
    const after = await goal()
    expect(after).toMatchObject({ state: 'reached', daysLeft: 0 })
    expect('joined' in after || 'waiting' in after).toBe(false)
  })

  test('an older team after an update never sees it, reached or not; a team that saw it gets "reached" for 7 more days', async () => {
    startedDaysAgo(30)
    expect(await goal()).toBeNull()
    // not even counted (every owner or admin Home visit asks): with the runs table out of the way the answer is the same
    h.ctx.db.exec('ALTER TABLE turn_skill_runs RENAME TO turn_skill_runs_away')
    try { expect(await goal()).toBeNull() } finally { h.ctx.db.exec('ALTER TABLE turn_skill_runs_away RENAME TO turn_skill_runs') }
    // reached in its first week, long before this version: still nothing
    for (const u of [ids.owner, ids.member, ids.erin]) turn(u, { skill: AD, at: new Date(Date.now() - 29 * DAY).toISOString() })
    expect(await goal()).toBeNull()
    expect(h.ctx.db.query('SELECT 1 FROM settings WHERE key = ?').get(GOAL_SHOWN_KEY)).toBeNull()
    // the window ended a day ago, reached, and the team saw the card: "reached" until 7 days after the window
    h.ctx.db.query("DELETE FROM turns WHERE id LIKE 'card-%'").run()
    startedDaysAgo(8)
    for (const u of [ids.owner, ids.member, ids.erin]) turn(u, { skill: AD, at: new Date(Date.now() - 7.5 * DAY).toISOString() })
    expect(await goal()).toBeNull()
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES (?, '\"2026-11-01T00:00:00.000Z\"')").run(GOAL_SHOWN_KEY)
    expect(await goal()).toMatchObject({ state: 'reached', daysLeft: 0 })
    startedDaysAgo(7 + REACHED_GRACE_MS / DAY + 0.1)
    expect(await goal()).toBeNull()
  })

  test('the window ended without the goal: nothing to show', async () => {
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES (?, '\"2026-11-01T00:00:00.000Z\"')").run(GOAL_SHOWN_KEY)
    startedDaysAgo(8)
    turn(ids.member, { skill: AD, at: new Date(Date.now() - 7.5 * DAY).toISOString() })
    expect(await goal()).toBeNull()
  })

  test('the owners hear about each member\'s first run of a skill, once per member per skill, with the count then', async () => {
    const first = turn(ids.member, { skill: AD })
    noteGoalRun(h.ctx, first)
    let items = await notices()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ eventType: 'onboarding.first_run', sourceId: first, link: null, firstRun: { member: 'MINA', skill: '광고 문구', runners: 1, target: 3 } })
    // the same member and skill again: nothing new; another skill: a new notice
    noteGoalRun(h.ctx, turn(ids.member, { skill: AD }))
    noteGoalRun(h.ctx, first)
    expect(await notices()).toHaveLength(1)
    noteGoalRun(h.ctx, turn(ids.member, { skill: SEO }))
    // a second person: "2/3"
    noteGoalRun(h.ctx, turn(ids.erin, { skill: AD }))
    items = await notices()
    expect(items.map((i: { firstRun: { skill: string; runners: number } }) => [i.firstRun.skill, i.firstRun.runners])).toEqual([['광고 문구', 2], ['seo-brief', 1], ['광고 문구', 1]])
    // admins and members get none; the owner is not told about their own run
    expect(await notices(admin)).toHaveLength(0)
    noteGoalRun(h.ctx, turn(ids.owner, { skill: AD }))
    expect(await notices()).toHaveLength(3)
  })

  test('no notice for a failed answer, a later run after an earlier success, or outside the window; a deleted member stays unnamed', async () => {
    noteGoalRun(h.ctx, turn(ids.member, { status: 'error', skill: AD }))
    expect(await notices()).toHaveLength(0)
    // not the first: an earlier successful run of the same skill (from before the notices existed)
    turn(ids.erin, { skill: AD, at: new Date(Date.now() - 3600_000).toISOString() })
    noteGoalRun(h.ctx, turn(ids.erin, { skill: AD }))
    expect(await notices()).toHaveLength(0)
    // the window ended
    startedDaysAgo(8)
    noteGoalRun(h.ctx, turn(ids.finn, { skill: AD }))
    expect(await notices()).toHaveLength(0)
    startedDaysAgo(1)
    noteGoalRun(h.ctx, turn(ids.finn, { skill: SEO }))
    h.ctx.db.query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), ids.finn)
    expect((await notices())[0].firstRun).toMatchObject({ member: null, skill: 'seo-brief', runners: 1 })
  })
})

describe('real turns with the fake engine', () => {
  let h: ChatHarness
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(h.team, rel)), { recursive: true }); fs.writeFileSync(path.join(h.team, rel), text) }
  const send = async (user: string, content: string) => {
    const chat = (await h.api(user).call(API.createChat, { body: {} })).id
    const r = await h.api(user).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => !['streaming', 'queued'].includes((h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string } | null)?.status ?? 'queued'), { timeoutMs: 30_000 })
    // the turn's end (status, then the goal's notice) is written right after the message
    await waitFor(() => (h.ctx.db.query('SELECT status FROM turns WHERE id = ?').get(r.turnId) as { status: string }).status !== 'running', { timeoutMs: 10_000 })
    return r.turnId as string
  }
  const runs = (turnId: string) => h.ctx.db.query('SELECT skill_path, source FROM turn_skill_runs WHERE turn_id = ?').all(turnId)
  const notices = () => h.ctx.db.query("SELECT user_id, member_id, skill_path, runners FROM onboarding_goal_notices ORDER BY created_at, id").all()
  const REL = 'skills/marketing/ad-copy/SKILL.md'

  beforeAll(async () => {
    h = await startHarness({ name: 'b-onboarding-goal-turns' })
    put(REL, '---\nname: ad-copy\ndescription: 광고 문구 — 광고 문구 3안을 써요.\nmetadata:\n  title: 광고 문구\n---\nWrite three ads.\n')
  })
  afterAll(async () => { await h?.close() })

  test('"/name" and the skill tool are runs, a plain read is not; a successful first run tells the owner', async () => {
    const read = await send('alice', fake({ tool: 'read', args: { file_path: REL } }, { say: 'read it' }))
    expect(runs(read)).toEqual([])
    expect(notices()).toEqual([])
    const command = await send('alice', '/ad-copy\n' + fake({ say: 'three ads' }))
    expect(runs(command)).toEqual([{ skill_path: REL, source: 'command' }])
    // dana is the fixture's owner
    expect(notices()).toEqual([{ user_id: 'dana', member_id: 'alice', skill_path: REL, runners: 1 }])
    const failed = await send('bob', '/ad-copy\n' + fake({ fail: 'synthetic failure' }))
    expect(runs(failed)).toEqual([{ skill_path: REL, source: 'command' }])
    expect(notices()).toHaveLength(1)
    const tool = await send('bob', fake({ tool: 'skill', args: { name: 'ad-copy' } }, { say: 'loaded' }))
    expect(runs(tool)).toEqual([{ skill_path: REL, source: 'tool' }])
    expect(notices()).toEqual([
      { user_id: 'dana', member_id: 'alice', skill_path: REL, runners: 1 },
      { user_id: 'dana', member_id: 'bob', skill_path: REL, runners: 2 },
    ])
  })
})
