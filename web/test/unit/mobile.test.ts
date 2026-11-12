import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { initMobile, mobileApp, sendFileToApp, setAppBadge, setAppNav, setMobileSession, openExternal, openAppSettings, downloadToApp, readMobileDownload, requestPushToken, confirmPushDevice, MobileFileTooLarge, appSharesText, appPicksPhotos, pickPhotosFromApp } from '../../src/lib/mobile'
import { canShareText, shareText, SHARE_PHONE_QUERY } from '../../src/lib/share'
import { clientKind } from '../../src/lib/desktop'
import { askLater, laterHides, LATER_MS, OFF_HERE_PREFIX, phonePushView, registerMobilePush, setMobilePushSession, turnOffPhonePush, usePhonePush } from '../../src/lib/mobile-push'
import { clearLocalData } from '../../src/lib/localData'
import { initAppNav, resetAppNavForTest } from '../../src/lib/appNav'
import { OVERLAY_ENTRY_EVENT } from '../../src/lib/backCloses'
import { HISTORY_STEPS_EVENT } from '../../src/lib/historySteps'
import { APPEARANCE_CAPABILITY, BADGE_CAPABILITY, MAX_CHUNK_BYTES, MAX_FILE_BYTES, MAX_SHARE_TEXT, MOBILE_CAPABILITIES, NAV_CAPABILITY, PHOTO_PICK_CAPABILITY, PICK_CHUNK_BYTES, PUSH_CAPABILITY, PUSH_LABEL_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, SHARE_TEXT_CAPABILITY, type MobileConfig, type MobileMessage, type MobileReply, type PushPermission } from '../../../mobile/src/protocol'
const config: MobileConfig = { protocol: 1, appVersion: '0.2.2', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
const win = Object.assign(new EventTarget(), { self: null as unknown, top: null as unknown, mycelMobile: { ...config }, ReactNativeWebView: { postMessage: (_raw: string) => {} } })
win.self = win; win.top = win
const doc = new EventTarget()
const prior = new Map(['window', 'document', 'location'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
let messages: MobileMessage[] = []
let handler: (m: MobileMessage) => void
function reply(m: MobileMessage, over: Partial<MobileReply> = {}) {
  win.dispatchEvent(new CustomEvent('mycel:mobile', { detail: { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}), ...over } }))
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://team.example', href: 'https://team.example/' } })
  initMobile()
})
afterAll(() => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k) } })
beforeEach(() => {
  messages = []; win.top = win; win.mycelMobile = { ...config }
  handler = m => { if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: m.generation + 1 }) } else reply(m) }
  win.ReactNativeWebView.postMessage = raw => { const m = JSON.parse(raw) as MobileMessage; messages.push(m); handler(m) }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
})
test('only a compatible top-level native bridge signs in as mobile; ordinary browser stays web', () => {
  expect(mobileApp()?.protocol).toBe(1)
  expect(clientKind()).toBe('mobile')
  win.mycelMobile = { ...config, protocol: 0 } as unknown as MobileConfig
  expect(mobileApp()).toBeNull(); expect(clientKind()).toBe('web')
  win.mycelMobile = { ...config }; win.top = {}
  expect(mobileApp()).toBeNull()
})
test('multi-chunk transfer carries an exact hash and awaits each native ACK before sending the next', async () => {
  let first: MobileMessage | null = null
  handler = m => { if (m.type === 'file-chunk' && m.seq === 0) first = m; else reply(m) }
  const blob = new Blob([new Uint8Array(MAX_CHUNK_BYTES + 7).fill(42)], { type: 'application/octet-stream' })
  const sending = sendFileToApp(blob, '../../report.bin')
  for (let i = 0; i < 100 && !first; i++) await tick()
  expect(first).not.toBeNull()
  expect(messages.map(m => m.type)).toEqual(['file-begin', 'file-chunk'])
  reply(first!); await sending
  expect(messages.map(m => m.type)).toEqual(['file-begin', 'file-chunk', 'file-chunk', 'file-end'])
  const chunks = messages.filter((m): m is Extract<MobileMessage, { type: 'file-chunk' }> => m.type === 'file-chunk')
  const bytes = Buffer.concat(chunks.map(m => Buffer.from(m.b64, 'base64')))
  expect(bytes.length).toBe(blob.size)
  expect(messages[0]).toMatchObject({ size: blob.size, name: safeName(), sha256: createHash('sha256').update(bytes).digest('hex') })
})
function safeName() { return '_.._report.bin' }
test('forged acknowledgements cannot advance transfer; signing out cancels an in-flight transfer', async () => {
  let start: MobileMessage | null = null
  handler = m => { if (m.type === 'file-begin') start = m; else if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: win.mycelMobile.generation }) } }
  const sending = sendFileToApp(new Blob(['private']), 'a.txt')
  const rejection = sending.then(() => null, error => error)
  for (let i = 0; i < 20 && !start; i++) await tick()
  reply(start!, { nonce: 'e'.repeat(64) }); await tick()
  expect(messages.filter(m => m.type === 'file-chunk')).toHaveLength(0)
  setMobileSession('another-session')
  expect(await rejection).toBeInstanceOf(DOMException); await tick()
  expect(messages.filter(m => m.type === 'file-end')).toHaveLength(0)
})
test('OAuth only requests the allowlisted external endpoint and rejects arbitrary schemes', async () => {
  await openExternal('https://accounts.google.com/o/oauth2/v2/auth?state=opaque', { purpose: 'google-oauth' })
  expect(messages.at(-1)).toMatchObject({ type: 'external-open', purpose: 'google-oauth' })
  const count = messages.length
  await expect(openExternal('javascript:alert(1)', { purpose: 'google-oauth' })).rejects.toThrow()
  expect(messages).toHaveLength(count)
})

test('an operation requested before logout cannot resume under the next session after an await', async () => {
  const pendingFile = sendFileToApp(new Blob(['old-session']), 'old.txt').then(() => null, error => error)
  const pendingDownload = downloadToApp('https://team.example/api/files/old').then(() => null, error => error)
  const pendingOpen = openExternal('https://accounts.google.com/o/oauth2/v2/auth?state=old-session', { purpose: 'google-oauth' }).then(() => null, error => error)
  setMobileSession('session-after-logout')
  expect(await pendingOpen).toBeInstanceOf(DOMException)
  expect(await pendingFile).toBeInstanceOf(DOMException)
  expect(await pendingDownload).toBeInstanceOf(DOMException)
  await tick()
  expect(messages.filter(m => m.type === 'external-open')).toHaveLength(0)
})

