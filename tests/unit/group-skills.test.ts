// Group skills (docs/DECISIONS.md "Group skills"): groups/<folder>/skills/ is a skill root for every group a person
// belongs to, seen and used only by that group's members (their AI included), personal > group > team for one name,
// two groups' skills of one name both listed (by path) and "/name" picking by group name, the group's name on the list
// line and in GET /api/skills, the skills_list connector tool, the AI's confirmation card in a group's skills folder
// and its audit, a rename that the sections follow, a deleted group whose skills vanish, usage and the prompt budget.
//
// Fixture (tests/lib/fixtures.ts): alice + erin = marketing (groups/marketing, the group writes it), bob = finance
// (groups/finance), carol = admin, dana = owner (in no group). The fixture's groups have no folder row link; each setup
// links them as Admin › Groups would have.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { TurnFiles } from '../../server/src/files/service'
import { groupSkillRoots, invokedSkill, listGroupSkills, listSkills, readSkill, skillInfo, skillIssues, type Skill } from '../../server/src/chat/skills'
import { buildSkillList, descriptionOrder, resolveSkill, SKILL_LIST_BUDGET } from '../../server/src/chat/skill-list'
import { skillBlock, skillsSection } from '../../server/src/chat/prompt'
import { recordSkillUse } from '../../server/src/admin/skill-usage'
import { popularSkills } from '../../server/src/skills/popular'
import { inSkills, skillRootOf } from '../../server/src/skills/guard'
import { deleteGroupAs, updateGroupAs } from '../../server/src/admin/groups'
import { managedSkillFolders, managesSkillFolder } from '../../server/src/skills/managers'

setDefaultTimeout(60_000)

const MKT_QUOTE = 'MKT-QUOTE-CANARY-4a1'
const FIN_QUOTE = 'FIN-QUOTE-CANARY-8c2'
const MKT_WEEKLY = 'MKT-WEEKLY-CANARY-1d7'
const TEAM_WEEKLY = 'TEAM-WEEKLY-CANARY-6e3'

/** Link the fixture's groups to their folders, as createGroupAs does. */
function linkGroups(db: import('bun:sqlite').Database) {
  for (const g of ['marketing', 'finance']) db.query(`UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?`).run(`groups/${g}`, g)
}
function layout(team: string) {
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(team, rel)), { recursive: true }); fs.writeFileSync(path.join(team, rel), text) }
  put('groups/marketing/skills/quote/SKILL.md', `---\nname: quote\ndescription: ${MKT_QUOTE}\n---\nmarketing quote steps\n`)
  put('groups/finance/skills/quote/SKILL.md', `---\nname: quote\ndescription: ${FIN_QUOTE}\n---\nfinance quote steps\n`)
  put('groups/marketing/skills/weekly.md', `---\nname: Weekly\ndescription: ${MKT_WEEKLY}\n---\nmarketing weekly\n`)
  put('skills/weekly.md', `---\nname: Weekly\ndescription: ${TEAM_WEEKLY}\n---\nteam weekly\n`)
  put('groups/marketing/skills/brief.md', '---\nname: Brief\ndescription: the group brief\n---\ngroup brief\n')
  put('users/alice/skills/brief.md', '---\nname: Brief\ndescription: my own brief\n---\nmy brief\n')
  // only the top-level skills/ folder of a group counts
  put('groups/marketing/campaigns/skills/deep.md', '---\nname: Deep\ndescription: DEEP-NOT-A-ROOT\n---\nx\n')
  // a file without a header in a group's skills is no team rule and no skill
  put('groups/marketing/skills/notes.md', 'plain notes\n')
}

