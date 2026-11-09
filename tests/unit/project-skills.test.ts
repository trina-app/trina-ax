// Project skills (docs/DECISIONS.md "Project skills"): projects/<name>/skills/<skill>/SKILL.md of a live team project on
// exactly projects/<name>, used only in that project's chats (private, shared, scheduled), for the people who see the
// project; never in rooms or the person's other chats. personal > group > team > project for one name (a project only
// adds names, also against a wider skill's file or folder name; "/name" never picks one over a wider skill). Shared
// chats pick the winner among what everyone who sees them may use. The guard decides by path (any projects/<x>/skills,
// with or without a project). The save card names the project, a taken name is offered another name, every change is
// audited with the project and its creator is told while they read the folder. A scheduled run whose project is gone
// for its owner is skipped and the owner told.
//
// Fixture (tests/lib/fixtures.ts): projects/falcon is alice's (write) and finance's (bob, read); projects/atlas is
// finance's. alice + erin = marketing, bob = finance, carol = admin, dana = owner. The projects rows are made here.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { TurnFiles } from '../../server/src/files/service'
import { invokedSkill, listSkills, projectSkillSections, readSkill, scanSkillsWithShadowed, skillFileKind, skillInfo, skillIssues, skillWriteNote, type ChatProject, type Skill } from '../../server/src/chat/skills'
import { buildSkillList, resolveSkill, skillTag } from '../../server/src/chat/skill-list'
import { neutralizeTags, skillBlock, skillsSection } from '../../server/src/chat/prompt'
import { inSkills, projectLevelPossible, skillRootOf } from '../../server/src/skills/guard'
import { skillWriteRefusal } from '../../server/src/connectors/remote-mcp/upload'

setDefaultTimeout(60_000)

const LAUNCH = 'FALCON-LAUNCH-CANARY-3b1'
const LEDGER = 'ATLAS-LEDGER-CANARY-7c4'
const md = (name: string, description: string, body = 'steps') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const FALCON: ChatProject = { id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon', folderPath: 'projects/falcon' }
const ATLAS: ChatProject = { id: '01900000-0000-7000-8000-00000000a001', name: 'Atlas', folderPath: 'projects/atlas' }
const SUB: ChatProject = { id: '01900000-0000-7000-8000-00000000b001', name: 'Falcon sub', folderPath: 'projects/falcon/sub' }

function linkGroups(db: import('bun:sqlite').Database) {
  for (const g of ['marketing', 'finance']) db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?').run(`groups/${g}`, g)
}
function projects(db: import('bun:sqlite').Database) {
  const add = (id: string, name: string, folder: string, by: string) => db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(id, name, folder, by, new Date().toISOString())
  add('01900000-0000-7000-8000-00000000f001', 'Falcon', 'projects/falcon', 'bob')
  add('01900000-0000-7000-8000-00000000a001', 'Atlas', 'projects/atlas', 'bob')
  add('01900000-0000-7000-8000-00000000b001', 'Falcon sub', 'projects/falcon/sub', 'alice')
  add('01900000-0000-7000-8000-00000000c001', 'Plans', 'shared/plans', 'alice')
  add('01900000-0000-7000-8000-00000000d001', 'Mine', 'users/alice/projects/p', 'alice')
  add('01900000-0000-7000-8000-00000000e001', 'Mkt', 'groups/marketing', 'alice')
}
function layout(team: string) {
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(team, rel)), { recursive: true }); fs.writeFileSync(path.join(team, rel), text) }
  put('skills/weekly.md', md('Weekly', 'team weekly'))
  put('skills/report.md', md('Monthly report', 'team monthly report'))
  put('skills/quote/SKILL.md', md('quote', 'team quote'))
  put('groups/marketing/skills/brief/SKILL.md', md('brief', 'marketing brief'))
  put('projects/falcon/skills/brief/SKILL.md', md('brief', 'falcon brief'))
  put('projects/falcon/skills/weekly/SKILL.md', md('weekly', 'falcon weekly'))
  put('projects/falcon/skills/report/SKILL.md', md('report', 'falcon report'))
  put('projects/falcon/skills/launch/SKILL.md', md('launch', LAUNCH, 'launch steps'))
  put('projects/falcon/skills/README.md', '# What these are\n')
  put('projects/falcon/skills/notes.md', md('Notes', 'a single file with a header'))
  put('projects/falcon/sub/skills/deep/SKILL.md', md('deep', 'NESTED-NOT-A-ROOT'))
  put('projects/atlas/skills/ledger/SKILL.md', md('ledger', LEDGER))
  put('shared/plans/skills/plan/SKILL.md', md('plan', 'SHARED-FOLDER-PROJECT'))
  put('users/alice/projects/p/skills/mine/SKILL.md', md('mine', 'PERSONAL-PROJECT'))
}