// Synthetic stream reuses one allocation; no provider request or large resident fixture.
test('downloads enforce both declared and streaming byte limits and cancel oversized bodies', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })
  await expect(readMobileDownload(response)).rejects.toBeInstanceOf(MobileFileTooLarge)
  expect(cancelled).toBe(true)
  cancelled = false
  const chunk = new Uint8Array(1024 * 1024)
  let reads = 0
  const streaming = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(chunk) }, cancel() { cancelled = true } }), { headers: { 'content-length': '1' } })
  await expect(readMobileDownload(streaming)).rejects.toBeInstanceOf(MobileFileTooLarge)
  expect(cancelled).toBe(true)
  expect(reads).toBeLessThanOrEqual(52)
  expect(await (await readMobileDownload(new Response('exact body', { headers: { 'content-type': 'text/plain' } }))).text()).toBe('exact body')
})

test('push-token-v1: the page gets the device token only from an app that offers it, and learns denied vs unavailable', async () => {
  await expect(requestPushToken()).rejects.toThrow('push_unavailable')
  expect(messages.filter(m => m.type === 'push-token')).toHaveLength(0)
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY] }
  const token = { platform: 'ios' as const, token: 'cd'.repeat(32), environment: 'production' as const }
  handler = m => { if (m.type === 'push-token') reply(m, { push: token }); else reply(m) }
  expect(await requestPushToken()).toEqual(token)
  handler = m => reply(m, { ok: false, error: 'push_denied' })
  await expect(requestPushToken()).rejects.toThrow('push_denied')
  handler = m => reply(m, { push: { ...token, token: 'not-a-token' } })
  await expect(requestPushToken()).rejects.toThrow('push_unavailable')
})
test('a token requested before logout is not handed to the next session', async () => {
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY] }
  handler = m => { if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: m.generation + 1 }) } }
  const pending = requestPushToken().then(() => null, error => error)
  for (let i = 0; i < 20 && !messages.some(m => m.type === 'push-token'); i++) await tick()
  setMobileSession('session-after-logout-push')
  expect(await pending).toBeInstanceOf(DOMException)
})
test('push-registered goes only to an app that offers push-registered-v1; the first store build is not asked', async () => {
  // the build already at Apple: push-token-v1 but no push-registered-v1. It would never answer, so nothing is sent
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY] }
  const before = messages.length, started = Date.now()
  expect(await confirmPushDevice('device-1', 'k'.repeat(43))).toBe(false)
  expect(messages.length).toBe(before); expect(Date.now() - started).toBeLessThan(1000)
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
  expect(await confirmPushDevice('device-1', 'k'.repeat(43))).toBe(true)
  expect(messages.at(-1)).toMatchObject({ type: 'push-registered', deviceId: 'device-1', removeKey: 'k'.repeat(43) })
})

// The server and the phone's storage for the sign-in flow: GET /api/push says push is available, POST registers.
function pushServer(over: object = {}) {
  const realFetch = globalThis.fetch, calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push(`${method} ${new URL(url, 'https://team.example').pathname}`)
    if (url.endsWith('/api/push') && method === 'GET') return Response.json({ configured: false, enabled: false, publicKey: null, subscriptionId: null, native: { available: true, deviceId: null, gateway: 'push.example.test' }, optedOut: false, ...over })
    if (url.endsWith('/api/push/devices')) return Response.json({ id: 'device-9', removeKey: 'k'.repeat(43) })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const stored = new Map<string, string>(), priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) } })
  return { calls, stored, restore() {
    globalThis.fetch = realFetch; setMobilePushSession(null)
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else Reflect.deleteProperty(globalThis, 'localStorage')
  } }
}
const androidToken = { platform: 'android' as const, token: 'fcm:' + 'A'.repeat(140), environment: 'production' as const }
const withPermission = (permission: PushPermission) => (m: MobileMessage) => { if (m.type === 'push-permission') reply(m, { permission }); else if (m.type === 'push-token') reply(m, { push: androidToken }); else reply(m) }
const settle = async (until: () => boolean = () => false) => { for (let i = 0; i < 60 && !until(); i++) await tick() }
const today = [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY, PUSH_PERMISSION_CAPABILITY]

test('a session known before the app installed its bridge registers the phone once the bridge is ready, when the OS already said yes', async () => {
  const server = pushServer()
  try {
    handler = withPermission('granted')
    win.mycelMobile = undefined as unknown as MobileConfig // the page loaded, the bridge is not there yet
    setMobilePushSession('user:session-before-bridge')
    await settle()
    expect(server.calls).toHaveLength(0)
    win.mycelMobile = { ...config, capabilities: today }
    win.dispatchEvent(new Event('mycel:mobile-ready'))
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(server.calls).toEqual(['GET /api/push', 'POST /api/push/devices'])
    expect(messages.map(m => m.type)).toEqual(['push-permission', 'push-token', 'push-registered'])
    expect(usePhonePush.getState()).toMatchObject({ permission: 'granted', ask: false })
    win.dispatchEvent(new Event('mycel:mobile-ready')) // another page load of the same session: not again
    await settle()
    expect(server.calls).toHaveLength(2)
  } finally { server.restore() }
})

test('never the OS prompt by itself: not asked yet, the page shows its own question; only its button asks the OS', async () => {
  const server = pushServer()
  try {
    handler = withPermission('undetermined')
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:session-undetermined')
    await settle(() => usePhonePush.getState().ask)
    expect(usePhonePush.getState()).toMatchObject({ permission: 'undetermined', ask: true })
    expect(messages.map(m => m.type)).toEqual(['push-permission'])
    expect(server.calls).toEqual(['GET /api/push'])
    await registerMobilePush() // [알림 켜기]
    expect(messages.map(m => m.type)).toEqual(['push-permission', 'push-token', 'push-registered'])
    expect(usePhonePush.getState()).toMatchObject({ permission: 'granted', ask: false })
    expect(server.stored.get('mycel.phonePush.granted')).toBe('1')
  } finally { server.restore() }
})

