// A new message in the conversation on screen, in a focused window, only appears (docs/DECISIONS.md "화면에 연 대화는
// 울리지 않는다"): no chime, no notification. Another conversation on screen: it rings as before. In the desktop app the
// window's focus is the app's word (DesktopBridge.focus), not the page's own: after the app starts with a team, and while
// the in-app browser has the keyboard, the team page has no focus of its own though its window is focused (the owner's
// report: the desktop app open on that conversation, and the sound still played).
// Web Audio, Notification, the service worker's showNotification and the desktop bridge are stand-ins: the test counts
// the chime's notes and the notifications asked for.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

const OPEN = '019a5f00-0000-7000-8000-00000000c001'
const OTHER = '019a5f00-0000-7000-8000-00000000c002'
const BEN = { id: 'ben', name: 'Ben' }
const ZOE = { id: 'zoe', name: 'Zoe' }
const rooms: MockRoomSpec[] = [
  { id: OPEN, kind: 'dm', name: null, peers: [BEN], ago: 5, last: '안녕하세요' },
  { id: OTHER, kind: 'dm', name: null, peers: [ZOE], ago: 9, last: '내일 봬요' },
]

/** Installed before the app's scripts: a Web Audio that counts the notes started, Notification and showNotification that
 * count what they are asked to show, and (desktop) a desktop bridge whose window focus the test sets, with the page's
 * own focus `pageFocus`. */
function stubs(o: { desktop: boolean; pageFocus: boolean }) {
  const w = window as unknown as Record<string, unknown>
  const notes: number[] = [], shown: string[] = []
  w.__notes = notes
  w.__shown = shown
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} })
  class FakeContext {
    state = 'suspended'
    currentTime = 0
    destination = {}
    async resume() { this.state = 'running' }
    async suspend() { this.state = 'suspended' }
    createGain() { return { gain: param(), connect() {} } }
    createOscillator() { const frequency = param(); return { type: '', frequency, connect() {}, start() { notes.push(frequency.value) }, stop() {} } }
    createBuffer() { return {} }
    createBufferSource() { return { buffer: null, connect() {}, start() {} } }
  }
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext })
  class FakeNotification {
    static permission = 'granted'
    static requestPermission = async () => 'granted'
    constructor(title: string) { shown.push(`page:${title}`) }
    close() {}
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification })
  if (typeof ServiceWorkerRegistration !== 'undefined') ServiceWorkerRegistration.prototype.showNotification = async function (title: string) { shown.push(`worker:${title}`) }
  if (!o.desktop) return
  // the page's own focus, as the desktop app's team page has it (none after a start, or with the in-app browser in use)
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => o.pageFocus })
  const listeners: ((f: boolean) => void)[] = []
  const d = { focused: true }
  w.__setWindowFocus = (f: boolean) => { d.focused = f; for (const l of listeners) l(f) }
  const noop = () => {}
  w.mycelDesktop = {
    bridgeVersion: 1,
    appVersion: '0.5.0',
    platform: 'darwin',
    browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
    pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
    connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
    // the main process shows it only while the window is not focused (desktop/src/common/notify.ts): counted when it would
    notify: (n: { title: string }) => { if (!d.focused) shown.push(`desktop:${n.title}`) },
    focus: { get: async () => d.focused, onChange: (cb: (f: boolean) => void) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) } },
    openTeams: noop,
  }
}

/** A message from the other person of `roomId`, as the server sends it live (with my notice: a DM's message). */
let seq = 10
async function arrives(page: Page, roomId: string, from: { id: string; name: string }) {
  const n = ++seq
  const message = { id: `019a5f00-0000-7000-8000-${String(700 + n).padStart(12, '0')}`, roomId, seq: n, authorKind: 'user', author: from, askedBy: null, visibility: 'room', body: `새 메시지 ${n}`, replyTo: null, mentions: [], files: [], createdAt: new Date().toISOString(), editedAt: null, deletedAt: null }
  const r = await page.request.post('/__test/publish', { data: { event: { type: 'room.message', data: { roomId, message, notice: 'room.dm' } } } })
  expect(r.ok()).toBeTruthy()
}

const notes = (page: Page) => page.evaluate(() => ((window as unknown as { __notes: number[] }).__notes).length)
const shown = (page: Page) => page.evaluate(() => (window as unknown as { __shown: string[] }).__shown)
/** well past the sound's wait for a read elsewhere (store/roomSound.ts SETTLE_MS, 1.5 s) and the notification's
 * (NOTIFY_DELAY_MS, 3 s) */
const settle = (page: Page) => page.waitForTimeout(4500)

async function openRoom(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`)
  await expect(page.getByTestId('room-scroller')).toContainText(roomId === OPEN ? '안녕하세요' : '내일 봬요')
  // a click in the room unlocks the page's audio (browsers start audio only in a gesture)
  await page.getByTestId('room-scroller').click({ position: { x: 5, y: 5 } })
}

test.describe('the conversation on screen in a focused window: it only appears', () => {
  test.beforeEach(async ({ page }) => {
    await reset(page)
  })

  test('a browser: the room open makes no sound and no notification; another room open, it rings', async ({ page }) => {
    await page.addInitScript(stubs, { desktop: false, pageFocus: true })
    await signIn(page)
    await routeRooms(page, rooms)
    await openRoom(page, OPEN)
    await arrives(page, OPEN, BEN)
    await expect(page.getByText(`새 메시지 ${seq}`)).toBeVisible()
    await settle(page)
    expect(await notes(page)).toBe(0)
    expect(await shown(page)).toEqual([])
    // another room on screen: the message of the first one rings, as before
    await openRoom(page, OTHER)
    await arrives(page, OPEN, BEN)
    await expect.poll(() => notes(page), { timeout: 6000 }).toBe(4)
  })

  test('the desktop app, its page without focus of its own (the owner\'s report): the room open stays quiet while the window is focused, and rings once it is not', async ({ page }) => {
    await page.addInitScript(stubs, { desktop: true, pageFocus: false })
    await signIn(page)
    await routeRooms(page, rooms)
    await openRoom(page, OPEN)
    const reads: number[] = []
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/rooms/${OPEN}/read`) reads.push((r.postDataJSON() as { seq: number }).seq) })
    await arrives(page, OPEN, BEN)
    await expect(page.getByText(`새 메시지 ${seq}`)).toBeVisible()
    // looked at: read at once (before, nothing was read, and the person's other windows and devices rang too)
    await expect.poll(() => reads).toContain(seq)
    await settle(page)
    expect(await notes(page)).toBe(0)
    expect(await shown(page)).toEqual([])
    // the window in the back (another app in front): the room on screen rings, as before
    await page.evaluate(() => (window as unknown as { __setWindowFocus: (f: boolean) => void }).__setWindowFocus(false))
    await arrives(page, OPEN, BEN)
    await expect.poll(() => notes(page), { timeout: 6000 }).toBe(4)
  })

  test('the desktop app, focused on another room: the message rings', async ({ page }) => {
    await page.addInitScript(stubs, { desktop: true, pageFocus: false })
    await signIn(page)
    await routeRooms(page, rooms)
    await openRoom(page, OTHER)
    await arrives(page, OPEN, BEN)
    await expect.poll(() => notes(page), { timeout: 6000 }).toBe(4)
  })
})
