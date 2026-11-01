// App review 2026-11-01: a member's Team skills page showed no skills. The "Available skills" tab lists what GET
// /api/skills returns for the person (team skills they can read, their own personal skills), read-only: a name, its
// description and file, "Use in chat" and "View file", and nothing a manager or admin does there.
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
const render = (list: SkillInfo[] | null) => renderToStaticMarkup(<AvailableSkillsList items={list} />)
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('Available skills', () => {
  test('every skill with its description and file, personal ones marked', () => {
    setLocale('en')
    const html = render(items)
    expect((html.match(/data-testid="skill-row"/g) ?? []).length).toBe(3)
    for (const s of items) {
      expect(html).toContain(s.path)
      expect(html).toContain(`aria-label="${translate('en', 'skills.useNamed', { name: s.name })}"`)
    }
    expect(html).toContain('Friday team report')
    expect((html.match(new RegExp(`>${translate('en', 'skills.personal')}<`, 'g')) ?? []).length).toBe(1)
    expect(html).toContain(translate('en', 'skills.availableHint').replace(/"/g, '&quot;'))
  })

  test('read-only: only "Use in chat" and "View file", nothing to edit, delete, review or register', () => {
    setLocale('ko')
    const html = render(items)
    expect((html.match(/data-testid="skill-use"/g) ?? []).length).toBe(3)
    expect((html.match(/data-testid="skill-file"/g) ?? []).length).toBe(3)
    expect((html.match(/<button/g) ?? []).length).toBe(6)
    for (const k of ['skills.review', 'skills.register', 'skills.reject', 'common.delete', 'skills.edit'] as const) expect(html).not.toContain(`>${translate('ko', k)}<`)
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