test('store builds without push-permission-v1: the question until a token came once; then quiet re-registration', async () => {
  const server = pushServer()
  try {
    handler = withPermission('granted') // an old app never gets push-permission: its capability list lacks it
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    setMobilePushSession('user:old-build-1')
    await settle(() => usePhonePush.getState().ask)
    expect(usePhonePush.getState()).toMatchObject({ permission: null, ask: true })
    expect(messages).toHaveLength(0)
    await registerMobilePush()
    expect(messages.map(m => m.type)).toEqual(['push-token', 'push-registered'])
    messages = []
    setMobilePushSession('user:old-build-2') // the next sign-in on this phone: the OS said yes before
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(messages.map(m => m.type)).toEqual(['push-token', 'push-registered'])
    expect(usePhonePush.getState().ask).toBe(false)
  } finally { server.restore() }
})

test('a "no" in the OS prompt stands (Android may let the app ask once more), and Settings learns it', async () => {
  const server = pushServer()
  try {
    handler = m => { if (m.type === 'push-permission') reply(m, { permission: 'undetermined' }); else if (m.type === 'push-token') reply(m, { ok: false, error: 'push_denied' }); else reply(m) }
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:denies')
    await settle(() => usePhonePush.getState().ask)
    await expect(registerMobilePush()).rejects.toThrow('push_denied')
    expect(usePhonePush.getState()).toMatchObject({ permission: 'denied', ask: false })
    setMobilePushSession('user:denies-again')
    await settle(() => usePhonePush.getState().permission !== null)
    expect(usePhonePush.getState()).toMatchObject({ permission: 'denied', ask: false })
    // turned on in the phone's Settings: the OS says granted, the page registers on its own
    handler = withPermission('granted')
    win.dispatchEvent(new Event('mycel:mobile-foreground'))
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(usePhonePush.getState().permission).toBe('granted')
    expect(server.stored.has('mycel.phonePush.denied')).toBe(false)
  } finally { server.restore() }
})

test('no question when push is off on this server, the person turned it off, or the OS said no', async () => {
  for (const [over, permission] of [[{ native: { available: false, deviceId: null, gateway: null } }, 'undetermined'], [{ optedOut: true }, 'undetermined'], [{}, 'denied']] as const) {
    const server = pushServer(over)
    try {
      handler = withPermission(permission)
      win.mycelMobile = { ...config, capabilities: today }
      setMobilePushSession(`user:quiet-${JSON.stringify(over)}`)
      await settle(() => server.calls.length > 0 && (messages.length > 0 || !!(over as { native?: unknown }).native))
      await settle()
      expect(usePhonePush.getState().ask).toBe(false)
      expect(messages.filter(m => m.type === 'push-token')).toHaveLength(0)
    } finally { server.restore(); messages = [] }
  }
})

test('[나중에]: away for a week, then for good after the second time', () => {
  const now = Date.UTC(2026, 10, 5)
  expect(laterHides(null, now)).toBe(false)
  expect(laterHides(JSON.stringify({ n: 1, at: now }), now + LATER_MS - 1)).toBe(true)
  expect(laterHides(JSON.stringify({ n: 1, at: now }), now + LATER_MS)).toBe(false)
  expect(laterHides(JSON.stringify({ n: 2, at: now }), now + 365 * LATER_MS)).toBe(true)
  expect(laterHides('not json', now)).toBe(false)
  const server = pushServer()
  try {
    usePhonePush.setState({ ask: true })
    askLater(now); expect(usePhonePush.getState().ask).toBe(false)
    askLater(now + LATER_MS)
    expect(JSON.parse(server.stored.get('mycel.phonePush.later')!)).toEqual({ n: 2, at: now + LATER_MS })
  } finally { server.restore() }
})

test('appearance-v1: the page tells the app its look when the bridge is ready and when the theme changes', async () => {
  const root = { classList: { contains: (c: string) => c === 'dark' && dark } }
  let dark = true
  Object.defineProperty(doc, 'documentElement', { configurable: true, value: root })
  try {
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, APPEARANCE_CAPABILITY] }
    win.dispatchEvent(new Event('mycel:mobile-ready'))
    await settle(() => messages.some(m => m.type === 'appearance'))
    const looks = () => messages.filter(m => m.type === 'appearance').map(m => ({ dark: (m as { dark: boolean }).dark, system: (m as { system?: boolean }).system }))
    expect(looks()).toEqual([{ dark: true, system: true }])
    dark = false; win.dispatchEvent(new Event('mycel:theme'))
    await settle(() => looks().length > 1)
    expect(looks()).toEqual([{ dark: true, system: true }, { dark: false, system: true }])
    // a session reset (sign-in) right after the look was asked for: the look is sent again with the new generation
    messages = []
    setMobileSession('user:appearance-after-reset')
    await settle(() => messages.some(m => m.type === 'appearance'))
    expect(messages.map(m => m.type)).toEqual(['session-reset', 'appearance'])
    expect(messages[1]!.generation).toBe(messages[0]!.generation + 1)
    messages = []; win.mycelMobile = { ...config } // an app without it gets nothing
    win.dispatchEvent(new Event('mycel:theme')); await settle()
    expect(messages).toHaveLength(0)
  } finally { Reflect.deleteProperty(doc, 'documentElement') }
})

