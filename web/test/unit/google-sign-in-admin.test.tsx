// Admin › Team settings › "Sign in with Google" (pages/admin/TeamSettings.tsx GoogleSignInSwitch; Sign in with Google,
// part A2): the switch where this server has a Google client (GET /api/admin/google-login), else one line with a link to
// Connected apps › Google Drive, where a server gets one; nothing while it reads or on an older server.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { GoogleSignInSwitch } from '../../src/pages/admin/TeamSettings'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
let answer: () => Response = () => new Response('{}', { status: 500 })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).split('?')[0]!.endsWith('/api/admin/google-login') ? answer() : json(404, { error: { code: 'not_found', message: 'no' } }))) as unknown as typeof fetch
})
afterEach(() => { answer = () => new Response('{}', { status: 500 }) })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
})

const render = (value: boolean) => mount(<MemoryRouter><GoogleSignInSwitch value={value} onChange={() => {}} /></MemoryRouter>)

describe('the Sign in with Google row', () => {
  test('a Google client: the switch, on or off as the setting says', async () => {
    answer = () => json(200, { client: true })
    const m = await render(true)
    const row = await m.until(() => m.find('team-google-sign-in'), 'the row')
    expect(row.getAttribute('data-on')).toBe('true')
    expect(row.textContent).toContain(translate('en', 'teamSettings.googleSignIn'))
    expect(row.textContent).toContain(translate('en', 'teamSettings.row.googleSignInDesc'))
    expect(m.find('team-google-sign-in-setup')).toBeNull()
    await m.unmount()
    const off = await render(false)
    expect((await off.until(() => off.find('team-google-sign-in'), 'the row')).getAttribute('data-on')).toBe('false')
    await off.unmount()
  })

  test('no Google client: one line and a link to where a server gets one', async () => {
    answer = () => json(200, { client: false })
    const m = await render(true)
    const row = await m.until(() => m.find('team-google-sign-in'), 'the row')
    expect(row.getAttribute('data-client')).toBe('none')
    expect(row.textContent).toContain(translate('en', 'teamSettings.googleSignInNoClient'))
    expect(m.get('team-google-sign-in-setup').getAttribute('href')).toBe('/admin/connectors/google-drive')
    await m.unmount()
  })

  test('an older server without the read: no row', async () => {
    answer = () => json(404, { error: { code: 'not_found', message: 'no' } })
    const m = await render(true)
    await m.settle(100)
    expect(m.find('team-google-sign-in')).toBeNull()
    await m.unmount()
  })
})
