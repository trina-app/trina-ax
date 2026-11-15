// QA TC-2260: a page load while an update migrates the database gets "Trina is updating", not the stand-in's JSON
// (server/src/system/updating-page.ts); API calls keep their JSON.
import { describe, expect, test } from 'bun:test'
import { updatingHtml, updatingLocale, updatingPageResponse, wantsUpdatingPage, UPDATING_RELOAD_S } from '../../server/src/system/updating-page'

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`http://team.localhost${path}`, { method, headers })

describe('the updating page', () => {
  test('a browser page load gets it; API calls, scripts and writes do not', () => {
    expect(wantsUpdatingPage(req('/c/abc', { 'sec-fetch-mode': 'navigate', accept: 'text/html' }))).toBe(true)
    expect(wantsUpdatingPage(req('/', { accept: 'text/html,application/xhtml+xml' }))).toBe(true)
    expect(wantsUpdatingPage(req('/api/me', { accept: 'text/html' }))).toBe(false)
    expect(wantsUpdatingPage(req('/assets/app.js', { 'sec-fetch-mode': 'no-cors', accept: '*/*' }))).toBe(false)
    expect(wantsUpdatingPage(req('/c/abc', { accept: 'application/json' }))).toBe(false)
    expect(wantsUpdatingPage(req('/c/abc', { accept: 'text/html' }, 'POST'))).toBe(false)
  })

  test('in the language the page last showed, else English; reloads itself; 503, never cached', async () => {
    expect(updatingLocale('a=1; mycel_locale=ja')).toBe('ja')
    expect(updatingLocale('mycel_locale=xx')).toBe('en')
    expect(updatingLocale(null)).toBe('en')
    const html = updatingHtml('en')
    expect(html).toContain('Trina is updating')
    expect(html).toContain('back in a few minutes')
    expect(html).toContain(`<meta http-equiv="refresh" content="${UPDATING_RELOAD_S}">`)
    const res = updatingPageResponse(req('/c/abc', { cookie: 'mycel_locale=es' }))
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe(String(UPDATING_RELOAD_S))
    expect(res.headers.get('x-mycel-updating')).toBe('1')
    expect(await res.text()).toContain('Trina se está actualizando')
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) expect(updatingHtml(l)).toContain(`lang="${l}"`)
  })
})