describe('discovery and precedence (real folder rules)', () => {
  const e = makeEnv('group-skills')
  linkGroups(e.db)
  layout(e.fx.team)
  afterAll(() => e.db.close())
  const who = (id: string) => e.files.principal(id)
  const list = (id: string) => listSkills(e.files, who(id))

  test('members get their group\'s skills with the group; non-members, the owner and admins outside it do not', () => {
    const alice = list('alice')
    const quote = alice.find((s) => s.path === 'groups/marketing/skills/quote/SKILL.md')!
    expect(quote.group).toEqual({ id: 'marketing', name: 'Marketing' })
    expect(skillInfo(quote)).toEqual({ path: 'groups/marketing/skills/quote/SKILL.md', name: 'quote', description: MKT_QUOTE, group: { id: 'marketing', name: 'Marketing' } })
    // bob is in finance only; carol (admin) and dana (owner) are in no group, though the folder rules let them read it
    expect(JSON.stringify(list('bob'))).not.toContain(MKT_QUOTE)
    for (const id of ['carol', 'dana']) {
      expect(list(id).some((s) => s.path.startsWith('groups/'))).toBe(false)
      expect(readSkill(e.files, who(id), 'groups/marketing/skills/quote/SKILL.md')).toBeNull()
    }
    expect(readSkill(e.files, who('bob'), 'groups/marketing/skills/quote/SKILL.md')).toBeNull()
    expect(readSkill(e.files, who('alice'), 'groups/marketing/skills/quote/SKILL.md')?.group).toEqual({ id: 'marketing', name: 'Marketing' })
  })

  test('only groups/<folder>/skills counts: no deeper skills folder, and no header = neither skill nor rule', () => {
    expect(JSON.stringify(list('alice'))).not.toContain('DEEP-NOT-A-ROOT')
    expect(list('alice').some((s) => s.path === 'groups/marketing/skills/notes.md')).toBe(false)
    expect(groupSkillRoots(e.db, who('alice')).map((g) => g.root)).toEqual(['groups/marketing/skills'])
  })

  test('depth 3 of a group never reads as a person\'s folder: a group folder named like a person', () => {
    // groups/alice/skills is not alice's personal folder
    expect(readSkill(e.files, who('alice'), 'groups/alice/skills/x.md')).toBeNull()
  })

  test('personal > group > team, for that person only', () => {
    const alice = list('alice')
    // Weekly: the group's hides the team's for marketing members
    expect(alice.filter((s) => s.name === 'Weekly').map((s) => s.path)).toEqual(['groups/marketing/skills/weekly.md'])
    expect(list('bob').filter((s) => s.name === 'Weekly').map((s) => s.path)).toEqual(['skills/weekly.md'])
    expect(list('erin').filter((s) => s.name === 'Weekly').map((s) => s.path)).toEqual(['groups/marketing/skills/weekly.md'])
    // Brief: alice's own hides the group's; erin (same group) keeps the group's
    expect(alice.filter((s) => s.name === 'Brief').map((s) => s.path)).toEqual(['users/alice/skills/brief.md'])
    expect(list('erin').filter((s) => s.name === 'Brief').map((s) => s.path)).toEqual(['groups/marketing/skills/brief.md'])
    // the team's own list (for name checks before adding a team skill) is unchanged; a group's own list too
    expect(listGroupSkills(e.files, who('alice'), 'marketing').map((s) => s.name).sort()).toEqual(['Brief', 'Weekly', 'quote'])
    expect(listGroupSkills(e.files, who('bob'), 'marketing')).toEqual([])
  })

  test('two groups with one name: both listed, by path; "/name" picks the group whose name comes first', () => {
    e.db.query("INSERT INTO group_members (group_id, user_id) VALUES ('finance', 'erin')").run()
    try {
      const erin = list('erin')
      expect(erin.filter((s) => s.name === 'quote').map((s) => s.path).sort()).toEqual(['groups/finance/skills/quote/SKILL.md', 'groups/marketing/skills/quote/SKILL.md'])
      // Finance < Marketing (letter case ignored)
      expect(invokedSkill(erin, '/quote for ACME')?.skill.path).toBe('groups/finance/skills/quote/SKILL.md')
      // the list line gives both their path and the group
      const lines = buildSkillList(erin).lines.join('\n')
      expect(lines).toContain('- quote (groups/finance/skills/quote/SKILL.md) [group: Finance]')
      expect(lines).toContain('- quote (groups/marketing/skills/quote/SKILL.md) [group: Marketing]')
      // the skill tool: ambiguous by name, resolved by the line as written
      expect('ambiguous' in (resolveSkill(erin, 'quote') ?? {})).toBe(true)
      expect(resolveSkill(erin, 'quote (groups/marketing/skills/quote/SKILL.md) [group: Marketing]')).toEqual({ skill: erin.find((s) => s.path === 'groups/marketing/skills/quote/SKILL.md')! })
      // renamed so that marketing comes first: "/quote" follows
      e.db.query("UPDATE groups SET name = 'A-Marketing' WHERE id = 'marketing'").run()
      expect(invokedSkill(list('erin'), '/quote')?.skill.path).toBe('groups/marketing/skills/quote/SKILL.md')
    } finally {
      e.db.query("UPDATE groups SET name = 'Marketing' WHERE id = 'marketing'").run()
      e.db.query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'erin'").run()
    }
  })

  test('"/name": personal > group > team at the same length', () => {
    const team: Skill = { path: 'skills/x/SKILL.md', name: 'x', description: '', body: 'team' }
    const group: Skill = { path: 'groups/g/skills/x/SKILL.md', name: 'x', description: '', body: 'group', group: { id: 'g', name: 'G' } }
    const mine: Skill = { path: 'users/alice/skills/x/SKILL.md', name: 'x', description: '', body: 'mine' }
    expect(invokedSkill([team, group, mine], '/x')?.skill).toBe(mine)
    expect(invokedSkill([team, group], '/x')?.skill).toBe(group)
    expect(invokedSkill([team], '/x')?.skill).toBe(team)
  })

  test('the prompt: [group: …] on the line, the note on who writes them, the skill block says whose it is', () => {
    const text = skillsSection(e.files, who('alice'))
    expect(text).toContain('- quote [group: Marketing]: ' + MKT_QUOTE)
    expect(text).toContain('Entries marked [group: <name>] are skills of that group of the user')
    expect(text).toContain('any member may have written them')
    // alice may write her group's skills folder: how to save one there, with the card
    expect(text).toContain('groups/marketing/skills/<short-name>.md for the group "Marketing"')
    // bob has no group skill of marketing in his prompt
    expect(skillsSection(e.files, who('bob'))).not.toContain(MKT_QUOTE)
    const quote = list('alice').find((s) => s.path === 'groups/marketing/skills/quote/SKILL.md')!
    expect(skillBlock(quote, '')).toContain('The user invoked this group (of "Marketing", written by its members) skill')
  })

  test('the description order: personal first, then group and team by usage (a group\'s first on a tie)', () => {
    const skills = list('alice')
    const order = descriptionOrder(skills, new Map())
    expect(order[0]).toBe('users/alice/skills/brief.md')
    const groupAt = order.indexOf('groups/marketing/skills/quote/SKILL.md'), teamAt = order.indexOf('skills/team-rules.md')
    expect(groupAt).toBeGreaterThan(0)
    // a team skill used a lot comes before an unused group skill
    const used = descriptionOrder([...skills, { path: 'skills/hot.md', name: 'Hot', description: 'h', body: '' }], new Map([['skills/hot.md', 9]]))
    expect(used.indexOf('skills/hot.md')).toBeLessThan(used.indexOf('groups/marketing/skills/quote/SKILL.md'))
    expect(teamAt).toBe(-1) // a team rule is no skill
  })

  test('the "save one for a group" line (outside the list\'s budget) names at most 5 groups, each name cut at 40', () => {
    const long = 'G'.repeat(90)
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const id = `many-${i}`, folder = `f_many_${i}`
      ids.push(id)
      e.db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(folder, `groups/many-${i}`)
      e.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', ?, 'write')").run(`r_many_${i}`, folder, id)
      e.db.query('INSERT INTO groups (id, name, folder_id) VALUES (?, ?, ?)').run(id, `${i}-${long}`, folder)
      e.db.query('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, 'bob')
      fs.mkdirSync(path.join(e.fx.team, `groups/many-${i}`), { recursive: true })
    }
    try {
      const line = skillsSection(e.files, who('bob')).split('\n').find((l) => l.startsWith('To save a workflow as a skill for one of the user\'s groups'))!
      expect(line.match(/for the group "/g)).toHaveLength(5)
      expect(line).toContain('… and 4 more groups of the user') // 8 here and finance
      expect(line).toContain('find_skills')
      expect(line).not.toContain('G'.repeat(41))
      expect(line.length).toBeLessThan(1200)
    } finally {
      for (const id of ids) {
        e.db.query('DELETE FROM group_members WHERE group_id = ?').run(id)
        e.db.query('DELETE FROM groups WHERE id = ?').run(id)
      }
    }
  })

  test('a person in many groups stays within the 8,000-character budget', () => {
    const many: Skill[] = []
    for (let g = 0; g < 40; g++) for (let i = 0; i < 25; i++) many.push({ path: `groups/g${g}/skills/s${i}/SKILL.md`, name: `s${i}-group-${g}`, description: 'd'.repeat(150), body: '', group: { id: `g${g}`, name: `Group number ${g} with a long name` } })
    for (let i = 0; i < 50; i++) many.push({ path: `skills/t${i}.md`, name: `team-${i}`, description: 't'.repeat(150), body: '' })
    const l = buildSkillList(many)
    expect(l.lines.join('\n').length).toBeLessThanOrEqual(SKILL_LIST_BUDGET)
    expect(l.unlisted).toBeGreaterThan(0)
    expect(l.lines.at(-1)).toContain('find_skills')
  })

  test('usage: a group skill counts (ranking, popular) but is no run; a personal skill neither', () => {
    const chat = crypto.randomUUID(), turn = crypto.randomUUID()
    e.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chat, 'alice')
    // an hour ago: popular counts uses before "now" (a turn started in the same millisecond would not count)
    e.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at) VALUES (?,?,?,?,'done',?)").run(turn, chat, 'alice', 'claude-code', new Date(Date.now() - 3_600_000).toISOString())
    recordSkillUse(e.db, { turnId: turn, userId: 'alice', skill: { path: 'groups/marketing/skills/quote/SKILL.md', name: 'quote' }, source: 'command' })
    recordSkillUse(e.db, { turnId: turn, userId: 'alice', skill: { path: 'users/alice/skills/brief.md', name: 'Brief' }, source: 'command' })
    expect(e.db.query('SELECT skill_path FROM turn_skill_usage WHERE turn_id = ?').all(turn)).toEqual([{ skill_path: 'groups/marketing/skills/quote/SKILL.md' }])
    expect(e.db.query('SELECT COUNT(*) AS n FROM turn_skill_runs WHERE turn_id = ?').get(turn)).toEqual({ n: 0 })
    expect(popularSkills(e.db, e.files, who('alice')).items.map((i) => i.path)).toEqual(['groups/marketing/skills/quote/SKILL.md'])
    // bob is not in the group: its count is not his to see
    expect(popularSkills(e.db, e.files, who('bob')).items).toEqual([])
  })

  test('the guard: a group\'s skills folder by the resolved root, never the first name alone', () => {
    expect(skillRootOf('groups/marketing/skills/x.md')).toEqual({ kind: 'group', folder: 'groups/marketing' })
    expect(skillRootOf('Groups/Marketing/SKILLS/x.md')).toEqual({ kind: 'group', folder: 'Groups/Marketing' })
    expect(skillRootOf('skills/x.md')).toEqual({ kind: 'team' })
    expect(inSkills('groups/marketing/skills')).toBe(true)
    expect(inSkills('groups/marketing/campaigns/skills/x.md')).toBe(false)
    expect(inSkills('groups/marketing/x.md')).toBe(false)
    expect(inSkills('users/alice/skills/x.md')).toBe(false)
  })

  test('managers of a group\'s skills: its members who may write it, not the owner or admins outside it', () => {
    expect(managesSkillFolder({ db: e.db, files: e.files } as never, who('alice'), 'groups/marketing/skills')).toBe(true)
    expect(managesSkillFolder({ db: e.db, files: e.files } as never, who('bob'), 'groups/marketing/skills')).toBe(false)
    expect(managesSkillFolder({ db: e.db, files: e.files } as never, who('dana'), 'groups/marketing/skills')).toBe(false)
    expect(managedSkillFolders({ db: e.db, files: e.files } as never, who('alice'))).toEqual(['groups/marketing/skills'])
    expect(managedSkillFolders({ db: e.db, files: e.files } as never, who('carol'))).toEqual(['skills'])
  })

  test('skill issues: a group skill that does not load shows to its members only', () => {
    fs.writeFileSync(path.join(e.fx.team, 'groups/marketing/skills/broken.md'), '---\nname: a/b\n---\nx\n')
    try {
      expect(skillIssues(e.files, who('alice')).map((i) => i.path)).toContain('groups/marketing/skills/broken.md')
      expect(skillIssues(e.files, who('bob')).map((i) => i.path)).not.toContain('groups/marketing/skills/broken.md')
    } finally { fs.rmSync(path.join(e.fx.team, 'groups/marketing/skills/broken.md')) }
  })
})

