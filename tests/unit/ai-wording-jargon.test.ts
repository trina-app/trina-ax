// What the AI is led to say to people who are not developers (real-AI scenario cases SKL-04, SKL-02.member,
// PRJ-01.outsider, PRJ-03.project, ADM-07; docs/decisions/20261117-ai-wording-jargon.md): skills by the title people
// see, not their folder id; a read-only team skill points to "Suggest as skill" or a personal copy instead of a pasted
// file; a project the person is not in is said to be one they are not in (the same text whether it exists or not); a
// member in a shared project chat is told who changes its members instead of being sent to a private chat that would
// refuse them too; "the server" is not a word for the person.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Skill } from '../../server/src/chat/skills'
import { buildSkillList, matchSkills, resolveSkill, skillChanges, skillChangesText } from '../../server/src/chat/skill-list'
import { plainWordsRule, sharedSection, skillBlock, skillHintsBlock } from '../../server/src/chat/prompt'
import { projectNotFoundNote, readOnlyNote, readOnlySkillLine } from '../../server/src/policy/refusal'
import { projectMembersBy } from '../../server/src/chat/projects'
import { answerHasButtons, notMemberFor } from '../../server/src/chat/tools'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sk = (p: string, name: string, description: string, title?: string): Skill => ({ path: p, name, description, body: 'steps', ...(title ? { title } : {}) })
const QUOTE = sk('skills/quote-writer/SKILL.md', 'quote-writer', '거래처 견적서를 만들고 회사 직인을 찍는다.', '견적서 작성')
const WEEKLY = sk('skills/weekly-report/SKILL.md', 'weekly-report', 'Weekly sales report.', 'Weekly sales report')
const PLAIN = sk('skills/거래처-응대/SKILL.md', '거래처-응대', '거래처 문의에 답하는 메일을 쓴다.')
const SAME = sk('skills/notes/SKILL.md', 'notes', 'Meeting notes.', 'Notes')

describe('skills by the title people see (SKL-04)', () => {
  test('the list line gives the title next to the name; none when there is no title or it is the name', () => {
    const l = buildSkillList([QUOTE, WEEKLY, PLAIN, SAME])
    expect(l.lines).toContain('- quote-writer "견적서 작성": 거래처 견적서를 만들고 회사 직인을 찍는다.')
    expect(l.lines).toContain('- weekly-report "Weekly sales report": Weekly sales report.')
    expect(l.lines).toContain('- 거래처-응대: 거래처 문의에 답하는 메일을 쓴다.')
    expect(l.lines).toContain('- notes: Meeting notes.')
  })

  test('a title cannot break the line or the quotes', () => {
    const odd = sk('skills/odd/SKILL.md', 'odd', 'x', 'Say "hi"\nnow')
    expect(buildSkillList([odd]).lines[0]).toBe('- odd "Say \'hi\' now": x')
  })

  test('the skill tool takes the name, the line as written, or the title', () => {
    const skills = [QUOTE, WEEKLY, PLAIN]
    for (const input of ['quote-writer', 'quote-writer "견적서 작성"', '견적서 작성']) {
      const r = resolveSkill(skills, input)
      expect(r && 'skill' in r ? r.skill.path : null).toBe(QUOTE.path)
    }
  })

  test('find_skills matches the title words', () => {
    const settle = sk('skills/month-end/SKILL.md', 'month-end', 'Closes the month.', '월말 정산')
    expect(matchSkills([QUOTE, PLAIN, settle], '월말 정산 해줘').map((m) => m.skill.name)).toEqual(['month-end'])
  })

  test('a loaded skill, the hints and the changes since the chat started carry the title', () => {
    expect(skillBlock(QUOTE, '', 'loaded')).toContain('<team_skill name="quote-writer" title="견적서 작성" path="skills/quote-writer/SKILL.md">')
    expect(skillBlock(PLAIN, '', 'loaded')).toContain('<team_skill name="거래처-응대" path=')
    expect(skillHintsBlock([QUOTE])).toContain('- quote-writer "견적서 작성": ')
    expect(skillChangesText(skillChanges([], [QUOTE]))).toContain('- added: quote-writer "견적서 작성": ')
  })
})

