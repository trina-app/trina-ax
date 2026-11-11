// Settings > Browser (the clinic pilot: the "allow all websites" setting was only in the browser panel's ⚙): shown only
// inside a desktop app that offers it (the value lives there), the same value as the panel, "all" disabled with the
// reason when the team turned it off; and the admin switch "members can turn on 'Allow all websites'" (default on).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { TeamSettings, UpdateSettingsBody } from '@mycel/shared/api'
import { DESKTOP_BRIDGE_GLOBAL, WEB_ALLOW_ALL_RISK, WEB_ALLOW_ALL_WARNING_VERSION, type DesktopAccessOutcome, type DesktopBridge, type DesktopBrowserSettings } from '@mycel/shared'
import { translate, useLocaleStore } from '../../src/i18n'
import { browserSettingsBridge, type BrowserSettingsBridge } from '../../src/lib/desktop'
import { allowAllPermitted, BrowserSettings, BrowserSettingsView } from '../../src/pages/BrowserSettings'
import { browserTabShown, sectionMatches, settingsTabs } from '../../src/pages/settingsTabs'
import { BrowserPolicySwitch, WebAllowAllSwitch } from '../../src/pages/admin/TeamSettings'
import { DialogHost } from '../../src/components/ui'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom, type Mounted } from './dom-host'

const noop = () => {}
const settings = (o: Partial<DesktopBrowserSettings> = {}): DesktopBrowserSettings => ({ siteAccess: 'ask', always: [], privateAlways: [], teamAllowsAll: true, ...o })
const view = (s: DesktopBrowserSettings | null | undefined, o: { serverPolicyOff?: boolean; confirming?: boolean; web?: { on: boolean } } = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <BrowserSettingsView settings={s} {...o} onAccess={noop} onRemove={noop} onClear={noop} onAllowHere={noop} />
    </MemoryRouter>,
  )
/** the HTML text of a string as renderToStaticMarkup writes it */
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
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
    expect(settingsTabs(Boolean(browserSettingsBridge())).map((x) => x.id)).toEqual(['profile', 'security', 'usage', 'memory', 'allowances', 'connectors', 'ai-apps', 'notifications', 'apps', 'about'])
  })
  test('inside the desktop app: the Browser tab, after Security', () => {
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = fakeBridge(true)
    expect(browserSettingsBridge()).not.toBeNull()
    expect(settingsTabs(Boolean(browserSettingsBridge())).map((x) => x.id)).toEqual(['profile', 'security', 'browser', 'usage', 'memory', 'allowances', 'connectors', 'ai-apps', 'notifications', 'apps', 'about'])
  })
  test('a desktop app from before this addition (no browserSettings): no tab', () => {
    ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = fakeBridge(false)
    expect(browserSettingsBridge()).toBeNull()
    expect(settingsTabs(false).some((x) => x.id === 'browser')).toBe(false)
  })
  test('Dev environment sites: only when the dev environment on srt is on for the person, after App connectors and AI apps', () => {
    expect(settingsTabs(false, false).some((x) => x.id === 'dev-env-sites')).toBe(false)
    const ids = settingsTabs(false, false, true).map((x) => x.id)
    expect(ids.indexOf('ai-apps')).toBe(ids.indexOf('connectors') + 1)
    expect(ids.indexOf('dev-env-sites')).toBe(ids.indexOf('ai-apps') + 1)
  })
  test('Providers lead the Connections group, after Account ends with what the AI remembers and what I allowed it, with or without the Browser tab', () => {
    expect(settingsTabs(true, true).map((x) => x.id).slice(0, 8)).toEqual(['profile', 'security', 'browser', 'usage', 'memory', 'allowances', 'providers', 'connectors'])
    expect(settingsTabs(false, true).map((x) => x.id).slice(0, 7)).toEqual(['profile', 'security', 'usage', 'memory', 'allowances', 'providers', 'connectors'])
  })
  test('the groups: Account, Connections, App (no AI group), each section in one of them', () => {
    const by = (g: string) => settingsTabs(true, true).filter((x) => x.group === g).map((x) => x.id)
    expect(by('account')).toEqual(['profile', 'security', 'browser', 'usage', 'memory', 'allowances'])
    expect(by('ai')).toEqual([])
    expect(by('connections')).toEqual(['providers', 'connectors', 'ai-apps'])
    expect(by('app')).toEqual(['notifications', 'apps', 'about'])
  })
})

