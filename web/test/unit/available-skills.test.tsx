// App review 2026-11-01: a member's Team skills page showed no skills. The "Available skills" tab lists what GET
// /api/skills returns for the person (team skills they can read, their own personal skills), read-only: one line per
// skill, a row that starts a chat, a "…" menu with the file, and nothing a manager or admin does there.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { AvailableSkillsList, skillChatLink, skillFileLink } from '../../src/components/AvailableSkills'
import { useSession } from '../../src/store/session'

const items: SkillInfo[] = [
  { path: 'skills/weekly/SKILL.md', name: 'weekly', description: 'Friday team report' },
  { path: 'skills/견적서.md', name: '견적서', description: '' },
  { path: 'users/bob/skills/my-tone.md', name: 'My tone', description: 'Bob’s mail tone', personal: true },
]
const render = (list: SkillInfo[] | null, query?: string) => renderToStaticMarkup(<AvailableSkillsList items={list} query={query} />)
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

// a static render reads the store's initial state
const signedOut = useSession.getInitialState().status
const as = (role: 'owner' | 'admin' | 'member' | null) => Object.assign(useSession.getInitialState(), { status: role ? { kind: 'signed-in', me: { user: { id: 'u1', role }, team: { name: 'Acme', defaultLocale: 'ko' } } } : signedOut })

describe('Available skills', () => {
  test('every skill with its description; owners and admins also see its folder; personal ones in their own section', () => {
    setLocale('en')
    try {
      as('owner')
      const html = render(items)
      expect((html.match(/data-testid="skill-row"/g) ?? []).length).toBe(3)
      for (const s of items) expect(html).toContain(`data-path="${s.path}"`)
      expect(html).toContain('skills/ · Friday team report')
      expect(html).toContain('>skills/<')
      expect((html.match(new RegExp(`>${translate('en', 'skills.personal')}<`, 'g')) ?? []).length).toBe(1)
      expect(html).toContain(`>${translate('en', 'skills.fromTeam')}<`)
      expect(html).not.toContain('users/bob/skills/ ·')
      // a member reads the title and the line only, never a raw folder (docs/DECISIONS.md "W3": "skills/general/")
      as('member')
      const member = render([...items, { path: 'skills/general/card-news/SKILL.md', name: 'card-news', title: '카드뉴스', description: '카드뉴스 — 회사 소개서로 카드뉴스 5장을 만들어요.' }])
      expect((member.match(/data-testid="skill-row"/g) ?? []).length).toBe(4)
      expect(member).toContain('>Friday team report<')
      expect(member).toContain('>회사 소개서로 카드뉴스 5장을 만들어요.<')
      // (the path stays only in the row's data attribute)
      expect(member.replace(/data-path="[^"]*"/g, '')).not.toContain('skills/general/')
      expect(member).not.toContain('>skills/<')
      expect(member).not.toContain('skills/ ·')
    } finally { as(null) }
  })

  test('read-only: a row and its "…" menu, nothing to edit, delete, review or register', () => {
    setLocale('ko')
    const html = render(items)
    expect((html.match(/data-testid="skill-use"/g) ?? []).length).toBe(3)
    expect((html.match(/data-testid="skill-more"/g) ?? []).length).toBe(3)
    expect((html.match(/<button/g) ?? []).length).toBe(6)
    for (const k of ['skills.review', 'skills.register', 'skills.reject', 'common.delete', 'skills.edit'] as const) expect(html).not.toContain(`>${translate('ko', k)}<`)
  })

  test('search: by name or description, and it says so when nothing matches', () => {
    setLocale('en')
    expect((render(items, 'FRIDAY').match(/data-testid="skill-row"/g) ?? []).length).toBe(1)
    expect((render(items, ' 견적 ').match(/data-testid="skill-row"/g) ?? []).length).toBe(1)
    const none = render(items, 'nothing like this')
    expect(none).not.toContain('skill-row')
    expect(none).toContain(translate('en', 'skills.noMatch', { q: 'nothing like this' }).replace(/"/g, '&quot;'))
  })

  test('links: a new chat with the slash command, and the file selected in its folder', () => {
    expect(skillChatLink('견적서')).toBe(`/?prompt=${encodeURIComponent('/견적서 ')}`)
    expect(skillFileLink('skills/weekly/SKILL.md')).toBe('/files?path=skills%2Fweekly&select=skills%2Fweekly%2FSKILL.md')
    expect(skillFileLink('users/bob/skills/my-tone.md')).toBe('/files?path=users%2Fbob%2Fskills&select=users%2Fbob%2Fskills%2Fmy-tone.md')
  })

  test('none yet: says so and how one gets there; nothing while loading', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      setLocale(l)
      const html = render([])
      expect(html).toContain(translate(l, 'skills.noSkills'))
      expect(html).not.toContain('skill-row')
    }
    expect(render(null)).not.toContain('skill-row')
  })

  test('a team with skills but no marketing ones: owners and admins get one quiet "add the marketing skills" line, nobody else, not while searching', () => {
    setLocale('ko')
    const general: SkillInfo[] = [{ path: 'skills/general/meeting-tasks/SKILL.md', name: 'meeting-tasks', title: '할 일 정리', description: '' }]
    try {
      for (const role of ['owner', 'admin'] as const) {
        as(role)
        const html = render(general)
        expect(html).toContain('data-testid="skill-pack-marketing"')
        expect(html).toContain('>마케팅 스킬 7개 넣기<')
        // what goes in, as its tooltip; no second button or card
        expect(html).toContain(`title="${translate('ko', 'skillPack.adminHint')}"`)
        expect(html).not.toContain('skill-pack-offer')
        // a marketing skill already there (or a search): nothing
        expect(render([...general, { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' }])).not.toContain('skill-pack-marketing')
        expect(render(general, '할 일')).not.toContain('skill-pack-marketing')
      }
      as('member')
      expect(render(general)).not.toContain('skill-pack-marketing')
      // a personal skill under a folder named marketing is not the team's pack
      as('owner')
      expect(render([...general, { path: 'users/u1/skills/marketing-note.md', name: 'marketing-note', description: '', personal: true }])).toContain('skill-pack-marketing')
    } finally { as(null) }
  })

  test('the optional HR pack: owners and admins get one quiet "add the HR document skills" line until one of its skills is in the team', () => {
    setLocale('ko')
    const team: SkillInfo[] = [
      { path: 'skills/general/meeting-tasks/SKILL.md', name: 'meeting-tasks', title: '할 일 정리', description: '' },
      { path: 'skills/marketing/ad-copy/SKILL.md', name: 'ad-copy', description: '' },
    ]
    try {
      for (const role of ['owner', 'admin'] as const) {
        as(role)
        const html = render(team)
        expect(html).toContain('data-testid="skill-pack-hr"')
        expect(html).toContain('>인사 서류 스킬 3개 넣기<')
        expect(html).toContain(`title="${translate('ko', 'skillPack.hrHint')}"`)
        expect(render([...team, { path: 'skills/hr/annual-leave/SKILL.md', name: 'annual-leave', description: '' }])).not.toContain('skill-pack-hr')
        expect(render(team, '할 일')).not.toContain('skill-pack-hr')
      }
      as('member')
      expect(render(team)).not.toContain('skill-pack-hr')
    } finally { as(null) }
  })
})
