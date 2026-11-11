// QA TC-264: inside the phone app (a WebView around the web app) the copy never sends people to "the browser's
// settings" or "a new tab"; a browser and the desktop app keep those words. A folder's ⋯ menu says "folder".
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { chatItemKey, externalImageHintKey, micDeniedKey } from '../../src/lib/appWording'
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
