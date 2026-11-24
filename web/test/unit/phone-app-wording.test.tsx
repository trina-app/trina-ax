// QA TC-264: inside the phone app (a WebView around the web app) the copy never sends people to "the browser's
// settings" or "a new tab"; a browser and the desktop app keep those words. A folder's ⋯ menu says "folder".
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { androidAppWithoutMic, chatItemKey, externalImageHintKey, messagePreviewDescKey, micBlocked, micDeniedKey, micErrorKey } from '../../src/lib/appWording'
import { recorderErrorOf } from '../../src/lib/recorder'
import { Markdown } from '../../src/components/Markdown'
import { DICTS, translate } from '../../src/i18n'
import { MOBILE_CAPABILITIES, type MobileConfig } from '../../../mobile/src/protocol'

const LOCALES = Object.keys(DICTS) as (keyof typeof DICTS)[]
const BROWSER_WORDS = [/browser/i, /브라우저/, /ブラウザー/, /navegador/i]
const TAB_WORDS = [/\btab\b/i, /탭/, /タブ/, /pestaña/i, /\btab baru\b/i]

describe('the mic-blocked note', () => {
  test('a browser (computer or phone, desktop app) keeps the browser-settings words', () => {
    expect(micDeniedKey(null)).toBe('voice.denied')
    expect(translate('en', 'voice.denied')).toContain('browser settings')
    expect(translate('ko', 'voice.denied')).toContain('브라우저 설정')
  })
  test("inside the phone app it points to the phone's Settings for this app, per platform", () => {
    expect(micDeniedKey({ platform: 'ios' })).toBe('voice.deniedIos')
    expect(micDeniedKey({ platform: 'android' })).toBe('voice.deniedAndroid')
    expect(translate('en', 'voice.deniedIos')).toMatch(/Settings › .+ and turn on Microphone/)
    expect(translate('ko', 'voice.deniedIos')).toMatch(/^마이크 사용이 막혀 있어요\. iPhone의 설정 › .+에서 마이크를 켜 주세요\.$/)
    expect(translate('ko', 'voice.deniedAndroid')).toContain('› 권한에서 마이크를 허용해 주세요')
    for (const l of LOCALES) for (const k of ['voice.deniedIos', 'voice.deniedAndroid'] as const) {
      const s = translate(l, k)
      expect(s).not.toContain('{product}')
      for (const w of BROWSER_WORDS) expect(s).not.toMatch(w)
    }
  })
})

// QA TC-4740: the Android app 1.0.8 had the microphone allowed, but its WebView could not open it (a permission
// missing), and the box said "Microphone access is blocked". Only a refusal is "blocked" now.
describe('why the microphone did not start', () => {
  const err = (name: string) => Object.assign(new Error(name), { name })
  test("getUserMedia's refusal by name: refused, no microphone, or failed for another reason", () => {
    for (const n of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) expect(recorderErrorOf(err(n))).toBe('denied')
    for (const n of ['NotFoundError', 'DevicesNotFoundError']) expect(recorderErrorOf(err(n))).toBe('missing')
    for (const n of ['NotReadableError', 'TrackStartError', 'AbortError', 'OverconstrainedError', 'TypeError', '']) expect(recorderErrorOf(err(n))).toBe('failed')
    expect(recorderErrorOf(undefined)).toBe('failed')
    expect(recorderErrorOf('NotAllowedError')).toBe('failed')
  })
  test('a browser: refused while it would still ask is "not allowed, tap again"; refused for good is blocked', () => {
    expect(micErrorKey('denied', { app: null, permission: 'prompt' })).toBe('voice.notAllowed')
    expect(micErrorKey('denied', { app: null, permission: 'denied' })).toBe('voice.denied')
    expect(micErrorKey('denied', { app: null, permission: null })).toBe('voice.denied')
    expect(micErrorKey('denied', { app: null, permission: 'granted' })).toBe('voice.denied')
    // a second refusal in a row: Safari keeps saying "prompt" after Don't Allow and refuses without asking
    expect(micErrorKey('denied', { app: null, permission: 'prompt', refusedBefore: true })).toBe('voice.denied')
  })
  test('a browser: no microphone, or one that did not start, is never "blocked"', () => {
    expect(micErrorKey('missing', { app: null, permission: 'granted' })).toBe('voice.noMic')
    expect(micErrorKey('failed', { app: null, permission: 'granted' })).toBe('voice.micFailed')
    expect(micErrorKey('unsupported', { app: null, permission: null })).toBe('voice.unsupported')
  })
  test("the phone app: a refusal is blocked in the phone's Settings (the phone asks, never the page); anything else could not start", () => {
    const android = (appVersion: string) => ({ platform: 'android' as const, appVersion }), ios = { platform: 'ios' as const, appVersion: '1.0.8' }
    for (const permission of ['prompt', 'denied', null] as const) {
      expect(micErrorKey('denied', { app: android('1.0.9'), permission })).toBe('voice.deniedAndroid')
      expect(micErrorKey('denied', { app: ios, permission })).toBe('voice.deniedIos')
    }
    for (const code of ['missing', 'failed'] as const) {
      // the Android app without the WebView's audio permission (1.0.8 and older) is told to update; no other app is
      for (const v of ['1.0.8', '1.0.0', '0.9.12']) expect(micErrorKey(code, { app: android(v), permission: 'granted' })).toBe('voice.micFailedApp')
      for (const v of ['1.0.9', '1.1.0', '2.0.0', 'odd']) expect(micErrorKey(code, { app: android(v), permission: 'granted' })).toBe('voice.micFailedPhone')
      expect(micErrorKey(code, { app: ios, permission: 'granted' })).toBe('voice.micFailedPhone')
    }
    expect(androidAppWithoutMic(android('1.0.10'))).toBe(false)
    expect(androidAppWithoutMic(ios)).toBe(false)
  })
  test('Open Settings goes only with a "blocked" note', () => {
    expect(['voice.denied', 'voice.deniedIos', 'voice.deniedAndroid'].every((k) => micBlocked(k as never))).toBe(true)
    for (const k of ['voice.notAllowed', 'voice.noMic', 'voice.micFailed', 'voice.micFailedApp', 'voice.micFailedPhone', 'voice.unsupported'] as const) expect(micBlocked(k)).toBe(false)
  })
  test('the words: none of the other notes says blocked; the app\'s never send to the browser', () => {
    for (const l of LOCALES) {
      for (const k of ['voice.notAllowed', 'voice.noMic', 'voice.micFailed', 'voice.micFailedApp', 'voice.micFailedPhone'] as const) {
        expect(translate(l, k)).not.toBe(translate(l, 'voice.denied'))
        expect(translate(l, k)).not.toMatch(/blocked|막혀|ブロック|bloqueado|diblokir|阻止/i)
      }
      for (const k of ['voice.micFailedApp', 'voice.micFailedPhone'] as const) for (const w of BROWSER_WORDS) expect(translate(l, k)).not.toMatch(w)
    }
    expect(translate('en', 'voice.micFailedApp')).toContain('update the app')
  })
})