describe('in the app: GET /api/skills, rename, delete, the AI\'s card, skills_list', () => {
  let h: Harness
  const socks: Record<string, TestSocket> = {}
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const cm = () => 'cm-' + crypto.randomUUID()
  beforeAll(async () => {
    h = await startHarness({ name: 'group-skills-app', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
    linkGroups(h.ctx.db)
    layout(h.team)
    for (const u of ['alice', 'bob', 'carol', 'dana', 'erin']) {
      socks[u] = await h.ws(u, { windowId: `win-gs-${u}` })
      await socks[u]!.next('hello')
    }
  })
  afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

  async function aiTurn(user: string, content: string, answer?: 'save' | 'skip' | null) {
    const chat = await h.api(user).call(API.createChat, { body: {} })
    const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    let card = null as { question: string; origin?: string; preview?: { path: string; skillName: string | null } } | null
    if (answer !== undefined) {
      const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
      card = c.data.request as unknown as NonNullable<typeof card>
      if (answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
    }
    const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string, card }
  }

  test('GET /api/skills: the group\'s skills with the group, for its members only', async () => {
    const alice = (await h.api('alice').call(API.listSkills)).items
    expect(alice.find((s) => s.path === 'groups/marketing/skills/quote/SKILL.md')?.group).toEqual({ id: 'marketing', name: 'Marketing' })
    expect(JSON.stringify((await h.api('bob').call(API.listSkills)).items)).not.toContain(MKT_QUOTE)
    expect(JSON.stringify((await h.api('dana').call(API.listSkills)).items)).not.toContain(MKT_QUOTE)
  })

  test('a rename: the group\'s new name at once (the folder stays)', async () => {
    updateGroupAs(h.ctx, 'dana', 'marketing', { name: 'Growth' }, 'en')
    try {
      const alice = (await h.api('alice').call(API.listSkills)).items
      expect(alice.find((s) => s.path === 'groups/marketing/skills/quote/SKILL.md')?.group).toEqual({ id: 'marketing', name: 'Growth' })
    } finally { updateGroupAs(h.ctx, 'dana', 'marketing', { name: 'Marketing' }, 'en') }
  })

  test('the AI writes a group skill: the card names the group; declining writes nothing and is audited', async () => {
    const r = await aiTurn('alice', fake({ tool: 'write', args: { file_path: 'groups/marketing/skills/pitch.md', content: '---\nname: Pitch\ndescription: a pitch\n---\nsteps\n' }, sayResult: true }), 'skip')
    expect(r.card!.origin).toBe('server')
    expect(r.card!.question).toContain('Save this as a skill of the group "Marketing"?')
    expect(r.card!.question).toContain('new group skill "Pitch"')
    expect(r.content).toContain('did not allow saving')
    expect(fs.existsSync(path.join(h.team, 'groups/marketing/skills/pitch.md'))).toBe(false)
    const a = h.ctx.db.query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'skills.ai_write_refused' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; target: string; detail: string }
    expect({ actor: a.actor_id, target: a.target }).toEqual({ actor: 'alice', target: 'groups/marketing/skills/pitch.md' })
    expect(JSON.parse(a.detail).group).toEqual({ id: 'marketing', name: 'Marketing' })
    expect(h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").get(r.turnId)).toEqual({ summary: 'write -> not allowed by the user (group skills)', ok: 0 })
  })

  test('saved after the card: audited as skills.change with the group, the owner and admins told', async () => {
    const r = await aiTurn('alice', fake({ tool: 'write', args: { file_path: 'groups/marketing/skills/pitch.md', content: '---\nname: Pitch\ndescription: a pitch\n---\nsteps\n' }, sayResult: true }), 'save')
    expect(r.card!.preview).toMatchObject({ path: 'groups/marketing/skills/pitch.md', skillName: 'Pitch' })
    expect(fs.existsSync(path.join(h.team, 'groups/marketing/skills/pitch.md'))).toBe(true)
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.change' AND target = 'groups/marketing/skills/pitch.md' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(a.actor_id).toBe('alice')
    expect(JSON.parse(a.detail)).toMatchObject({ change: 'create', byAi: true, kind: 'skill', group: { id: 'marketing', name: 'Marketing' } })
    await socks.dana!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.message.includes('groups/marketing/skills/pitch.md'))
    // the recent changes view names the group
    const changes = (await h.api('dana').call(API.listSkillChanges, { query: { limit: 20 } })).items
    expect(changes.find((c) => c.path === 'groups/marketing/skills/pitch.md')?.group).toEqual({ id: 'marketing', name: 'Marketing' })
    // without the card the file layer refuses, for a group's folder too (fail closed)
    const chat = crypto.randomUUID(), turn = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chat, 'alice')
    h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?,?,?,?)').run(turn, chat, 'alice', 'claude-code')
    const out = await h.ctx.files.call('write', { file_path: 'groups/marketing/skills/other.md', content: '# x\n' }, { user: h.ctx.files.principal('alice'), turnId: turn, files: new TurnFiles() })
    expect(out.text).toContain("needs the user's confirmation")
  })

  test('a member outside the group: the folder rules refuse before any card', async () => {
    const r = await aiTurn('bob', fake({ tool: 'write', args: { file_path: 'groups/marketing/skills/bob.md', content: '# x\n' }, sayResult: true }))
    expect(r.card).toBeNull()
    expect(fs.existsSync(path.join(h.team, 'groups/marketing/skills/bob.md'))).toBe(false)
  })

  test('"스킬로 제안" into a group\'s skills: its members review it, nobody outside the group sees it', async () => {
    const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { return (e as { status: number }).status } }
    await h.api('alice').call(API.saveContent, { body: { path: 'users/alice/idea.md', content: 'GROUP-SUGGESTION-CANARY steps\n', baseSha256: null } })
    const before = (await h.api('erin').call(API.skillsOverview))
    expect(before.managedFolders).toContain('groups/marketing/skills')
    expect(before.suggestFolders).toContain('groups/marketing/skills')
    expect((await h.api('bob').call(API.skillsOverview)).suggestFolders).not.toContain('groups/marketing/skills')
    const s = await h.api('alice').call(API.createSkillSuggestion, { body: { source: { kind: 'file', path: 'users/alice/idea.md' }, targetFolder: 'groups/marketing/skills', name: 'Idea', description: 'an idea', content: 'GROUP-SUGGESTION-CANARY steps\n' } })
    expect(s).toMatchObject({ targetFolder: 'groups/marketing/skills', targetGroup: { id: 'marketing', name: 'Marketing' }, canReview: true })
    await socks.erin!.next('notice', (f) => f.data.code === 'skill_suggested' && f.data.link === `/skills?review=${s.id}`)
    // outside the group: never seen, the owner and admins included (they manage the team's skills, not the group's)
    for (const u of ['bob', 'dana', 'carol']) {
      expect(await status(h.api(u).call(API.getSkillSuggestion, { params: { id: s.id } }))).toBe(404)
      expect(JSON.stringify((await h.api(u).call(API.listSkillSuggestions, { query: { scope: 'review' } })).items)).not.toContain(s.id)
    }
    expect(await status(h.api('bob').call(API.approveSkillSuggestion, { params: { id: s.id }, body: { targetFolder: 'groups/marketing/skills', name: 'Idea', description: 'an idea', content: 'x\n' } }))).toBe(404)
    // bob cannot suggest into it either (the same answer as a folder that is not there)
    await h.api('bob').call(API.saveContent, { body: { path: 'users/bob/idea.md', content: 'x\n', baseSha256: null } })
    expect(await status(h.api('bob').call(API.createSkillSuggestion, { body: { source: { kind: 'file', path: 'users/bob/idea.md' }, targetFolder: 'groups/marketing/skills', name: 'X', content: 'x' } }))).toBe(400)
    expect((await h.api('erin').call(API.listSkillSuggestions, { query: { scope: 'review' } })).items.map((x) => x.id)).toContain(s.id)
    const done = await h.api('erin').call(API.approveSkillSuggestion, { params: { id: s.id }, body: { targetFolder: 'groups/marketing/skills', name: 'Idea', description: 'an idea', content: 'GROUP-SUGGESTION-CANARY steps\n' } })
    expect(done).toMatchObject({ status: 'approved', resultPath: 'groups/marketing/skills/Idea.md' })
    expect((await h.api('alice').call(API.listSkills)).items.find((x) => x.path === 'groups/marketing/skills/Idea.md')?.group?.id).toBe('marketing')
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.change' AND target = 'groups/marketing/skills/Idea.md' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(a.actor_id).toBe('erin')
    expect(JSON.parse(a.detail)).toMatchObject({ change: 'create', byAi: false, group: { id: 'marketing' } })
  })

  test('a deleted group: its skills vanish for its former members', async () => {
    const before = (await h.api('bob').call(API.listSkills)).items
    expect(before.some((s) => s.group?.id === 'finance')).toBe(true)
    deleteGroupAs(h.ctx, 'dana', 'finance')
    const after = (await h.api('bob').call(API.listSkills)).items
    expect(after.some((s) => s.path.startsWith('groups/'))).toBe(false)
    expect(JSON.stringify(after)).not.toContain(FIN_QUOTE)
    expect(readSkill(h.ctx.files, h.ctx.files.principal('bob'), 'groups/finance/skills/quote/SKILL.md')).toBeNull()
  })
})

