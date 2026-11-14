// Settings › Notifications › Phone › "Phone notifications" (components/settings/PhoneGatewayRow.tsx, docs/DECISIONS.md
// "Owners and admins choose where phone notifications go"): owners and admins pick the product's push service (the
// default), Off or Custom. Default and Off save at once; Custom shows an address field with one line under it and
// saves with its button, and a refused address says why (nothing saved). Set in the server's own settings: the value,
// where it is set, no control. Members get no row and the page never asks the server for it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Me, PushGatewaySetting } from '@mycel/shared/api'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { translate, useLocaleStore, type MessageKey, type Params } from '../../src/i18n'
import { PhoneGatewayRow } from '../../src/components/settings/PhoneGatewayRow'
import { Notifications } from '../../src/components/settings/Notifications'
import { MemoryRouter } from 'react-router-dom'
import { FakeEvent, installDom, mount as mountUi, removeDom, type Mounted } from './dom-host'

const en = (k: MessageKey, p?: Params) => translate('en', k, p)
const realFetch = globalThis.fetch
const status = useSession.getState().status, locale = useLocaleStore.getState().locale
const me = (role: string) => ({ user: { id: 'olga', username: 'olga', name: 'Olga', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'en' }, session: { id: 's', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false, deployment: 'self' } }) as unknown as Me
const base: PushGatewaySetting = { choice: 'default', url: null, defaultHost: 'push.trina.app', lockedBy: null }

let calls: { method: string; path: string; body: unknown }[] = []
let server: PushGatewaySetting = base
let refuse: string | null = null
function fakeServer() {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input), 'http://team.localhost')
    const method = (init.method ?? 'GET').toUpperCase(), body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/admin/push-gateway') {
      if (method === 'GET') return Response.json(server)
      if (refuse) return Response.json({ error: { code: 'validation', message: 'Check the fields.', params: { reason: refuse } } }, { status: 400 })
      server = { ...server, choice: body.choice, url: body.choice === 'custom' ? body.url : null }
      return Response.json(server)
    }
    if (u.pathname === '/api/notification-preferences') return Response.json({ scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true, chatAnswers: true, phoneWhen: 'away' })
    if (u.pathname === '/api/push') return Response.json({ configured: false, enabled: false, publicKey: null, subscriptionId: null })
    return Response.json({})
  }) as unknown as typeof fetch
}
/** pick an option in a <select>, as a person does (React reads the change event) */
// every page is taken down after its test, also one that failed half way
const pages: Mounted[] = []
const mount = async (ui: Parameters<typeof mountUi>[0]) => { const p = await mountUi(ui); pages.push(p); return p }
const choose = async (page: Mounted, value: string) => {
  const select = page.get('phone-gateway-choice')
  await page.type(select, value)
  const { act } = await import('react')
  await act(async () => { select.dispatchEvent(new FakeEvent('change', { bubbles: true })) })
  await page.settle(30)
}

beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
beforeEach(() => { calls = []; server = base; refuse = null; fakeServer(); useSession.setState({ status: { kind: 'signed-in', me: me('admin') } } as never) })
afterEach(async () => { for (const p of pages.splice(0)) await p.unmount(); globalThis.fetch = realFetch })
afterAll(() => { removeDom(); useSession.setState({ status }); useLocaleStore.setState({ locale }) })

