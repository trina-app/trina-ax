// The AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md), the web half:
// Settings › Browser › "Your Chrome" (components/settings/ChromeLink.tsx: how to connect, the linked Chrome with its state
// and Disconnect, the desktop app's "Use my Chrome" switch), where the section shows (computers only), the extension's
// Connect page (pages/ConnectChrome.tsx: the team and account, Connect makes the code and moves to the done page with the
// code only after #), and the site card for Chrome (components/chat/AskCard.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { CHROME_CONNECT_DONE_PATH, type ChromeLink, type Me, type TurnRequest } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ChromeLinkSettings, ChromeLinkView, linkOfProfile, siteOf, type ChromeLinkData } from '../../src/components/settings/ChromeLink'
import type { DesktopBrowserProfile } from '@mycel/shared'
import { ConnectChrome, chromeDoneHref, readChallenge } from '../../src/pages/ConnectChrome'
import { browserTabShown, chromeLinkHere, settingsTabs } from '../../src/pages/settingsTabs'
import AskCard from '../../src/components/chat/AskCard'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const noop = () => {}
const link = (o: Partial<ChromeLink> = {}): ChromeLink => ({ id: 'l1', label: 'Chrome on Mac', email: null, browser: null, createdAt: '2026-11-28T00:00:00.000Z', lastSeenAt: null, online: true, version: '0.1.0', sites: [], onlyListed: false, ...o })
const view = (data: ChromeLinkData | null, inApp = false, now = Date.parse('2026-11-28T12:00:00.000Z'), openIds: string[] = []) =>
  renderToStaticMarkup(<ChromeLinkView data={data} inApp={inApp} host="acme.trina.app" now={now} onDisconnect={noop} onTarget={noop} onPatch={async () => true} openIds={openIds} />)
