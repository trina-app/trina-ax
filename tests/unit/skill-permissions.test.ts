// Skills: folder permissions and personal skills (docs/DECISIONS.md "Skills: folder permissions and personal skills").
// A skill in a restricted skills/<sub>/ folder reaches only the people who can read that folder, and a personal skill
// in users/<id>/skills/ reaches only its owner (not other members, not admins), through every path that lists or
// invokes skills: GET /api/skills (the "/" menu), the prompt's skill index, "/name" (invokedSkill), skill issues,
// popular skills and usage records. The remote MCP skills_list tool is in remote-mcp-tools.test.ts; the HTTP routes
// for every persona are in the security matrix (tests/security/lib/world.ts canaries finSkill and aliceSkill).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { newId } from '../../server/src/db'
import { checkSkill, invokedSkill, listSkills, readSkill, skillInfo, skillIssues } from '../../server/src/chat/skills'
import { buildTurnPrompt, skillBlock, skillsSection, teamRules } from '../../server/src/chat/prompt'
import { recordSkillUse } from '../../server/src/admin/skill-usage'
import { popularSkills } from '../../server/src/skills/popular'
import { CONFIRMED } from '../lib/schedule-card'

setDefaultTimeout(60_000)

const FIN = 'FIN-SKILL-CANARY-5b1'
const FIN_PKG = 'FIN-PKG-CANARY-0c2'
const MINE = 'ALICE-PERSONAL-CANARY-7d4'
const MINE_PKG = 'ALICE-PKG-CANARY-3e9'
const MINE_RULE = 'ALICE-RULE-CANARY-11f'
const TEAM_WEEKLY = 'TEAM-WEEKLY-BODY-8a0'

/** The same layout for both setups: a finance-only skills folder, a team skill, and alice's personal skills. */
function layout(team: string, db: import('bun:sqlite').Database) {
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(team, rel)), { recursive: true }); fs.writeFileSync(path.join(team, rel), text) }
  put('skills/finance/close.md', `---\nname: Month close\ndescription: ${FIN}\n---\nclose the books\n`)
  put('skills/finance/budget-review/SKILL.md', `---\nname: budget-review\ndescription: ${FIN_PKG}\n---\nreview\n`)
  put('skills/weekly.md', `---\nname: Weekly\ndescription: team weekly report\n---\n${TEAM_WEEKLY}\n`)
  put('users/alice/skills/weekly.md', `---\nname: Weekly\ndescription: ${MINE}\n---\nmy own weekly steps\n`)
  put('users/alice/skills/draft-mail/SKILL.md', `---\nname: draft-mail\ndescription: ${MINE_PKG}\n---\ndraft\n`)
  put('users/alice/skills/draft-mail/references/tone.md', '---\nname: Not a skill\n---\nresource\n')
  put('users/alice/skills/broken.md', '---\nname: a/b\n---\nbroken header\n')
  put('users/alice/skills/my-rule.md', `${MINE_RULE}\n`)
  // skills/finance: everyone none + finance read (a group rule wins over everyone; without the none rule the
  // folder would fall back to the everyone-read rule of skills/)
  const folder = 'f_skills_finance_' + newId()
  db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(folder, 'skills/finance')
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'none')").run(newId(), folder)
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', 'finance', 'read')").run(newId(), folder)
}

