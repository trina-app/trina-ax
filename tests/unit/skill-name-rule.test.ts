// R2-SKILL-03: a SKILL.md whose name breaks the rule (lowercase a to z, 0 to 9, hyphens, the same as the folder name).
// The warning reaches everyone who can read the file and nobody else, a save warns before and after, and a SKILL.md
// outside the skill roots gets no warning: a project folder can hold one for another tool.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type TurnRequest } from '@mycel/shared/api'
import { makeEnv } from '../lib/env'
import { startHarness, type Harness } from '../lib/b-harness'
import { listSkills, skillFileProblem, skillIssues, skillWriteNote } from '../../server/src/chat/skills'
import { TurnExec } from '../../server/src/chat/turn'
import { sha256 } from '../../server/src/files/store'
import { newId } from '../../server/src/db'

setDefaultTimeout(60_000)

const md = (name: string) => `---\nname: ${name}\ndescription: Makes a quote.\n---\nSteps\n`

/** The JDR cases, the same name in a personal folder, in a finance-only folder and outside the skill roots. */
function layout(team: string, db: import('bun:sqlite').Database) {
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(team, rel)), { recursive: true }); fs.writeFileSync(path.join(team, rel), text) }
  put('skills/jdr-견적/SKILL.md', md('jdr-견적'))
  put('skills/jdr-quote/SKILL.md', md('jdr-견적'))
  put('skills/jdr-ok/SKILL.md', md('jdr-ok'))
  put('skills/finance/jdr-견적/SKILL.md', md('jdr-견적'))
  put('users/alice/skills/jdr-견적/SKILL.md', md('jdr-견적'))
  put('projects/jdr-video/skills/jdr-견적/SKILL.md', md('jdr-견적'))
  put('shared/SKILL.md', md('shared'))
  const folder = 'f_skills_finance_' + newId()
  db.query('INSERT INTO folders (id, path) VALUES (?, ?)').run(folder, 'skills/finance')
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'everyone', NULL, 'none')").run(newId(), folder)
  db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'group', 'finance', 'read')").run(newId(), folder)
}

const TEAM = [
  { path: 'skills/jdr-quote/SKILL.md', problem: 'name' },
  { path: 'skills/jdr-견적/SKILL.md', problem: 'name' },
]
const FINANCE = { path: 'skills/finance/jdr-견적/SKILL.md', problem: 'name' }
const ALICE = { path: 'users/alice/skills/jdr-견적/SKILL.md', problem: 'name' }

describe('who sees the warning', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ name: 'skill-name-rule' })
    layout(h.team, h.ctx.db)
  })
  afterAll(async () => { await h?.close() })
  const items = async (user: string) => (await h.api(user).call(API.listSkillIssues)).items

  test('GET /api/skills/issues: a member sees team files and their own, an admin and the owner see no personal file', async () => {
    expect(await items('alice')).toEqual(expect.arrayContaining([...TEAM, ALICE]))
    expect(await items('alice')).not.toContainEqual(FINANCE)
    expect(await items('erin')).not.toContainEqual(ALICE)
    for (const user of ['carol', 'dana']) {
      expect(await items(user)).toEqual(expect.arrayContaining([...TEAM, FINANCE]))
      expect(await items(user)).not.toContainEqual(ALICE)
    }
  })

  test('a file outside the skill roots is not a skill and gets no warning', async () => {
    const all = JSON.stringify(await items('carol'))
    expect(all).not.toContain('projects/')
    expect(all).not.toContain('shared/')
    expect(listSkills(h.ctx.files, h.ctx.files.principal('carol')).map(s => s.path)).toEqual(['skills/jdr-ok/SKILL.md'])
  })
})

