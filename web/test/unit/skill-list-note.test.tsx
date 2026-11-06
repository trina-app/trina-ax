// The Team skills page says how many skills the AI sees by name only (server/src/chat/skill-list.ts) and how many team
// rule files it follows, only when something is left out (components/SkillListNote.tsx).
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Locale, SkillsOverview } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { SkillListNote } from '../../src/components/SkillListNote'

type AiList = NonNullable<SkillsOverview['aiList']>
const list = (o: Partial<AiList> = {}): AiList => ({ skills: 120, described: 64, nameOnly: 56, unlisted: 0, cut: true, rules: 3, rulesFollowed: 3, ...o })
const render = (l: AiList | undefined) => renderToStaticMarkup(<SkillListNote list={l} />)
const setLocale = (l: Locale) => Object.assign(useLocaleStore.getInitialState(), { locale: l })
const before = useLocaleStore.getInitialState().locale
afterEach(() => setLocale(before))

describe('how many skills the AI sees', () => {
  test('a cut list: all, with a description, by name only', () => {
    setLocale('ko')
    const html = render(list())
    expect(html).toContain('스킬 120개 · AI 목록에 설명까지 64개 · 이름만 56개')
    expect(html).toContain(translate('ko', 'skills.aiListHint'))
    expect(html).not.toContain('목록 밖')
    expect(html).not.toContain('data-testid="skill-rules-count"')
  })
  for (const locale of ['en', 'id', 'ja', 'es'] as const) {
    test(`${locale}: the counts and the ones not listed`, () => {
      setLocale(locale)
      const html = render(list({ described: 40, nameOnly: 900, unlisted: 60, skills: 1000 }))
      expect(html).toContain(translate(locale, 'skills.aiList', { skills: 1000, described: 40, nameOnly: 900 }).replace(/'/g, '&#x27;'))
      expect(html).toContain(translate(locale, 'skills.aiListUnlisted', { unlisted: 60 }).replace(/'/g, '&#x27;'))
    })
  }
  test('more team rules than the AI follows', () => {
    setLocale('en')
    const html = render(list({ cut: false, rules: 14, rulesFollowed: 10 }))
    expect(html).toContain('the AI follows the first 10 of 14 rule files')
    expect(html).not.toContain('data-testid="skill-list-counts"')
  })
  test('nothing when the whole list fits, or from an older server', () => {
    expect(render(list({ cut: false, described: 120, nameOnly: 0 }))).toBe('')
    expect(render(undefined)).toBe('')
  })
})
