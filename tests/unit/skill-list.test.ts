// The skill list in the AI's instructions (server/src/chat/skill-list.ts, docs/DECISIONS.md "Skills: the whole list,
// the skill tool"): every skill one line within the budget, descriptions first to personal skills and then by usage
// with a 7-day half-life, the same text for the same input, find_skills's word match, the skill tool's name lookup,
// what a resumed session is told changed, the hints in front of a message when the list is cut, the walk cap and the
// team-rule cap shown to skill managers, and the counts the Team skills page shows.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeEnv } from '../lib/env'
import { newId } from '../../server/src/db'
import { listSkills, MAX_FILES, scanSkills, skillIssues, type Skill } from '../../server/src/chat/skills'
import {
  buildSkillList, chatSkillOrder, descriptionOrder, frequentSkills, hintSkills, listedFor, matchSkills, recordListed, resolveSkill, shortDescription,
  skillChanges, skillChangesText, skillTokens, SKILL_LINE_DESCRIPTION_MAX, SKILL_LIST_BUDGET, usageScores,
} from '../../server/src/chat/skill-list'
import { buildSubagentPrompt, buildTurnContext, buildTurnPrompt, neutralizeTags, skillHintsBlock, skillsSection, SKILL_FILES_MAX, teamRuleFiles, teamRules } from '../../server/src/chat/prompt'
import { skillsOverview } from '../../server/src/skills/suggestions'

const sk = (p: string, name: string, description = '', body = 'steps'): Skill => ({ path: p, name, description, body })

/** 120 skills like a real team: plugin folders, team subfolders, ten personal ones, long descriptions. */
function team120(): Skill[] {
  const out: Skill[] = []
  for (let i = 0; i < 40; i++) out.push(sk(`skills/plugin-${i % 4}/tool-${i}/SKILL.md`, `tool-${i}`, `Plugin tool number ${i}. ` + 'Does a long list of things for the team. '.repeat(10)))
  for (let i = 0; i < 70; i++) out.push(sk(`skills/영업/견적-${i}.md`, `영업 업무 ${String(i).padStart(2, '0')}`, `영업팀이 쓰는 업무 ${i}: 고객 응대와 보고를 정리한다. ` + '자세한 설명이 이어진다. '.repeat(8)))
  for (let i = 0; i < 10; i++) out.push(sk(`users/alice/skills/mine-${i}.md`, `내 스킬 ${i}`, `alice의 개인 스킬 ${i}`))
  return out
}