describe('listing and reading (real folder rules)', () => {
  const e = makeEnv('skill-permissions')
  layout(e.fx.team, e.db)
  afterAll(() => e.db.close())
  const who = (id: string) => e.files.principal(id)
  const paths = (id: string) => listSkills(e.files, who(id)).map((s) => s.path)

  test('a member outside skills/finance does not see its skills; a member of finance, admins and the owner do', () => {
    expect(paths('alice').some((p) => p.startsWith('skills/finance/'))).toBe(false)
    expect(paths('erin').some((p) => p.startsWith('skills/finance/'))).toBe(false)
    for (const id of ['bob', 'carol', 'dana']) expect(paths(id)).toEqual(expect.arrayContaining(['skills/finance/close.md', 'skills/finance/budget-review/SKILL.md']))
    expect(readSkill(e.files, who('alice'), 'skills/finance/close.md')).toBeNull()
    expect(readSkill(e.files, who('bob'), 'skills/finance/close.md')?.description).toBe(FIN)
  })

  test('a personal skill is listed only for its owner: not for other members, not for admins or the owner', () => {
    expect(paths('alice')).toEqual(expect.arrayContaining(['users/alice/skills/weekly.md', 'users/alice/skills/draft-mail/SKILL.md']))
    for (const id of ['bob', 'erin', 'carol', 'dana']) {
      expect(paths(id).some((p) => p.startsWith('users/'))).toBe(false)
      expect(readSkill(e.files, who(id), 'users/alice/skills/weekly.md')).toBeNull()
      expect(JSON.stringify(listSkills(e.files, who(id)))).not.toContain(MINE)
    }
    // a resource inside a personal package is not a skill of its own
    expect(paths('alice')).not.toContain('users/alice/skills/draft-mail/references/tone.md')
  })

  test('a personal skill with the same name as a team skill replaces it for its owner only', () => {
    const mine = listSkills(e.files, who('alice')).filter((s) => s.name === 'Weekly')
    expect(mine.map((s) => s.path)).toEqual(['users/alice/skills/weekly.md'])
    expect(listSkills(e.files, who('bob')).filter((s) => s.name === 'Weekly').map((s) => s.path)).toEqual(['skills/weekly.md'])
    expect(skillInfo(mine[0]!)).toEqual({ path: 'users/alice/skills/weekly.md', name: 'Weekly', description: MINE, personal: true })
    expect(skillInfo(listSkills(e.files, who('bob')).find((s) => s.name === 'Weekly')!)).toEqual({ path: 'skills/weekly.md', name: 'Weekly', description: 'team weekly report' })
  })

  test('"/name" uses the list of the person who sends it', () => {
    expect(invokedSkill(listSkills(e.files, who('alice')), '/Month close now')).toBeNull()
    expect(invokedSkill(listSkills(e.files, who('alice')), '/close now')).toBeNull()
    expect(invokedSkill(listSkills(e.files, who('bob')), '/Month close now')?.skill.path).toBe('skills/finance/close.md')
    expect(invokedSkill(listSkills(e.files, who('alice')), '/Weekly')?.skill.path).toBe('users/alice/skills/weekly.md')
    expect(invokedSkill(listSkills(e.files, who('bob')), '/Weekly')?.skill.path).toBe('skills/weekly.md')
    expect(invokedSkill(listSkills(e.files, who('alice')), '/draft-mail x')?.skill.path).toBe('users/alice/skills/draft-mail/SKILL.md')
    for (const id of ['bob', 'carol', 'dana']) expect(invokedSkill(listSkills(e.files, who(id)), '/draft-mail x')).toBeNull()
    // equal key length: a personal file alias wins over a team file alias of the same name
    const team = { path: 'skills/memo.md', name: 'Team memo', description: '', body: '' }
    const own = { path: 'users/alice/skills/memo.md', name: 'My memo', description: '', body: '' }
    expect(invokedSkill([team, own], '/memo')?.skill.path).toBe(own.path)
  })

  test('the prompt skill index and team rules are those of the person running the turn', () => {
    const a = skillsSection(e.files, who('alice')), b = skillsSection(e.files, who('bob')), c = skillsSection(e.files, who('carol'))
    expect(a).not.toContain(FIN)
    expect(a).toContain(MINE)
    expect(a).toContain('users/alice/skills/weekly.md) [personal]')
    expect(a).toContain('users/alice/skills/<short-name>.md')
    expect(b).toContain(FIN)
    expect(b).toContain('skills/weekly.md')
    for (const s of [b, c]) { expect(s).not.toContain(MINE); expect(s).not.toContain(MINE_PKG); expect(s).not.toContain('users/alice') }
    expect(c).toContain(FIN)
    // a personal file without a header is not a team rule, for nobody (team rules are skills/*.md only)
    for (const id of ['alice', 'bob', 'carol']) expect(teamRules(e.files, who(id))).not.toContain(MINE_RULE)
    const prompt = (id: string) => buildTurnPrompt(e.files, { user: who(id), groupNames: [], locale: 'en', timeZone: 'UTC', memories: [], project: null, browser: false, tools: [], history: null })
    expect(prompt('alice')).not.toContain(FIN)
    expect(prompt('bob')).not.toContain(MINE)
    expect(prompt('carol')).not.toContain(MINE)
    const own = listSkills(e.files, who('alice')).find((s) => s.path === 'users/alice/skills/weekly.md')!
    expect(skillBlock(own, '')).toContain('The user invoked this personal skill.')
  })

  test('skill issues of a personal folder are shown to its owner only', () => {
    expect(skillIssues(e.files, who('alice'))).toEqual(expect.arrayContaining([{ path: 'users/alice/skills/broken.md', problem: 'name' }]))
    for (const id of ['bob', 'carol', 'dana']) expect(JSON.stringify(skillIssues(e.files, who(id)))).not.toContain('users/alice')
  })

  test('a personal SKILL.md must sit in a folder named like the skill, at most two folders deep', () => {
    expect(checkSkill('---\nname: draft-mail\ndescription: d\n---\nx', 'users/alice/skills/draft-mail/SKILL.md').ok).toBe(true)
    expect(checkSkill('---\nname: other\ndescription: d\n---\nx', 'users/alice/skills/draft-mail/SKILL.md')).toEqual({ ok: false, problem: 'name_folder' })
    expect(checkSkill('---\nname: skills\ndescription: d\n---\nx', 'users/alice/skills/SKILL.md')).toEqual({ ok: false, problem: 'location' })
    expect(checkSkill('---\nname: d\ndescription: d\n---\nx', 'users/alice/skills/a/b/c/d/SKILL.md')).toEqual({ ok: false, problem: 'location' })
    expect(checkSkill('---\nname: x\ndescription: d\n---\nx', 'users/alice/notes/x/SKILL.md')).toEqual({ ok: false, problem: 'location' })
  })

  test('popular skills and usage records: restricted skills only for their readers, personal skills never', () => {
    const turn = (userId: string) => {
      const id = newId()
      e.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,started_at) VALUES(?,'c',?,'claude-code','done',?)").run(id, userId, new Date(Date.now() - 3600_000).toISOString())
      return id
    }
    recordSkillUse(e.db, { turnId: turn('bob'), userId: 'bob', skill: { path: 'skills/finance/close.md', name: 'Month close' }, source: 'command' })
    recordSkillUse(e.db, { turnId: turn('alice'), userId: 'alice', skill: { path: 'users/alice/skills/weekly.md', name: 'Weekly' }, source: 'command' })
    expect(e.db.query("SELECT COUNT(*) n FROM turn_skill_usage WHERE skill_path LIKE 'users/%'").get()).toEqual({ n: 0 })
    expect(popularSkills(e.db, e.files, who('bob')).items.map((s) => s.path)).toContain('skills/finance/close.md')
    expect(JSON.stringify(popularSkills(e.db, e.files, who('alice')))).not.toContain('finance')
    expect(JSON.stringify(popularSkills(e.db, e.files, who('alice')))).not.toContain('users/')
  })
})

