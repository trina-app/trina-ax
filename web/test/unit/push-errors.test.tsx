// Settings › Notifications › 기기 푸시 알림 in a browser: a failure says why (lib/push.ts pushFailure,
// components/settings/PushNotifications.tsx pushFailureText) instead of "푸시 설정을 저장하지 못했어요. 연결 상태를
// 확인하고 다시 시도해 주세요." for everything: the browser's push service, a service worker that did not start, the
// server's key (an admin's matter), the server's own refusal, a blocked site, a closed question, no connection. "다시
// 시도" only where trying again can help; an unexpected failure is logged (name and message, never an address).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { ApiError } from '../../src/lib/api'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { logPushFailure, PushError, pushFailure, pushRetryHelps, pushSupport, setPushSession, type PushFailure } from '../../src/lib/push'
import { PushNotifications, pushFailureText } from '../../src/components/settings/PushNotifications'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const ko = (k: MessageKey, p?: Params) => translate('ko', k, p)
const dom = (name: string, message = name) => new DOMException(message, name)
const api = (status: number, code: string, o: { params?: Record<string, number> } = {}) => new ApiError(status, { code: code as never, message: `server says ${code}`, ...o })
const kind = (e: unknown, permission: NotificationPermission | null = 'granted') => pushFailure(e, permission).kind

describe('why it failed', () => {
  test('the browser\'s subscription: push service off or away, private windows, a blocked site, no push, a refused key', () => {
    expect(kind(new PushError('subscribe', dom('AbortError', 'Registration failed - push service not available')))).toBe('service')
    expect(kind(new PushError('subscribe', dom('AbortError', 'Registration failed - push service error')))).toBe('service')
    // Chrome's private window and Safari say NotAllowedError; only a blocked site is the person's own "no"
    expect(kind(new PushError('subscribe', dom('NotAllowedError')), 'granted')).toBe('service')
    expect(kind(new PushError('subscribe', dom('NotAllowedError')), 'denied')).toBe('denied')
    expect(kind(new PushError('subscribe', dom('NotSupportedError')))).toBe('unsupported')
    expect(kind(new PushError('subscribe', dom('InvalidAccessError')))).toBe('key')
    expect(kind(new PushError('subscribe', dom('InvalidStateError')))).toBe('unknown')
  })

  test('this page: the worker, the key, the browser\'s question, the account changing', () => {
    expect(kind(new PushError('worker', new Error('push worker unavailable')))).toBe('worker')
    expect(kind(new PushError('worker', new TypeError('Failed to register a ServiceWorker')))).toBe('worker')
    expect(kind(new Error('invalid push key'))).toBe('key')
    expect(kind(new Error('push permission denied'), 'denied')).toBe('denied')
    // the question closed without an answer leaves 'default'
    expect(kind(new Error('push permission denied'), 'default')).toBe('dismissed')
    expect(kind(new Error('push session changed'))).toBe('cancelled')
    expect(kind(new Error('push session unavailable'))).toBe('cancelled')
    expect(kind(new Error('push unsupported'))).toBe('unsupported')
    expect(kind(new Error('invalid browser subscription'))).toBe('unknown')
    expect(kind(new TypeError('x is not a function'))).toBe('unknown')
  })

  test('the team server: unreachable, no key, too many devices, a push service it does not take, its own refusal', () => {
    expect(kind(new PushError('server', new TypeError('Failed to fetch')))).toBe('network')
    // a relay or proxy answered without the server's JSON: the server is away
    expect(kind(new PushError('server', api(502, 'unavailable', { params: { httpStatus: 502 } })))).toBe('network')
    // the server itself: no usable Web Push key (or its secrets folder is unsafe)
    expect(kind(new PushError('server', api(503, 'unavailable')))).toBe('key')
    expect(kind(new PushError('server', api(409, 'plan_limit')))).toBe('tooMany')
    expect(kind(new PushError('server', api(400, 'validation')))).toBe('browserService')
    expect(kind(new PushError('server', api(401, 'unauthorized')))).toBe('server')
    expect(kind(new PushError('server', api(409, 'conflict')))).toBe('server')
    expect(kind(new PushError('server', api(429, 'rate_limited')))).toBe('server')
    // a code this page does not know (a newer server): the general line
    expect(kind(new PushError('server', api(400, 'shiny_new_code')))).toBe('unknown')
  })

  test('"다시 시도" only where trying again can help: no connection, too many requests, a server fault', () => {
    const helps = (e: unknown) => pushRetryHelps(pushFailure(e, 'granted'))
    expect(helps(new PushError('server', new TypeError('Failed to fetch')))).toBe(true)
    expect(helps(new PushError('server', api(429, 'rate_limited')))).toBe(true)
    expect(helps(new PushError('server', api(500, 'internal')))).toBe(true)
    expect(helps(new PushError('server', api(401, 'unauthorized')))).toBe(false)
    expect(helps(new PushError('server', api(503, 'unavailable')))).toBe(false)
    expect(helps(new PushError('subscribe', dom('AbortError')))).toBe(false)
    expect(helps(new PushError('worker', new Error('push worker unavailable')))).toBe(false)
    expect(helps(new Error('push permission denied'))).toBe(false)
    expect(helps(new Error('something else'))).toBe(false)
  })
})