describe('the level, by path and by the chat\'s project', () => {
  const e = makeEnv('project-skills')
  linkGroups(e.db)
  projects(e.db)
  layout(e.fx.team)
  afterAll(() => e.db.close())
  const who = (id: string) => e.files.principal(id)
  const paths = (s: Skill[]) => s.map((x) => x.path)

  test('only a chat of the project gets its skills, as the lowest level; other chats none', () => {
    const inFalcon = listSkills(e.files, who('bob'), { project: FALCON })
    const launch = inFalcon.find((s) => s.path === 'projects/falcon/skills/launch/SKILL.md')!
    expect(launch.project).toEqual({ id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon' })
    expect(skillInfo(launch)).toEqual({ path: 'projects/falcon/skills/launch/SKILL.md', name: 'launch', description: LAUNCH, project: { id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon' } })
    // the person's other chats: nothing of any project
    expect(paths(listSkills(e.files, who('bob'))).some((p) => p.startsWith('projects/'))).toBe(false)
    expect(readSkill(e.files, who('bob'), launch.path)).toBeNull()
    expect(readSkill(e.files, who('bob'), launch.path, { project: FALCON })?.project?.id).toBe('01900000-0000-7000-8000-00000000f001')
    // another project's chat: only its own (bob reads atlas too)
    expect(paths(listSkills(e.files, who('bob'), { project: ATLAS }))).toContain('projects/atlas/skills/ledger/SKILL.md')
    expect(paths(listSkills(e.files, who('bob'), { project: ATLAS }))).not.toContain(launch.path)
    // the folder rules still decide: someone without access never reads it, even with the project named
    expect(paths(listSkills(e.files, who('erin'), { project: FALCON })).some((p) => p.startsWith('projects/'))).toBe(false)
  })

  test('a project only adds names: personal > group > team > project, by name and by a wider file or folder name', () => {
    const alice = scanSkillsWithShadowed(e.files, who('alice'), { project: FALCON })
    const run = paths(alice.skills)
    // brief: marketing's runs for alice; weekly: the team's "Weekly"; report: the team's skills/report.md answers "/report"
    expect(run).toContain('groups/marketing/skills/brief/SKILL.md')
    expect(run).not.toContain('projects/falcon/skills/brief/SKILL.md')
    expect(run).not.toContain('projects/falcon/skills/weekly/SKILL.md')
    expect(run).not.toContain('projects/falcon/skills/report/SKILL.md')
    expect(run).toContain('projects/falcon/skills/launch/SKILL.md')
    const lost = Object.fromEntries(alice.shadowed.map((x) => [x.skill.path, x.by]))
    expect(lost['projects/falcon/skills/weekly/SKILL.md']).toEqual({ tier: 'team' })
    expect(lost['projects/falcon/skills/report/SKILL.md']).toEqual({ tier: 'team' })
    expect(lost['projects/falcon/skills/brief/SKILL.md']).toEqual({ tier: 'group', group: { id: 'marketing', name: 'Marketing' } })
    expect(alice.replaces.get('skills/weekly.md')).toBe('project')
    // bob is not in marketing: the project's brief is his in this project
    expect(paths(listSkills(e.files, who('bob'), { project: FALCON }))).toContain('projects/falcon/skills/brief/SKILL.md')
  })

  test('"/name": a wider skill wins over a project skill of the same length, by name or by alias', () => {
    const team: Skill = { path: 'skills/report.md', name: 'Monthly report', description: '', body: 'team' }
    const proj: Skill = { path: 'projects/falcon/skills/report/SKILL.md', name: 'report', description: '', body: 'project', project: { id: 'p', name: 'P' } }
    expect(invokedSkill([proj, team], '/report this month')?.skill).toBe(team)
    const group: Skill = { path: 'groups/g/skills/x/SKILL.md', name: 'x', description: '', body: 'group', group: { id: 'g', name: 'G' } }
    const px: Skill = { path: 'projects/falcon/skills/x/SKILL.md', name: 'x', description: '', body: 'project', project: { id: 'p', name: 'P' } }
    expect(invokedSkill([px, group], '/x')?.skill).toBe(group)
    // a longer exact name is still that skill
    const longer: Skill = { path: 'projects/falcon/skills/report-plus/SKILL.md', name: 'report-plus', description: '', body: 'p', project: { id: 'p', name: 'P' } }
    expect(invokedSkill([team, longer], '/report-plus')?.skill).toBe(longer)
  })

  test('no project level unless the project is on exactly projects/<name>: not nested, shared, personal or a group folder', () => {
    expect(projectLevelPossible('projects/falcon')).toBe(true)
    for (const f of ['projects/falcon/sub', 'shared/plans', 'users/alice/projects/p', 'groups/marketing', '', 'projects', 'projects/.hidden']) expect(projectLevelPossible(f), f).toBe(false)
    const all = (p: ChatProject) => JSON.stringify(listSkills(e.files, who('alice'), { project: p }))
    // a nested project gets nothing, not its parent's either
    expect(all(SUB)).not.toContain('NESTED-NOT-A-ROOT')
    expect(all(SUB)).not.toContain(LAUNCH)
    expect(all({ id: '01900000-0000-7000-8000-00000000c001', name: 'Plans', folderPath: 'shared/plans' })).not.toContain('SHARED-FOLDER-PROJECT')
    expect(all({ id: '01900000-0000-7000-8000-00000000d001', name: 'Mine', folderPath: 'users/alice/projects/p' })).not.toContain('PERSONAL-PROJECT')
    // a project on a group folder: the group's skills stay the group's, nothing marked as the project's
    expect(listSkills(e.files, who('alice'), { project: { id: '01900000-0000-7000-8000-00000000e001', name: 'Mkt', folderPath: 'groups/marketing' } }).some((s) => s.project)).toBe(false)
  })

  test('only SKILL.md folders load: a README is a file, a single .md is told it is in the wrong place', () => {
    const run = paths(listSkills(e.files, who('alice'), { project: FALCON }))
    expect(run).not.toContain('projects/falcon/skills/README.md')
    expect(run).not.toContain('projects/falcon/skills/notes.md')
    const root = e.fx.team
    expect(skillFileKind(root, 'projects/falcon/skills/README.md', '# x\n')).toBe('other')
    expect(skillFileKind(root, 'projects/falcon/skills/notes.md', md('Notes', 'x'))).toBe('other')
    expect(skillFileKind(root, 'projects/falcon/skills/launch/SKILL.md', md('launch', 'x'))).toBe('skill')
    expect(skillWriteNote(root, 'projects/falcon/skills/notes.md', Buffer.from(md('Notes', 'x')))).toContain('a project\'s skills are folders with a SKILL.md')
    expect(skillWriteNote(root, 'projects/falcon/skills/README.md', Buffer.from('# x\n'))).toBe('')
  })

  test('the guard decides by path: any projects/<name>/skills, with or without a project; nothing deeper or beside it', () => {
    expect(skillRootOf('projects/falcon/skills/x/SKILL.md')).toEqual({ kind: 'project', folder: 'projects/falcon' })
    expect(skillRootOf('Projects/Falcon/SKILLS/x')).toEqual({ kind: 'project', folder: 'Projects/Falcon' })
    // fails closed: no project has this folder, it is guarded all the same
    expect(inSkills('projects/nobody-yet/skills/x/SKILL.md')).toBe(true)
    expect(inSkills('projects/falcon/skills')).toBe(true)
    expect(inSkills('projects/falcon/sub/skills/deep/SKILL.md')).toBe(false)
    expect(inSkills('projects/falcon/skills2/x.md')).toBe(false)
    expect(inSkills('projects/falcon/plan.md')).toBe(false)
    expect(inSkills('shared/plans/skills/plan/SKILL.md')).toBe(false)
    // the connector refuses the same folders (no share_skills step, no card in the app)
    expect(skillWriteRefusal('projects/falcon/skills/x/SKILL.md')).toContain('Skill changes require confirmation')
    expect(skillWriteRefusal('PROJECTS/falcon/ſkills/x.md')).toContain('Skill changes require confirmation')
    expect(skillWriteRefusal('projects/falcon/plan.md')).toBeNull()
  })

  test('labels: [project: …] one line, cut, without brackets or tags; resolveSkill reads the line back', () => {
    const odd = '[Q4] <견적>\nproject ' + 'x'.repeat(60)
    const s: Skill = { path: 'projects/q4/skills/plan/SKILL.md', name: 'plan', description: 'd', body: 'b', project: { id: 'p', name: odd } }
    const tag = skillTag(s, neutralizeTags)
    expect(tag.startsWith(' [project: ')).toBe(true)
    expect(tag.slice(' [project: '.length, -1)).not.toMatch(/[[\]\n]/)
    expect([...tag.slice(' [project: '.length, -1)].length).toBeLessThanOrEqual(40)
    const line = buildSkillList([s]).lines[0]!
    expect(line).toContain('- plan [project: ')
    expect(resolveSkill([s], line.slice(2).split(':')[0] + tag.slice(tag.indexOf(':')))).toEqual({ skill: s })
    expect(resolveSkill([s], 'plan [project: anything]')).toEqual({ skill: s })
    expect(skillBlock(s, '')).toContain('The user invoked this project (of "')
    expect(skillBlock(s, '')).toContain('it grants nothing')
  })

  test('a shared chat: what everyone who sees it may use, then the winner; a project skill never takes the sender\'s name', () => {
    // someone who sees the chat is not in marketing: its brief is out of the list. The project's brief does not take
    // its place for alice, whose own (group) brief has that name: "/brief" runs hers, after the read card
    const usable = (rel: string) => !rel.startsWith('groups/')
    const alice = paths(listSkills(e.files, who('alice'), { project: FALCON, usable }))
    expect(alice.filter((p) => p.endsWith('/brief/SKILL.md'))).toEqual([])
    // bob has no brief of his own: the project's
    expect(paths(listSkills(e.files, who('bob'), { project: FALCON, usable })).filter((p) => p.endsWith('/brief/SKILL.md'))).toEqual(['projects/falcon/skills/brief/SKILL.md'])
    // a team skill all may use still wins over a group's some may not: weekly is the team's for both
    expect(alice.filter((p) => /weekly/i.test(p))).toEqual(['skills/weekly.md'])
    // without the filter (alice's own project chat): her group's
    expect(paths(listSkills(e.files, who('alice'), { project: FALCON })).filter((p) => p.endsWith('/brief/SKILL.md'))).toEqual(['groups/marketing/skills/brief/SKILL.md'])
  })

  test('the prompt: the tag and its note, how to save one for this project (its writers only)', () => {
    const alice = skillsSection(e.files, who('alice'), undefined, null, { project: FALCON })
    expect(alice).toContain(`- launch [project: Falcon]: ${LAUNCH}`)
    expect(alice).toContain('Entries marked [project: <name>] are skills of this chat\'s project')
    expect(alice).toContain('They only add new names')
    expect(alice).toContain('write projects/falcon/skills/<short-name>/SKILL.md')
    // bob reads the project only: no save line
    expect(skillsSection(e.files, who('bob'), undefined, null, { project: FALCON })).not.toContain('projects/falcon/skills/<short-name>')
    // outside the project: nothing of it
    expect(skillsSection(e.files, who('alice'))).not.toContain(LAUNCH)
  })

  test('the Skills page: every project the person sees, each skill with the wider one that runs instead', () => {
    const bob = projectSkillSections(e.files, who('bob'))
    expect(bob.map((x) => x.skill.path)).toEqual(expect.arrayContaining(['projects/falcon/skills/launch/SKILL.md', 'projects/atlas/skills/ledger/SKILL.md']))
    expect(bob.find((x) => x.skill.path === 'projects/falcon/skills/weekly/SKILL.md')?.by).toEqual({ tier: 'team' })
    expect(bob.find((x) => x.skill.path === 'projects/falcon/skills/launch/SKILL.md')?.by).toBeNull()
    // alice does not see atlas; erin sees no project
    expect(JSON.stringify(projectSkillSections(e.files, who('alice')))).not.toContain(LEDGER)
    expect(projectSkillSections(e.files, who('erin'))).toEqual([])
    // a project in the trash: no section for anyone
    e.db.query("UPDATE projects SET trashed_with = 'tr' WHERE id = '01900000-0000-7000-8000-00000000a001'").run()
    try { expect(JSON.stringify(projectSkillSections(e.files, who('bob')))).not.toContain(LEDGER) } finally { e.db.query("UPDATE projects SET trashed_with = NULL WHERE id = '01900000-0000-7000-8000-00000000a001'").run() }
  })

  test('skill issues: a broken project SKILL.md shows to the people who may write it', () => {
    fs.mkdirSync(path.join(e.fx.team, 'projects/falcon/skills/broken'), { recursive: true })
    fs.writeFileSync(path.join(e.fx.team, 'projects/falcon/skills/broken/SKILL.md'), md('other-name', 'x'))
    try {
      expect(skillIssues(e.files, who('alice')).map((i) => i.path)).toContain('projects/falcon/skills/broken/SKILL.md')
      expect(skillIssues(e.files, who('bob')).map((i) => i.path)).not.toContain('projects/falcon/skills/broken/SKILL.md')
    } finally { fs.rmSync(path.join(e.fx.team, 'projects/falcon/skills/broken'), { recursive: true }) }
  })
})

describe('in the app: the "/" list, chats, the card, removal, the trash, scheduled runs', () => {
  let h: Harness
  const socks: Record<string, TestSocket> = {}
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const cm = () => 'cm-' + crypto.randomUUID()
  beforeAll(async () => {
    h = await startHarness({ name: 'project-skills-app', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
    linkGroups(h.ctx.db)
    projects(h.ctx.db)
    layout(h.team)
    for (const u of ['alice', 'bob', 'carol', 'dana', 'erin']) {
      socks[u] = await h.ws(u, { windowId: `win-ps-${u}` })
      await socks[u]!.next('hello')
    }
  })
  afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

  async function turn(user: string, chatId: string, content: string, answer?: string | null) {
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    let card = null as { question: string; options?: { value: string }[]; preview?: { path: string; skillName: string | null; sameName?: { text: string; hidden: boolean } } } | null
    if (answer !== undefined) {
      const c = await socks[user]!.next('turn.request', (f) => f.data.turnId === r.turnId)
      card = c.data.request as unknown as NonNullable<typeof card>
      if (answer !== null) await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
    }
    const done = await socks[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string, card }
  }
  const projectChat = async (user: string, projectId: string | null = '01900000-0000-7000-8000-00000000f001') => (await h.api(user).call(API.createChat, { body: projectId ? { projectId } : {} })).id
  const unreadable = () => h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = (SELECT id FROM folders WHERE path = 'projects/falcon') AND subject_type = 'group' AND subject_id = 'finance'").run()
  const readable = () => h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, (SELECT id FROM folders WHERE path = 'projects/falcon'), 'group', 'finance', 'read')").run(crypto.randomUUID())

  test('GET /api/skills?projectId=: the project\'s skills while the person sees it; never after the trash', async () => {
    const bob = (await h.api('bob').call(API.listSkills, { query: { projectId: '01900000-0000-7000-8000-00000000f001' } })).items
    expect(bob.find((s) => s.path === 'projects/falcon/skills/launch/SKILL.md')?.project).toEqual({ id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon' })
    expect((await h.api('bob').call(API.listSkills)).items.some((s) => s.path.startsWith('projects/'))).toBe(false)
    // erin cannot see the project: naming it gives her nothing of it
    expect(JSON.stringify((await h.api('erin').call(API.listSkills, { query: { projectId: '01900000-0000-7000-8000-00000000f001' } })).items)).not.toContain(LAUNCH)
    // the Skills page: the sections (alice: marketing's brief runs, the project's is marked)
    const page = (await h.api('alice').call(API.listSkills, { query: { shadowed: '1', projects: '1' } })).items
    expect(page.find((s) => s.path === 'projects/falcon/skills/brief/SKILL.md')?.shadowedBy).toEqual({ tier: 'group', group: { id: 'marketing', name: 'Marketing' } })
    expect(page.find((s) => s.path === 'projects/falcon/skills/launch/SKILL.md')?.shadowedBy).toBeUndefined()
    h.ctx.db.query("UPDATE projects SET trashed_with = 'tr' WHERE id = '01900000-0000-7000-8000-00000000f001'").run()
    try {
      for (const u of ['bob', 'alice', 'dana']) expect(JSON.stringify((await h.api(u).call(API.listSkills, { query: { projectId: '01900000-0000-7000-8000-00000000f001', projects: '1' } })).items), u).not.toContain(LAUNCH)
    } finally { h.ctx.db.query("UPDATE projects SET trashed_with = NULL WHERE id = '01900000-0000-7000-8000-00000000f001'").run() }
  })

  test('only the project\'s chats: its instructions list them, another chat of the same person does not', async () => {
    const inProject = await turn('bob', await projectChat('bob'), fake({ echo: 'system' }))
    expect(inProject.content).toContain(`- launch [project: Falcon]: ${LAUNCH}`)
    const elsewhere = await turn('bob', await projectChat('bob', null), fake({ echo: 'system' }))
    expect(elsewhere.content).not.toContain(LAUNCH)
    // owners and admins: in their own project chats too
    expect((await turn('dana', await projectChat('dana'), fake({ echo: 'system' }))).content).toContain('[project: Falcon]')
  })

  test('a person who loses the project loses its skills at the next turn', async () => {
    const chat = await projectChat('bob')
    const load = fake({ tool: 'skill', args: { name: 'launch' }, sayResult: true })
    expect((await turn('bob', chat, load)).content).toContain('launch steps')
    unreadable()
    try {
      const after = await turn('bob', chat, load)
      expect(after.content).toContain('No skill called "launch"')
      expect(after.content).not.toContain('launch steps')
    } finally { readable() }
  })

  test('"/name" of a project skill taints the session; a team skill does not', async () => {
    const a = await projectChat('bob')
    await turn('bob', a, '/launch for the release\n' + fake({ say: 'ok' }))
    expect(h.ctx.db.query('SELECT session_tainted AS t FROM chats WHERE id = ?').get(a)).toEqual({ t: 1 })
    const b = await projectChat('bob')
    await turn('bob', b, '/quote for ACME\n' + fake({ say: 'ok' }))
    expect(h.ctx.db.query('SELECT session_tainted AS t FROM chats WHERE id = ?').get(b)).toEqual({ t: 0 })
  })

  test('the save card names the project; saved, it is audited with the project and its creator is told', async () => {
    const chat = await projectChat('alice')
    const r = await turn('alice', chat, fake({ tool: 'write', args: { file_path: 'projects/falcon/skills/pitch/SKILL.md', content: md('pitch', 'a pitch') }, sayResult: true }), 'save')
    expect(r.card!.question).toContain('Save this as a skill of the project "Falcon"?')
    expect(r.card!.question).toContain('new project skill "pitch"')
    expect(fs.existsSync(path.join(h.team, 'projects/falcon/skills/pitch/SKILL.md'))).toBe(true)
    const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'skills.change' AND target = 'projects/falcon/skills/pitch/SKILL.md' ORDER BY id DESC LIMIT 1").get() as { actor_id: string; detail: string }
    expect(a.actor_id).toBe('alice')
    expect(JSON.parse(a.detail)).toMatchObject({ change: 'create', byAi: true, kind: 'skill', project: { id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon' } })
    // bob made the project and reads its folder: told, in words that name the project
    const told = await socks.bob!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.message.includes('projects/falcon/skills/pitch/SKILL.md'))
    expect(told.data.message).toContain('"Falcon"')
    const changes = (await h.api('dana').call(API.listSkillChanges, { query: { limit: 20 } })).items
    expect(changes.find((c) => c.path === 'projects/falcon/skills/pitch/SKILL.md')?.project).toEqual({ id: '01900000-0000-7000-8000-00000000f001', name: 'Falcon' })
    // without the card the file layer refuses, also where no project is (fail closed by path; carol may write there)
    const c = crypto.randomUUID(), t = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(c, 'carol')
    h.ctx.db.query('INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?,?,?,?)').run(t, c, 'carol', 'claude-code')
    for (const p of ['projects/falcon/skills/other/SKILL.md', 'projects/nobody-yet/skills/x/SKILL.md']) {
      const out = await h.ctx.files.call('write', { file_path: p, content: md('x', 'x') }, { user: h.ctx.files.principal('carol'), turnId: t, files: new TurnFiles() })
      expect(out.text, p).toContain("needs the user's confirmation")
    }
  })

  test('a skills folder under projects/ that no live project has: the card says no chat follows it', async () => {
    const r = await turn('carol', await projectChat('carol'), fake({ tool: 'write', args: { file_path: 'projects/nobody-yet/skills/x/SKILL.md', content: md('x', 'x') }, sayResult: true }), 'skip')
    // (carol reads Korean)
    expect(r.card!.question).toContain('projects/nobody-yet의 스킬 폴더에 저장할까요? 아직 이 폴더를 쓰는 프로젝트가 없어서 어떤 채팅도 따르지 않아요.')
  })

  test('a side chat beside a room is like a room: no project skills; moved into the project, like any of its chats', async () => {
    const room = await h.api('bob').call(API.createRoom, { body: { kind: 'dm', userId: 'dana' } })
    const side = await h.api('bob').call(API.createChat, { body: { sideRoomId: room.id } })
    expect((await turn('bob', side.id, fake({ echo: 'system' }))).content).not.toContain(LAUNCH)
    await h.api('bob').call(API.updateChat, { params: { id: side.id }, body: { projectId: '01900000-0000-7000-8000-00000000f001' } })
    expect((await turn('bob', side.id, fake({ echo: 'system' }))).content).toContain(`- launch [project: Falcon]: ${LAUNCH}`)
  })

  test('skills that switch on ask first: a project pointed at projects/<name> with skills, a personal project shared there', async () => {
    const status = async (p: Promise<unknown>) => { try { await p; return 0 } catch (e) { return (e as { body: { params?: { reason?: string } } }).body.params?.reason } }
    // an older project on a plain folder, pointed by an admin at projects/kite, which holds a skill
    const id = '01900000-0000-7000-8000-0000000c1001'
    h.ctx.db.query('INSERT INTO projects (id, name, folder_path, created_by, created_at) VALUES (?,?,?,?,?)').run(id, 'Kite', 'shared/kite-old', 'dana', new Date().toISOString())
    fs.mkdirSync(path.join(h.team, 'shared/kite-old'), { recursive: true })
    fs.mkdirSync(path.join(h.team, 'projects/kite/skills/fly'), { recursive: true })
    fs.writeFileSync(path.join(h.team, 'projects/kite/skills/fly/SKILL.md'), md('fly', 'kite fly'))
    expect(await status(h.api('dana').call(API.updateProject, { params: { id }, body: { folderPath: 'projects/kite' } }))).toBe('project_skills_on')
    expect((await h.api('dana').call(API.getProject, { params: { id } })).folderPath).toBe('shared/kite-old')
    await h.api('dana').call(API.updateProject, { params: { id }, body: { folderPath: 'projects/kite', skillsOk: true } })
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'skills.change' AND target = 'projects/kite/skills/fly/SKILL.md'").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ change: 'create', kind: 'skill', project: { id, name: 'Kite' }, switchedOn: 'project_folder' })
    // a personal project with a skill, shared into projects/: the dry run names it, the share asks for it
    const mine = await h.api('bob').call(API.createProject, { body: { name: 'notes', scope: 'personal', participants: [], instructions: '' } })
    fs.mkdirSync(path.join(h.team, mine.folderPath, 'skills/jot'), { recursive: true })
    fs.writeFileSync(path.join(h.team, mine.folderPath, 'skills/jot/SKILL.md'), md('jot', 'jot it'))
    const dry = await h.api('carol').call(API.shareProject, { params: { id: mine.id }, body: { toParent: 'projects', dryRun: true } }).catch(() => null)
    // (only its creator shares it: carol may not; bob may only when he may write projects/)
    expect(dry).toBeNull()
    h.ctx.db.query("INSERT INTO folders (id, path) VALUES ('f_projects_root', 'projects') ON CONFLICT DO NOTHING").run()
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('r_projects_bob', (SELECT id FROM folders WHERE path = 'projects'), 'user', 'bob', 'write')").run()
    const dry2 = await h.api('bob').call(API.shareProject, { params: { id: mine.id }, body: { toParent: 'projects', dryRun: true } })
    expect('viewersAdded' in dry2 && dry2.skills).toEqual(['jot'])
    expect(await status(h.api('bob').call(API.shareProject, { params: { id: mine.id }, body: { toParent: 'projects' } }))).toBe('project_skills_on')
    try {
      const shared = await h.api('bob').call(API.shareProject, { params: { id: mine.id }, body: { toParent: 'projects', skillsOk: true } })
      expect('id' in shared && shared.folderPath).toMatch(/^projects\//)
      const target = 'id' in shared ? shared.folderPath : ''
      expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'skills.change' AND target = ?").get(`${target}/skills/jot/SKILL.md`)).toEqual({ n: 1 })
    } finally { h.ctx.db.query("DELETE FROM folder_rules WHERE id = 'r_projects_bob'").run() }
  })

  test('the creator is told only while they read the folder', async () => {
    h.ctx.db.query("UPDATE projects SET created_by = 'erin' WHERE id = '01900000-0000-7000-8000-00000000f001'").run()
    try {
      const before = socks.erin!.frames.length
      await turn('alice', await projectChat('alice'), fake({ tool: 'write', args: { file_path: 'projects/falcon/skills/pitch2/SKILL.md', content: md('pitch2', 'x') }, sayResult: true }), 'save')
      await socks.dana!.next('notice', (f) => f.data.code === 'skill_changed' && f.data.message.includes('pitch2'))
      expect(socks.erin!.frames.slice(before).some((f) => f.type === 'notice' && JSON.stringify(f).includes('pitch2'))).toBe(false)
    } finally { h.ctx.db.query("UPDATE projects SET created_by = 'bob' WHERE id = '01900000-0000-7000-8000-00000000f001'").run() }
  })

  test('a name a wider skill has: no dead save, the card offers another name', async () => {
    const r = await turn('alice', await projectChat('alice'), fake({ tool: 'write', args: { file_path: 'projects/falcon/skills/quote/SKILL.md', content: md('quote', 'falcon quote') }, sayResult: true }), 'rename')
    expect(r.card!.preview!.sameName).toEqual({ text: '"quote" is in the whole team, so this project uses that one. It is not saved under this name.', hidden: true })
    // alice cannot write the team's skills: no "change the team's" choice
    expect(r.card!.options!.map((o) => o.value)).toEqual(['rename', 'skip'])
    expect(r.content).toContain('pick a new name')
    expect(fs.existsSync(path.join(h.team, 'projects/falcon/skills/quote/SKILL.md'))).toBe(false)
    // carol (admin) may change the team's: offered
    const c = await turn('carol', await projectChat('carol'), fake({ tool: 'write', args: { file_path: 'projects/falcon/skills/quote/SKILL.md', content: md('quote', 'falcon quote') }, sayResult: true }), 'fix')
    expect(c.card!.options!.map((o) => o.value)).toEqual(['rename', 'fix', 'skip'])
    expect(c.content).toContain('change the existing "quote" skill')
  })

  test('a scheduled task whose project its owner no longer sees: skipped, said in the result and the inbox', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('bob', { title: 'Falcon digest', prompt: fake({ echo: 'system' }), repeat: 'daily', time: '09:00', projectId: '01900000-0000-7000-8000-00000000f001' } as never, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    unreadable()
    try {
      expect(rt.schedules.runDue(now)).toEqual([])
      expect(h.ctx.db.query('SELECT project_id FROM schedule_project_skips WHERE schedule_id = ?').get(made.id)).toEqual({ project_id: '01900000-0000-7000-8000-00000000f001' })
      // paused after this one notice, not one at every run while the project stays gone
      expect(h.ctx.db.query('SELECT enabled FROM schedules WHERE id = ?').get(made.id)).toEqual({ enabled: 0 })
      expect(rt.schedules.lastOutcome('bob', made.id)).toBe('project_gone')
      // no chat ran outside the project
      expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM turns WHERE schedule_id = ?").get(made.id)).toEqual({ n: 0 })
      const inbox = await waitFor(async () => (await h.api('bob').call(API.listNotifications, { query: {} } as never)).items.find((n: { projectGone?: boolean }) => n.projectGone), { timeoutMs: 10_000 })
      expect(inbox).toMatchObject({ code: 'schedule.failure', projectGone: true, link: null })
    } finally { readable() }
  })
})
