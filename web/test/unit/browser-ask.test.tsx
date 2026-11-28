// The page one of my own MCP apps sends me to when it wants a site in my linked browser profile (pages/BrowserAsk.tsx,
// server/src/chrome/asks.ts): who asks, the profile, the full address, a note for a not-plain or an office address;
// Allow once / Always allow in that profile (only when offered) / Don't allow; Disconnect this app after a confirm; and
// a plain line when the question is no longer open (the server's 404).
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { BrowserAskView } from '@mycel/shared/api'
import BrowserAsk from '../../src/pages/BrowserAsk'
import { DialogHost } from '../../src/components/ui'
import { translate, useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const URL_LONG = 'https://shop.example.com/checkout?session=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a&ref=x'
const ask = (o: Partial<BrowserAskView> = {}): BrowserAskView => ({
  id: 'ask-1', client: { name: 'Claude Code', connectedAt: '2026-11-20T01:00:00.000Z', connectionId: 'conn-1' },
  profile: 'Work', host: 'example.com', url: 'https://example.com/', kind: 'site', always: true, site: 'example.com',
  expiresAt: '2099-01-01T00:00:00.000Z', ...o,
})

let answer: BrowserAskView | null = ask()
const calls: { method: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.startsWith('/api/chrome/asks/')) {
      if (!answer) return new Response(JSON.stringify({ code: 'not_found', message: 'Not found or no access.' }), { status: 404, headers: { 'content-type': 'application/json' } })
      if (method === 'GET') return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(null, { status: 204 })
    }
    if (url.startsWith('/api/connectors/remote/') && method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
beforeEach(() => { calls.length = 0; answer = ask(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

const page = () => <MemoryRouter initialEntries={['/browser-ask/ask-1']}><Routes><Route path="/browser-ask/:id" element={<BrowserAsk />} /></Routes><DialogHost /></MemoryRouter>

test('a new site: who asks, the profile, the full address, the app line and the three answers', async () => {
  const m = await mount(page())
  try {
    await m.until(() => m.find('browser-ask-title'), 'the card')
    expect(m.get('browser-ask-title').textContent).toBe(en('browserAsk.title', { name: 'Claude Code' }))
    expect(m.get('browser-ask-profile').textContent).toContain('Work')
    expect(m.get('browser-ask-url').textContent).toBe('https://example.com/')
    expect(m.find('browser-ask-note')).toBeNull()
    expect(m.get('browser-ask-app').textContent).toContain('Claude Code · ')
    expect(m.get('browser-ask-always').textContent).toBe(en('browserAsk.always', { profile: 'Work' }))
    expect(m.get('browser-ask-once').textContent).toBe(en('browserAsk.once'))
    expect(m.get('browser-ask-no').textContent).toBe(en('browserAsk.no'))
  } finally { await m.unmount() }
})

test('a not-plain address: the whole address, never cut, and the note; no Always when it is not offered', async () => {
  answer = ask({ kind: 'address', url: URL_LONG, always: false, site: null })
  const m = await mount(page())
  try {
    await m.until(() => m.find('browser-ask-url'), 'the card')
    expect(m.get('browser-ask-url').textContent).toBe(URL_LONG)
    expect(m.get('browser-ask-note').textContent).toBe(en('browserAsk.addressNote'))
    expect(m.find('browser-ask-always')).toBeNull()
  } finally { await m.unmount() }
})

test('an office-network address: its own note', async () => {
  answer = ask({ kind: 'office', url: 'http://intranet.local/wiki', host: 'intranet.local', always: false, site: null })
  const m = await mount(page())
  try {
    await m.until(() => m.find('browser-ask-note'), 'the note')
    expect(m.get('browser-ask-note').textContent).toBe(en('browserAsk.officeNote'))
  } finally { await m.unmount() }
})

for (const decision of ['once', 'always', 'no'] as const)
  test(`${decision}: sends the decision, then says to go back to the app`, async () => {
    const m = await mount(page())
    try {
      await m.click(await m.until(() => m.find(`browser-ask-${decision}`), 'the button'))
      await m.until(() => m.find('browser-ask-done'), 'done')
      expect(m.get('browser-ask-done').textContent).toBe(en('browserAsk.done', { name: 'Claude Code' }))
      expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/api/chrome/asks/ask-1', body: { decision } })
      expect(m.find('browser-ask-once')).toBeNull()
    } finally { await m.unmount() }
  })

test('Disconnect this app asks first, then disconnects the connection and says so', async () => {
  const m = await mount(page())
  try {
    await m.click(await m.until(() => m.find('browser-ask-disconnect'), 'the link'))
    await m.click(await m.until(() => m.find('dialog-confirm'), 'the confirm'))
    await m.until(() => m.find('browser-ask-disconnected'), 'disconnected')
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/connectors/remote/conn-1')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  } finally { await m.unmount() }
})

test('cancelling the confirm disconnects nothing', async () => {
  const m = await mount(page())
  try {
    await m.click(await m.until(() => m.find('browser-ask-disconnect'), 'the link'))
    await m.click(await m.until(() => m.find('dialog-cancel'), 'the cancel'))
    await m.until(() => (m.find('dialog-cancel') ? null : true), 'closed')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(m.find('browser-ask-once')).not.toBeNull()
  } finally { await m.unmount() }
})

test('answered, expired or not mine (404): one plain line, no buttons', async () => {
  answer = null
  const m = await mount(page())
  try {
    await m.until(() => m.find('browser-ask-gone'), 'the line')
    expect(m.get('browser-ask-gone').textContent).toBe(en('browserAsk.gone'))
    expect(m.find('browser-ask-once')).toBeNull()
  } finally { await m.unmount() }
})