describe('what it says', () => {
  const say = (f: PushFailure, o: { admin?: boolean; brave?: boolean; t?: typeof en } = {}) => pushFailureText(f, o.t ?? en, 'en', { admin: o.admin ?? false, brave: o.brave ?? false })
  test('one line per reason, none of them the old generic one', () => {
    const lines = new Map<PushFailure['kind'], string | null>([
      ['unsupported', en('push.unsupported')], ['insecure', en('push.insecure')], ['service', en('push.service')],
      ['browserService', en('push.browserService')], ['worker', en('push.worker')], ['key', en('push.keyMember')],
      ['denied', en('push.denied')], ['dismissed', en('push.dismissed')], ['network', en('error.network')],
      ['unknown', en('push.failedUnknown')], ['cancelled', null],
    ])
    for (const [k, line] of lines) {
      expect(say({ kind: k })).toBe(line)
      expect(say({ kind: k })).not.toBe(en('push.failed'))
    }
    expect(say({ kind: 'tooMany' })).toBe('Too many devices get push already. Use “Turn off push on all devices”, then turn it on here again.')
    expect(say({ kind: 'service' })).toContain('private window')
    expect(say({ kind: 'worker' })).toContain('Reload the page')
  })

  test('Brave: the setting that turns its push service on, in the person\'s language', () => {
    expect(say({ kind: 'service' }, { brave: true })).toBe(en('push.serviceBrave'))
    expect(say({ kind: 'service' }, { brave: true, t: ko })).toContain("'푸시 메시지에 Google 서비스 사용'")
    expect(say({ kind: 'service' }, { brave: true, t: ko })).toContain('설정 › 개인정보 및 보안')
  })

  test('the server\'s key: an admin is told what to fix, a member only to let an admin know (nothing technical)', () => {
    expect(say({ kind: 'key' }, { admin: true })).toBe(en('push.keyAdmin'))
    expect(say({ kind: 'key' }, { admin: true })).toContain('web push key')
    const member = say({ kind: 'key' })!
    expect(member).toBe('Push cannot be turned on in this team right now. Let your admin know.')
    expect(member).not.toMatch(/key|VAPID|server/i)
    expect(say({ kind: 'key' }, { t: ko })).toBe('지금은 이 팀에서 푸시를 켤 수 없어요. 관리자에게 알려 주세요.')
  })

  test('the server\'s own refusal is shown as it explains it; a code this page does not know gets the general line', () => {
    expect(say(pushFailure(new PushError('server', new ApiError(401, { code: 'unauthorized', message: 'Please sign in.' })), 'granted'))).toBe('Please sign in.')
    expect(say(pushFailure(new PushError('server', api(400, 'shiny_new_code')), 'granted'))).toBe(en('push.failedUnknown'))
  })

  test('every new line exists in all five languages', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      for (const k of ['push.insecure', 'push.service', 'push.serviceBrave', 'push.browserService', 'push.worker', 'push.keyAdmin', 'push.keyMember', 'push.dismissed', 'push.tooMany', 'push.failedUnknown'] as const) {
        expect(translate(l, k)).not.toBe(k)
        if (l !== 'en') expect(translate(l, k)).not.toBe(translate('en', k))
      }
    }
  })
})

describe('the console', () => {
  const realWarn = console.warn
  let lines: unknown[][] = []
  beforeAll(() => { console.warn = (...a: unknown[]) => { lines.push(a) } })
  afterEach(() => { lines = [] })
  afterAll(() => { console.warn = realWarn })
  test('an unexpected subscription failure is logged with its name and message, addresses cut out', () => {
    logPushFailure(new PushError('subscribe', dom('InvalidStateError', 'Subscription at https://fcm.googleapis.com/fcm/send/abc123 already exists')))
    expect(lines).toHaveLength(1)
    const text = lines[0]!.map(String).join(' ')
    expect(text).toContain('[push] subscribe: unknown')
    expect(text).toContain('InvalidStateError')
    expect(text).not.toContain('fcm.googleapis.com')
    expect(text).not.toContain('abc123')
  })
  test('the push service\'s own words are kept too (Brave, a private window); a person\'s "no" is not logged', () => {
    logPushFailure(new PushError('subscribe', dom('AbortError', 'Registration failed - push service error')))
    expect(lines.map((a) => a.map(String).join(' '))).toEqual(['[push] subscribe: service AbortError Registration failed - push service error'])
    lines = []
    logPushFailure(new Error('push permission denied'), { kind: 'denied' })
    logPushFailure(new PushError('server', new TypeError('Failed to fetch')))
    expect(lines).toEqual([])
  })
})