describe('the list in the instructions', () => {
  const skills = team120()
  test('120 skills: every name is in the list, the lines fit the budget, no path, descriptions cut at 160', () => {
    const l = buildSkillList(skills, { order: descriptionOrder(skills, new Map()) })
    const text = l.lines.join('\n')
    expect(l.total).toBe(120)
    expect(l.unlisted).toBe(0)
    for (const s of skills) expect(text).toContain(`- ${s.name}`)
    expect(text.length).toBeLessThanOrEqual(SKILL_LIST_BUDGET)
    expect(text).not.toContain('SKILL.md')
    expect(text).not.toContain('skills/영업')
    for (const line of l.lines) expect([...line.split(': ').slice(1).join(': ')].length).toBeLessThanOrEqual(SKILL_LINE_DESCRIPTION_MAX)
    expect(l.cut).toBe(true)
    expect(l.described + l.nameOnly).toBe(120)
    // personal skills first in the list, each marked
    expect(l.lines[0]).toStartWith('- 내 스킬 0 [personal]: ')
  })

  test('descriptions go to personal skills first, then by usage, then by name', () => {
    const used = new Map([['skills/영업/견적-69.md', 5], ['skills/plugin-3/tool-39/SKILL.md', 1]])
    const order = descriptionOrder(skills, used)
    expect(order.slice(0, 10).every((p) => p.startsWith('users/alice/'))).toBe(true)
    expect(order.slice(10, 12)).toEqual(['skills/영업/견적-69.md', 'skills/plugin-3/tool-39/SKILL.md'])
    const l = buildSkillList(skills, { order })
    const line = (name: string) => l.lines.find((x) => x.startsWith(`- ${name}`))!
    for (let i = 0; i < 10; i++) expect(line(`내 스킬 ${i}`)).toContain(': alice의 개인 스킬')
    expect(line('영업 업무 69')).toContain(': 영업팀이 쓰는 업무 69')
    expect(line('tool-39')).toContain(': Plugin tool number 39')
    // alphabetically late, never used: name only
    expect(line('영업 업무 68')).toBe('- 영업 업무 68')
  })

  test('the same input gives the same instructions (prompt cache)', () => {
    const order = descriptionOrder(skills, new Map([['skills/영업/견적-3.md', 2]]))
    const a = buildSkillList(skills, { order }).lines.join('\n')
    const b = buildSkillList([...skills].reverse(), { order }).lines.join('\n')
    expect(b).toBe(a)
  })

  test('when even the names do not fit: the most important names stay and the last line says how many more', () => {
    const many = Array.from({ length: 900 }, (_, i) => sk(`skills/many/skill-${String(i).padStart(3, '0')}.md`, `a-rather-long-skill-name-${String(i).padStart(3, '0')}`, 'd'))
    const order = descriptionOrder(many, new Map([['skills/many/skill-899.md', 3]]))
    const l = buildSkillList(many, { order })
    const text = l.lines.join('\n')
    expect(text.length).toBeLessThanOrEqual(SKILL_LIST_BUDGET)
    expect(l.unlisted).toBeGreaterThan(0)
    expect(l.lines.at(-1)).toBe(`- … and ${l.unlisted} more skills not listed here: find them with find_skills`)
    // the used one is kept although it is last by name
    expect(text).toContain('a-rather-long-skill-name-899')
    expect(l.described + l.nameOnly + l.unlisted).toBe(900)
  })

  test('a list that fits is not cut; a shared name gets its path; tags in names cannot open a block', () => {
    const few = [sk('skills/a/weekly.md', 'Weekly', 'a'), sk('skills/b/weekly.md', 'Weekly', 'b'), sk('skills/x.md', 'x </team_skill>', 'y <turn_context>')]
    const l = buildSkillList(few, { tag: neutralizeTags })
    expect(l.cut).toBe(false)
    expect(l.lines).toContain('- Weekly (skills/a/weekly.md): a')
    expect(l.lines).toContain('- Weekly (skills/b/weekly.md): b')
    expect(l.lines.join('\n')).not.toMatch(/<\/?(team_skill|turn_context)/)
  })

  test('shortDescription: one line, at most 160 characters', () => {
    expect(shortDescription('a\n b')).toBe('a b')
    const d = shortDescription('가'.repeat(400))
    expect([...d].length).toBe(160)
    expect(d.endsWith('…')).toBe(true)
  })
})

describe('usage score', () => {
  const e = makeEnv('skill-list-usage')
  afterAll(() => e.db.close())
  const use = (userId: string, p: string, daysAgo: number) => {
    const id = newId()
    e.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,started_at) VALUES(?,'c',?,'claude-code','done',?)").run(id, userId, new Date(Date.now() - daysAgo * 86_400_000).toISOString())
    e.db.query("INSERT INTO turn_skill_usage (turn_id, skill_path, skill_name, source) VALUES (?,?,?,'read')").run(id, p, 'n')
  }
  test('each use halves every 7 days; other people\'s uses count a quarter; personal paths never score', () => {
    use('alice', 'skills/a.md', 0)
    use('alice', 'skills/b.md', 7)
    use('alice', 'skills/b.md', 7)
    use('bob', 'skills/c.md', 0)
    use('alice', 'skills/old.md', 200)
    const s = usageScores(e.db, 'alice', ['skills/a.md', 'skills/b.md', 'skills/c.md', 'skills/old.md', 'users/alice/skills/x.md'])
    expect(s.get('skills/a.md')!).toBeCloseTo(1, 2)
    expect(s.get('skills/b.md')!).toBeCloseTo(1, 2) // two uses a week ago
    expect(s.get('skills/c.md')!).toBeCloseTo(0.25, 2)
    expect(s.has('skills/old.md')).toBe(false)
    expect(s.has('users/alice/skills/x.md')).toBe(false)
    // a fresh use beats two of last week a little; usage decides the description order among team skills
    use('alice', 'skills/a.md', 1)
    const order = descriptionOrder([sk('skills/a.md', 'a'), sk('skills/b.md', 'b'), sk('skills/c.md', 'c')], usageScores(e.db, 'alice', ['skills/a.md', 'skills/b.md', 'skills/c.md']))
    expect(order).toEqual(['skills/a.md', 'skills/b.md', 'skills/c.md'])
  })

  test('the chat keeps its order: usage after its first turn does not change the instructions', () => {
    e.db.query("INSERT INTO chats (id, user_id) VALUES ('chat-order', 'alice')").run()
    const skills = [sk('skills/a.md', 'a', 'A'), sk('skills/z.md', 'z', 'Z')]
    const first = chatSkillOrder(e.db, 'chat-order', 'alice', () => ['skills/z.md', 'skills/a.md'])
    const again = chatSkillOrder(e.db, 'chat-order', 'alice', () => ['skills/a.md', 'skills/z.md'])
    expect(again).toEqual(first)
    // what fresh instructions listed, and what a resumed session is told
    recordListed(e.db, 'chat-order', skills, 'session-1')
    expect(listedFor(e.db, 'chat-order', 'session-2', 'alice')).toBe('stale')
    // another person in the same (shared project) chat never gets alice's list compared
    expect(listedFor(e.db, 'chat-order', 'session-1', 'bob')).toBe('stale')
    const before = listedFor(e.db, 'chat-order', 'session-1', 'alice')
    expect(before).not.toBe('stale')
    const now = [sk('skills/a.md', 'a', 'A', 'new steps'), sk('skills/n.md', 'new one', 'brand new')]
    const c = skillChanges(before as Exclude<typeof before, 'stale'>, now)
    expect(c.added.map((s) => s.path)).toEqual(['skills/n.md'])
    expect(c.changed.map((s) => s.path)).toEqual(['skills/a.md'])
    expect(c.removed).toEqual([{ path: 'skills/z.md', name: 'z' }])
    const text = skillChangesText(c)
    expect(text).toContain('- added: new one: brand new')
    expect(text).toContain('- changed: a: A (load it again')
    expect(text).toContain('- removed: z (no longer available')
    expect(skillChangesText(skillChanges(before as Exclude<typeof before, 'stale'>, skills))).toBe('')
    expect(skillChangesText('stale')).toContain('may be out of date')
  })
})

