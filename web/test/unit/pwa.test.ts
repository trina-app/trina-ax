// The install guide (Settings > Apps): platform detection, "already installed" detection, the step order and when
// push needs the Home Screen app.
import { describe, expect, test } from 'bun:test'
import { DESKTOP_BRIDGE_GLOBAL } from '@mycel/shared'
import { guideOrder, installGuideShown, platformOf, pushNeedsInstall, standaloneOf } from '../../src/lib/pwa'

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