test('the settings search finds a section by what is inside it, in every language (비밀번호 → 보안·기기)', () => {
  const tabs = settingsTabs(true, true)
  const find = (l: 'ko' | 'en' | 'id' | 'ja' | 'es', q: string) => tabs.filter((x) => sectionMatches(x, q.trim().toLowerCase(), (k) => translate(l, k))).map((x) => x.id)
  expect(find('ko', '비밀번호')).toEqual(['security'])
  expect(find('en', 'Password')).toEqual(['security'])
  expect(find('id', 'kata sandi')).toEqual(['security'])
  expect(find('ja', 'パスワード')).toEqual(['security'])
  expect(find('es', 'contraseña')).toEqual(['security'])
  // the name still finds it, and an empty search shows every section
  expect(find('ko', '보안')).toEqual(['security'])
  expect(find('ko', '다크 모드')).toEqual(['profile'])
  expect(find('ko', '')).toEqual(tabs.map((x) => x.id))
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

describe('"Allow all websites" for the AI\'s web reads (the team allows it: Me.team.webAllowAll)', () => {
  test('the Browser tab follows the team key outside the desktop app; inside it, it is there either way', () => {
    expect(browserTabShown(false, undefined)).toBe(false)
    expect(browserTabShown(false, false)).toBe(false)
    expect(browserTabShown(false, true)).toBe(true)
    expect(browserTabShown(true, undefined)).toBe(true)
    expect(settingsTabs(browserTabShown(false, undefined)).some((x) => x.id === 'browser')).toBe(false)
    expect(settingsTabs(browserTabShown(false, true)).some((x) => x.id === 'browser')).toBe(true)
  })
  test('team key off: today\'s desktop page, its own texts, no server lines', () => {
    const html = view(settings({ siteAccess: 'all' }))
    expect(html).toContain(esc(translate('en', 'settings.browser.desc')))
    expect(html).toContain(esc(translate('en', 'settings.browser.allHint')))
    expect(html).not.toContain(esc(WEB_ALLOW_ALL_RISK.en))
    expect(html).not.toContain('browser-here-asks')
    expect(html).not.toContain('browser-here-only')
  })
  test('outside the desktop app: the server value and the risk sentence; no sites list', () => {
    const off = view(undefined, { web: { on: false } })
    expect(radio(off, 'ask')).toContain('checked')
    expect(radio(off, 'all')).not.toContain('disabled')
    expect(off).toContain(esc(translate('en', 'settings.browser.descWeb')))
    expect(off).toContain(esc(WEB_ALLOW_ALL_RISK.en))
    expect(off).toContain(esc(translate('en', 'settings.browser.allHintWeb', { risk: WEB_ALLOW_ALL_RISK.en })))
    expect(off).not.toContain('per answer')
    expect(off).not.toContain('data-testid="browser-sites')
    expect(off).not.toContain('data-testid="browser-all-on"')
    const on = view(undefined, { web: { on: true } })
    expect(radio(on, 'all')).toContain('checked')
    expect(on).toContain('data-testid="browser-all-on"')
    // nothing to show before the team allows it and outside the desktop app
    expect(view(undefined)).not.toContain('browser-access-all')
  })
  test('inside the desktop app: on elsewhere, this computer still asks (with "Allow here too"); "all" here alone says web reads still ask', () => {
    const asks = view(settings({ siteAccess: 'ask' }), { web: { on: true } })
    expect(radio(asks, 'all')).toContain('checked')
    expect(asks).toContain('data-testid="browser-here-asks"')
    expect(asks).toContain('data-testid="browser-allow-here"')
    expect(asks).toContain(esc(translate('en', 'settings.browser.hereAsks')))
    // the desktop app's policy is off (it heard it last): no button that could not work
    expect(view(settings({ siteAccess: 'ask', teamAllowsAll: false }), { web: { on: true } })).not.toContain('browser-allow-here')
    const here = view(settings({ siteAccess: 'all' }), { web: { on: false } })
    expect(radio(here, 'ask')).toContain('checked')
    expect(here).toContain('data-testid="browser-here-only"')
    // both on: neither line, and the sites list as before
    const both = view(settings({ siteAccess: 'all', always: ['naver.com'] }), { web: { on: true } })
    expect(both).not.toContain('browser-here-asks')
    expect(both).not.toContain('browser-here-only')
    expect(both).toContain('data-testid="browser-site"')
  })
  test('the risk sentence and the new texts in five languages', () => {
    for (const l of ['en', 'ko', 'id', 'ja', 'es'] as const) {
      expect(WEB_ALLOW_ALL_RISK[l].length).toBeGreaterThan(20)
      expect(translate(l, 'settings.browser.allHintWeb', { risk: WEB_ALLOW_ALL_RISK[l] })).toContain(WEB_ALLOW_ALL_RISK[l])
      expect(translate(l, 'teamSettings.webAllowAllHint', { risk: WEB_ALLOW_ALL_RISK[l] })).toContain(WEB_ALLOW_ALL_RISK[l])
    }
    expect(translate('en', 'audit.act.web.allow_all_on')).toBe('Allow all websites turned on (web reads)')
    expect(translate('ko', 'settings.browser.allOnFromCard')).toContain('설정 › 브라우저')
  })
  test('admin: one indented line under the browser switch, a boolean team setting admins can turn off, disabled while that switch is off', () => {
    expect(TeamSettings.shape.webAllowAll.safeParse(true).success).toBe(true)
    expect(TeamSettings.shape.webAllowAll.safeParse('yes').success).toBe(false)
    expect(UpdateSettingsBody.safeParse({ webAllowAll: false }).success).toBe(true)
    const on = renderToStaticMarkup(<WebAllowAllSwitch value parentOn onChange={noop} />)
    expect(on).toContain('data-testid="team-web-allow-all-line"')
    expect(on).toContain('data-on="true"')
    expect(on).toContain(esc(translate('en', 'teamSettings.webAllowAll')))
    expect(on).toContain(esc(WEB_ALLOW_ALL_RISK.en))
    expect(on).not.toMatch(/<input[^>]*disabled/)
    const parentOff = renderToStaticMarkup(<WebAllowAllSwitch value parentOn={false} onChange={noop} />)
    expect(parentOff).toContain('data-on="false"')
    expect(parentOff).toMatch(/<input[^>]*disabled/)
    expect(parentOff).not.toMatch(/<input[^>]*checked/)
  })
})

describe('turning it on: the risk sentence first, then the server value with its version', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const sent: { key: string; body: unknown }[] = []
  let routes: Record<string, () => Response> = {}
  const realFetch = globalThis.fetch
  const localeBefore = useLocaleStore.getState().locale
  const sessionBefore = useSession.getState().status
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'en' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      sent.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null })
      return routes[key]?.() ?? json(500, { error: { code: 'internal', message: `no route ${key}` } })
    }) as unknown as typeof fetch
  })
  afterEach(() => { sent.length = 0; useSession.setState({ status: sessionBefore }) })
  afterAll(() => {
    globalThis.fetch = realFetch
    removeDom()
    useLocaleStore.setState({ locale: localeBefore })
  })
  const signedIn = (webOn = false) =>
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'member', ...(webOn ? { webAllowAll: true } : {}) }, groups: [], team: { name: 'Acme', defaultLocale: 'en', browserAllowAll: true, webAllowAll: true }, server: { version: '0', dev: false } } } } as never)
  const puts = () => sent.filter((x) => x.key === 'PUT /api/me/web-access').map((x) => x.body)
  /** a browser checks a radio before the click's listeners run, past React's value tracker (this small DOM does not) */
  const pick = async (m: Mounted, id: string) => {
    const input = m.get(id)
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')!.set!.call(input, true)
    await m.click(input)
  }
  const fakeSettingsBridge = (outcome: DesktopAccessOutcome, calls: string[]): BrowserSettingsBridge => ({
    get: async () => settings(),
    onChange: () => noop,
    setAccess: async (v) => { calls.push(v); return v === 'all' ? outcome : 'changed' },
    removeSite: async () => settings(),
    clearSites: async () => settings(),
  })

  test('outside the desktop app: the page\'s confirm shows the risk sentence; cancel sends nothing, confirm sends the version', async () => {
    signedIn()
    routes = { 'PUT /api/me/web-access': () => json(200, { allowAll: true }) }
    const m = await mount(<MemoryRouter><BrowserSettings bridge={null} /><DialogHost /></MemoryRouter>)
    await pick(m, 'browser-access-all')
    const warning = await m.until(() => m.find('browser-all-warning'), 'the confirm')
    expect(warning.textContent).toContain(WEB_ALLOW_ALL_RISK.en)
    await m.click(m.get('dialog-confirm').parentElement!.querySelector('button')!) // the first button: cancel
    await m.until(() => !m.find('browser-all-warning'), 'the confirm closed')
    await m.settle(50)
    expect(puts()).toEqual([])
    await pick(m, 'browser-access-all')
    await m.until(() => m.find('browser-all-warning'), 'the confirm again')
    await m.click('dialog-confirm')
    await m.until(() => puts().length > 0, 'the PUT')
    expect(puts()).toEqual([{ on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION }])
    await m.unmount()
  })

  test('inside the desktop app: the app\'s own window is the confirm; a refused PUT puts this computer\'s browser back to asking', async () => {
    signedIn()
    const calls: string[] = []
    routes = { 'PUT /api/me/web-access': () => json(409, { error: { code: 'conflict', message: 'no', params: { reason: 'web_allow_all_off' } } }) }
    const m = await mount(<MemoryRouter><BrowserSettings bridge={fakeSettingsBridge('changed', calls)} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('browser-access-all'), 'the page')
    await pick(m, 'browser-access-all')
    await m.until(() => calls.includes('ask'), 'the browser back to asking')
    expect(m.find('browser-all-warning')).toBeNull() // no second confirm in the page
    expect(calls).toEqual(['all', 'ask'])
    expect(puts()).toEqual([{ on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION }])
    await m.unmount()
  })

  test('inside the desktop app with its browser already "all" (no window opened): the page\'s confirm first; turning off sends off and asks here too', async () => {
    signedIn()
    const calls: string[] = []
    routes = { 'PUT /api/me/web-access': () => json(200, { allowAll: true }) }
    const m = await mount(<MemoryRouter><BrowserSettings bridge={fakeSettingsBridge('unchanged', calls)} /><DialogHost /></MemoryRouter>)
    await m.until(() => m.find('browser-access-all'), 'the page')
    await pick(m, 'browser-access-all')
    await m.until(() => m.find('browser-all-warning'), 'the page\'s confirm')
    await m.click('dialog-confirm')
    await m.until(() => puts().length > 0, 'the PUT')
    expect(puts()).toEqual([{ on: true, acceptWarning: WEB_ALLOW_ALL_WARNING_VERSION }])
    await m.unmount()
    sent.length = 0
    calls.length = 0
    signedIn(true)
    const m2 = await mount(<MemoryRouter><BrowserSettings bridge={fakeSettingsBridge('unchanged', calls)} /><DialogHost /></MemoryRouter>)
    await m2.until(() => m2.find('browser-access-ask'), 'the page')
    await pick(m2, 'browser-access-ask')
    await m2.until(() => calls.includes('ask'), 'this computer back to asking')
    expect(puts()).toEqual([{ on: false }])
    await m2.unmount()
  })
})
