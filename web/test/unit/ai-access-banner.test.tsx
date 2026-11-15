// Onboarding A + B: the line above the composer when nothing answers this person (components/chat/AiAccessBanner.tsx).
import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useAiAccess } from '../../src/store/aiAccess'
import AiAccessBanner from '../../src/components/chat/AiAccessBanner'

// a static render reads the stores' initial state
const first = { ...useAiAccess.getInitialState() }
const beforeLocale = useLocaleStore.getInitialState().locale
afterEach(() => { Object.assign(useAiAccess.getInitialState(), first); Object.assign(useLocaleStore.getInitialState(), { locale: beforeLocale }) })
const render = (l: Locale, s: Partial<ReturnType<typeof useAiAccess.getState>>) => {
  Object.assign(useLocaleStore.getInitialState(), { locale: l })
  Object.assign(useAiAccess.getInitialState(), { loaded: true, usable: false, action: 'ask_owner', requested: false, ...s })
  return renderToStaticMarkup(<MemoryRouter><AiAccessBanner /></MemoryRouter>)
}

test('the line and the button for this person, in every language; AI works: nothing', () => {
  for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
    const team = render(l, { action: 'connect_team' })
    expect(team).toContain(translate(l, 'aiAccess.banner.connectTeam'))
    expect(team).toContain('data-action="connect_team"')
    expect(render(l, { action: 'ask_owner' })).toContain(translate(l, 'aiAccess.askOwner'))
  }
  const html = render('en', { action: 'connect_own' })
  expect(html).toContain(translate('en', 'aiAccess.banner.connectOwn'))
  expect(render('en', { usable: true })).toBe('')
})