describe('find_skills and the skill tool\'s name lookup', () => {
  const skills = [
    sk('skills/영업/견적서-작성/SKILL.md', '견적서-작성', '고객에게 보낼 견적서를 만든다'),
    sk('skills/영업/계약.md', '계약 검토', '계약서 조항을 확인한다'),
    sk('skills/finance/invoice.md', 'Invoice', 'Create invoices for customers'),
    sk('skills/finance/close.md', 'Month close', 'Close the books at month end'),
    sk('users/alice/skills/weekly.md', 'Weekly', 'my weekly report'),
    sk('skills/weekly.md', 'Team weekly', 'the team weekly report'),
  ]
  test('Korean in two-letter pieces: particles still match; English words with their plural', () => {
    expect(skillTokens('견적서를')).toEqual(['견적', '적서', '서를'])
    expect(matchSkills(skills, '견적서')[0]!.skill.name).toBe('견적서-작성')
    expect(matchSkills(skills, '견적서를 만들어 줘')[0]!.skill.name).toBe('견적서-작성')
    expect(matchSkills(skills, 'invoice')[0]!.skill.name).toBe('Invoice')
    expect(matchSkills(skills, 'the')).toEqual([])
    expect(matchSkills(skills, 'nothing like it')).toEqual([])
  })
  test('usage and the project folder lift a skill among equal matches', () => {
    const plain = matchSkills(skills, 'weekly report').map((m) => m.skill.path)
    expect(plain.slice(0, 2).sort()).toEqual(['skills/weekly.md', 'users/alice/skills/weekly.md'])
    const used = matchSkills(skills, 'report', { scores: new Map([['skills/weekly.md', 4]]) })
    expect(used[0]!.skill.path).toBe('skills/weekly.md')
    const inProject = matchSkills(skills, '확인', { projectFolder: 'groups/영업' })
    expect(inProject[0]!.skill.path).toBe('skills/영업/계약.md')
  })
  test("the skill's own folder or file name counts like its name: a Korean folder over an English name and description", () => {
    const list = [
      ...skills,
      sk('skills/sales/견적서/SKILL.md', 'quote', 'Builds a price quote for a customer'),
      sk('skills/sales/notes.md', 'Notes', '견적서 메모를 모은다'),
      sk('skills/견적서-자료/archive.md', 'Archive', 'Old files'),
    ]
    const r = matchSkills(list, '견적서 만들기')
    // "quote" in skills/sales/견적서/: as high as a skill whose name says it, above a description or a parent folder
    expect(r[0]!.skill.name === 'quote' || r[1]!.skill.name === 'quote').toBe(true)
    const rank = (n: string) => r.findIndex((m) => m.skill.name === n)
    expect(rank('quote')).toBeLessThan(rank('Notes'))
    expect(rank('quote')).toBeLessThan(rank('Archive'))
    // a file name too (skills/영업/계약.md, named "계약 검토")
    expect(matchSkills([sk('skills/legal/계약서.md', 'Contract review', 'Check the clauses'), sk('skills/legal/b.md', 'B', '계약서 사본')], '계약서')[0]!.skill.name).toBe('Contract review')
  })
  test('no word in common: the skills used most, then personal ones, then by name; only the given list', () => {
    const scores = new Map([['skills/finance/close.md', 3], ['skills/weekly.md', 1]])
    const top = frequentSkills(skills, scores)
    expect(top.skills.map((s) => s.path).slice(0, 3)).toEqual(['skills/finance/close.md', 'skills/weekly.md', 'users/alice/skills/weekly.md'])
    expect(top.used).toBe(2)
    expect(top.skills).toHaveLength(skills.length)
    expect(frequentSkills(skills, new Map(), 2)).toEqual({ skills: [skills[4]!, skills[2]!], used: 0 })
    // a person who cannot read skills/finance passes a list without it: it is never named
    expect(frequentSkills(skills.filter((s) => !s.path.startsWith('skills/finance/')), scores).skills.map((s) => s.path)).not.toContain('skills/finance/close.md')
  })
  test('hints: only a clear word match, at most three', () => {
    expect(hintSkills(skills, '고객 견적서 좀 만들어 줘').map((s) => s.name)).toEqual(['견적서-작성'])
    expect(hintSkills(skills, '안녕하세요')).toEqual([])
    const block = skillHintsBlock(hintSkills(skills, '견적서'))
    expect(block).toStartWith('<skill_hints>')
    expect(block).toContain('- 견적서-작성: 고객에게 보낼 견적서를 만든다')
  })
  test('resolveSkill: the name, the path, the folder or file name; a shared name is ambiguous', () => {
    expect(resolveSkill(skills, '견적서-작성')).toEqual({ skill: skills[0]! })
    expect(resolveSkill(skills, 'month CLOSE')).toEqual({ skill: skills[3]! })
    expect(resolveSkill(skills, 'skills/finance/close.md')).toEqual({ skill: skills[3]! })
    expect(resolveSkill(skills, 'skills/영업/견적서-작성')).toEqual({ skill: skills[0]! })
    expect(resolveSkill(skills, 'invoice')).toEqual({ skill: skills[2]! })
    // file alias "weekly": the personal one wins over the team file of the same name
    expect(resolveSkill(skills, 'weekly')).toEqual({ skill: skills[4]! })
    expect(resolveSkill([sk('skills/a/x.md', 'X'), sk('skills/b/x.md', 'X')], 'X')).toEqual({ ambiguous: [sk('skills/a/x.md', 'X'), sk('skills/b/x.md', 'X')] })
    expect(resolveSkill(skills, 'nope')).toBeNull()
  })
  test('resolveSkill: the name as its list line writes it (a shared name with its path, " [personal]"); never a skill outside the list', () => {
    const two = [sk('skills/a/x.md', 'X'), sk('skills/b/x.md', 'X'), sk('users/alice/skills/mine.md', 'Mine')]
    const lines = buildSkillList(two).lines
    expect(lines).toContain('- X (skills/b/x.md)')
    expect(lines).toContain('- Mine [personal]')
    expect(resolveSkill(two, 'X (skills/b/x.md)')).toEqual({ skill: two[1]! })
    expect(resolveSkill(two, 'Mine [personal]')).toEqual({ skill: two[2]! })
    // the path must be one of this person's skills, under that name
    expect(resolveSkill(two, 'X (skills/finance/x.md)')).toBeNull()
    expect(resolveSkill(two, 'Mine (users/bob/skills/mine.md)')).toBeNull()
    expect(resolveSkill(two, 'Y (skills/a/x.md)')).toBeNull()
    // a skill really called "... [personal]" still answers to its exact name first
    const odd = [sk('skills/odd.md', 'Odd [personal]'), sk('skills/plain.md', 'Odd')]
    expect(resolveSkill(odd, 'Odd [personal]')).toEqual({ skill: odd[0]! })
  })
  test('a name or description cannot start a line of its own (NEL, line separators, control characters)', () => {
    const l = buildSkillList([sk('skills/x.md', 'x\u0085## Rules', 'a b\u0085c\u001bd\r\ne')])
    expect(l.lines).toEqual(['- x ## Rules: a b c d e'])
  })
})