test('nav-v1: the page tells the app where Back goes when it changes, once per bridge, and again after a reset', async () => {
  const navs = () => messages.filter(m => m.type === 'nav').map(m => ({ canGoBack: (m as { canGoBack: boolean }).canGoBack, home: (m as { home?: boolean }).home }))
  // an app without nav-v1 hears nothing (an older build would never answer)
  setAppNav({ canGoBack: true, home: true }); await settle()
  expect(navs()).toEqual([])
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, NAV_CAPABILITY] }
  // the bridge comes: the latest the page worked out
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle(() => navs().length > 0)
  expect(navs()).toEqual([{ canGoBack: true, home: true }])
  expect(messages.at(-1)).toMatchObject({ v: 1, nonce: config.nonce, generation: config.generation })
  // the same again is not sent; a change is
  setAppNav({ canGoBack: true, home: true }); await settle()
  setAppNav({ canGoBack: false, home: false }); await settle(() => navs().length > 1)
  expect(navs()).toEqual([{ canGoBack: true, home: true }, { canGoBack: false, home: false }])
  // a reset (a sign-in) fences the old generation: sent again after it, with the new one
  messages = []
  setMobileSession('user:nav-after-reset')
  await settle(() => navs().length > 0)
  expect(messages.map(m => m.type)).toEqual(['session-reset', 'nav'])
  expect(messages[1]!.generation).toBe(messages[0]!.generation + 1)
  // a new bridge (another nonce: the app installed it again) hears it again
  messages = []
  win.mycelMobile = { ...win.mycelMobile, nonce: 'd'.repeat(64) }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle(() => navs().length > 0)
  expect(navs()).toEqual([{ canGoBack: false, home: false }])
  // the app did not take it: the same is sent again next time (not skipped as heard)
  handler = m => reply(m, m.type === 'nav' ? { ok: false, error: 'mobile_operation_failed' } : {})
  setAppNav({ canGoBack: true, home: false }); await settle(() => navs().length > 1)
  handler = m => reply(m)
  await tick()
  setAppNav({ canGoBack: true, home: false }); await settle(() => navs().length > 2)
  expect(navs().slice(1)).toEqual([{ canGoBack: true, home: false }, { canGoBack: true, home: false }])
})

test('badge-v1: the icon gets the page\'s number when it changes, when the bridge comes, and again at every foreground; 0 at sign-out', async () => {
  const badges = () => messages.filter(m => m.type === 'badge').map(m => (m as { count: number }).count)
  // an app without badge-v1 hears nothing
  setAppBadge(3); await settle()
  expect(badges()).toEqual([])
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, BADGE_CAPABILITY] }
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle(() => badges().length > 0)
  expect(badges()).toEqual([3])
  // the same again is not sent; a change is; a whole number from 0 to 9999 only
  setAppBadge(3); await settle()
  setAppBadge(12_345.7); await settle(() => badges().length > 1)
  setAppBadge(-2); await settle(() => badges().length > 2)
  expect(badges()).toEqual([3, 9999, 0])
  // the app comes to the foreground: sent again, even unchanged (a push may have set the server's number meanwhile)
  setAppBadge(2); await settle(() => badges().length > 3)
  win.dispatchEvent(new Event('mycel:mobile-foreground'))
  await settle(() => badges().length > 4)
  expect(badges()).toEqual([3, 9999, 0, 2, 2])
  // the message carries a number and nothing else
  expect(Object.keys(messages.filter(m => m.type === 'badge').at(-1)!).sort()).toEqual(['count', 'generation', 'id', 'nonce', 'type', 'v'])
  // another session: the last one's number is not sent again; 0 until this page's count is worked out
  setMobileSession('user:badge'); await settle(() => messages.some(m => m.type === 'session-reset'))
  await settle(() => badges().length > 5)
  expect(badges().at(-1)).toBe(0)
  // signed out: the app clears the icon itself; the last person's number is never sent again after the reset, only 0
  messages = []
  setMobileSession(null, true)
  await settle(() => badges().length > 0)
  expect(messages.map(m => m.type)).toEqual(['session-reset', 'badge'])
  expect(messages[0]).toMatchObject({ signedOut: true })
  expect(badges()).toEqual([0])
})

test('nav-v1: the page works out where Back goes from its history, and sends it after Back, an overlay or a step', async () => {
  const state: { current: unknown } = { current: null }
  const extra = { history: { get state() { return state.current } }, location: { pathname: '/rooms' }, matchMedia: (q: string) => ({ matches: q.includes('max-width'), addEventListener() {} }) }
  Object.assign(win, extra)
  try {
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, NAV_CAPABILITY] }
    resetAppNavForTest(); initAppNav()
    const last = () => messages.filter(m => m.type === 'nav').at(-1) as { canGoBack: boolean; home: boolean } | undefined
    // the 대화 tab's root: nothing under it, not the start tab
    state.current = { idx: 2, key: 'a', scr: { tab: 'chats', sid: 's', base: 2, root: { k: 'a', p: '/rooms' }, trail: [{ k: 'a', p: '/rooms' }] } }
    win.dispatchEvent(new Event('popstate'))
    await settle(() => !!last())
    expect(last()).toMatchObject({ canGoBack: false, home: false })
    // a sheet opened over it: Back closes it
    state.current = { ...(state.current as object), mycelOverlay: 7, mycelOverlayDepth: 1 }
    win.dispatchEvent(new Event(OVERLAY_ENTRY_EVENT))
    await settle(() => last()?.canGoBack === true)
    expect(last()).toMatchObject({ canGoBack: true, home: false })
    // a room above the list (the end of a step of the history)
    state.current = { idx: 3, key: 'b', scr: { tab: 'chats', sid: 's', base: 2, root: { k: 'a', p: '/rooms' }, trail: [{ k: 'a', p: '/rooms' }, { k: 'b', p: '/rooms/r1' }] } }
    win.dispatchEvent(new CustomEvent(HISTORY_STEPS_EVENT, { detail: { stepping: false } }))
    await settle(() => last()?.canGoBack === true && messages.filter(m => m.type === 'nav').length > 2)
    expect(last()).toMatchObject({ canGoBack: true, home: false })
  } finally {
    for (const k of Object.keys(extra)) Reflect.deleteProperty(win, k)
    resetAppNavForTest()
  }
})

