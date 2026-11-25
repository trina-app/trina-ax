// The landing's language picker against a real gate: the link a visitor follows gives that language's page, and the
// Start form on that page opens a session in that language.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { WORDS } from '../src/pages.ts'
import { NODE, fakeTurnstile, fakeUpstream, get, startGate, startVisit, visitor, warm, type Gate } from './harness.ts'

setDefaultTimeout(30_000)

const langOf = (html: string) => html.match(/name="lang" value="([a-z]+)"/)?.[1]

describe.skipIf(!NODE)('gate: the language picker', () => {
  const upstream = fakeUpstream()
  const turnstile = fakeTurnstile()
  let g: Gate
  beforeAll(async () => {
    g = await startGate({ upstream: upstream.url, turnstile: turnstile.url, locales: ['en', 'ko', 'ja', 'zh', 'es', 'id'] })
    // the landing (with its Start form) is served only while that language has a warm copy, else the busy page; the
    // pool starts all six at once and they get warm in any order, so wait for each language a test reads as a landing
    await warm(g, 1, 'en')
    await warm(g, 1, 'ko')
  })
  afterAll(async () => { await g?.stop(); upstream.stop(); turnstile.stop() })

  test('an English browser sees all six, and choosing Korean gives Korean text and a Korean session', async () => {
    const v = visitor()
    const first = await (await get(g, v, '/', { headers: { 'accept-language': 'en-US' } })).text()
    expect(first).toContain('<html lang="en">')
    expect(langOf(first)).toBe('en')
    expect(first.match(/data-lang-link href/g)?.length).toBe(6)
    const href = first.match(/href="(\/\?lang=ko)"/)?.[1]
    expect(href).toBe('/?lang=ko')
    const ko = await (await get(g, v, href!, { headers: { 'accept-language': 'en-US' } })).text()
    expect(ko).toContain('<html lang="ko">')
    expect(ko).toContain(WORDS.ko.landingH)
    expect(ko).toContain('<a data-lang-link href="/?lang=ko" lang="ko" hreflang="ko" aria-current="true">')
    expect(langOf(ko)).toBe('ko')
    const started = await startVisit(g, v, { lang: langOf(ko)! })
    expect(started.status).toBe(303)
    expect(started.headers.getSetCookie().join('\n')).toContain('mycel_locale=ko;')
  })

  test('an unknown language falls back safely and is never written into the page', async () => {
    for (const bad of ['xx', '%22%3E%3Cimg%20src%3Dx%3E', 'ko%0d%0aX-Test:1']) {
      const r = await get(g, visitor(), `/?lang=${bad}`, { headers: { 'accept-language': 'en-US' } })
      const html = await r.text()
      expect(html, bad).toContain('<html lang="en">')
      expect(langOf(html), bad).toBe('en')
      expect(html, bad).not.toContain('<img')
      expect(html, bad).not.toContain('X-Test')
      expect(r.headers.get('x-test'), bad).toBeNull()
    }
  })
})
