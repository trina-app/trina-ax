// App review 2026-11-01: a member's Team skills page showed no skills. The "Available skills" tab lists what GET
// /api/skills returns for the person (team skills they can read, their own personal skills), read-only: one line per
// skill, a row that starts a chat, a "…" menu with the file, and nothing a manager or admin does there.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, SkillInfo } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { AvailableSkillsList, skillChatLink, skillFileLink } from '../../src/components/AvailableSkills'

const items: SkillInfo[] = [
  { path: 'skills/weekly/SKILL.md', name: 'weekly', description: 'Friday team report' },
  { path: 'skills/견적서.md', name: '견적서', description: '' },
  { path: 'users/bob/skills/my-tone.md', name: 'My tone', description: 'Bob’s mail tone', personal: true },
]
const render = (list: SkillInfo[] | null, query?: string) => renderToStaticMarkup(<AvailableSkillsList items={list} query={query} />)
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('Available skills', () => {
  test('every skill with its folder and description, personal ones in their own section', () => {
    setLocale('en')
    const html = render(items)
    expect((html.match(/data-testid="skill-row"/g) ?? []).length).toBe(3)
    for (const s of items) expect(html).toContain(`data-path="${s.path}"`)
    expect(html).toContain('skills/ · Friday team report')
    expect(html).toContain('>skills/<')
    expect((html.match(new RegExp(`>${translate('en', 'skills.personal')}<`, 'g')) ?? []).length).toBe(1)
    expect(html).toContain(`>${translate('en', 'skills.fromTeam')}<`)
    expect(html).not.toContain('users/bob/skills/ ·')
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
})