describe('an owner or admin', () => {
  test('sees the default with what it means; Off saves at once', async () => {
    const page = await mount(<PhoneGatewayRow />)
    const select = await page.until(() => page.find('phone-gateway-choice'), 'the choice')
    expect(select.querySelectorAll('option').map((o) => o.textContent)).toEqual(['Trina AX push (default)', 'Off', 'Custom'])
    expect(page.get('phone-gateway').textContent).toContain(en('pushGateway.desc.default'))
    expect(page.find('phone-gateway-custom')).toBeNull()
    await choose(page, 'off')
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/admin/push-gateway', body: { choice: 'off' } }])
    expect(page.get('phone-gateway').textContent).toContain(en('pushGateway.desc.off'))
    await page.unmount()
  })

  test('Custom shows the address field and its one line; nothing is saved until Save, and a refusal says why', async () => {
    const page = await mount(<PhoneGatewayRow />)
    await page.until(() => page.find('phone-gateway-choice'), 'the choice')
    await choose(page, 'custom')
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    expect(page.get('phone-gateway-custom').textContent).toContain(en('pushGateway.customNote'))
    expect(page.get('phone-gateway-save').hasAttribute('disabled')).toBe(true)
    useUi.setState({ toasts: [] })
    await page.type('phone-gateway-address', 'https://push.example.com')
    refuse = 'not_gateway'
    await page.click('phone-gateway-save')
    const error = await page.until(() => page.find('phone-gateway-error'), 'the reason')
    expect(error.textContent).toContain(en('pushGateway.problem.not_gateway'))
    // a refusal saves nothing and says nothing was saved
    expect(useUi.getState().toasts).toEqual([])
    expect(server.choice).toBe('default')
    // still Custom with what was typed, to fix it
    expect((page.get('phone-gateway-address') as unknown as { value: string }).value).toBe('https://push.example.com')
    refuse = null
    await page.click('phone-gateway-save')
    await page.until(() => !page.find('phone-gateway-error') && server.choice === 'custom', 'the save')
    expect(calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual({ choice: 'custom', url: 'https://push.example.com' })
    expect(page.get('phone-gateway').textContent).toContain(en('pushGateway.desc.custom'))
    await page.unmount()
  })

  test('set in the server\'s settings: the value and where, no control', async () => {
    server = { choice: 'custom', url: 'https://own.example.com', defaultHost: 'push.trina.app', lockedBy: 'MYCEL_PUSH_GATEWAY' }
    const page = await mount(<PhoneGatewayRow />)
    await page.until(() => page.find('phone-gateway-locked'), 'the lock line')
    expect(page.find('phone-gateway-choice')).toBeNull()
    expect(page.find('phone-gateway-address')).toBeNull()
    expect(page.get('phone-gateway-value').textContent).toBe('Custom')
    expect(page.get('phone-gateway-url').textContent).toBe('https://own.example.com')
    expect(page.get('phone-gateway-locked').textContent).toBe(en('pushGateway.locked', { where: 'MYCEL_PUSH_GATEWAY' }))
    await page.unmount()
  })

  test('a build without a default push service: Off and Custom only', async () => {
    server = { ...base, choice: 'off', defaultHost: null }
    const page = await mount(<PhoneGatewayRow />)
    const select = await page.until(() => page.find('phone-gateway-choice'), 'the choice')
    expect(select.querySelectorAll('option').map((o) => o.textContent)).toEqual(['Off', 'Custom'])
    await page.unmount()
  })
})

describe('Settings › Notifications', () => {
  test('an admin gets the row in the Phone section; the browser\'s own row says it is the browser\'s', async () => {
    const page = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
    const row = await page.until(() => page.find('phone-gateway'), 'the row')
    expect(page.get('notifications-phone').contains(row)).toBe(true)
    // QA TC-1537: this browser's row is named for the browser, so its "not set up" is not read as phone push being off
    const browser = await page.until(() => page.find('push-notifications'), 'the browser row')
    expect(browser.textContent).toContain(en('push.titleBrowser'))
    expect(browser.textContent).toContain(en('push.notConfiguredBrowser'))
    expect(page.find('phone-gateway')!.closest('[data-testid="push-notifications"]')).toBeNull()
    await page.unmount()
  })
  test('a member gets no row, and the page never asks for it', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('member') } } as never)
    const page = await mount(<MemoryRouter><Notifications /></MemoryRouter>)
    await page.until(() => page.find('notifications-phone'), 'the Phone section')
    await page.settle(50)
    expect(page.find('phone-gateway')).toBeNull()
    expect(calls.some((c) => c.path === '/api/admin/push-gateway')).toBe(false)
    await page.unmount()
  })
})
