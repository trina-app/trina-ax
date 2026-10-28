// Settings > Browser (the clinic pilot: the "allow all websites" setting was only in the browser panel's ⚙): shown only
// inside a desktop app that offers it (the value lives there), the same value as the panel, "all" disabled with the
// reason when the team turned it off; and the admin switch "members can turn on 'Allow all websites'" (default on).
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { TeamSettings, UpdateSettingsBody } from '@mycel/shared/api'
import { DESKTOP_BRIDGE_GLOBAL, type DesktopBridge, type DesktopBrowserSettings } from '@mycel/shared'
import { translate } from '../../src/i18n'
import { browserSettingsBridge } from '../../src/lib/desktop'
import { allowAllPermitted, BrowserSettingsView } from '../../src/pages/BrowserSettings'
import { settingsTabs } from '../../src/pages/settingsTabs'
import { BrowserPolicySwitch } from '../../src/pages/admin/TeamSettings'

const noop = () => {}
const settings = (o: Partial<DesktopBrowserSettings> = {}): DesktopBrowserSettings => ({ siteAccess: 'ask', always: [], privateAlways: [], teamAllowsAll: true, ...o })
const view = (s: DesktopBrowserSettings | null, o: { serverPolicyOff?: boolean; confirming?: boolean } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <BrowserSettingsView settings={s} {...o} onAccess={noop} onRemove={noop} onClear={noop} />
    </MemoryRouter>,
  )
/** the <input> of one radio choice, as rendered */
const radio = (html: string, value: 'ask' | 'all') => new RegExp(`<input[^>]*data-testid="browser-access-${value}"[^>]*>`).exec(html)?.[0] ?? ''

const fakeBridge = (withSettings: boolean) =>
  ({
    bridgeVersion: 1,
    appVersion: '0.2.3',
    platform: 'darwin',
    browser: { run: async () => ({}) as never, cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({}) as never, onChange: () => noop },
    notify: noop,
    openTeams: noop,
    ...(withSettings
      ? { browserSettings: { get: async () => settings(), onChange: () => noop, setAccess: async () => 'changed' as const, removeSite: async () => settings(), clearSites: async () => settings() } }
      : {}),
  }) as DesktopBridge

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL]
})

describe('where Settings > Browser shows', () => {
  test('a normal browser or the PWA: no Browser tab (the value lives in the desktop app)', () => {
    expect(browserSettingsBridge()).toBeNull()
    expect(settingsTabs(Boolean(browserSettingsBridge())).map((x) => x.id)).toEqual(['profile', 'security', 'memory', 'drive', 'integrations', 'connectors', 'schedules', 'notifications', 'apps', 'about'])
  })
  test('inside the desktop app: the Browser tab, after Security', () => {
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = fakeBridge(true)
    expect(browserSettingsBridge()).not.toBeNull()
    expect(settingsTabs(Boolean(browserSettingsBridge())).map((x) => x.id)).toEqual(['profile', 'security', 'browser', 'memory', 'drive', 'integrations', 'connectors', 'schedules', 'notifications', 'apps', 'about'])
  })
  test('a desktop app from before this addition (no browserSettings): no tab', () => {
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = fakeBridge(false)
    expect(browserSettingsBridge()).toBeNull()
    expect(settingsTabs(false).some((x) => x.id === 'browser')).toBe(false)
  })
  test('AI connections still comes after what the AI remembers, with or without the Browser tab', () => {
    expect(settingsTabs(true, true).map((x) => x.id).slice(0, 5)).toEqual(['profile', 'security', 'browser', 'memory', 'credentials'])
    expect(settingsTabs(false, true).map((x) => x.id).slice(0, 4)).toEqual(['profile', 'security', 'memory', 'credentials'])
  })
})

