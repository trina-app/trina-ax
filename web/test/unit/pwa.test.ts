// The install guide (Settings > Apps): platform detection, "already installed" detection, the step order and when
// push needs the Home Screen app.
import { describe, expect, test } from 'bun:test'
import { DESKTOP_BRIDGE_GLOBAL } from '@mycel/shared'
import { guideOrder, insidePhoneApp, installGuideShown, platformOf, pushNeedsInstall, standaloneOf } from '../../src/lib/pwa'

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

describe('install guide', () => {
  test('platform: iPhone, iPad in desktop mode, Android, Mac, Windows, other', () => {
    expect(platformOf(UA.iphone, 'iPhone', 5)).toBe('ios')
    // iPadOS Safari asks for the desktop site: a "Macintosh" with touch points is an iPad
    expect(platformOf(UA.ipadDesktop, 'MacIntel', 5)).toBe('ios')
    expect(platformOf(UA.ipadDesktop, 'MacIntel', 0)).toBe('mac')
    expect(platformOf(UA.android, 'Linux armv8l', 5)).toBe('android')
    expect(platformOf(UA.windows, 'Win32', 0)).toBe('windows')
    expect(platformOf(UA.linux, 'Linux x86_64', 0)).toBe('other')
  })
  test('installed: display-mode standalone or iOS navigator.standalone', () => {
    expect(standaloneOf(true, undefined)).toBe(true)
    expect(standaloneOf(false, true)).toBe(true)
    expect(standaloneOf(false, false)).toBe(false)
    expect(standaloneOf(false, undefined)).toBe(false)
    expect(standaloneOf(false, 'true')).toBe(false)
  })
  test('the steps for this device come first, then the others', () => {
    expect(guideOrder('ios')).toEqual(['ios', 'android', 'desktop'])
    expect(guideOrder('android')).toEqual(['android', 'ios', 'desktop'])
    for (const p of ['mac', 'windows', 'other'] as const) expect(guideOrder(p)).toEqual(['desktop', 'ios', 'android'])
  })
  test('push needs the Home Screen app only on iOS in a browser tab', () => {
    expect(pushNeedsInstall('ios', false, true)).toBe(true)
    expect(pushNeedsInstall('ios', true, true)).toBe(false)
    expect(pushNeedsInstall('android', false, true)).toBe(false)
    expect(pushNeedsInstall('mac', false, true)).toBe(false)
    // the phone app and the desktop app are already apps
    expect(pushNeedsInstall('ios', false, false)).toBe(false)
  })
  test('a plain browser shows the guide, the desktop app does not', () => {
    expect(installGuideShown()).toBe(true)
    const g = globalThis as Record<string, unknown>
    g[DESKTOP_BRIDGE_GLOBAL] = { bridgeVersion: 1 }
    try {
      expect(installGuideShown()).toBe(false)
      expect(pushNeedsInstall('ios', false)).toBe(false)
    } finally {
      delete g[DESKTOP_BRIDGE_GLOBAL]
    }
  })
})

test('inside the phone app (react-native-webview bridge) the page registers no service worker', () => {
  expect(insidePhoneApp({ ReactNativeWebView: { postMessage: () => {} } })).toBe(true)
  for (const w of [{}, { ReactNativeWebView: {} }, { ReactNativeWebView: { postMessage: 'x' } }]) expect(insidePhoneApp(w)).toBe(false)
})

test("a computer's browser picks its install steps: Chrome and Edge from the address bar, Safari on a Mac from File → Add to Dock, Firefox none", async () => {
  const { browserOf } = await import('../../src/lib/pwa')
  const { computerFlow } = await import('../../src/components/settings/InstallGuide')
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
  const winEdge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'
  const macFirefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
  const winOpera = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0'
  expect(browserOf(macChrome)).toBe('chrome')
  expect(browserOf(UA.windows)).toBe('chrome')
  expect(browserOf(macSafari)).toBe('safari')
  expect(browserOf(winEdge)).toBe('edge')
  expect(browserOf(macFirefox)).toBe('firefox')
  expect(browserOf(winOpera)).toBe('chrome')
  expect(browserOf('Opera/9.80 (Windows NT 6.1) Presto/2.12.388 Version/12.18')).toBe('other')
  expect(browserOf('')).toBe('other')
  // Safari's steps only for Safari on a Mac; everything else that can install uses Chrome's and Edge's
  expect(computerFlow('mac', 'safari')).toBe('safari')
  expect(computerFlow('mac', 'chrome')).toBe('chromium')
  expect(computerFlow('windows', 'edge')).toBe('chromium')
  expect(computerFlow('other', 'safari')).toBe('chromium')
})
