// The web ask (lib/push-ask.ts, components/WebPushAsk.tsx): "새 메시지 알림을 받으려면 [알림 켜기] · [나중에]" in a web
// browser, only when every condition holds; [알림 켜기] runs enablePush in the click (the browser's question first); on
// success the line goes and a toast says so; a failure says why in the line with the way to Settings › Notifications;
// [나중에] puts it away for 7 days on this device; the browser's "block" puts it away for good. Not in Microsoft Edge (the
// team server refuses its push service). It first shows on the page after the one where it became ready (no jump under
// the person's finger); its words are one live region; the focus goes to the page when the line goes from under it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { DESKTOP_BRIDGE_GLOBAL } from '@mycel/shared'
import { translate, useLocaleStore } from '../../src/i18n'
import { isEdge, setPushSession } from '../../src/lib/push'
import { ASK_BLOCKED_KEY, ASK_LATER_KEY, ASK_LATER_MS, askAllowedHere, prepareWebPushAsk, turnOnWebPush, useWebPushAsk, webPushAskShows, type AskConditions } from '../../src/lib/push-ask'
import { WebPushAsk } from '../../src/components/WebPushAsk'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
const NOW = Date.parse('2026-11-07T09:00:00Z')

describe('when the line may show', () => {
  const all: AskConditions = { supported: true, edge: false, permission: 'default', settings: { configured: true, publicKey, optedOut: false }, signedIn: true, later: null, blocked: false, now: NOW }
  test('all of them hold: shown', () => {
    expect(webPushAskShows(all)).toBe(true)
    expect(askAllowedHere(all)).toBe(true)
  })
  test('any one missing: hidden', () => {
    const off: [string, Partial<AskConditions>][] = [
      ['signed out', { signedIn: false }],
      ['no Web Push here (desktop app, phone app, http, an iPhone tab, an old browser)', { supported: false }],
      ['Microsoft Edge (the team server refuses its push service)', { edge: true }],
      ['the browser was asked: allowed', { permission: 'granted' }],
      ['the browser was asked: blocked', { permission: 'denied' }],
      ['no Notification at all', { permission: null }],
      ['the server has no Web Push', { settings: { configured: false, publicKey: null, optedOut: false } }],
      ['the server sent no key', { settings: { configured: true, publicKey: null, optedOut: false } }],
      ['the server\'s key is not a valid one', { settings: { configured: true, publicKey: 'not-a-key', optedOut: false } }],
      ['the server could not be read', { settings: null }],
      ['the person turned push off on all devices', { settings: { configured: true, publicKey, optedOut: true } }],
      ['[나중에] a minute ago', { later: String(NOW - 60_000) }],
      ['[나중에] 7 days ago less a minute', { later: String(NOW - ASK_LATER_MS + 60_000) }],
      ['blocked from this line before', { blocked: true }],
    ]
    for (const [why, change] of off) expect([why, webPushAskShows({ ...all, ...change })]).toEqual([why, false])
  })
  test('[나중에] more than 7 days ago, or a value that is not a time: shown again', () => {
    expect(webPushAskShows({ ...all, later: String(NOW - ASK_LATER_MS - 1) })).toBe(true)
    expect(webPushAskShows({ ...all, later: 'garbage' })).toBe(true)
  })
})

test('Microsoft Edge: by its user agent or its brand', () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const as = (v: object) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: v })
  try {
    as({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0' })
    expect(isEdge()).toBe(true)
    as({ userAgent: 'Mozilla/5.0 Chrome/130', userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] } })
    expect(isEdge()).toBe(true)
    as({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36', userAgentData: { brands: [{ brand: 'Google Chrome' }] } })
    expect(isEdge()).toBe(false)
  } finally { if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator) }
})