describe('turns through the chat runtime (HTTP, no WebSocket)', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'skill-permissions-turns' })
    layout(h.team, h.ctx.db)
  })
  afterAll(async () => { await h?.close() })
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const answerOf = async (chatId: string) => {
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
    const m = h.ctx.db.query("SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string; content: string; error: string | null }
    if (m.status !== 'done') throw new Error(`turn ended ${m.status} ${JSON.stringify(m)}`)
    return m.content
  }
  const ask = async (user: string, content: string) => {
    const chat = await h.api(user).call(API.createChat, { body: {} })
    await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    return answerOf(chat.id)
  }

  test('GET /api/skills (the "/" menu) follows the folder rules and personal folders', async () => {
    const items = async (user: string) => (await h.api(user).call(API.listSkills)).items
    const alice = await items('alice')
    expect(JSON.stringify(alice)).not.toContain(FIN)
    expect(alice.find((s) => s.name === 'Weekly')).toEqual({ path: 'users/alice/skills/weekly.md', name: 'Weekly', description: MINE, personal: true })
    for (const user of ['bob', 'carol', 'dana']) {
      const list = await items(user)
      expect(JSON.stringify(list)).toContain(FIN)
      expect(JSON.stringify(list)).not.toContain(MINE)
      expect(list.some((s) => s.personal)).toBe(false)
    }
    expect(JSON.stringify((await h.api('carol').call(API.listSkillIssues)).items)).not.toContain('users/alice')
  })

  test('"/name" in a chat: a restricted skill only for its readers, a personal skill only for its owner', async () => {
    const out = await ask('alice', '/Month close\n' + fake({ echo: 'message' }))
    expect(out).not.toContain('<team_skill')
    expect(out).not.toContain('close the books')
    expect(await ask('bob', '/Month close\n' + fake({ echo: 'message' }))).toContain('<team_skill name="Month close" path="skills/finance/close.md">')
    const mine = await ask('alice', '/Weekly\n' + fake({ echo: 'message' }))
    expect(mine).toContain('path="users/alice/skills/weekly.md"')
    expect(mine).not.toContain(TEAM_WEEKLY)
    const carol = await ask('carol', '/Weekly\n' + fake({ echo: 'message' }))
    expect(carol).toContain('path="skills/weekly.md"')
    expect(await ask('carol', '/draft-mail\n' + fake({ echo: 'message' }))).not.toContain('<team_skill')
    // the system prompt index of the turn
    const sys = await ask('bob', fake({ echo: 'system' }))
    expect(sys).toContain(FIN)
    expect(sys).not.toContain(MINE)
  })

  test('a personal skill can be suggested to the team: the suggester and the managers of skills/ see it, nobody else', async () => {
    const made = await h.api('alice').call(API.createSkillSuggestion, { body: { source: { kind: 'file', path: 'users/alice/skills/weekly.md' }, targetFolder: 'skills', name: 'Weekly mine', description: '', content: 'my own weekly steps' } })
    for (const user of ['alice', 'carol', 'dana']) expect((await h.api(user).call(API.getSkillSuggestion, { params: { id: made.id } })).source.path).toBe('users/alice/skills/weekly.md')
    for (const user of ['bob', 'erin']) expect((await h.req(user, `/api/skills/suggestions/${made.id}`)).status).toBe(404)
    // a suggestion does not make the personal skill visible to anyone else
    expect(JSON.stringify((await h.api('carol').call(API.listSkills)).items)).not.toContain(MINE)
  })

  test('a scheduled run uses the skills of the schedule owner', async () => {
    const rt = h.rt()
    const run = async (user: string, prompt: string) => {
      const made = rt.schedules.create(user, { title: 'Skill run', prompt, repeat: 'once', date: '2099-01-01', time: '09:00' }, undefined, CONFIRMED)
      const now = new Date()
      h.ctx.db.query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 1000).toISOString(), made.id)
      rt.schedules.runDue(now)
      const chatId = await waitFor(() => rt.schedules.get(user, made.id)?.last_chat_id ?? null, { timeoutMs: 10_000 })
      return answerOf(chatId!)
    }
    expect(await run('bob', '/Month close\n' + fake({ echo: 'message' }))).toContain('path="skills/finance/close.md"')
    expect(await run('alice', '/Month close\n' + fake({ echo: 'message' }))).not.toContain('<team_skill')
    expect(await run('alice', '/draft-mail\n' + fake({ echo: 'message' }))).toContain('path="users/alice/skills/draft-mail/SKILL.md"')
    expect(await run('dana', '/draft-mail\n' + fake({ echo: 'message' }))).not.toContain('<team_skill')
  })
})
