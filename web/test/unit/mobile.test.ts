import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { initMobile, mobileApp, sendFileToApp, setMobileSession, openExternal, downloadToApp, readMobileDownload, requestPushToken, confirmPushDevice, MobileFileTooLarge } from '../../src/lib/mobile'
import { clientKind } from '../../src/lib/desktop'
import { askLater, laterHides, LATER_MS, phonePushView, registerMobilePush, setMobilePushSession, usePhonePush } from '../../src/lib/mobile-push'
import { APPEARANCE_CAPABILITY, MAX_CHUNK_BYTES, MAX_FILE_BYTES, MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, type MobileConfig, type MobileMessage, type MobileReply, type PushPermission } from '../../../mobile/src/protocol'
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