describe('in a browser', () => {
  const g = globalThis as Record<string, unknown>
  const realFetch = globalThis.fetch, realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const status = useSession.getState().status, locale = useLocaleStore.getState().locale
  const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130'
  let userAgent = CHROME
  let permission: NotificationPermission = 'default'
  let answer: NotificationPermission = 'granted'
  let settings: Record<string, unknown> = {}
  let subscribe: () => Promise<unknown> = async () => ({})
  const order: string[] = []
  const registration = { active: { postMessage() {} }, pushManager: { getSubscription: async () => null, subscribe: () => { order.push('subscribe'); return subscribe() } } }
  const subscription = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => true }
  const me = (id = 'session-a') => ({ user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id, client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'hosted' } }) as unknown as Me
  let n = 0
  /** a new session each time: the line is made ready once per session */
  const signIn = () => {
    const id = `session-${++n}`
    useSession.setState({ status: { kind: 'signed-in', me: me(id) } } as never)
    setPushSession(`mina:${id}`)
  }
  beforeAll(() => {
    installDom()
    useLocaleStore.setState({ locale: 'ko' })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get userAgent() { return userAgent }, platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration, controller: null } } })
    g.PushManager = function PushManager() {}
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { get permission() { return permission }, requestPermission: async () => { order.push('permission'); permission = answer; return permission } } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      order.push(key)
      if (key === 'GET /api/push') return Response.json({ configured: true, enabled: false, publicKey, subscriptionId: null, ...settings })
      if (key === 'POST /api/push/subscriptions') return Response.json({ id: 'sub-1' })
      return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 })
    }) as typeof fetch
  })
  beforeEach(() => {
    permission = 'default'; answer = 'granted'; settings = {}; order.length = 0; userAgent = CHROME
    subscribe = async () => subscription
    localStorage.clear()
    useUi.setState({ toasts: [] })
    delete g[DESKTOP_BRIDGE_GLOBAL]
  })
  afterAll(() => {
    setPushSession(null)
    globalThis.fetch = realFetch
    delete g.PushManager
    delete g[DESKTOP_BRIDGE_GLOBAL]
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
    removeDom()
    useSession.setState({ status })
    useLocaleStore.setState({ locale })
  })
  /** a link to another page, as the sidebar or the tab bar has */
  function Go() {
    const navigate = useNavigate()
    return <><button type="button" data-testid="go-files" onClick={() => navigate('/files')}>files</button><button type="button" data-testid="go-home" onClick={() => navigate('/')}>home</button></>
  }
  const page = (path = '/') => mount(<MemoryRouter initialEntries={[path]}><main id="main" tabIndex={-1}><WebPushAsk at="top" /><WebPushAsk at="bottom" /></main><Go /></MemoryRouter>)
  /** made ready on this page, then the person moves on: the line shows on the next page */
  const shown = async (path = '/') => {
    const p = await page(path)
    await p.until(() => useWebPushAsk.getState().show, 'ready')
    await p.settle()
    expect(p.find('web-push-ask-top')).toBeNull()
    await p.click('go-files')
    return { p, top: await p.until(() => p.find('web-push-ask-top'), 'the line') }
  }

  test('ready on the page in front of the person: not shown there (it would push the page under their finger); on the next page it is', async () => {
    signIn()
    const p = await page()
    await p.until(() => useWebPushAsk.getState().show, 'ready')
    await p.settle(50)
    expect(p.find('web-push-ask-top')).toBeNull()
    await p.click('go-files')
    await p.until(() => p.find('web-push-ask-top'), 'the line on the next page')
    await p.unmount()
  })

  test('shown at the top on a computer and above the tab bar on a phone: one line, a hairline, no box; its words a live region', async () => {
    signIn()
    const { p, top } = await shown()
    expect(top.textContent).toContain('새 메시지 알림을 받으려면')
    expect(top.textContent).toContain('알림 켜기')
    expect(top.textContent).toContain('나중에')
    expect(top.className).toContain('border-b')
    expect(top.className).toContain('max-md:hidden')
    expect(top.className).not.toMatch(/rounded|shadow/)
    expect(top.querySelector('[data-testid="web-push-ask-text"]')!.getAttribute('role')).toBe('status')
    const bottom = p.get('web-push-ask-bottom')
    expect(bottom.className).toContain('border-t')
    expect(bottom.className).toContain('md:hidden')
    // nothing was asked of the browser yet
    expect(order).not.toContain('permission')
    await p.unmount()
  })

  test('turnOnWebPush asks the browser before anything waits', async () => {
    signIn()
    const { p } = await shown()
    order.length = 0
    const work = turnOnWebPush()
    // not awaited yet: the browser's question must already be asked (Safari allows it only inside the click)
    expect(order).toEqual(['permission'])
    expect(await work).toBe('on')
    await p.unmount()
  })

  test('[알림 켜기]: the question in the click itself, then the subscription; the line goes, a toast says it is on, the focus goes to the page', async () => {
    signIn()
    const { p, top } = await shown()
    order.length = 0
    const on = top.querySelector('[data-testid="web-push-on"]')!
    on.focus()
    let inTheClick: string[] = []
    act(() => { on.click(); inTheClick = [...order] })
    expect(inTheClick).toEqual(['permission'])
    // busy: still focusable (aria-busy, not disabled)
    expect(on.getAttribute('aria-busy')).toBe('true')
    expect(on.hasAttribute('disabled')).toBe(false)
    await p.until(() => !p.find('web-push-ask-top'), 'the line gone')
    expect(order).toEqual(['permission', 'subscribe', 'POST /api/push/subscriptions'])
    expect(useUi.getState().toasts.map((x) => [x.level, x.text])).toEqual([['success', ko('push.askOn')]])
    expect((document.activeElement as unknown as { id?: string })?.id).toBe('main')
    await p.unmount()
  })

  test('[나중에]: gone, the focus goes to the page, and away for 7 days on this device', async () => {
    signIn()
    const { p, top } = await shown()
    const before = Date.now()
    const later = top.querySelector('[data-testid="web-push-later"]')!
    later.focus()
    await p.click(later)
    expect(p.find('web-push-ask-top')).toBeNull()
    expect((document.activeElement as unknown as { id?: string })?.id).toBe('main')
    const at = Number(localStorage.getItem(ASK_LATER_KEY))
    expect(at).toBeGreaterThanOrEqual(before)
    expect(order).not.toContain('permission')
    await p.unmount()
    // the next session on this device, within the week: no line, and the server is not even asked
    order.length = 0
    await prepareWebPushAsk('mina:later-1', at + ASK_LATER_MS - 1)
    expect(useWebPushAsk.getState().show).toBe(false)
    expect(order).toEqual([])
    // after the week
    await prepareWebPushAsk('mina:later-2', at + ASK_LATER_MS + 1)
    expect(useWebPushAsk.getState().show).toBe(true)
  })

  test('the browser\'s "block": gone for good on this device; Settings says how to undo it', async () => {
    signIn()
    answer = 'denied'
    const { p, top } = await shown()
    await p.click(top.querySelector('[data-testid="web-push-on"]')!)
    await p.until(() => !p.find('web-push-ask-top'), 'the line gone')
    expect(localStorage.getItem(ASK_BLOCKED_KEY)).toBe('1')
    expect(order).not.toContain('subscribe')
    expect(useUi.getState().toasts).toEqual([])
    await p.unmount()
    // even if the browser's setting is reset later
    permission = 'default'
    await prepareWebPushAsk('mina:blocked-1', Date.now())
    expect(useWebPushAsk.getState().show).toBe(false)
  })

  test('a failure says why in the same live region, with the way to Settings › 알림 (the push service off)', async () => {
    signIn()
    subscribe = async () => { throw new DOMException('Registration failed - push service error', 'AbortError') }
    const warn = console.warn
    console.warn = () => {}
    try {
      const { p, top } = await shown()
      const region = top.querySelector('[data-testid="web-push-ask-text"]')!
      await p.click(top.querySelector('[data-testid="web-push-on"]')!)
      await p.until(() => region.getAttribute('data-reason') === 'service', 'the reason')
      // the same element, still the live region: the reason replaces the question inside it
      expect(p.get('web-push-ask-top').querySelector('[data-testid="web-push-ask-text"]')).toBe(region)
      expect(region.getAttribute('role')).toBe('status')
      expect(region.textContent).toContain(ko('push.service'))
      expect(region.textContent).toContain('설정 › 알림')
      expect(region.querySelector('a')!.getAttribute('href')).toBe('/settings/notifications')
      await p.unmount()
    } finally { console.warn = warn }
  })

  test('hidden: Edge, the browser already asked, the server without Web Push or turned off by the person, the desktop app, signed out', async () => {
    const hidden = async (why: string) => {
      const p = await page()
      await p.settle(30)
      await p.click('go-files')
      await p.settle(30)
      expect([why, p.find('web-push-ask-top'), p.find('web-push-ask-bottom')]).toEqual([why, null, null])
      expect(useWebPushAsk.getState().show).toBe(false)
      await p.unmount()
    }
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    order.length = 0
    signIn(); await hidden('Microsoft Edge')
    // decided on this device: the server is not even asked
    expect(order).toEqual([])
    userAgent = CHROME
    permission = 'granted'; signIn(); await hidden('allowed before')
    permission = 'denied'; signIn(); await hidden('blocked before')
    permission = 'default'
    settings = { configured: false, publicKey: null }; signIn(); await hidden('no Web Push on the server')
    settings = { optedOut: true }; signIn(); await hidden('turned off by the person')
    settings = {}
    g[DESKTOP_BRIDGE_GLOBAL] = { bridgeVersion: 1, platform: 'darwin', appVersion: '0.4.0' }
    signIn(); await hidden('the desktop app')
    delete g[DESKTOP_BRIDGE_GLOBAL]
    useSession.setState({ status: { kind: 'signed-out' } } as never)
    await hidden('signed out')
  })

  test('on a phone: not inside a room or an AI chat (the message box needs the bottom), nor on Settings › 알림', async () => {
    signIn()
    const p = await page('/rooms/r1')
    await p.until(() => useWebPushAsk.getState().show, 'ready')
    await p.settle()
    await p.click('go-home')
    await p.until(() => p.find('web-push-ask-bottom'), 'the line above the tabs')
    await p.unmount()
    const room = await page('/rooms/r2')
    await room.settle(30)
    expect(room.find('web-push-ask-top')).not.toBeNull()
    expect(room.find('web-push-ask-bottom')).toBeNull()
    await room.unmount()
    const settingsPage = await page('/settings/notifications')
    await settingsPage.settle(30)
    expect(settingsPage.find('web-push-ask-top')).toBeNull()
    await settingsPage.unmount()
  })
})
