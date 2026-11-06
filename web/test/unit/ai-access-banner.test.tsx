// Onboarding A + B: the line above the composer when nothing answers this person (components/chat/AiAccessBanner.tsx).
// When the hosting service's trial AI credit is used up or over, it says so first, then the usual sentence and button.
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
  Object.assign(useAiAccess.getInitialState(), { loaded: true, usable: false, action: 'ask_owner', requested: false, trial: null, ...s })
  return renderToStaticMarkup(<MemoryRouter><AiAccessBanner /></MemoryRouter>)
}

test('trial credit used up or over: that line first, then the button for this person, in every language', () => {
  for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
    const used = render(l, { action: 'connect_team', trial: 'used' })
    const line = translate(l, 'aiAccess.banner.trialUsed')
    expect(used).toContain('data-testid="ai-access-trial"')
    expect(used.indexOf(line)).toBeGreaterThan(-1)
    expect(used.indexOf(line)).toBeLessThan(used.indexOf(translate(l, 'aiAccess.banner.connectTeam')))
    expect(used).toContain('data-action="connect_team"')
    const ended = render(l, { action: 'ask_owner', trial: 'ended' })
    expect(ended).toContain(translate(l, 'aiAccess.banner.trialEnded'))
    expect(ended).toContain(translate(l, 'aiAccess.askOwner'))
  }
})

test('no trial: the line as before; AI works: nothing', () => {
  const html = render('en', { action: 'connect_own' })
  expect(html).not.toContain('ai-access-trial')
  expect(html).toContain(translate('en', 'aiAccess.banner.connectOwn'))
  expect(render('en', { usable: true, trial: 'used' })).toBe('')
})