const CHALLENGE = 'A'.repeat(43)
const json = (body: unknown, code = 200) => new Response(code === 204 ? null : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = (): Me => ({
  user: { id: 'mina', username: 'mina', name: 'Mina Kim', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'hosted' },
} as unknown as Me)

describe('where "Your Chrome" shows', () => {
  test('on a computer, not on a phone, the phone app or a free-roam demo', () => {
    expect(chromeLinkHere({ phone: false, phoneApp: false, freeRoam: false })).toBe(true)
    expect(chromeLinkHere({ phone: true, phoneApp: false, freeRoam: false })).toBe(false)
    expect(chromeLinkHere({ phone: false, phoneApp: true, freeRoam: false })).toBe(false)
    expect(chromeLinkHere({ phone: false, phoneApp: false, freeRoam: true })).toBe(false)
  })
  test('the Browser tab is there on a computer browser for it, and still not for a guest', () => {
    expect(settingsTabs(browserTabShown(false, undefined, false, true)).some((x) => x.id === 'browser')).toBe(true)
    expect(settingsTabs(browserTabShown(false, undefined, false, false)).some((x) => x.id === 'browser')).toBe(false)
    expect(settingsTabs(browserTabShown(false, undefined, false, true), false, false, true).some((x) => x.id === 'browser')).toBe(false)
  })
})

describe('Settings › Browser › On this computer (desktop app links profiles itself)', () => {
  const prof = (o: Partial<DesktopBrowserProfile> = {}): DesktopBrowserProfile => ({ browser: 'chrome', dir: 'Default', name: 'Work', email: 'mina@work.example', installed: true, ...o })
  const withProfiles = (data: ChromeLinkData, profiles: DesktopBrowserProfile[] | null) =>
    renderToStaticMarkup(<ChromeLinkView data={data} inApp host="acme.trina.app" onDisconnect={noop} onTarget={noop} onPatch={async () => true} profiles={profiles} onConnectProfile={noop} onConnectAll={noop} />)
  test('each profile with Connect (installed) or Add to Chrome (not yet), Connect all for two or more; no "how" text', () => {
    const html = withProfiles({ links: [], target: 'app' }, [prof(), prof({ dir: 'Profile 1', name: 'Person 1', email: undefined, installed: false }), prof({ browser: 'edge', dir: 'Default', name: 'Home', email: undefined })])
    expect(html.match(/data-testid="chrome-profile-row"/g)?.length).toBe(3)
    expect(html).toContain(translate('en', 'settings.chrome.install'))
    // Connect all: only the profiles that have the extension (two here)
    expect(html).toContain('data-testid="chrome-profiles-all"')
    expect(html).toContain('mina@work.example')
    expect(html).toContain('Edge')
    expect(html).toContain(translate('en', 'settings.chrome.appHint'))
    expect(html).not.toContain('data-testid="chrome-link-how"')
  })
  test('a profile already linked (same account, else the same name) is only in the connected list; one left: no Connect all', () => {
    const html = withProfiles({ links: [link({ label: 'Work', email: 'mina@work.example', browser: 'Chrome on Mac' })], target: 'app' }, [prof(), prof({ dir: 'Profile 2', name: 'Home', email: 'mina@home.example' })])
    expect(html.match(/data-testid="chrome-profile-row"/g)?.length).toBe(1)
    expect(html).toContain('data-testid="chrome-links-title"')
    expect(html).not.toContain('data-testid="chrome-profiles-all"')
    // all linked: the section is gone
    expect(withProfiles({ links: [link({ label: 'Work', email: 'mina@work.example' })], target: 'app' }, [prof()])).not.toContain('data-testid="chrome-profiles"')
    expect(linkOfProfile(prof({ email: undefined, name: 'Person 1' }), [link({ label: 'Person 1' })])).toBeTruthy()
    // an Edge profile is not matched by a Chrome link of the same account
    expect(linkOfProfile(prof({ browser: 'edge' }), [link({ email: 'mina@work.example', browser: 'Chrome on Mac' })])).toBeUndefined()
  })
  test('the linked row names the account and the browser', () => {
    const html = withProfiles({ links: [link({ label: 'Work', email: 'mina@work.example', browser: 'Chrome on Mac' })], target: 'app' }, [])
    expect(html).toContain('data-testid="chrome-link-account"')
    expect(html).toContain('Chrome on Mac')
    expect(html).toContain('data-testid="chrome-profiles-none"')
  })
})

describe('Settings › Browser › Your Chrome', () => {
  test('no link: how to connect, with the team address; no row, no switch', () => {
    const html = view({ links: [], target: 'app' })
    expect(html).toContain(translate('en', 'settings.chrome.title'))
    expect(html).toContain('data-testid="chrome-link-how"')
    expect(html).toContain('acme.trina.app')
    expect(html).not.toContain('data-testid="chrome-link-row"')
    expect(html).not.toContain('data-testid="chrome-target"')
  })
  test('linked and online: its name, "Connected", Disconnect', () => {
    const html = view({ links: [link()], target: 'app' })
    expect(html).toContain('Chrome on Mac')
    expect(html).toContain(translate('en', 'settings.chrome.online'))
    expect(html).toContain('data-testid="chrome-link-disconnect"')
    expect(html).not.toContain('data-testid="chrome-link-how"')
  })
  test('several profiles: one row each, the line on connecting another (each profile once, the store link)', () => {
    const html = view({ links: [link(), link({ id: 'l2', label: '업무 메일', online: false })], target: 'app' })
    expect(html.match(/data-testid="chrome-link-row"/g)?.length).toBe(2)
    expect(html).toContain('업무 메일')
    expect(html).toContain('data-testid="chrome-link-another"')
    expect(html).toContain(translate('en', 'settings.chrome.oneEach'))
    expect(html).toContain('data-testid="chrome-link-store"')
    // the sites stay closed until asked for
    expect(html).not.toContain('data-testid="chrome-link-sites"')
    expect(html).toContain(translate('en', 'settings.chrome.sites', { n: 0 }))
  })
  test('a profile\'s sites, opened: removable chips, the field to add one, and the one switch "Only these sites"', () => {
    const html = view({ links: [link({ sites: ['mail.google.com', 'naver.com'], onlyListed: true })], target: 'app' }, false, undefined, ['l1'])
    expect(html.match(/data-testid="chrome-link-site"/g)?.length).toBe(2)
    expect(html.match(/data-testid="chrome-link-site-remove"/g)?.length).toBe(2)
    expect(html).toContain('data-testid="chrome-link-site-input"')
    expect(new RegExp('<input[^>]*data-testid="chrome-link-only"[^>]*>').exec(html)?.[0]).toContain('checked')
    expect(html).toContain(translate('en', 'settings.chrome.onlyListedHint'))
    const none = view({ links: [link({ onlyListed: true })], target: 'app' }, false, undefined, ['l1'])
    expect(none).toContain(translate('en', 'settings.chrome.sitesNoneOnly'))
  })
  test('a typed site as the server keeps it', () => {
    expect(siteOf('https://www.Naver.com/news?x=1')).toBe('www.naver.com')
    expect(siteOf(' mail.google.com/mail ')).toBe('mail.google.com')
    expect(siteOf('example.com:8080')).toBe('example.com')
    expect(siteOf('localhost')).toBeNull()
    expect(siteOf('not a site')).toBeNull()
    expect(siteOf('')).toBeNull()
  })
  test('linked, not online: when it was last used; never seen: "Not connected now"', () => {
    expect(view({ links: [link({ online: false, lastSeenAt: '2026-11-28T09:00:00.000Z' })], target: 'app' })).toContain('Last used 3 hours ago')
    expect(view({ links: [link({ online: false })], target: 'app' })).toContain(translate('en', 'settings.chrome.offline'))
  })
  test('the desktop app with a linked Chrome: the switch, with the hint for its state; not in a browser, not without a link', () => {
    const off = view({ links: [link()], target: 'app' }, true)
    expect(off).toContain('data-testid="chrome-target-switch"')
    expect(off).toContain(translate('en', 'settings.chrome.useOff'))
    expect(view({ links: [link()], target: 'chrome' }, true)).toContain(translate('en', 'settings.chrome.useOn'))
    expect(view({ links: [link()], target: 'app' }, false)).not.toContain('data-testid="chrome-target"')
    expect(view({ links: [], target: 'chrome' }, true)).not.toContain('data-testid="chrome-target"')
  })

  describe('with the server', () => {
    const realFetch = globalThis.fetch
    const realLocation = (globalThis as { location?: unknown }).location
    const before = useLocaleStore.getState().locale
    let links: ChromeLink[] = []
    const calls: string[] = []
    const patches: unknown[] = []
    beforeAll(() => {
      installDom()
      ;(globalThis as { location?: unknown }).location = { host: 'acme.trina.app', origin: 'https://acme.trina.app', pathname: '/settings/browser', search: '', hash: '' }
      useLocaleStore.setState({ locale: 'en' })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
        calls.push(key)
        if (key === 'GET /api/chrome/links') return json({ links, target: 'app' })
        if (key === 'DELETE /api/chrome/links/l1') { links = []; return json(null, 204) }
        if (key === 'PATCH /api/chrome/links/l1') {
          const b = JSON.parse(String(init?.body)) as { label?: string; addSite?: string }
          patches.push(b)
          links = links.map((l) => ({ ...l, ...(b.label ? { label: b.label } : {}), ...(b.addSite ? { sites: [...l.sites, b.addSite] } : {}) }))
          return json(links[0])
        }
        return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
      }) as unknown as typeof fetch
    })
    afterAll(() => {
      globalThis.fetch = realFetch
      ;(globalThis as { location?: unknown }).location = realLocation
      removeDom()
      useLocaleStore.setState({ locale: before })
    })
    test('Disconnect: DELETE, then the list again shows how to connect (no question first)', async () => {
      links = [link()]
      const m = await mount(<ChromeLinkSettings />)
      try {
        await m.until(() => m.find('chrome-link-row'), 'the linked row')
        await m.click('chrome-link-disconnect')
        await m.until(() => m.find('chrome-link-how'), 'how to connect')
        expect(calls).toContain('DELETE /api/chrome/links/l1')
      } finally {
        await m.unmount()
      }
    })
    test('add a site: typed as an address, kept as its name (one PATCH), the chip shows the answer', async () => {
      links = [link()]
      const m = await mount(<ChromeLinkSettings />)
      try {
        await m.until(() => m.find('chrome-link-row'), 'the linked row')
        await m.click('chrome-link-sites-toggle')
        await m.type('chrome-link-site-input', 'https://Mail.Google.com/mail')
        await m.click('chrome-link-site-add')
        await m.until(() => m.find('chrome-link-site'), 'the added site')
        expect(m.get('chrome-link-site').textContent).toContain('mail.google.com')
        expect(patches).toContainEqual({ addSite: 'mail.google.com' })
      } finally {
        await m.unmount()
      }
    })
  })
})

