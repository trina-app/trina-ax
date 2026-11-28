// The consent page's "Use my browser profiles" box (pages/ConnectorConsent.tsx, scope mcp:browser): offered by the
// server, unticked at first (the strongest box, like "Write in conversations"), `browser` sent as ticked, and a line to
// link a browser first when the person has none (the box stays tickable). An older server that does not offer it: no
// box and no `browser` field.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me, RemoteConsentInfo } from '@mycel/shared/api'
import ConnectorConsent from '../../src/pages/ConnectorConsent'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('en', k, p)
const ID = 'a'.repeat(43)
const me = {
  user: { id: 'mia', username: 'mia', name: 'Mia', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me
const consent = (o: Partial<RemoteConsentInfo> = {}): RemoteConsentInfo => ({
  id: ID, clientName: 'Claude Code', redirectOrigin: 'http://127.0.0.1:5555', scopes: ['mcp:read'], optional: ['mcp:write', 'mcp:rooms', 'mcp:rooms.write', 'mcp:browser'],
  admin: false, resource: 'https://acme.example.com/mcp', expiresAt: '2099-01-01T00:00:00.000Z', browserProfiles: 1, ...o,
})

let answer = consent()
const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = []
const assigned: string[] = []
const realFetch = globalThis.fetch, status = useSession.getState().status
let hadLocation = false
beforeAll(() => {
  installDom()
  hadLocation = 'location' in globalThis
  if (!hadLocation) Object.assign(globalThis, { location: { origin: 'https://acme.example.com', assign: (u: string) => { assigned.push(u) } } })
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/connectors/remote/requests/')) return json(method === 'GET' ? answer : { redirectUrl: 'http://127.0.0.1:5555/callback?code=x' })
    return json({})
  }) as unknown as typeof fetch
})
beforeEach(() => { calls.length = 0; assigned.length = 0; answer = consent(); useLocaleStore.setState({ locale: 'en' }); useSession.setState({ status: { kind: 'signed-in', me } } as never) })
afterEach(() => useSession.setState({ status }))
afterAll(() => {
  globalThis.fetch = realFetch
  if (!hadLocation) delete (globalThis as Record<string, unknown>).location
  removeDom()
})

const page = () => <MemoryRouter initialEntries={[`/connectors/authorize?id=${ID}`]}><ConnectorConsent /></MemoryRouter>
const check = (m: Awaited<ReturnType<typeof mount>>) => m.get('connector-browser-check') as unknown as { checked: boolean }
/** a browser checks the box before the click's listeners run, past React's value tracker (this small DOM does not) */
const tick = async (m: Awaited<ReturnType<typeof mount>>) => {
  const box = await m.until(() => m.find('connector-browser-check'), 'the box')
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'checked')!.set!.call(box, true)
  await m.click(box)
}
const decided = () => calls.find((c) => c.method === 'POST')?.body

test('the box is offered unticked, with its line; Allow without ticking sends browser: false', async () => {
  const m = await mount(page())
  try {
    await m.until(() => m.find('connector-browser'), 'the box')
    expect(check(m).checked).toBe(false)
    expect(m.get('connector-browser').textContent).toContain(en('connectors.browserOptIn'))
    expect(m.get('connector-browser').textContent).toContain(en('connectors.browser'))
    expect(m.get('connector-browser').textContent).not.toContain(en('connectors.browserNoProfile'))
    await m.click('connector-allow')
    await m.until(() => assigned.length > 0, 'the redirect')
    expect(decided()).toMatchObject({ allow: true, browser: false })
  } finally { await m.unmount() }
})

test('ticked: Allow sends browser: true', async () => {
  const m = await mount(page())
  try {
    await tick(m)
    expect(check(m).checked).toBe(true)
    await m.click('connector-allow')
    await m.until(() => assigned.length > 0, 'the redirect')
    expect(decided()).toMatchObject({ allow: true, browser: true })
  } finally { await m.unmount() }
})

test('no linked browser: the line says to link one first, and the box can still be ticked', async () => {
  answer = consent({ browserProfiles: 0 })
  const m = await mount(page())
  try {
    await m.until(() => m.find('connector-browser'), 'the box')
    expect(m.get('connector-browser').textContent).toContain(en('connectors.browserNoProfile'))
    await tick(m)
    expect(check(m).checked).toBe(true)
  } finally { await m.unmount() }
})

test('a server that does not offer it: no box and no browser field', async () => {
  answer = consent({ optional: ['mcp:write', 'mcp:rooms', 'mcp:rooms.write'], browserProfiles: undefined })
  const m = await mount(page())
  try {
    await m.until(() => m.find('connector-allow'), 'the page')
    expect(m.find('connector-browser')).toBeNull()
    await m.click('connector-allow')
    await m.until(() => assigned.length > 0, 'the redirect')
    expect(decided()).not.toHaveProperty('browser')
  } finally { await m.unmount() }
})