test("Settings' switch off for this phone is one person's: not registered again for them by itself, another person on the phone is, and signing out forgets it", async () => {
  const server = pushServer({ enabled: true, native: { available: true, deviceId: 'device-1', gateway: 'push.example.test' } })
  const pushFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') { server.calls.push(`DELETE ${new URL(String(input), 'https://team.example').pathname}`); return new Response(null, { status: 204 }) }
    return pushFetch(input, init)
  }) as typeof fetch
  const registered = () => messages.filter((m) => m.type === 'push-token').length
  try {
    handler = withPermission('granted')
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('alice:s1')
    await settle(() => messages.some((m) => m.type === 'push-registered'))
    expect(registered()).toBe(1)
    // Alice turns this phone off in Settings
    await turnOffPhonePush('device-1')
    expect(server.calls).toContain('DELETE /api/push/devices/device-1')
    expect(server.stored.get(`${OFF_HERE_PREFIX}alice`)).toBe('1')
    // the app starts again for her: not registered by itself, and no question
    messages = []
    setMobilePushSession('alice:s2')
    await settle()
    await settle()
    expect(registered()).toBe(0)
    expect(usePhonePush.getState().ask).toBe(false)
    // Bob signs in on the same phone: his push is not off
    setMobilePushSession('bob:s3')
    await settle(() => messages.some((m) => m.type === 'push-registered'))
    expect(registered()).toBe(1)
    // signing out forgets every person's choice on this phone
    const store = { getItem: (k: string) => server.stored.get(k) ?? null, setItem: (k: string, v: string) => void server.stored.set(k, v), removeItem: (k: string) => void server.stored.delete(k), key: (i: number) => [...server.stored.keys()][i] ?? null, get length() { return server.stored.size } }
    clearLocalData(store)
    expect([...server.stored.keys()].filter((k) => k.startsWith(OFF_HERE_PREFIX))).toEqual([])
    expect(server.stored.get('mycel.phonePush.granted')).toBe('1') // the phone's own answers stay
  } finally { server.restore() }
})

test('store builds 1 and 2: a session that already has a registered phone gets no question and registers again quietly', async () => {
  const server = pushServer({ enabled: true, native: { available: true, deviceId: 'device-1', gateway: 'push.example.test' } })
  try {
    handler = withPermission('granted') // an old app never gets push-permission
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    setMobilePushSession('user:old-build-registered')
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(usePhonePush.getState()).toMatchObject({ permission: 'granted', ask: false })
    expect(messages.map(m => m.type)).toEqual(['push-token', 'push-registered'])
    expect(server.stored.get('mycel.phonePush.granted')).toBe('1') // the next sign-in registers quietly too
  } finally { server.restore() }
})

test('store builds 1 and 2 after a "no": Settings keeps [알림 켜기]; once the phone allows it, it registers', async () => {
  expect(phonePushView({ permission: 'denied', on: false, canOpenSettings: false })).toEqual({ status: 'push.deniedApp', action: 'enable' })
  expect(phonePushView({ permission: 'denied', on: false, canOpenSettings: true })).toEqual({ status: 'push.deniedPhone', action: 'open-settings' })
  expect(phonePushView({ permission: 'granted', on: true, canOpenSettings: false })).toEqual({ status: 'push.on', action: 'disable' })
  expect(phonePushView({ permission: null, on: false, canOpenSettings: false })).toEqual({ status: 'push.off', action: 'enable' })
  const server = pushServer()
  try {
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    handler = m => { if (m.type === 'push-token') reply(m, { ok: false, error: 'push_denied' }); else reply(m) }
    setMobilePushSession('user:old-build-denied')
    await settle(() => usePhonePush.getState().ask)
    await expect(registerMobilePush()).rejects.toThrow('push_denied') // Don't Allow
    expect(usePhonePush.getState().permission).toBe('denied')
    handler = withPermission('granted') // turned on in the phone's Settings; the button asks again, no prompt
    await registerMobilePush()
    expect(usePhonePush.getState().permission).toBe('granted')
    expect(server.stored.has('mycel.phonePush.denied')).toBe(false)
  } finally { server.restore() }
})

test('one registration at a time: coming back from the OS prompt does not register the phone twice', async () => {
  const server = pushServer()
  try {
    let answer!: () => void
    handler = m => {
      if (m.type === 'push-permission') reply(m, { permission: 'undetermined' })
      else if (m.type === 'push-token') answer = () => reply(m, { push: androidToken }) // the OS prompt is up
      else reply(m)
    }
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:one-at-a-time')
    await settle(() => usePhonePush.getState().ask)
    const first = registerMobilePush() // [알림 켜기]
    await settle(() => messages.some(m => m.type === 'push-token'))
    handler = m => { if (m.type === 'push-permission') reply(m, { permission: 'granted' }); else if (m.type === 'push-token') reply(m, { push: androidToken }); else reply(m) }
    win.dispatchEvent(new Event('mycel:mobile-foreground')) // the app is back while the first one still waits
    const second = registerMobilePush()
    await settle(() => messages.filter(m => m.type === 'push-permission').length > 1)
    answer()
    expect(await first).toBe(await second)
    await settle(() => messages.some(m => m.type === 'push-registered'))
    await settle()
    expect(messages.filter(m => m.type === 'push-token')).toHaveLength(1)
    expect(server.calls.filter(c => c === 'POST /api/push/devices')).toHaveLength(1)
  } finally { server.restore() }
})

test('a build without push (Android without Firebase): the question goes away after its button', async () => {
  const server = pushServer()
  try {
    handler = m => { if (m.type === 'push-token') reply(m, { ok: false, error: 'push_unavailable' }); else reply(m) }
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    setMobilePushSession('user:no-firebase')
    await settle(() => usePhonePush.getState().ask)
    await expect(registerMobilePush()).rejects.toThrow('push_unavailable')
    expect(usePhonePush.getState().ask).toBe(false)
  } finally { server.restore() }
})

test('store builds 1 and 2: a registered session does not override a "no" this phone gave (no unasked OS prompt)', async () => {
  const server = pushServer({ enabled: true, native: { available: true, deviceId: 'device-1', gateway: 'push.example.test' } })
  try {
    server.stored.set('mycel.phonePush.denied', '1')
    handler = withPermission('granted')
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
    setMobilePushSession('user:old-build-registered-then-denied')
    await settle(() => usePhonePush.getState().permission !== null)
    await settle()
    expect(usePhonePush.getState()).toMatchObject({ permission: 'denied', ask: false })
    expect(messages.filter(m => m.type === 'push-token')).toHaveLength(0)
    expect(server.stored.has('mycel.phonePush.granted')).toBe(false)
  } finally { server.restore() }
})