describe('/connect-chrome', () => {
  test('the challenge must be the extension\'s (43 base64url characters)', () => {
    expect(readChallenge(`?challenge=${CHALLENGE}`)).toBe(CHALLENGE)
    expect(readChallenge('')).toBeNull()
    expect(readChallenge('?challenge=short')).toBeNull()
    expect(readChallenge(`?challenge=${'A'.repeat(42)}=`)).toBeNull()
    expect(chromeDoneHref('c'.repeat(43))).toBe(`${CHROME_CONNECT_DONE_PATH}#code=${'c'.repeat(43)}`)
  })

  const realFetch = globalThis.fetch
  const realLocation = (globalThis as { location?: unknown }).location
  const status = useSession.getState().status
  const before = useLocaleStore.getState().locale
  const replaced: string[] = []
  const posted: unknown[] = []
  beforeAll(() => {
    installDom()
    ;(globalThis as { location?: unknown }).location = { host: 'acme.trina.app', origin: 'https://acme.trina.app', pathname: '/connect-chrome', search: '', hash: '', replace: (u: string) => void replaced.push(u) }
    useLocaleStore.setState({ locale: 'en' })
    useSession.setState({ status: { kind: 'signed-in', me: me() } } as never)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      if (key === 'POST /api/chrome/pair') { posted.push(JSON.parse(String(init?.body))); return json({ code: 'c'.repeat(43), expiresAt: '2026-11-28T12:05:00.000Z' }) }
      return json({ error: { code: 'internal', message: `no route ${key}` } }, 500)
    }) as unknown as typeof fetch
  })
  afterEach(() => { replaced.length = 0; posted.length = 0 })
  afterAll(() => {
    globalThis.fetch = realFetch
    ;(globalThis as { location?: unknown }).location = realLocation
    removeDom()
    useSession.setState({ status })
    useLocaleStore.setState({ locale: before })
  })

  test('the team and the account in large type; Connect makes the code for the challenge and moves to the done page with it after #', async () => {
    const m = await mount(<MemoryRouter initialEntries={[`/connect-chrome?challenge=${CHALLENGE}`]}><ConnectChrome /></MemoryRouter>)
    try {
      expect(m.get('connect-chrome-host').textContent).toBe('acme.trina.app')
      expect(m.get('connect-chrome-account').textContent).toContain('Mina Kim')
      expect(m.get('connect-chrome-account').textContent).toContain('@mina')
      await m.click('connect-chrome-connect')
      await m.until(() => replaced.length > 0, 'the move to the done page')
      expect(posted).toEqual([{ challenge: CHALLENGE }])
      expect(replaced).toEqual([`${CHROME_CONNECT_DONE_PATH}#code=${'c'.repeat(43)}`])
    } finally {
      await m.unmount()
    }
  })
  test('no challenge (opened by hand): one line, no buttons, nothing sent', async () => {
    const m = await mount(<MemoryRouter initialEntries={['/connect-chrome']}><ConnectChrome /></MemoryRouter>)
    try {
      expect(m.find('connect-chrome-missing')).not.toBeNull()
      expect(m.find('connect-chrome-connect')).toBeNull()
      expect(m.find('connect-chrome-cancel')).toBeNull()
      expect(posted).toEqual([])
    } finally {
      await m.unmount()
    }
  })
})

