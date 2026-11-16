// A new skill is a folder with a SKILL.md (AI scenario check SKL-06): the prompt's save lines say <root>/<name>/SKILL.md
// for the team, a group, a project and the person's own skills, with the header said once; a new single .md skill the
// AI writes still loads, and the write result says the next one goes in a folder. Team rules (no header) and older
// single-file skills are unchanged.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSkills, skillWriteNote } from '../../server/src/chat/skills'
import { skillsSection } from '../../server/src/chat/prompt'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-skill-save-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
const legacy = '---\nname: agreement-draft\ndescription: Drafts an agreement.\n---\nSteps\n'
put('skills/old-way.md', legacy)
put('skills/quote/SKILL.md', '---\nname: quote\ndescription: Makes a quote.\n---\nSteps\n')
put('skills/quote/notes.md', '---\nname: notes\ndescription: x\n---\n')

type Files = Parameters<typeof listSkills>[0]
type User = Parameters<typeof listSkills>[1]
const files = (writer: boolean) => ({
  fx: { root },
  db: { query: () => ({ all: () => [], get: () => null }) },
  rules: () => ({ canList: () => true, access: (u: { id: string }) => (writer && u.id === 'admin' ? 'write' : 'read') }),
}) as unknown as Files
const admin = { id: 'admin', groups: [] } as unknown as User
const member = { id: 'mina', groups: [] } as unknown as User

describe('the save lines', () => {
  test('a skill manager: team and personal skills are folders; the header is said once', () => {
    const s = skillsSection(files(true), admin)
    expect(s).toContain('write skills/<name>/SKILL.md (a folder per skill), starting with a header: a line "---", "name: <name>" (the folder name')
    expect(s).toContain('write users/admin/skills/<name>/SKILL.md, with the same header.')
    expect(s).not.toContain('<short-name>.md')
    expect(s.split('starting with a header').length - 1).toBe(1)
  })
  test('a member who cannot write skills/: the personal line has the header itself', () => {
    const s = skillsSection(files(false), member)
    expect(s).toContain('You cannot save under skills/.')
    expect(s).toContain('write users/mina/skills/<name>/SKILL.md, starting with a header')
    expect(s).not.toContain('with the same header')
  })
})

describe('the write result', () => {
  const note = (rel: string, text: string, created = true) => skillWriteNote(root, rel, Buffer.from(text), { created })
  test('a new single-file skill loads, and the result says the next one goes in a folder', () => {
    expect(note('skills/agreement-draft.md', legacy)).toContain('a new skill should be a folder: skills/<name>/SKILL.md')
    expect(note('users/mina/skills/agreement-draft.md', legacy)).toContain('users/mina/skills/<name>/SKILL.md')
    expect(listSkills(files(true), admin).map((s) => s.path)).toContain('skills/old-way.md')
  })
  test('no note for an older single-file skill changed, a SKILL.md, a team rule, a skill\'s own file or a file elsewhere', () => {
    expect(note('skills/old-way.md', legacy, false)).toBe('')
    expect(note('skills/quote/SKILL.md', '---\nname: quote\ndescription: Makes a quote.\n---\nSteps\n')).toBe('')
    expect(note('skills/answer-rules.md', '# Answer rules\nAmounts in won.')).toBe('')
    expect(note('skills/quote/notes.md', legacy)).toBe('')
    expect(note('shared/agreement-draft.md', legacy)).toBe('')
  })
})
