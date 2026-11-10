// Is the person looking at this page (lib/attention.ts)? What reading a room or a thread and the room sound go by. In a
// browser on a computer: on screen and focused. In the desktop app: on screen and its window focused, as the app says
// (the team page has no focus of its own after a start, or while the in-app browser has the keyboard). In the phone app
// (its WebView reports no focus until a touch) and a phone's browser: on screen.
// (The phone app once marked nothing read because of that: the person's other windows kept the badge and rang. The
// desktop app rang for the conversation on screen: the owner, 2026-11-10.)
// And is a new message's conversation on screen (conversationOnScreen): the room open, or the thread a panel shows.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { conversationOnScreen, lookingAt, onWindowFocus, unwatchWindowFocus, watchWindowFocus, windowFocused } from '../../src/lib/attention'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'
import { installDom, removeDom } from './dom-host'

const config: MobileConfig = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
const page = () => document as unknown as { visibilityState: string; hasFocus: () => boolean }
const g = globalThis as unknown as Record<string, unknown>
beforeEach(() => installDom())
afterEach(() => {
  unwatchWindowFocus()
  delete g.mycelMobile
  delete g.ReactNativeWebView
  delete g.mycelDesktop
  removeDom()
})

/** a desktop app's bridge with its window's focus (`focus: false`: an app older than the word) */
function desktopApp(o: { focused: boolean; focus?: false }) {
  const listeners = new Set<(f: boolean) => void>()
  const app = { focused: o.focused, set(f: boolean) { app.focused = f; for (const l of listeners) l(f) } }
  g.mycelDesktop = {
    bridgeVersion: 1,
    ...(o.focus === false ? {} : { focus: { get: async () => app.focused, onChange: (cb: (f: boolean) => void) => { listeners.add(cb); return () => listeners.delete(cb) } } }),
  }
  return app
}

test('a browser or the desktop app: on screen and focused', () => {
  page().visibilityState = 'visible'
  page().hasFocus = () => true
  expect(lookingAt()).toBe(true)
  // another window in front (a second monitor, another app)
  page().hasFocus = () => false
  expect(lookingAt()).toBe(false)
  // a tab in the background
  page().hasFocus = () => true
  page().visibilityState = 'hidden'
  expect(lookingAt()).toBe(false)
})

test('the phone app: on screen is looking at it, whatever focus its WebView reports', () => {
  g.mycelMobile = { ...config }
  g.ReactNativeWebView = { postMessage: () => {} }
  page().visibilityState = 'visible'
  page().hasFocus = () => false
  expect(lookingAt()).toBe(true)
  // the app in the background, or the phone locked
  page().visibilityState = 'hidden'
  expect(lookingAt()).toBe(false)
})

test('a phone browser (only a finger to point with; iOS Chrome is a WKWebView too): on screen is looking at it', () => {
  const media = (coarse: boolean) => (q: string) => ({ matches: coarse && q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} })
  page().visibilityState = 'visible'
  page().hasFocus = () => false
  g.matchMedia = media(true)
  expect(lookingAt()).toBe(true)
  page().visibilityState = 'hidden'
  expect(lookingAt()).toBe(false)
  // a computer with a mouse or trackpad: focus still decides
  page().visibilityState = 'visible'
  g.matchMedia = media(false)
  expect(lookingAt()).toBe(false)
})

test('no page (a worker, the server): never', () => {
  removeDom()
  expect(typeof document).toBe('undefined')
  expect(lookingAt()).toBe(false)
  installDom()
})

describe('the desktop app: its window\'s focus, as the app says', () => {
  test('the window focused and the page without focus of its own (after a start, the in-app browser in use): looking', async () => {
    const app = desktopApp({ focused: true })
    page().visibilityState = 'visible'
    page().hasFocus = () => false
    watchWindowFocus()
    await Promise.resolve()
    expect(windowFocused()).toBe(true)
    expect(lookingAt()).toBe(true)
    // another app in front: not looking, whatever the page says
    const told: (boolean | null)[] = []
    const off = onWindowFocus(() => told.push(windowFocused()))
    app.set(false)
    page().hasFocus = () => true
    expect(lookingAt()).toBe(false)
    // back in front
    app.set(true)
    expect(lookingAt()).toBe(true)
    expect(told).toEqual([false, true])
    off()
    // the window focused but the page hidden (minimised): not looking
    page().visibilityState = 'hidden'
    expect(lookingAt()).toBe(false)
  })

  test('until the app answers, the page\'s own focus; signed out (not watched): the page\'s own focus again', async () => {
    desktopApp({ focused: true })
    page().visibilityState = 'visible'
    page().hasFocus = () => false
    watchWindowFocus()
    expect(lookingAt()).toBe(false)
    await Promise.resolve()
    expect(lookingAt()).toBe(true)
    unwatchWindowFocus()
    expect(windowFocused()).toBeNull()
    expect(lookingAt()).toBe(false)
  })

  test('a desktop app older than the word: the page\'s own focus, as before', () => {
    desktopApp({ focused: true, focus: false })
    page().visibilityState = 'visible'
    page().hasFocus = () => false
    watchWindowFocus()
    expect(windowFocused()).toBeNull()
    expect(lookingAt()).toBe(false)
    page().hasFocus = () => true
    expect(lookingAt()).toBe(true)
  })
})

describe('the conversation of a new message on screen', () => {
  const ROOM = uuidv7(), OTHER = uuidv7(), ROOT = uuidv7()

  test('the room open: its messages, and replies in its threads (as before)', () => {
    expect(conversationOnScreen({ room: ROOM }, ROOM)).toBe(true)
    expect(conversationOnScreen({ room: ROOM }, ROOM, ROOT)).toBe(true)
  })

  test('a DM is a room like any other: the DM open is on screen; another DM or room open is not', () => {
    const dm = uuidv7()
    expect(conversationOnScreen({ room: dm }, dm)).toBe(true)
    expect(conversationOnScreen({ room: OTHER }, dm)).toBe(false)
    expect(conversationOnScreen({ room: dm }, OTHER)).toBe(false)
  })

  test('a reply in a thread a panel shows (beside a file opened outside its room): on screen; a message of its room is not', () => {
    const on = { room: null, threads: [`${ROOM}/${ROOT}`] }
    expect(conversationOnScreen(on, ROOM, ROOT)).toBe(true)
    expect(conversationOnScreen(on, ROOM)).toBe(false)
    // another thread of the same room, the same root id in another room: not on screen
    expect(conversationOnScreen(on, ROOM, uuidv7())).toBe(false)
    expect(conversationOnScreen(on, OTHER, ROOT)).toBe(false)
  })

  test('nothing on screen (another page, or no window looked at): never', () => {
    expect(conversationOnScreen(null, ROOM)).toBe(false)
    expect(conversationOnScreen({ room: null }, ROOM, ROOT)).toBe(false)
  })
})
