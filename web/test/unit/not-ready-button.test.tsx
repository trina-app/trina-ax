// "Trina isn't ready yet" (chat error engine_missing, owner decision 2026-11-11): one button by who reads it
// (components/chat/NotReadyButton.tsx). The owner and an admin get [Connect AI] (to Admin › AI accounts); a member gets
// [Tell an admin], which turns into "Told" once sent; nobody gets both.
import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Locale } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import NotReadyButton from '../../src/components/chat/NotReadyButton'

const beforeLocale = useLocaleStore.getInitialState().locale
afterEach(() => { Object.assign(useLocaleStore.getInitialState(), { locale: beforeLocale }) })
const render = (l: Locale, role: 'owner' | 'admin' | 'member' | undefined, initial?: 'idle' | 'told') => {
  Object.assign(useLocaleStore.getInitialState(), { locale: l })
  return renderToStaticMarkup(<MemoryRouter><NotReadyButton role={role} initial={initial} /></MemoryRouter>)
}
const LOCALES = ['ko', 'en', 'id', 'ja', 'es'] as const

test('the owner and an admin: [Connect AI], never the member\'s button', () => {
  for (const l of LOCALES) for (const role of ['owner', 'admin'] as const) {
    const html = render(l, role)
    expect(html).toContain('data-action="connect"')
    expect(html).toContain(translate(l, 'aiAccess.connectTeam'))
    expect(html).not.toContain(translate(l, 'notReady.tell'))
    expect(html.match(/<button/g)).toHaveLength(1)
  }
  expect(render('en', 'owner')).toContain('>Connect AI<')
})

test('a member: [Tell an admin], then "Told" (disabled); never [Connect AI]', () => {
  for (const l of LOCALES) {
    const html = render(l, 'member')
    expect(html).toContain('data-action="tell"')
    expect(html).toContain(translate(l, 'notReady.tell'))
    expect(html).not.toContain('data-action="connect"')
    expect(html.match(/<button/g)).toHaveLength(1)
    const told = render(l, 'member', 'told')
    expect(told).toContain(translate(l, 'notReady.told'))
    expect(told).toMatch(/<button[^>]*disabled/)
  }
  expect(render('en', 'member')).toContain('>Tell an admin<')
  expect(render('en', 'member', 'told')).toContain('>Told<')
})

test('no person yet: no button', () => {
  expect(render('en', undefined)).toBe('')
})
