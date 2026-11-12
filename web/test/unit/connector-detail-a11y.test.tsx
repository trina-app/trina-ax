// A connector's page (components/integrations/AppDetail.tsx) for people without a mouse: a tool's description is in the
// chip for a screen reader and the chip takes keyboard focus (its tooltip shows on focus); the privacy and terms links
// say what they open; a Google app's Settings opened from ⋯ gives focus back to ⋯ when it closes.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { GoogleAppId, GoogleAppView } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { GoogleAppDetail, type GoogleAppsState } from '../../src/components/integrations/GoogleAppConnector'
import { GOOGLE_APP_IDS, MOCK_GOOGLE_TOOLS } from '../mock/googleApps'
import { installDom, mount, removeDom } from './dom-host'

const view = (over: Partial<GoogleAppView> = {}): GoogleAppView => ({
  id: 'gmail', available: true, reason: null, status: 'connected', account: { name: 'Fixture', email: 'fixture@example.test' }, writePolicy: 'ask', serviceDown: false, tools: MOCK_GOOGLE_TOOLS.gmail, ...over,
})
const flow = { flow: null, inProgress: false, busy: false, error: false, authorizationUrl: null, start: async () => {}, cancel: async () => {}, complete: async () => {}, setError: () => {} }
const g = (apps: GoogleAppView[]) => ({ apps, load: async () => {}, busy: null, setPolicy: async () => {}, disconnect: async () => {}, flows: Object.fromEntries(GOOGLE_APP_IDS.map((id) => [id, flow])) as unknown as Record<GoogleAppId, GoogleAppsState['flows']['gmail']> }) as unknown as GoogleAppsState
const page = (v: GoogleAppView) => <MemoryRouter><GoogleAppDetail v={v} g={g([v])} /></MemoryRouter>

let before: ReturnType<typeof useLocaleStore.getState>['locale']
beforeEach(() => { before = useLocaleStore.getState().locale; useLocaleStore.getState().setLocale('en') })
afterEach(() => { useLocaleStore.getState().setLocale(before) })

test('every tool with a description: a focusable chip with the description inside it for a screen reader', () => {
  const html = renderToStaticMarkup(page(view()))
  const described = MOCK_GOOGLE_TOOLS.gmail.filter((x) => x.description)
  expect(described.length).toBeGreaterThan(0)
  for (const x of described) expect(html).toContain(`<span class="sr-only" data-testid="app-tool-description">${x.description!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')}</span>`)
  const chips = html.match(/<span[^>]*data-testid="app-tool-chip"/g) ?? []
  expect(chips.length).toBe(MOCK_GOOGLE_TOOLS.gmail.length)
  const withTip = MOCK_GOOGLE_TOOLS.gmail.filter((x) => x.description || x.changes).length
  expect(chips.filter((c) => c.includes('tabindex="0"')).length).toBe(withTip)
})

test('the privacy and terms links say what they open', () => {
  const html = renderToStaticMarkup(page(view()))
  expect(html).toContain(`aria-label="${translate('en', 'gapps.privacyName', { by: 'Google' })}"`)
  expect(html).toContain(`aria-label="${translate('en', 'gapps.termsName', { by: 'Google' })}"`)
  expect(translate('en', 'gapps.privacyName', { by: 'Google' })).toBe('Google privacy policy')
  expect(translate('en', 'gapps.termsName', { by: 'Google' })).toBe('Google terms of service')
})

test('Settings opened from ⋯: closing it gives focus back to ⋯, not the page', async () => {
  const dom = installDom()
  try {
    const m = await mount(page(view()))
    await m.click('gapp-menu')
    await m.click('gapp-settings')
    expect(m.find('gapp-settings-dialog')).toBeTruthy()
    await m.click('gapp-settings-done')
    expect(m.find('gapp-settings-dialog')).toBeFalsy()
    expect(dom.document.activeElement?.getAttribute('data-testid')).toBe('gapp-menu')
    await m.unmount()
  } finally { removeDom() }
})
