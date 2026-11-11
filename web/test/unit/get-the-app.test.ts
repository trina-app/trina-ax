// "Get the app" on the join pages (docs/AGENTS/plan/20261111-1058-invite-get-the-app.md, docs/DECISIONS.md "Get the
// app"): which platform shows what, and the invite token never in a store address or the intent's fallback.
import { describe, expect, test } from 'bun:test'
import { APP_DOWNLOADS } from '@mycel/shared'
import { parseTeamInput as sharedParse } from '../../../shared/src/team-link'
import { parseTeamInput as mobileParse } from '../../../mobile/src/team-link'
import { DICTS, LOCALES, translate } from '../../src/i18n'
import { getAppHref, openInAppHref } from '../../src/lib/team-link'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
const PLAY = 'https://play.google.com/store/apps/details?id=app.trina.ax'
const TRINA = { page: 'https://ax.trina.app/download', iphone: 'https://apps.apple.com/app/trina-ax/id6829192435?platform=iphone', android: PLAY }
const NONE = { page: '', iphone: '', android: '' }

describe('who sees "Get the app"', () => {
  test('the edition links are the Trina ones (App Store id 6829192435, Google Play app.trina.ax)', () => {
    expect(APP_DOWNLOADS.iphone).toBe(TRINA.iphone)
    expect(APP_DOWNLOADS.page).toBe(TRINA.page)
    expect(APP_DOWNLOADS.android).toBe(PLAY)
  })
  test('an iPhone browser: the App Store listing', () => {
    expect(getAppHref('ios', 'web', TRINA)).toBe(TRINA.iphone)
  })
  test('an Android browser: Google Play; a build without a Play listing: its download page', () => {
    expect(getAppHref('android', 'web', TRINA)).toBe(PLAY)
    expect(getAppHref('android', 'web', { ...TRINA, android: '' })).toBe('https://ax.trina.app/download')
  })
  test('computers: nothing (the page stays as it was)', () => {
    for (const p of ['mac', 'windows', 'other'] as const) expect(getAppHref(p, 'web', TRINA)).toBeNull()
  })
  test('inside our own apps: never', () => {
    for (const c of ['desktop', 'mobile'] as const) for (const p of ['ios', 'android', 'mac'] as const) expect(getAppHref(p, c, TRINA)).toBeNull()
  })
  test('a build that names no store and no page: nothing; never a non-https address', () => {
    for (const p of ['ios', 'android'] as const) expect(getAppHref(p, 'web', NONE)).toBeNull()
    expect(getAppHref('ios', 'web', { ...NONE, iphone: 'javascript:alert(1)' })).toBeNull()
  })
})