test('a first check that got no answer (a busy phone) is tried again; the question then shows', async () => {
  const server = pushServer()
  try {
    win.mycelMobile = { ...config, capabilities: today }
    handler = m => { if (m.type === 'push-permission') reply(m, { ok: false, error: 'mobile_operation_failed' }); else reply(m) }
    setMobilePushSession('user:busy-phone')
    await settle(() => messages.some(m => m.type === 'push-permission'))
    await settle()
    expect(usePhonePush.getState().ask).toBe(false)
    handler = withPermission('undetermined')
    win.dispatchEvent(new Event('mycel:mobile-foreground')) // or the next bridge-ready, or the retry timer
    await settle(() => usePhonePush.getState().ask)
    expect(usePhonePush.getState()).toMatchObject({ permission: 'undetermined', ask: true })
    expect(messages.filter(m => m.type === 'push-permission')).toHaveLength(2)
  } finally { server.restore() }
})

test('open-settings does not wait for the app: no error when the person stays in the phone\'s Settings', async () => {
  win.mycelMobile = { ...config, capabilities: today }
  handler = m => { if (m.type !== 'open-settings') reply(m) } // the app answers only when it is back
  const started = Date.now()
  await openAppSettings() // resolves at once and never rejects later
  expect(Date.now() - started).toBeLessThan(1000)
  expect(messages.some(m => m.type === 'open-settings')).toBe(true)
})

test('notifications turned off in the OS: a registered device does not make it "on", and does not override the "no"', async () => {
  expect(phonePushView({ permission: 'undetermined', on: true, canOpenSettings: true })).toEqual({ status: 'push.off', action: 'enable' })
  const server = pushServer({ enabled: true, native: { available: true, deviceId: 'device-1', gateway: 'push.example.test' } })
  try {
    handler = withPermission('denied')
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:os-turned-off')
    await settle(() => usePhonePush.getState().permission !== null)
    await settle()
    expect(usePhonePush.getState()).toMatchObject({ permission: 'denied', ask: false })
    expect(messages.filter(m => m.type === 'push-token')).toHaveLength(0)
    expect(phonePushView({ permission: 'denied', on: true, canOpenSettings: true })).toEqual({ status: 'push.deniedPhone', action: 'open-settings' })
  } finally { server.restore() }
})

test('push-label-v1: the page registers the hash of the app\'s label key with the token; the key never crosses', async () => {
  const realFetch = globalThis.fetch, bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/push') && (init?.method ?? 'GET') === 'GET') return Response.json({ configured: false, enabled: false, publicKey: null, subscriptionId: null, native: { available: true, deviceId: null, gateway: 'push.example.test' }, optedOut: false })
    if (url.endsWith('/api/push/devices')) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ id: 'device-7', removeKey: 'k'.repeat(43) }) }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const labelHash = 'a'.repeat(64)
  const iosToken = { platform: 'ios' as const, token: 'ab'.repeat(32), environment: 'production' as const }
  try {
    handler = m => { if (m.type === 'push-permission') reply(m, { permission: 'granted' }); else if (m.type === 'push-token') reply(m, { push: iosToken, labelHash }); else reply(m) }
    win.mycelMobile = { ...config, capabilities: [...today, PUSH_LABEL_CAPABILITY] }
    setMobilePushSession('user:labels-1')
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(bodies.at(-1)).toEqual({ consent: true, ...iosToken, labelHash })
    expect(messages.find(m => m.type === 'push-registered')).not.toHaveProperty('labelKey')
    // an app without push-label-v1 (or anything that is no hash) registers without one
    messages = []
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:labels-2')
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(bodies.at(-1)).toEqual({ consent: true, ...iosToken })
    messages = []
    handler = m => { if (m.type === 'push-permission') reply(m, { permission: 'granted' }); else if (m.type === 'push-token') reply(m, { push: iosToken, labelHash: 'not-a-hash' }); else reply(m) }
    win.mycelMobile = { ...config, capabilities: [...today, PUSH_LABEL_CAPABILITY] }
    setMobilePushSession('user:labels-3')
    await settle(() => messages.some(m => m.type === 'push-registered'))
    expect(bodies.at(-1)).toEqual({ consent: true, ...iosToken })
  } finally { globalThis.fetch = realFetch; setMobilePushSession(null) }
})

test('the app hears signedOut on a sign-out, one person after another, and a sign-in page at a cold start; not on loading or a reload', async () => {
  const resets = () => messages.filter((m): m is Extract<MobileMessage, { type: 'session-reset' }> => m.type === 'session-reset').map(m => m.signedOut === true)
  const step = async (key: string | null, signedOut = false) => { setMobileSession(key, signedOut); await settle() }
  await step('user:a')
  messages = []
  await step(null) // loading or an error screen: no sign-out
  await step('user:a') // the same person again (a reload of a signed-in page)
  expect(resets()).toEqual([false, false])
  messages = []
  await step(null, true) // signed out
  await step(null, true) // told once
  expect(resets()).toEqual([true])
  messages = []
  await step('user:b')
  await step('user:c') // another person's session took this one's place
  expect(resets()).toEqual([false, true])
  // a cold start on the sign-in page: the page knows before the bridge is there; the app hears it once the bridge is ready
  messages = []
  const bridge = win.mycelMobile
  win.mycelMobile = undefined as unknown as MobileConfig
  await step(null, true)
  expect(resets()).toEqual([])
  win.mycelMobile = bridge
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle(() => resets().length > 0)
  expect(resets()).toEqual([true])
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle()
  expect(resets()).toEqual([true])
  // a sign-out reset the app never answered (dropped, a new bridge) is told again at the next bridge-ready
  await step('user:d')
  messages = []
  const replying = handler
  handler = () => {}
  setMobileSession(null, true)
  await settle(() => resets().length > 0)
  handler = replying
  win.dispatchEvent(new Event('mycel:mobile-ready'))
  await settle(() => resets().length > 1)
  expect(resets()).toEqual([true, true])
})