describe('at the save', () => {
  const env = makeEnv('skill-name-rule-save')
  layout(env.fx.team, env.db)
  afterAll(() => env.db.close())

  test('the check gives the same answer as the warning, and nothing outside the skill roots', () => {
    const root = env.fx.team
    expect(skillIssues(env.files, env.files.principal('carol'))).toEqual(expect.arrayContaining(TEAM))
    expect(skillFileProblem(root, 'skills/jdr-견적/SKILL.md', md('jdr-견적'))).toBe('name')
    expect(skillFileProblem(root, 'skills/jdr-quote/SKILL.md', md('other-name'))).toBe('name_folder')
    expect(skillFileProblem(root, 'skills/jdr-ok/SKILL.md', md('jdr-ok'))).toBeNull()
    expect(skillFileProblem(root, 'skills/rule.md', 'A rule without a header')).toBeNull()
    expect(skillFileProblem(root, 'projects/jdr-video/skills/jdr-견적/SKILL.md', md('jdr-견적'))).toBeNull()
    expect(skillFileProblem(root, 'projects/jdr-video/notes.md', '---\nbroken\n---\nBody')).toBeNull()
  })

  test('the card of an AI write shows the problem before the save', async () => {
    const cards: TurnRequest[] = []
    const ctx = env.ctx('carol')
    const exec = Object.assign(Object.create(TurnExec.prototype) as TurnExec, {
      rt: { files: env.files, db: env.db, askUserTimeoutMs: () => 1000 }, spec: { locale: 'en', userId: 'carol' }, files: ctx.files,
      livePrincipal: () => env.files.principal('carol'),
      waitForPerson: async (card: TurnRequest) => { cards.push(card); return 'save' },
    })
    await exec.confirmSkillWrite('write', { file_path: 'skills/jdr-new/SKILL.md', content: md('jdr-견적') })
    expect(cards.at(-1)).toMatchObject({ preview: { path: 'skills/jdr-new/SKILL.md', skillName: null, problem: 'name' } })
    await exec.confirmSkillWrite('write', { file_path: 'skills/jdr-new2/SKILL.md', content: md('jdr-new2') })
    expect(cards.at(-1)).toMatchObject({ preview: { skillName: 'jdr-new2' } })
    expect((cards.at(-1) as { preview: object }).preview).not.toHaveProperty('problem')
  })

  test('the AI gets the rule in the result of write and edit, in a team and a personal skill folder', async () => {
    const turn = (id: string, user: string) => {
      env.db.query("INSERT INTO chats (id,user_id) VALUES (?,?)").run(`chat-${id}`, user)
      env.db.query("INSERT INTO turns (id,chat_id,user_id,engine) VALUES (?,?,?,'claude-code')").run(id, `chat-${id}`, user)
      return env.ctx(user, id)
    }
    const c = turn('name-rule-team', 'carol')
    const rel = 'skills/jdr-saved/SKILL.md', content = md('jdr-견적')
    c.files.skillApprovals.set(rel, sha256(content))
    const saved = await env.files.call('write', { file_path: rel, content }, c)
    expect(saved.isError).toBeFalsy()
    expect(saved.text).toContain('does not load')
    expect(saved.text).toContain('lowercase a to z, 0 to 9 and hyphens')

    const a = turn('name-rule-own', 'alice')
    const own = 'users/alice/skills/mine/SKILL.md'
    expect((await env.files.call('write', { file_path: own, content: md('mine') }, a)).text).not.toContain('does not load')
    const edited = await env.files.call('edit', { file_path: own, old_string: 'name: mine', new_string: 'name: 내것' }, a)
    expect(edited.text).toContain('does not load')
  })

  test('a file that loads and a SKILL.md in a project folder add no text to the result', async () => {
    const c = env.ctx('carol', 'no-note')
    env.db.query("INSERT INTO chats (id,user_id) VALUES ('chat-no-note','carol')").run()
    env.db.query("INSERT INTO turns (id,chat_id,user_id,engine) VALUES ('no-note','chat-no-note','carol','claude-code')").run()
    const r = await env.files.call('write', { file_path: 'projects/jdr-video/tools/x/SKILL.md', content: md('한글') }, c)
    expect(r.isError).toBeFalsy()
    expect(r.text).not.toContain('does not load')
    expect(skillWriteNote(env.fx.team, 'skills/jdr-ok/SKILL.md', Buffer.from(md('jdr-ok')))).toBe('')
  })
})