describe('the site card for Chrome', () => {
  type Site = Extract<TurnRequest, { kind: 'browser_site' }>
  const site = (o: Partial<Site> = {}): Site => ({ kind: 'browser_site', requestId: 'r1', url: 'https://www.naver.com/news', host: 'www.naver.com', chrome: true, site: 'naver.com', ...o })
  const card = (r: Site) => renderToStaticMarkup(<AskCard req={{ request: r }} onAnswer={async () => {}} />)
  const tr = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate(useLocaleStore.getState().locale, k, p)
  test('its own title, "Always allow this site (naver.com)" naming the site it keeps', () => {
    const html = card(site())
    expect(html).toContain(tr('ask.chromeSiteTitle', { host: 'www.naver.com', profile: 'Chrome' }).replace(/'/g, '&#x27;').replace(/"/g, '&quot;'))
    expect(html).toContain('data-testid="site-card-always"')
    expect(html).toContain(tr('ask.chromeAlways', { site: 'naver.com' }))
  })
  test('no site to keep, or the team turned Always off: no Always', () => {
    expect(card(site({ site: undefined }))).not.toContain('data-testid="site-card-always"')
    expect(card(site({ noAlways: true }))).not.toContain('data-testid="site-card-always"')
  })
  test('without chrome: the in-app browser\'s office card as before', () => {
    const html = card(site({ chrome: undefined }))
    expect(html).toContain(tr('ask.siteTitle'))
    expect(html).not.toContain('data-chrome')
  })
  test('the answers are the same as the office card\'s', async () => {
    installDom()
    const answers: unknown[] = []
    const m = await mount(<AskCard req={{ request: site() }} onAnswer={async (_id, body) => void answers.push(body)} />)
    try {
      await m.click('site-card-always')
      expect(answers).toEqual([{ kind: 'browser_site', decision: 'always' }])
    } finally {
      await m.unmount()
      removeDom()
    }
  })
})