test('a registration answered after the session changed does not hand that device to the app', async () => {
  const realFetch = globalThis.fetch
  let answer!: () => void
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/push') && (init?.method ?? 'GET') === 'GET') return Response.json({ configured: false, enabled: false, publicKey: null, subscriptionId: null, native: { available: true, deviceId: null, gateway: 'push.example.test' }, optedOut: false })
    if (url.endsWith('/api/push/devices')) { await new Promise<void>(r => { answer = r }); return Response.json({ id: 'device-late', removeKey: 'k'.repeat(43) }) }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  try {
    handler = withPermission('granted')
    win.mycelMobile = { ...config, capabilities: today }
    setMobilePushSession('user:late-1')
    await settle(() => typeof answer === 'function')
    setMobilePushSession('user:late-2')
    answer()
    await settle()
    expect(messages.find(m => m.type === 'push-registered' && m.deviceId === 'device-late')).toBeUndefined()
  } finally { globalThis.fetch = realFetch; setMobilePushSession(null) }
})

test('the invite to the phone\'s share sheet (QA TC-271): the app\'s own (share-text-v1), else navigator.share, else none (the page points at its copy button); never on a computer', async () => {
  const w = win as unknown as { matchMedia?: (q: string) => { matches: boolean } }
  const media = w.matchMedia
  const nav = globalThis.navigator as unknown as { share?: unknown }
  const had = Object.getOwnPropertyDescriptor(nav, 'share')
  const setShare = (fn: ((d: unknown) => Promise<void>) | undefined) => Object.defineProperty(nav, 'share', { configurable: true, writable: true, value: fn })
  w.matchMedia = (q: string) => ({ matches: q === SHARE_PHONE_QUERY })
  try {
    // today's Android app: no capability, no navigator.share: no sheet (the page copies)
    setShare(undefined)
    expect(appSharesText()).toBe(false)
    expect(canShareText()).toBe(false)
    expect(await shareText('초대해요')).toBe('failed')
    // the iPhone app's WebView and phone browsers: navigator.share; closed is no failure, a refusal is
    const shared: unknown[] = []
    setShare(async (d) => { shared.push(d) })
    expect(canShareText()).toBe(true)
    expect(await shareText('초대해요')).toBe('shared')
    expect(shared).toEqual([{ text: '초대해요' }])
    setShare(async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) })
    expect(await shareText('초대해요')).toBe('cancelled')
    setShare(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) })
    expect(await shareText('초대해요')).toBe('failed')
    // an app with share-text-v1: its own sheet first, through the bridge
    setShare(undefined)
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, SHARE_TEXT_CAPABILITY] }
    expect(appSharesText()).toBe(true)
    expect(canShareText()).toBe(true)
    expect(await shareText('초대해요\nhttps://team.example/join#t=x')).toBe('shared')
    expect(messages.filter((m) => m.type === 'share-text')).toEqual([expect.objectContaining({ type: 'share-text', text: '초대해요\nhttps://team.example/join#t=x' })])
    // the app could not: no second sheet after its answer (the press is spent, WebKit would refuse it): the page points
    // at its copy button
    handler = (m) => { if (m.type === 'share-text') reply(m, { ok: false, error: 'mobile_operation_failed' }); else reply(m) }
    expect(await shareText('초대해요')).toBe('failed')
    let browser = 0
    setShare(async () => { browser++ })
    expect(await shareText('초대해요')).toBe('failed')
    expect(browser).toBe(0)
    // too long for the bridge: never sent
    const before = messages.length
    setShare(undefined)
    expect(await shareText('x'.repeat(MAX_SHARE_TEXT + 1))).toBe('failed')
    expect(messages.length).toBe(before)
    // a computer keeps its copy button
    w.matchMedia = () => ({ matches: false })
    expect(canShareText()).toBe(false)
    // Settings › Apps' send-to-computer row (QA TC-089) knows it is on a phone or tablet: any width (a phone held
    // sideways, a tablet), and the browser's sheet gets the link as a link (AirDrop opens it on a Mac)
    expect(canShareText({ anyWidth: true })).toBe(true)
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES] }
    const links: unknown[] = []
    setShare(async (d) => { links.push(d) })
    expect(canShareText({ anyWidth: true })).toBe(true)
    expect(await shareText('https://team.example/settings/apps', { url: true, title: 'Desktop app' })).toBe('shared')
    expect(links).toEqual([{ url: 'https://team.example/settings/apps', title: 'Desktop app' }])
    setShare(undefined)
    expect(canShareText({ anyWidth: true })).toBe(false)
    win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, SHARE_TEXT_CAPABILITY] }
    handler = (m) => reply(m)
    expect(canShareText({ anyWidth: true })).toBe(true)
    expect(await shareText('https://team.example/settings/apps', { url: true })).toBe('shared')
    expect(messages.filter((m) => m.type === 'share-text').at(-1)).toEqual(expect.objectContaining({ text: 'https://team.example/settings/apps' }))
  } finally {
    w.matchMedia = media
    if (had) Object.defineProperty(nav, 'share', had); else Reflect.deleteProperty(nav, 'share')
  }
})

/** photo-pick-v1 (QA TC-251): an app that answers a pick with these files and their bytes, chunk by chunk */
function photoApp(files: { name: string; mime: string; bytes: Buffer }[], over: (m: MobileMessage) => Partial<MobileReply> | null = () => ({})) {
  win.mycelMobile = { ...config, capabilities: [...MOBILE_CAPABILITIES, PHOTO_PICK_CAPABILITY] }
  handler = (m) => {
    const extra = over(m)
    if (extra === null) return
    if (m.type === 'photo-pick') reply(m, { files: files.map((f) => ({ name: f.name, mime: f.mime, size: f.bytes.length })), tooBig: [], ...extra })
    else if (m.type === 'photo-chunk') reply(m, { b64: files[m.index]!.bytes.subarray(m.offset, m.offset + PICK_CHUNK_BYTES).toString('base64'), ...extra })
    else if (m.type === 'session-reset') { win.mycelMobile = { ...win.mycelMobile, generation: m.generation + 1 }; reply(m, { nextGeneration: m.generation + 1 }) }
    else reply(m, extra)
  }
}
const fill = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255))

test('photo-pick-v1: only an app that offers it opens its picker; an older app keeps the input and hears nothing', async () => {
  expect(appPicksPhotos()).toBe(false)
  await expect(pickPhotosFromApp(3)).rejects.toThrow('mobile_unavailable')
  expect(messages.some((m) => m.type.startsWith('photo-'))).toBe(false)
  photoApp([])
  expect(appPicksPhotos()).toBe(true)
  // a browser: no app at all
  win.top = {}
  expect(appPicksPhotos()).toBe(false)
})

