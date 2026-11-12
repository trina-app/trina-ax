// Feature coverage of answers given in the browser (docs/FEATURES.md): the mock team server marks its own /api answers,
// counts an endpoint a spec answered with page.route when told (POST /__test/coverage {method, path}), and the e2e
// helper tells answers of the browser from the server's.
import { afterAll, expect, test } from 'bun:test'
import path from 'node:path'
import { MOCK_ANSWER_HEADER, answeredInBrowser } from '../e2e/coverage-report'
import { MockServer } from '../mock/server'

const mock = new MockServer()
const server = mock.serve(0, path.resolve(import.meta.dir, '..', '..', 'dist'))
const base = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const report = (body: unknown) => fetch(`${base}/__test/coverage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('the mock server marks its own /api answers, not the web app', async () => {
  expect((await fetch(`${base}/api/health`)).headers.get(MOCK_ANSWER_HEADER)).toBe('1')
  expect((await fetch(`${base}/api/me`)).headers.get(MOCK_ANSWER_HEADER)).toBe('1') // an error answer too (401)
  expect((await fetch(`${base}/login`)).headers.get(MOCK_ANSWER_HEADER)).toBeNull()
})

test('an endpoint answered in the browser counts by its contract name; an unknown request counts nothing', async () => {
  expect((await report({ method: 'GET', path: '/api/rooms/r1/messages/m1/thread' })).status).toBe(204)
  expect((await report({ method: 'GET', path: '/api/rooms/r1/messages/m1/thread' })).status).toBe(204)
  expect((await report({ method: 'DELETE', path: '/api/rooms/r1/messages/m1/thread' })).status).toBe(404)
  expect((await report({ method: 'GET', path: '/api/nothing-here' })).status).toBe(404)
  const counts = (await (await report({})).json()) as Record<string, number>
  expect(counts.listRoomThread).toBe(2)
  // kept over a reset, like the server's own count
  await report({ method: 'POST', path: '/api/rooms/r1/read' })
  await fetch(`${base}/__test/reset`, { method: 'POST', body: '{}' })
  const after = (await (await fetch(`${base}/__test/coverage`, { method: 'POST' })).json()) as Record<string, number>
  expect(after.listRoomThread).toBe(2)
  expect(after.markRoomRead).toBe(1)
})

test('the e2e helper reports only /api answers of the page origin without the mock server mark', () => {
  const origin = 'http://127.0.0.1:19143'
  const res = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({ url: () => url, headers: () => headers, request: () => ({ method: () => method }) })
  expect(answeredInBrowser(res(`${origin}/api/rooms/r1?x=1`, {}, 'PATCH'), origin)).toEqual({ method: 'PATCH', path: '/api/rooms/r1' })
  expect(answeredInBrowser(res(`${origin}/api/rooms`, { [MOCK_ANSWER_HEADER]: '1' }), origin)).toBeNull()
  expect(answeredInBrowser(res(`${origin}/assets/app.js`), origin)).toBeNull()
  expect(answeredInBrowser(res('https://claude.ai/api/x'), origin)).toBeNull()
})