describe('the settings row in a browser', () => {
  const g = globalThis as Record<string, unknown>
  const realFetch = globalThis.fetch, realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const status = useSession.getState().status, locale = useLocaleStore.getState().locale
  const publicKey = Buffer.from([4, ...new Uint8Array(64).fill(2)]).toString('base64url')
  let permission: NotificationPermission = 'default'
  let subscribe: () => Promise<unknown> = async () => { throw dom('AbortError', 'Registration failed - push service error') }
  let post: () => Response | Promise<Response> = () => Response.json({ id: 'sub-1' })
  let subscribes = 0, warned = 0
  const realWarn = console.warn
  const registration = {
    active: { postMessage() {} },
    pushManager: { getSubscription: async () => null, subscribe: () => { subscribes++; return subscribe() } },
  }
  const me = { user: { id: 'mina', username: 'mina', name: '김민아', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: 'session-a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'hosted' } } as unknown as Me
  beforeAll(() => {
    installDom()
    console.warn = () => { warned++ }
    useLocaleStore.setState({ locale: 'ko' })
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration, controller: null } } })
    g.PushManager = function PushManager() {}
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { get permission() { return permission }, requestPermission: async () => { permission = 'granted'; return permission } } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
      if (key === 'GET /api/push') return Response.json({ configured: true, enabled: false, publicKey, subscriptionId: null })
      if (key === 'POST /api/push/subscriptions') return post()
      return Response.json({ error: { code: 'not_found', message: key } }, { status: 404 })
    }) as typeof fetch
    setPushSession('mina:session-a')
  })
  afterAll(() => {
    setPushSession(null)
    console.warn = realWarn
    globalThis.fetch = realFetch
    delete g.PushManager
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
    removeDom()
    useSession.setState({ status })
    useLocaleStore.setState({ locale })
  })
  const row = async () => {
    const page = await mount(<MemoryRouter><PushNotifications /></MemoryRouter>)
    const button = await page.until(() => page.container.querySelectorAll('button').find((b) => b.textContent === ko('push.enable') && !b.hasAttribute('disabled')), 'the enable button')
    return { page, button }
  }

  test('the push service is off (Brave without Google push): that reason, no "다시 시도", and the console has it', async () => {
    permission = 'default'
    const { page, button } = await row()
    await page.click(button)
    const note = await page.until(() => page.find('push-failure'), 'the reason')
    expect(note.getAttribute('data-kind')).toBe('service')
    expect(note.textContent).toContain(ko('push.service'))
    expect(note.textContent).not.toContain(ko('push.failed'))
    expect(note.textContent).not.toContain(ko('common.retry'))
    expect(warned).toBe(1)
    await page.unmount()
  })

  test('the team server could not be reached: that reason with "다시 시도", which tries once more', async () => {
    permission = 'granted'
    subscribe = async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => true })
    post = () => { throw new TypeError('Failed to fetch') }
    const { page, button } = await row()
    await page.click(button)
    const note = await page.until(() => page.find('push-failure'), 'the reason')
    expect(note.getAttribute('data-kind')).toBe('network')
    expect(note.textContent).toContain(ko('error.network'))
    const retry = note.querySelectorAll('button').find((b) => b.textContent === ko('common.retry'))!
    expect(retry).toBeTruthy()
    const before = subscribes
    post = () => Response.json({ id: 'sub-1' })
    await page.click(retry)
    await page.until(() => !page.find('push-failure'), 'the reason gone')
    expect(subscribes).toBe(before + 1)
    await page.unmount()
  })

  test('a site the browser blocks: the status line says so and how to undo it', async () => {
    permission = 'denied'
    const page = await mount(<MemoryRouter><PushNotifications /></MemoryRouter>)
    const line = await page.until(() => page.find('push-status'), 'the status')
    expect(line.textContent).toBe(ko('push.denied'))
    await page.unmount()
  })
})

describe('where Web Push can be', () => {
  const g = globalThis as Record<string, unknown>
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  beforeAll(() => {
    installDom()
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Chrome/130', serviceWorker: {} } })
    g.PushManager = function PushManager() {}
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'default' } })
  })
  afterAll(() => {
    delete g.PushManager
    delete g.mycelDesktop
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
    removeDom()
  })
  test('a browser on https: yes; the desktop app (no push service in Electron): an app; plain http: insecure; no push: browser', () => {
    expect(pushSupport()).toBe('ok')
    g.mycelDesktop = { bridgeVersion: 1, platform: 'darwin' }
    expect(pushSupport()).toBe('app')
    delete g.mycelDesktop
    g.isSecureContext = false
    expect(pushSupport()).toBe('insecure')
    g.isSecureContext = true
    delete g.PushManager
    expect(pushSupport()).toBe('browser')
    g.PushManager = function PushManager() {}
  })
})
