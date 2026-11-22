// Settings › Security & devices › Google account (components/settings/GoogleAccount.tsx; Sign in with Google, part A2):
// right after a connect (?google=connected) one line offers the person's own Google Drive and Gmail, each a link to its
// connector page, only the ones they can connect and have not yet; none of them: no line. A plain visit: no line.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { GoogleAccount } from '../../src/components/settings/GoogleAccount'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ACCOUNT = { available: true, account: { email: 'mia@acme.test', connectedAt: '2026-11-22T06:00:00.000Z', lastUsedAt: null } }
const gmail = (o: { available?: boolean; status?: string } = {}) => ({ id: 'gmail', available: o.available ?? true, reason: null, status: o.status ?? 'disconnected', account: null, writePolicy: 'ask', serviceDown: false, tools: [] })
let drive = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
let apps = [gmail()]

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const p = String(input).split('?')[0]!
    if (p.endsWith('/api/me/google')) return json(200, ACCOUNT)
    if (p.endsWith('/api/integrations/google-drive')) return json(200, drive)
    if (p.endsWith('/api/integrations/google-apps')) return json(200, { apps })
    return json(404, { error: { code: 'not_found', message: 'no' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  drive = { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null }
  apps = [gmail()]
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

const render = (search: string) => mount(<MemoryRouter initialEntries={[`/settings/security${search}`]}><GoogleAccount phone={false} /></MemoryRouter>)

describe('after connecting a Google account', () => {
  test('one line offers Google Drive and Gmail, each a link to its page', async () => {
    const m = await render('?google=connected')
    const line = await m.until(() => m.find('google-also-connect'), 'the line')
    expect(line.textContent).toBe(`${translate('en', 'settings.google.alsoConnect')} Google Drive · Gmail`)
    expect(m.get('google-also-google-drive').getAttribute('href')).toBe('/settings/connectors/google-drive')
    expect(m.get('google-also-gmail').getAttribute('href')).toBe('/settings/connectors/gmail')
    await m.unmount()
  })

  test('only what is not connected yet and can be connected; nothing left: no line', async () => {
    drive = { ...drive, status: 'connected' }
    let m = await render('?google=connected')
    await m.until(() => m.find('google-also-connect'), 'the line')
    expect(m.find('google-also-google-drive')).toBeNull()
    expect(m.find('google-also-gmail')).toBeTruthy()
    await m.unmount()
    apps = [gmail({ available: false })]
    m = await render('?google=connected')
    await m.until(() => m.find('google-email'), 'the account')
    await m.settle(100)
    expect(m.find('google-also-connect')).toBeNull()
    await m.unmount()
  })

  test('a plain visit has no line', async () => {
    const m = await render('')
    await m.until(() => m.find('google-email'), 'the account')
    await m.settle(100)
    expect(m.find('google-also-connect')).toBeNull()
    await m.unmount()
  })
})