describe('a read-only team skill (SKL-02.member)', () => {
  let db: Database
  beforeAll(() => {
    db = new Database(':memory:')
    db.run("CREATE TABLE users (id TEXT, name TEXT, role TEXT, status TEXT DEFAULT 'active', deleted_at TEXT)")
    db.run('CREATE TABLE projects (id TEXT, name TEXT, folder_path TEXT, created_by TEXT, trashed_with TEXT)')
  })
  afterAll(() => db.close())
  const t = "Access denied: read-only: you cannot change 'skills/weekly-report/SKILL.md'"

  // "Suggest as skill" turns an answer or a file into a NEW skill; registering it never changes an existing one (a file of
  // that name is refused: skills/suggestions.ts approveSuggestion). Offering it for a change to quote-writer was a false
  // claim (AI scenarios SKL-01.member, SKL-02.approval, 2026-11-17; since b4eeacdd0)
  test('a change to a team skill: ask its managers or a personal copy, never "Suggest as skill" or the whole text', () => {
    const note = readOnlyNote(db, t, 'ko', { userId: 'd', sees: () => true, button: true })!
    expect(note).toBe("Write access to 'skills/weekly-report/SKILL.md': an admin can give it (in Admin › Folder permissions (\"관리자 › 폴더 권한\")). " +
      'Next step: tell the user in a sentence that only the people who manage team skills (the owner, admins, or whoever they chose) change a team skill; then offer, a line each: ' +
      'you write a short message for them saying what to change, which the user sends them themselves (you cannot send it); or, if they ask, you save a personal copy with the change, which replaces the team skill for them only (not for a change that drops an approval or check the team requires: then only the message). ' +
      '"스킬로 제안" under an answer suggests a new skill, never a change to an existing one: do not offer it for this. Do not paste the whole changed text for them to copy by hand.')
    expect(note).not.toContain('users/')
    expect(note).not.toContain('button under your answer')
  })

  test('the same next step in a shared chat', () => {
    const note = readOnlyNote(db, t, 'en', { userId: 'd', sees: () => true, button: false })!
    expect(note).toContain('if they ask, you save a personal copy with the change')
    expect(note).toContain('Do not paste the whole changed text')
    expect(note).not.toContain('button under your answer')
  })

  test('a loaded team skill the person cannot change says so up front, the same next step', () => {
    expect(readOnlySkillLine('skills/weekly-report/SKILL.md', true, 'ko')).toBe('This user cannot change this team skill; only the people who manage team skills can. If asked to change it, offer to write a short message for them saying what to change (the user sends it; you cannot), or a personal copy that replaces it for them only (not when the change drops an approval or check the team requires). "스킬로 제안" under an answer suggests a new skill, never a change to this one: do not offer it for this. Never paste the whole changed text.')
    expect(readOnlySkillLine('skills/weekly-report/SKILL.md', false, 'en')).toBeNull()
    expect(readOnlySkillLine('users/d/skills/x/SKILL.md', true, 'en')).toBeNull()
  })

  test('other folders keep their note', () => {
    expect(readOnlyNote(db, "Access denied: read-only: you cannot change 'shared/a.md'", 'en', { userId: 'd', sees: () => true, button: true })).toContain('save it in their own folder')
  })
})

describe('the buttons under an answer (Suggest as skill, save in my folder)', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE rooms (id TEXT, kind TEXT, name TEXT, group_id TEXT, archived_at TEXT)')
  db.run('CREATE TABLE chats (id TEXT, user_id TEXT, side_room_id TEXT)')
  db.run('CREATE TABLE room_members (room_id TEXT, user_id TEXT)')
  db.run("INSERT INTO rooms VALUES ('r', 'group', 'Sales', NULL, NULL)")
  db.run("INSERT INTO chats VALUES ('own', 'u', NULL), ('side', 'u', 'r')")
  db.run("INSERT INTO room_members VALUES ('r', 'u')")
  const e = (o: { chatId?: string; clientKind?: string; shared?: boolean; restricted?: boolean }) => ({ rt: { db }, spec: { chatId: o.chatId ?? 'own', userId: 'u', clientKind: o.clientKind ?? 'web' }, shared: o.shared ? {} : null, restricted: !!o.restricted }) as unknown as Parameters<typeof answerHasButtons>[0]
  test('only a person\'s own chat in the app', () => {
    expect(answerHasButtons(e({}))).toBe(true)
    expect(answerHasButtons(e({ clientKind: 'mobile' }))).toBe(true)
    expect(answerHasButtons(e({ chatId: 'side' }))).toBe(false)
    expect(answerHasButtons(e({ shared: true }))).toBe(false)
    expect(answerHasButtons(e({ clientKind: 'schedule' }))).toBe(false)
    expect(answerHasButtons(e({ clientKind: 'slack' }))).toBe(false)
    expect(answerHasButtons(e({ restricted: true }))).toBe(false)
  })
})