test('photo-pick-v1: the picked files arrive whole, in order, with their names and types; done lets the app delete its copies', async () => {
  const photo = fill(PICK_CHUNK_BYTES + 3, 1), clip = fill(9, 2)
  photoApp([{ name: 'IMG_0001.jpg', mime: 'image/jpeg', bytes: photo }, { name: 'clip.mov', mime: 'video/quicktime', bytes: clip }])
  const { files, tooBig } = await pickPhotosFromApp(25)
  expect(tooBig).toEqual([])
  expect(files.map((f) => [f.name, f.type, f.size])).toEqual([['IMG_0001.jpg', 'image/jpeg', photo.length], ['clip.mov', 'video/quicktime', 9]])
  expect(Buffer.from(await files[0]!.arrayBuffer()).equals(photo)).toBe(true)
  expect(Buffer.from(await files[1]!.arrayBuffer()).equals(clip)).toBe(true)
  const sent = messages.filter((m) => m.type.startsWith('photo-'))
  // the limit is clamped to what one message takes; the chunks go one by one, in order, under the pick's id
  expect(sent[0]).toMatchObject({ type: 'photo-pick', limit: 20 })
  expect(sent.slice(1).map((m) => m.type === 'photo-chunk' ? [m.seq, m.index, m.offset] : m.type)).toEqual([[0, 0, 0], [1, 0, PICK_CHUNK_BYTES], [2, 1, 0], 'photo-done'])
  expect(new Set(sent.map((m) => m.id)).size).toBe(1)
})

test('photo-pick-v1: cancelled is an empty answer with no error; what the app left out for its size is named', async () => {
  photoApp([])
  expect(await pickPhotosFromApp(1)).toEqual({ files: [], tooBig: [] })
  // nothing to delete: no done after an empty answer
  expect(messages.filter((m) => m.type.startsWith('photo-')).map((m) => m.type)).toEqual(['photo-pick'])
  photoApp([], (m) => (m.type === 'photo-pick' ? { tooBig: ['long-video.mov'] } : {}))
  expect(await pickPhotosFromApp(1)).toEqual({ files: [], tooBig: ['long-video.mov'] })
})

test('photo-pick-v1: a forged answer (a path, another type, too many, too big) or a chunk of the wrong length is refused', async () => {
  const ok = { name: 'a.jpg', mime: 'image/jpeg', size: 4 }
  for (const files of [[{ ...ok, name: '../../a.jpg' }], [{ ...ok, mime: 'text/html' }], [ok, ok], [{ ...ok, size: MAX_FILE_BYTES + 1 }], 'file:///private/a.jpg']) {
    photoApp([], (m) => (m.type === 'photo-pick' ? { files: files as never } : {}))
    messages = []
    await expect(pickPhotosFromApp(1)).rejects.toThrow('mobile_protocol_mismatch')
    // the app is told to drop its copies
    expect(messages.at(-1)?.type).toBe('photo-done')
  }
  photoApp([{ name: 'a.jpg', mime: 'image/jpeg', bytes: fill(4, 3) }], (m) => (m.type === 'photo-chunk' ? { b64: fill(5, 3).toString('base64') } : {}))
  await expect(pickPhotosFromApp(1)).rejects.toThrow('mobile_protocol_mismatch')
  photoApp([{ name: 'a.jpg', mime: 'image/jpeg', bytes: fill(4, 3) }], (m) => (m.type === 'photo-chunk' ? { b64: undefined } : {}))
  await expect(pickPhotosFromApp(1)).rejects.toThrow('mobile_protocol_mismatch')
  // a refusal by the phone is named (a short message); any other failure is generic
  photoApp([], (m) => (m.type === 'photo-pick' ? { ok: false, error: 'photo_denied' } : {}))
  await expect(pickPhotosFromApp(1)).rejects.toThrow('photo_denied')
  photoApp([], (m) => (m.type === 'photo-pick' ? { ok: false, error: '/var/mobile/secret' } : {}))
  await expect(pickPhotosFromApp(1)).rejects.toThrow('mobile_operation_failed')
})

test('photo-pick-v1: a sign-out or another person during the pick stops it; no chunk is asked for under the next session', async () => {
  let picked: MobileMessage | null = null
  photoApp([{ name: 'a.jpg', mime: 'image/jpeg', bytes: fill(PICK_CHUNK_BYTES * 2, 4) }], (m) => {
    if (m.type === 'photo-pick') { picked = m; return null }
    return {}
  })
  const picking = pickPhotosFromApp(1).then(() => null, (e) => e)
  for (let i = 0; i < 20 && !picked; i++) await tick()
  setMobileSession(`photo-person-${Date.now()}`)
  // the answer comes late, for the old document state
  reply(picked!, { files: [{ name: 'a.jpg', mime: 'image/jpeg', size: PICK_CHUNK_BYTES * 2 }], tooBig: [] })
  const error = await picking
  expect(error).toBeInstanceOf(DOMException)
  expect((error as DOMException).name).toBe('AbortError')
  await tick()
  expect(messages.filter((m) => m.type === 'photo-chunk')).toHaveLength(0)
  // a forged reply (another nonce) does not answer the pick either
  let second: MobileMessage | null = null
  photoApp([{ name: 'b.jpg', mime: 'image/jpeg', bytes: fill(3, 5) }], (m) => {
    if (m.type === 'photo-pick' && !second) { second = m; return null }
    return {}
  })
  const again = pickPhotosFromApp(1)
  for (let i = 0; i < 20 && !second; i++) await tick()
  reply(second!, { nonce: 'f'.repeat(64), files: [{ name: 'evil.jpg', mime: 'image/jpeg', size: 1 }], tooBig: [] })
  await tick()
  expect(messages.filter((m) => m.type === 'photo-chunk')).toHaveLength(0)
  reply(second!, { files: [{ name: 'b.jpg', mime: 'image/jpeg', size: 3 }], tooBig: [] })
  expect((await again).files.map((f) => f.name)).toEqual(['b.jpg'])
})