describe('the Browser section', () => {
  test('ask for each new site: both choices, "all" can be chosen', () => {
    const html = view(settings())
    expect(html).toContain('Sites the AI can open')
    expect(radio(html, 'ask')).toContain('checked')
    expect(radio(html, 'all')).not.toContain('disabled')
    expect(html).not.toContain('data-testid="browser-all-on"')
    expect(html).not.toContain('data-testid="browser-policy-off"')
    expect(html).toContain('data-testid="browser-sites-none"')
  })
  test('"all" on: checked and "Allowing all sites" shown', () => {
    const html = view(settings({ siteAccess: 'all' }))
    expect(radio(html, 'all')).toContain('checked')
    expect(html).toContain('data-testid="browser-all-on"')
    expect(html).toContain('Allowing all sites')
  })
  test('the team turned it off (the app says so, or the team server already does): disabled with the reason', () => {
    for (const html of [view(settings({ teamAllowsAll: false })), view(settings(), { serverPolicyOff: true })]) {
      expect(radio(html, 'all')).toContain('disabled')
      expect(radio(html, 'ask')).not.toContain('disabled')
      expect(html).toContain('data-testid="browser-policy-off"')
      expect(html).toContain('Your team admin has turned off')
    }
    expect(allowAllPermitted(settings())).toBe(true)
    expect(allowAllPermitted(settings({ teamAllowsAll: false }))).toBe(false)
    expect(allowAllPermitted(settings(), true)).toBe(false)
  })
  test('while the app\'s own confirmation is open: both choices wait, and the page says where to confirm', () => {
    const html = view(settings(), { confirming: true })
    expect(radio(html, 'ask')).toContain('disabled')
    expect(radio(html, 'all')).toContain('disabled')
    expect(html).toContain('data-testid="browser-confirming"')
  })
  test('always allowed sites: each with remove, office addresses tagged, "clear all" from two', () => {
    const one = view(settings({ always: ['naver.com'] }))
    expect(one.match(/data-testid="browser-site"/g)?.length).toBe(1)
    expect(one).not.toContain('data-testid="browser-sites-clear"')
    const html = view(settings({ always: ['naver.com', 'place.map.kakao.com'], privateAlways: ['192.168.0.20'] }))
    expect(html.match(/data-testid="browser-site"/g)?.length).toBe(3)
    expect(html.match(/data-testid="browser-site-remove"/g)?.length).toBe(3)
    expect(html).toContain('192.168.0.20')
    expect(html).toContain('Office network')
    expect(html).toContain('data-testid="browser-sites-clear"')
  })
  test('Korean and English copy (the server render uses the default language, so the dictionaries are checked directly)', () => {
    expect(translate('ko', 'settings.browser')).toBe('브라우저')
    expect(translate('ko', 'settings.browser.access')).toBe('AI가 열 수 있는 사이트')
    expect(translate('ko', 'settings.browser.ask')).toBe('새 사이트마다 묻기')
    expect(translate('ko', 'settings.browser.all')).toBe('모든 웹사이트 허용')
    expect(translate('ko', 'settings.browser.allOn')).toBe('모든 사이트 허용 중')
    expect(translate('ko', 'settings.browser.sites')).toBe('항상 허용한 사이트')
    expect(translate('en', 'settings.browser.access')).toBe('Sites the AI can open')
    expect(translate('en', 'settings.browser.allOn')).toBe('Allowing all sites')
  })
  test('loading: no choices before the desktop app answered', () => {
    expect(view(null)).not.toContain('browser-access-all')
  })
})

describe('admin: members can turn on "Allow all websites"', () => {
  test('a team setting, on by default (schema), changed by PATCH like the others', () => {
    expect(TeamSettings.shape.browserAllowAll.safeParse(true).success).toBe(true)
    expect(TeamSettings.shape.browserAllowAll.safeParse('yes').success).toBe(false)
    expect(UpdateSettingsBody.safeParse({ browserAllowAll: false }).success).toBe(true)
  })
  test('the switch shows the value, its label and what turning it off does', () => {
    const on = renderToStaticMarkup(<BrowserPolicySwitch value onChange={noop} />)
    expect(on).toContain('data-on="true"')
    expect(on).toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
    expect(on).toContain('Members can turn on')
    expect(on).toContain('goes back to')
    const off = renderToStaticMarkup(<BrowserPolicySwitch value={false} onChange={noop} />)
    expect(off).toContain('data-on="false"')
    expect(off).not.toMatch(/<input[^>]*checked/)
    expect(translate('ko', 'teamSettings.browserAllowAll')).toBe('팀원이 "모든 웹사이트 허용"을 켤 수 있음')
    expect(translate('en', 'teamSettings.browserAllowAll')).toBe('Members can turn on "Allow all websites"')
  })
})