describe('the token stays out of the store addresses', () => {
  test('store addresses are the fixed edition ones, whatever the page', () => {
    for (const p of ['ios', 'android'] as const) {
      const href = getAppHref(p, 'web', TRINA)!
      expect(href).not.toContain(TOKEN)
      expect(href).not.toContain('invite')
      expect(href).not.toContain('join')
    }
  })
  test("Android's intent: the token only in the app's own url, the fallback is the Play listing", () => {
    for (const path of [`/invite/${TOKEN}`, `/join#t=${TOKEN}`]) {
      const href = openInAppHref({ scheme: 'trina-ax', origin: 'https://acme.trina.app', path, platform: 'android', androidPackage: 'app.trina.ax', androidFallback: getAppHref('android', 'web', TRINA) })!
      expect(href).toBe(`intent://open?url=${encodeURIComponent(`https://acme.trina.app${path}`)}#Intent;scheme=trina-ax;package=app.trina.ax;S.browser_fallback_url=${encodeURIComponent(PLAY)};end`)
      const extras = href.slice(href.indexOf('#Intent'))
      expect(extras).not.toContain(TOKEN)
      expect(decodeURIComponent(extras)).not.toContain(TOKEN)
    }
  })
  test('no fallback: the intent as before; a non-https fallback is dropped', () => {
    const at = { scheme: 'trina-ax', origin: 'https://acme.trina.app', path: '/invite/abc', platform: 'android' as const, androidPackage: 'app.trina.ax' }
    const plain = 'intent://open?url=https%3A%2F%2Facme.trina.app%2Finvite%2Fabc#Intent;scheme=trina-ax;package=app.trina.ax;end'
    expect(openInAppHref(at)).toBe(plain)
    expect(openInAppHref({ ...at, androidFallback: null })).toBe(plain)
    expect(openInAppHref({ ...at, androidFallback: 'javascript:alert(1)' })).toBe(plain)
    // computers ignore the fallback
    expect(openInAppHref({ ...at, platform: 'mac', androidFallback: TRINA.page })).toBe('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2Finvite%2Fabc')
  })
})

describe("the copied link opens on the app's first screen", () => {
  test('an invite link and a team link, pasted as they are, read as that page (both copies of the reader)', () => {
    for (const parse of [sharedParse, mobileParse]) {
      expect(parse(`https://acme.trina.app/invite/${TOKEN}`, { teamDomain: 'trina.app', loopbackHttp: false })).toMatchObject({ ok: true, origin: 'https://acme.trina.app', entryPath: `/invite/${TOKEN}` })
      expect(parse(`https://acme.trina.app/join#t=${TOKEN}`, { teamDomain: 'trina.app', loopbackHttp: false })).toMatchObject({ ok: true, origin: 'https://acme.trina.app', entryPath: `/join#t=${TOKEN}` })
    }
  })
})

describe('words', () => {
  test('in all five languages, Korean only in Korean', () => {
    for (const k of ['auth.getApp', 'auth.getAppHint', 'auth.continueInBrowser', 'auth.linkCopied', 'auth.linkNotCopied'] as const)
      for (const { id } of LOCALES) {
        const v = DICTS[id][k]
        expect({ id, k, ok: typeof v === 'string' && v.length > 0 && (id === 'ko' || !/[가-힣]/.test(v)) }).toEqual({ id, k, ok: true })
      }
    expect(translate('en', 'auth.getApp')).toBe('Copy invite & get the app')
    expect(translate('ko', 'auth.getApp')).toBe('초대 링크 복사하고 앱 받기')
    expect(translate('en', 'auth.getAppHint')).toBe("After installing, paste the link in the app's first screen.")
    expect(translate('ko', 'auth.getAppHint')).toBe('앱을 설치한 다음 첫 화면에 붙여 넣으세요.')
    expect(translate('en', 'auth.linkCopied')).toBe('Link copied')
    expect(translate('ko', 'auth.linkCopied')).toBe('링크를 복사했어요')
  })
})

describe('the copy inside the tap', () => {
  // a stand-in document: execCommand answers what the browser would; the textarea is put in and taken out again
  const fakeDoc = (answer: boolean | 'throw') => {
    const log: string[] = []
    const area = { value: '', readOnly: false, style: { cssText: '' }, setAttribute() {}, select: () => log.push('select'), setSelectionRange: () => log.push('range') }
    const doc = {
      activeElement: null,
      createElement: () => area,
      execCommand: (c: string) => { log.push(`exec:${c}:${area.value}`); if (answer === 'throw') throw new Error('no'); return answer },
      body: { appendChild: () => log.push('in'), removeChild: () => log.push('out') },
    }
    return { doc: doc as never, log, area }
  }
  test('the synchronous copy worked: copied now (the store link goes ahead)', async () => {
    const { copyInTap } = await import('../../src/lib/copy-in-tap')
    const { doc, log, area } = fakeDoc(true)
    const writes: string[] = []
    const r = copyInTap('https://acme.trina.app/invite/abc', { doc, clipboard: { writeText: async (t) => { writes.push(t) } } })
    expect(r.now).toBe(true)
    expect(await r.later).toBe(true)
    expect(writes).toEqual(['https://acme.trina.app/invite/abc'])
    expect(area.readOnly).toBe(true)
    expect(log).toEqual(['in', 'select', 'range', 'exec:copy:https://acme.trina.app/invite/abc', 'out'])
  })
  test('an in-app browser with no Clipboard API and a refused copy: not copied (the page stays)', async () => {
    const { copyInTap } = await import('../../src/lib/copy-in-tap')
    for (const answer of [false, 'throw'] as const) {
      const { doc, log } = fakeDoc(answer)
      const r = copyInTap('x', { doc, clipboard: undefined })
      expect(r).toEqual({ now: false, later: null })
      expect(log.at(-1)).toBe('out') // the textarea never stays behind
    }
  })
  test('the Clipboard API refuses: its answer is false, never a throw', async () => {
    const { copyInTap } = await import('../../src/lib/copy-in-tap')
    const r = copyInTap('x', { doc: fakeDoc(false).doc, clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } })
    expect(r.now).toBe(false)
    expect(await r.later).toBe(false)
    const thrown = copyInTap('x', { doc: fakeDoc(false).doc, clipboard: { writeText: () => { throw new Error('sync') } } })
    expect(thrown.later).toBeNull()
  })
})
