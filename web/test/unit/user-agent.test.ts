// Settings › Security & devices (src/lib/userAgent.ts): a device shows a short name ("Chrome on macOS"), not the raw
// user agent; the desktop and phone apps say "<product> app on <system>"; too little to go on gives the client kind.
import { describe, expect, test } from 'bun:test'
import { PRODUCT } from '@mycel/shared'
import { translate, type MessageKey, type Params } from '../../src/i18n'
import { deviceLabel, parseUserAgent } from '../../src/lib/userAgent'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  samsungAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
  operaWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 OPR/120.0.0.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  desktopWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TrinaAX/0.4.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
}

const t = (key: MessageKey, params?: Params) => translate('en', key, params)

describe('user agent parser', () => {
  test('browser and system', () => {
    expect(parseUserAgent(UA.chromeMac)).toEqual({ browser: 'Chrome', os: 'macOS' })
    expect(parseUserAgent(UA.safariMac)).toEqual({ browser: 'Safari', os: 'macOS' })
    expect(parseUserAgent(UA.safariIphone)).toEqual({ browser: 'Safari', os: 'iPhone' })
    expect(parseUserAgent(UA.chromeIphone)).toEqual({ browser: 'Chrome', os: 'iPhone' })
    expect(parseUserAgent(UA.safariIpad)).toEqual({ browser: 'Safari', os: 'iPad' })
    expect(parseUserAgent(UA.edgeWindows)).toEqual({ browser: 'Edge', os: 'Windows' })
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({ browser: 'Firefox', os: 'Linux' })
    expect(parseUserAgent(UA.chromeAndroid)).toEqual({ browser: 'Chrome', os: 'Android' })
    expect(parseUserAgent(UA.samsungAndroid)).toEqual({ browser: 'Samsung Internet', os: 'Android' })
    expect(parseUserAgent(UA.operaWindows)).toEqual({ browser: 'Opera', os: 'Windows' })
    expect(parseUserAgent(UA.chromebook)).toEqual({ browser: 'Chrome', os: 'ChromeOS' })
    expect(parseUserAgent(UA.chromeMac.replace('Chrome/', 'HeadlessChrome/'))).toEqual({ browser: 'Chrome', os: 'macOS' })
  })

  test('an app session has no browser; unknown parts are null', () => {
    expect(parseUserAgent(UA.desktopWindows, true)).toEqual({ browser: null, os: 'Windows' })
    expect(parseUserAgent('curl/8.7.1')).toEqual({ browser: null, os: null })
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null })
  })
})

describe('device line', () => {
  test('a browser: "<browser> on <system>"', () => {
    expect(deviceLabel('web', UA.chromeMac, t)).toBe('Chrome on macOS')
    expect(deviceLabel('web', UA.safariIphone, t)).toBe('Safari on iPhone')
  })

  test('the desktop or phone app: "<product> app on <system>"', () => {
    expect(deviceLabel('desktop', UA.desktopWindows, t)).toBe(`${PRODUCT.displayName} app on Windows`)
    expect(deviceLabel('mobile', `${UA.chromeAndroid} TeamAX-Mobile/1.0`, t)).toBe(`${PRODUCT.displayName} app on Android`)
  })

  test('too little to go on: the browser alone, or the client kind', () => {
    expect(deviceLabel('web', 'Mozilla/5.0 Firefox/140.0', t)).toBe('Firefox')
    expect(deviceLabel('web', null, t)).toBe(t('client.web'))
    expect(deviceLabel('desktop', null, t)).toBe(t('client.desktop'))
    expect(deviceLabel('mobile', 'curl/8.7.1', t)).toBe(t('client.mobile'))
  })

  test('other languages keep their own word order', () => {
    expect(deviceLabel('web', UA.chromeMac, (k, p) => translate('ko', k, p))).toBe('macOS의 Chrome')
  })
})