// QA TC-4692: Android always shows "You have a new message"; inside the Android app the setting says so.
describe('"Show message preview" under Notifications', () => {
  test('the Android app says its notifications do not show the first line yet; a browser and the iPhone app keep the words', () => {
    expect(messagePreviewDescKey({ platform: 'android', capabilities: [] })).toBe('notifications.messagePreviewDescAndroid')
    // an Android app that asks its team for the words (push-label-v1) shows the first line as the iPhone does
    expect(messagePreviewDescKey({ platform: 'android', capabilities: ['push-label-v1'] })).toBe('notifications.messagePreviewDesc')
    expect(messagePreviewDescKey({ platform: 'ios', capabilities: [] })).toBe('notifications.messagePreviewDesc')
    expect(messagePreviewDescKey(null)).toBe('notifications.messagePreviewDesc')
    expect(translate('en', 'notifications.messagePreviewDescAndroid')).toContain('update the app')
    for (const l of LOCALES) expect(translate(l, 'notifications.messagePreviewDescAndroid')).toMatch(/Android/)
  })
})

describe("an answer's outside image", () => {
  test('the hint key: new tab in a browser, the browser (leaving the app) in the phone app', () => {
    expect(externalImageHintKey(false)).toBe('md.externalImageHint')
    expect(externalImageHintKey(true)).toBe('md.externalImageHintApp')
    expect(translate('ko', 'md.externalImageHint')).toBe('자동으로 불러오지 않아요. 누르면 새 탭에서 열려요.')
    expect(translate('ko', 'md.externalImageHintApp')).toBe('자동으로 불러오지 않아요. 누르면 브라우저에서 열려요.')
    for (const l of LOCALES) for (const w of TAB_WORDS) expect(translate(l, 'md.externalImageHintApp')).not.toMatch(w)
  })

  const config: MobileConfig = { protocol: 1, appVersion: '0.2.2', platform: 'ios', nonce: 'c'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window')
  afterEach(() => { if (had) Object.defineProperty(globalThis, 'window', had); else Reflect.deleteProperty(globalThis, 'window') })
  const render = () => renderToStaticMarkup(<MemoryRouter><Markdown text="![chart](https://images.example/chart.png)" /></MemoryRouter>)
  const hints = (html: string) => Object.values(DICTS).map((d) => [html.includes(d['md.externalImageHint']), html.includes(d['md.externalImageHintApp'])])
  test('rendered in a browser it says "new tab"', () => {
    expect(hints(render()).some(([tab]) => tab)).toBe(true)
    expect(hints(render()).some(([, app]) => app)).toBe(false)
  })
  test('rendered inside the phone app it says it opens in the browser', () => {
    const win = { mycelMobile: { ...config }, ReactNativeWebView: { postMessage: () => {} } } as Record<string, unknown>
    win.self = win; win.top = win
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
    const html = render()
    expect(hints(html).some(([, app]) => app)).toBe(true)
    expect(hints(html).some(([tab]) => tab)).toBe(false)
  })
})

describe("a folder's ⋯ menu", () => {
  test('a folder starts a chat about the folder, a file is asked about', () => {
    expect(chatItemKey(true)).toBe('files.chatWithFolder')
    expect(chatItemKey(false)).toBe('files.askAi')
    expect(translate('en', 'files.chatWithFolder')).toBe('Start a chat with this folder')
    expect(translate('ko', 'files.chatWithFolder')).toBe('이 폴더로 채팅 시작')
    for (const l of LOCALES) expect(translate(l, 'files.chatWithFolder')).not.toMatch(/file|파일|ファイル|archivo/i)
  })
})