describe('a project the person is not in (PRJ-01.outsider)', () => {
  const none = () => false
  test('projects/<name> they cannot read: not a member of a project there, the same text whether it exists or not', () => {
    const a = projectNotFoundNote("Access denied: not found or no access: 'projects/라마바카페-납품'", { sees: none, lists: none })!
    const b = projectNotFoundNote("Access denied: not found or no access: 'projects/없는-프로젝트'", { sees: none, lists: none })!
    expect(a).toBe('Only a project\'s members see it: the user is not a member of a project called "라마바카페-납품" (the same answer whether or not one exists, so do not say whether it does). Next step: say so plainly; if they should be in it, the person who made that project or an admin can add them.')
    expect(b.replace('없는-프로젝트', 'X')).toBe(a.replace('라마바카페-납품', 'X'))
    expect(projectNotFoundNote("Access denied: not found or no access: 'projects/라마바카페-납품/견적서.pdf'", { sees: none, lists: none })).toBe(a)
  })

  test('projects/ itself only when they cannot list it (in no project)', () => {
    expect(projectNotFoundNote("Access denied: not found or no access: 'projects'", { sees: none, lists: () => true })).toBeNull()
    expect(projectNotFoundNote("Access denied: not found or no access: 'projects'", { sees: none, lists: none })).toBe('The user is a member of no team project: only a project\'s members see it. Next step: say so plainly; if they should be in one, the person who made it or an admin can add them.')
  })

  test('the file tools add it after their own refusal, by the person\'s rules on the real folder name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'))
    fs.mkdirSync(path.join(root, 'projects', 'Atlas'), { recursive: true })
    // a case-insensitive disk (an office Mac): projects/atlas is the folder projects/Atlas, which the member reads
    const exec = (level: string, caseInsensitive = true) => ({
      rt: { files: { fx: { root, caseInsensitive }, rules: () => ({ access: (_p: unknown, segs: string[]) => (segs[1] === 'Atlas' ? 'write' : level), canList: () => false }) } },
      livePrincipal: () => ({ id: 'j', role: 'member', groups: [] }),
    }) as unknown as Parameters<typeof notMemberFor>[0]
    expect(notMemberFor(exec('none'), "Access denied: not found or no access: 'projects/atlas/missing.md'")).toBeNull()
    expect(notMemberFor(exec('none', false), "Access denied: not found or no access: 'projects/atlas/missing.md'")).toContain('not a member of a project called "atlas"')
    expect(notMemberFor(exec('none'), "Access denied: not found or no access: 'projects/p'")).toContain('the user is not a member of a project called "p"')
    expect(notMemberFor(exec('write'), "Access denied: not found or no access: 'projects/p/x.md'")).toBeNull()
    expect(notMemberFor(exec('none'), "Error: the service said: Access denied: not found or no access: 'projects/p'")).toBeNull()
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a missing file in a project they are in, any other folder, or another error: no note', () => {
    expect(projectNotFoundNote("Access denied: not found or no access: 'projects/atlas/x.md'", { sees: () => true, lists: () => true })).toBeNull()
    expect(projectNotFoundNote("Access denied: not found or no access: 'shared/x.md'", { sees: none, lists: none })).toBeNull()
    expect(projectNotFoundNote("Access denied: read-only: you cannot change 'projects/atlas/x.md'", { sees: none, lists: none })).toBeNull()
  })
})

describe('a member asks to change who is in the project from its shared chat (PRJ-03.project)', () => {
  let db: Database
  beforeAll(() => {
    db = new Database(':memory:')
    db.run("CREATE TABLE users (id TEXT, name TEXT, role TEXT, status TEXT DEFAULT 'active', deleted_at TEXT)")
    db.run("INSERT INTO users (id, name, role) VALUES ('j', '김지우', 'owner'), ('gone', 'Gone', 'member')")
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'gone'")
  })
  afterAll(() => db.close())

  test('who changes the members, as the project page says it (membersView)', () => {
    expect(projectMembersBy(db, { created_by: 'j' }, { membersEditable: true, creatorChangesMembers: true })).toBeNull()
    expect(projectMembersBy(db, { created_by: 'j' }, { membersEditable: false, creatorChangesMembers: true })).toBe('김지우 (who made it) or an admin')
    // a creator who left the project or lost the folder, or an older project on an admin's folder: not named
    expect(projectMembersBy(db, { created_by: 'j' }, { membersEditable: false, creatorChangesMembers: false })).toBe('an admin')
    expect(projectMembersBy(db, { created_by: null }, {})).toBe('an admin')
  })

  test('the shared project chat says who, and no longer sends them to a private chat for it', () => {
    const s = sharedSection({ project: '라마바카페 납품', audience: 4, asker: '이소라', members: '김지우 (who made it) or an admin' }, 'ko')
    expect(s).toContain("- Only 김지우 (who made it) or an admin changes this project's members, not 이소라: say so if asked.")
    expect(s).not.toContain("changing the project's members")
    // the one who may still goes to a chat only they see
    const may = sharedSection({ project: '라마바카페 납품', audience: 4, asker: '김지우' }, 'ko')
    expect(may).toContain("changing the project's members")
    expect(may).not.toContain("changes this project's members")
  })
})

describe('the skills section keeps "load before you follow" and its size (review)', () => {
  test('the guard is there and the title line is short', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../server/src/chat/prompt.ts'), 'utf8')
    expect(src).toContain('Load a skill before you follow it: the line here is only its summary.')
    expect(src).toContain("Each line: name, title in quotes (call the skill that to the user), what it is for.")
  })
})

describe('"the server" is not a word for the person (ADM-07)', () => {
  test('the plain words rule names it', () => {
    for (const stamp of [true, false]) expect(plainWordsRule(stamp)).toContain('tool names, a server or how it works inside')
  })
})
