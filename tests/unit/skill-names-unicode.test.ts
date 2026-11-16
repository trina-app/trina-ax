// Skill names in any language (docs/decisions/20261116-skill-names-unicode.md; AI scenario check SKL-11): the name
// rule of a SKILL.md folder (isSkillName), NFC compare of the name and its folder, "/name", the write note and a renamed
// copy (skills/move.ts copyNameOk, also skill_files' rename).
import { describe, expect, test } from 'bun:test'
import { checkSkill, invokedSkill, isSkillName, SKILL_NAME_MAX, skillWriteNote, type Skill } from '../../server/src/chat/skills'
import { copyNameOk } from '../../server/src/skills/move'
import { validSkillName } from '../../server/src/skills/share-check'
import { skillNameSkeleton } from '@mycel/shared/api'
import { isSkillName as sharedRule } from '@mycel/shared/api'
const folderNameOk = (raw: string) => sharedRule(raw.trim().normalize('NFC')) // the Skills page's check (web/src/pages/Skills.tsx)

const md = (name: string) => `---\nname: ${name}\ndescription: 거래처 문의에 답한다\n---\nSteps\n`

describe('the name rule', () => {
  const ok = ['거래처-응대', 'quote-writer', '견적-2026', 'スキル-データ', '报价单', 'отчёт-за-месяц', 'हिंदी-रिपोर्ट', 'ภาษา-ไทย', 'é-mail', '가'.repeat(SKILL_NAME_MAX)]
  const bad = ['Quote', '거래처 응대', '거래처.응대', '거래처_응대', '거래처--응대', '-응대', '응대-', 'ａｂ', 'a/b', '', '가'.repeat(SKILL_NAME_MAX + 1), '견적​서', 'Отчёт',
    // look-alikes of a Latin name: a Cyrillic о or Greek ο among Latin letters, a dotless ı, a click letter
    'qu\u043ete', 'qu\u03bfte', 'qu\u0131te', 'a\u01c0b',
    // invisible: the Hangul fillers (letters to the regex); more UTF-8 bytes than a folder name may have
    'quote\u115f', '견적\u3164', '\u{20000}'.repeat(SKILL_NAME_MAX)]
  test('lowercase letters of any script, marks and digits, joined by single hyphens; no capitals, signs or compatibility forms', () => {
    for (const n of ok) expect([n, isSkillName(n)]).toEqual([n, true])
    for (const n of bad) expect([n, isSkillName(n)]).toEqual([n, false])
    // the Skills page checks the same rule (shared), after trimming and NFC
    for (const n of ok) expect(folderNameOk(n)).toBe(true)
    for (const n of bad.filter((x) => x.trim())) expect([n, folderNameOk(n)]).toEqual([n, false])
  })
  test('a SKILL.md named in Korean loads; its name and folder are compared in NFC', () => {
    expect(checkSkill(md('거래처-응대'), 'skills/거래처-응대/SKILL.md')).toMatchObject({ ok: true, name: '거래처-응대' })
    // a folder made on a Mac in NFD, a name typed in NFD: the same skill, its name in NFC
    expect(checkSkill(md('거래처-응대'), `skills/${'거래처-응대'.normalize('NFD')}/SKILL.md`)).toMatchObject({ ok: true, name: '거래처-응대' })
    expect(checkSkill(md('거래처-응대'.normalize('NFD')), 'skills/거래처-응대/SKILL.md')).toMatchObject({ ok: true, name: '거래처-응대' })
    expect(checkSkill(md('거래처-응대'), 'groups/영업/skills/거래처-응대/SKILL.md')).toMatchObject({ ok: true })
    expect(checkSkill(md('거래처-응대'), 'users/u1/skills/거래처-응대/SKILL.md')).toMatchObject({ ok: true })
    expect(checkSkill(md('거래처-응대'), 'skills/거래처/SKILL.md')).toEqual({ ok: false, problem: 'name_folder' })
    expect(checkSkill(md('거래처 응대'), 'skills/거래처 응대/SKILL.md')).toEqual({ ok: false, problem: 'name' })
  })
  test('the write note: nothing for a Korean name that loads, the rule in plain words for one that does not', () => {
    expect(skillWriteNote('/nowhere', 'skills/거래처-응대/SKILL.md', Buffer.from(md('거래처-응대')))).toBe('')
    expect(skillWriteNote('/nowhere', 'skills/Bad Name/SKILL.md', Buffer.from(md('Bad Name')))).toContain('lowercase letters (any language) and digits in words joined by single hyphens')
  })
})

describe('"/name" and a renamed copy', () => {
  const skill: Skill = { path: 'skills/거래처-응대/SKILL.md', name: '거래처-응대', description: '', body: 'x' }
  test('"/거래처-응대 …" runs it, also typed in NFD; the rest is the input', () => {
    expect(invokedSkill([skill], '/거래처-응대 라마바카페 반품')).toMatchObject({ skill: { path: skill.path }, input: '라마바카페 반품' })
    expect(invokedSkill([skill], '/거래처-응대 라마바카페 반품'.normalize('NFD'))).toMatchObject({ skill: { path: skill.path }, input: '라마바카페 반품' })
    expect(invokedSkill([skill], '/거래처-응대들')).toBeNull()
  })
  test('a copy or a renamed skill folder may take a Korean name, never one the parser refuses', () => {
    expect(copyNameOk('견적-팔콘')).toBe(true)
    expect(copyNameOk('견적-팔콘'.normalize('NFD'))).toBe(true)
    expect(copyNameOk('견적 팔콘')).toBe(false)
    expect(copyNameOk('Quote')).toBe(false)
  })
})

describe('look-alikes and skills sent from Claude Code', () => {
  test('a whole-word Cyrillic copy of a name has the same skeleton; real other names do not', () => {
    expect(skillNameSkeleton('\u0441\u0435\u0440')).toBe(skillNameSkeleton('cep'))
    expect(skillNameSkeleton('quote')).toBe('quote')
    expect(skillNameSkeleton('거래처-응대')).not.toBe(skillNameSkeleton('거래처-응답'))
    expect(skillNameSkeleton('é-mail')).toBe('e-mail')
  })
  test('"Bring my skills" keeps a name the rule takes and romanizes only the rest', () => {
    expect(validSkillName('거래처-응대')).toBe('거래처-응대')
    expect(validSkillName('거래처-응대'.normalize('NFD'))).toBe('거래처-응대')
    expect(validSkillName('주간 업무 보고')).toBe('jugan-eopmu-bogo')
    expect(validSkillName('qu\u043ete')).not.toContain('\u043e')
  })
})