describe('the connector\'s skills_list follows the connected person\'s groups', () => {
  test('a member gets their group\'s skills with the group; the owner outside the group does not', async () => {
    const { RemoteOAuth } = await import('../../server/src/connectors/remote-mcp/oauth')
    const { RemoteTools } = await import('../../server/src/connectors/remote-mcp/tools')
    const { challenge } = await import('../../server/src/connectors/remote-mcp/policy')
    const { addMember, harness, withOwner } = await import('./a-lib')
    const { createGroupAs } = await import('../../server/src/admin/groups')
    const h = await harness('group-skills-connector')
    try {
      const owner = await withOwner(h), member = await addMember(h, owner, { username: 'seller' })
      const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
      const g = createGroupAs(h.ctx, ownerId, { name: 'Sales', memberIds: [member.id] }, 'en')
      const team = h.ctx.config.teamRoot
      fs.mkdirSync(path.join(team, 'groups/Sales/skills/offer'), { recursive: true })
      fs.writeFileSync(path.join(team, 'groups/Sales/skills/offer/SKILL.md'), '---\nname: offer\ndescription: SALES-OFFER-CANARY\n---\nsteps\n')
      const call = async (cookie: string) => {
        const auth = (await h.auth.resolve(new Request('http://team.localhost', { headers: { cookie } }), { ip: '10.0.0.7', via: 'test' }))!
        const oauth = new RemoteOAuth(h.ctx.db, { origin: 'https://team.example' }), tools = new RemoteTools(h.ctx, () => oauth)
        const redirect = 'https://claude.ai/api/mcp/auth_callback', verifier = 'v'.repeat(43)
        const c = oauth.register({ redirect_uris: [redirect] })
        const id = new URL(oauth.authorize({ client_id: c.client_id, redirect_uri: redirect, resource: oauth.resource(), response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge(verifier), scope: 'mcp:read' })).searchParams.get('id')!
        const code = new URL(oauth.decide(id, auth, true).redirectUrl).searchParams.get('code')!
        const token = oauth.token({ client_id: c.client_id, code, grant_type: 'authorization_code', code_verifier: verifier, redirect_uri: redirect, resource: oauth.resource() }).access_token
        const tool = tools.list(oauth.authenticate(token)).find((t) => t.name === 'skills_list')!
        expect(tool.description).toContain('the skills of your groups')
        const out = await tools.call(token, 'skills_list', {})
        expect(out.isError).toBeUndefined()
        return out.content[0]!.text
      }
      const mine = JSON.parse(await call(member.client.cookie!)) as unknown[]
      expect(mine).toContainEqual({ path: 'groups/Sales/skills/offer/SKILL.md', name: 'offer', description: 'SALES-OFFER-CANARY', group: { id: g.id, name: 'Sales' } })
      expect(await call(owner.cookie!)).not.toContain('SALES-OFFER-CANARY')
    } finally { await h.close() }
  })
})