describe('instructions, caps and counts (real folder rules)', () => {
  const e = makeEnv('skill-list-prompt')
  afterAll(() => e.db.close())
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(e.fx.team, rel)), { recursive: true }); fs.writeFileSync(path.join(e.fx.team, rel), text) }
  const who = (id: string) => e.files.principal(id)
  for (let i = 0; i < 120; i++) put(`skills/team/s-${String(i).padStart(3, '0')}.md`, `---\nname: Skill ${String(i).padStart(3, '0')}\ndescription: Team workflow ${i}. ${'More words about it. '.repeat(8)}\n---\nstep ${i}\n`)
  put('users/alice/skills/mine.md', '---\nname: My own\ndescription: alice only\n---\nmine\n')

  const input = (id: string) => ({ user: who(id), groupNames: [], locale: 'en' as const, timeZone: 'UTC', memories: [], project: null, browser: false, tools: [], history: null })
  test('one line per skill in every engine\'s instructions and the sub-agents\'; 50 was the old cap', () => {
    const main = buildTurnPrompt(e.files, input('alice'))
    const sub = buildSubagentPrompt(e.files, input('alice'), ['read'])
    for (const p of [main, sub]) {
      for (let i = 0; i < 120; i++) expect(p).toContain(`- Skill ${String(i).padStart(3, '0')}`)
      expect(p).toContain('- My own [personal]: alice only')
      expect(p).toContain('load it with the skill tool')
      expect(p).toContain('call find_skills')
    }
    const section = skillsSection(e.files, who('alice'))
    expect(main).toContain(section)
    expect(sub).toContain(section)
    // the old list wrote every path and every full description
    expect(section).not.toContain('(skills/team/')
  })

  test('the list section is the same for the same person and skills', () => {
    expect(skillsSection(e.files, who('alice'))).toBe(skillsSection(e.files, who('alice')))
  })

  test('a resumed session gets the changes in its turn context', () => {
    const t = buildTurnContext(e.files, { ...input('alice'), skillChanges: skillChangesText({ added: [sk('skills/n.md', 'New one', 'x')], changed: [], removed: [] }) })
    expect(t).toContain('## Skills changed since this chat started')
    expect(t).toContain('- added: New one: x')
  })

  test('team rules: the first 10 are followed, the rest are named as left out, managers get an issue', () => {
    for (let i = 0; i < 14; i++) put(`skills/rule-${String(i).padStart(2, '0')}.md`, `# Rule ${i}\nRULE-BODY-${i}\n`)
    const r = teamRuleFiles(e.files, who('alice'))
    // the fixture's skills/team-rules.md is one of them
    expect(r).toMatchObject({ total: 15, followed: SKILL_FILES_MAX })
    const text = teamRules(e.files, who('alice'))
    expect(text).toContain('RULE-BODY-0')
    expect(text).not.toContain('RULE-BODY-13')
    expect(text).toContain('(5 more team rule files under skills/ are not included')
    expect(skillIssues(e.files, who('carol'), { rules: r })).toContainEqual({ path: 'skills', problem: 'too_many_rules' })
    expect(skillIssues(e.files, who('alice'), { rules: r })).not.toContainEqual({ path: 'skills', problem: 'too_many_rules' })
    for (let i = 0; i < 14; i++) fs.rmSync(path.join(e.fx.team, `skills/rule-${String(i).padStart(2, '0')}.md`))
  })

  test('the Team skills page counts: how many the AI sees with a description and by name only', () => {
    const o = skillsOverview({ db: e.db, files: e.files } as never, 'alice')
    expect(o.aiList).toMatchObject({ skills: 121, unlisted: 0, cut: true, rules: 1, rulesFollowed: 1 })
    expect(o.aiList!.described + o.aiList!.nameOnly).toBe(121)
    expect(o.aiList!.nameOnly).toBeGreaterThan(0)
  })

  test(`the walk reads ${MAX_FILES} entries per folder (was 200) and tells the managers when there are more`, () => {
    for (let i = 0; i < MAX_FILES - 120; i++) put(`skills/bulk/b-${String(i).padStart(4, '0')}.md`, `---\nname: Bulk ${i}\ndescription: d\n---\nx\n`)
    // 120 + 880 skills + the fixture's team rule = 1,001 entries
    const scan = scanSkills(e.files, who('alice'))
    expect(scan.capped).toEqual(['skills'])
    expect(scan.skills.filter((s) => s.path.startsWith("skills/")).length).toBe(MAX_FILES)
    expect(scan.skills.some((s) => s.name === 'My own')).toBe(true) // the personal root has its own count
    expect(skillIssues(e.files, who('carol'))).toContainEqual({ path: 'skills', problem: 'too_many' })
    expect(skillIssues(e.files, who('alice'))).not.toContainEqual({ path: 'skills', problem: 'too_many' })
    fs.rmSync(path.join(e.fx.team, 'skills/bulk/b-0000.md'))
    expect(scanSkills(e.files, who('alice')).capped).toEqual([])
    expect(listSkills(e.files, who('alice')).length).toBe(MAX_FILES)
    fs.rmSync(path.join(e.fx.team, 'skills/bulk'), { recursive: true })
  }, 30_000)
})
