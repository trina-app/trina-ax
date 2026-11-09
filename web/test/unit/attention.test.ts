// Is the person looking at this page (lib/attention.ts)? What reading a room or a thread and the room sound go by. In a
// browser or the desktop app on a computer: on screen and focused. In the phone app (its WebView reports no focus until
// a touch) and a phone's browser: on screen.
// (The phone app once marked nothing read because of that: the person's other windows kept the badge and rang.)
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lookingAt } from '../../src/lib/attention'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'
import { installDom, removeDom } from './dom-host'

const config: MobileConfig = { protocol: 1, appVersion: '0.4.0', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
const page = () => document as unknown as { visibilityState: string; hasFocus: () => boolean }
const g = globalThis as unknown as Record<string, unknown>
beforeEach(() => installDom())
afterEach(() => {
  delete g.mycelMobile
  delete g.ReactNativeWebView
  removeDom()
})

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
