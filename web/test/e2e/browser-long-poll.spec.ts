// The AI's browser (desktop app) over the long-poll fallback (shared/src/api/browser.ts: GET /api/browser/calls,
// POST /api/browser/results), for windows whose WebSocket is blocked by a company proxy. The browser calls normally
// come over the WebSocket (web/src/lib/browserRelay.ts) and no screen of the web app reads these two endpoints, so this
// checks their contract from a signed-in window: only a signed-in person, only with a window id, nothing pending when the
// AI has not asked, and a result for a call that is not waiting is refused (the mock makes no calls; delivery over the
// WebSocket is the server's unit tests). Settings › Browser itself is browser-settings.spec.ts.
import { expect, test } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const WINDOW = 'win-0123456789'

test('signed in, a window polls for browser calls (none pending); a result needs a waiting call and the CSRF header', async ({ page }) => {
  await reset(page)
  // signed out: neither endpoint answers
  expect((await page.request.get(`/api/browser/calls?windowId=${WINDOW}&waitMs=0`)).status()).toBe(401)
  expect((await page.request.post('/api/browser/results', { headers: { [CSRF_HEADER]: '1' }, data: { callId: 'c1', ok: true, content: [] } })).status()).toBe(401)

  await signIn(page)
  const poll = await page.request.get(`/api/browser/calls?windowId=${WINDOW}&waitMs=0`)
  expect(poll.status()).toBe(200)
  expect(await poll.json()).toEqual({ calls: [] })
  // a window id is required
  expect((await page.request.get('/api/browser/calls?waitMs=0')).status()).toBe(400)

  const result = await page.request.post('/api/browser/results', {
    headers: { [CSRF_HEADER]: '1' },
    data: { callId: 'c1', ok: false, content: [{ type: 'text', text: 'no pane' }], error: 'This window has no in-app browser.' },
  })
  // no call c1 is waiting for its result
  expect(result.status()).toBe(404)
  // without the CSRF header a result is refused
  expect((await page.request.post('/api/browser/results', { data: { callId: 'c1', ok: true, content: [] } })).status()).toBe(403)
})
