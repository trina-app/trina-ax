// Settings › Trina AX MCP (pages/AiApps.tsx) for a connection with the browser scope (mcp:browser): "Browser" in its
// scope line; stopped in the browser (browserPausedUntil in the future): one line until when, and Resume, which lets it
// use the browser again and reads the list again. A past pause shows nothing.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, RemoteConnectionInfo } from '@mycel/shared/api'
import AiApps from '../../src/pages/AiApps'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const me = {
  user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me
const conn = (o: Partial<RemoteConnectionInfo> = {}): RemoteConnectionInfo => ({
  id: 'conn-1', clientName: 'Claude Code', scopes: ['mcp:read', 'mcp:rooms', 'mcp:browser', 'offline_access'],
  createdAt: '2026-11-20T01:00:00.000Z', expiresAt: '2027-02-20T01:00:00.000Z', browserPausedUntil: null, ...o,
})

let items: RemoteConnectionInfo[] = [conn()]
const calls: { method: string; url: string }[] = []
const realFetch = globalThis.fetch, status = useSession.getState().status
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (url === '/api/connectors/remote/conn-1/browser-resume' && method === 'POST') { items = items.map((x) => ({ ...x, browserPausedUntil: null })); return new Response(null, { status: 204 }) }
    if (url.startsWith('/api/connectors/remote')) return new Response(JSON.stringify({ configured: true, resource: 'https://acme.example.com/mcp', items }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
beforeEach(() => { calls.length = 0; items = [conn()]; useLocaleStore.setState({ locale: 'en' }); useSession.setState({ status: { kind: 'signed-in', me } } as never) })
afterEach(() => useSession.setState({ status }))
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

const page = () => <MemoryRouter><AiApps /></MemoryRouter>

test('"Browser" in the scope line; no pause, no line', async () => {
  const m = await mount(page())
  try {
    const row = await m.until(() => m.find('connector-item'), 'the connection')
    expect(row.textContent).toContain(` · ${en('aiApps.browserScope')}`)
    expect(m.find('connector-browser-paused')).toBeNull()
  } finally { await m.unmount() }
})

test('a pause in the past shows nothing', async () => {
  items = [conn({ browserPausedUntil: new Date(Date.now() - 60_000).toISOString() })]
  const m = await mount(page())
  try {
    await m.until(() => m.find('connector-item'), 'the connection')
    expect(m.find('connector-browser-paused')).toBeNull()
  } finally { await m.unmount() }
})

test('paused: the line until when, and Resume lets it use the browser again', async () => {
  items = [conn({ browserPausedUntil: new Date(Date.now() + 30 * 60_000).toISOString() })]
  const m = await mount(page())
  try {
    const line = await m.until(() => m.find('connector-browser-paused'), 'the paused line')
    expect(line.textContent).toContain(en('aiApps.browserPaused', { time: '' }).trim())
    await m.click('connector-browser-resume')
    await m.until(() => (m.find('connector-browser-paused') ? null : true), 'the line gone after Resume')
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/connectors/remote/conn-1/browser-resume'])
  } finally { await m.unmount() }
})

test('an app connecting elsewhere shows up without a reload: the quiet notice reads the list again (QA 2026-11-28 H)', async () => {
  const { integrationsChanged } = await import('../../src/store/live')
  items = []
  const m = await mount(page())
  try {
    await m.until(() => calls.some((c) => c.url.startsWith('/api/connectors/remote')), 'the first read')
    expect(m.find('connector-item')).toBeNull()
    items = [conn({ id: 'conn-2', clientName: 'Claude' })]
    integrationsChanged.emit()
    const row = await m.until(() => m.find('connector-item'), 'the new connection')
    expect(row.textContent).toContain('Claude')
  } finally { await m.unmount() }
})
