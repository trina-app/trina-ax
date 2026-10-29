// B-W7-7 (TEAM-04): the new-chat home shows the team's top skills with "uses · people", like the Skills page.
// It shows only the first rows, puts the slash command in the composer, and shows nothing when no skill has uses.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Locale, PopularSkills } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { PopularSkillsList, skillPrompt } from '../../src/components/PopularSkills'

const skill = (n: number, uses: number, users: number) => ({ path: `skills/s${n}/SKILL.md`, name: `skill-${n}`, description: `does ${n}`, uses, users })
const result: PopularSkills = { days: 30, items: [skill(1, 7, 2), skill(2, 5, 3), skill(3, 4, 1), skill(4, 2, 1)] }
const render = (r: PopularSkills | null, props: { limit?: number; onChoose?: (p: string) => void } = {}) =>
  renderToStaticMarkup(<MemoryRouter><PopularSkillsList result={r} {...props} /></MemoryRouter>)
// Server rendering reads the store's initial state, not the current state: set the language there
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale

afterEach(() => setLocale(before))

describe('popular skills on the new-chat home', () => {
  for (const locale of ['ko', 'en', 'id'] as const) {
    test(`${locale}: title, home hint and "uses · people"`, () => {
      setLocale(locale)
      const html = render(result, { limit: 3, onChoose: () => {} })
      expect(html).toContain(translate(locale, 'skills.popularTitle'))
      expect(html).toContain(translate(locale, 'home.popularSkillsHint'))
      expect(html).toContain(translate(locale, 'skills.popularCount', { uses: 7, users: 2 }))
    })
  }

  test('home shows the top three rows as buttons', () => {
    const html = render(result, { limit: 3, onChoose: () => {} })
    for (const n of [1, 2, 3]) expect(html).toContain(`skill-${n}`)
    expect(html).not.toContain('skill-4')
    expect(html).not.toContain('href=')
    expect((html.match(/<button/g) ?? []).length).toBe(3)
  })

  test('Skills page keeps all rows as links to a new chat', () => {
    const html = render(result)
    expect(html).toContain('skill-4')
    expect(html).toContain(`href="/?prompt=${encodeURIComponent(skillPrompt('skill-1'))}"`)
  })

  test('nothing shows while loading or with no uses', () => {
    expect(render(null, { limit: 3, onChoose: () => {} })).toBe('')
    expect(render({ days: 30, items: [] }, { limit: 3, onChoose: () => {} })).toBe('')
  })

  test('a row fills the composer with the slash command', () => {
    expect(skillPrompt('QA 회의록 요약')).toBe('/QA 회의록 요약 ')
  })
})
