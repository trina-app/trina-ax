// Admin › System › Health "Restart…" (pages/admin/System.tsx Restart / AdminRestart; docs/decisions/20261127-restart.md):
// one row with what goes on and one button; the dialog asks what (only the choices the server offers) and when, then
// the password. The owner may restart right away, an admin only when answers finish. While a restart waits: the count of
// running answers (never whose), "Restart now" for the owner and "Don't restart" for both.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { Me, RestartStatus } from '@mycel/shared/api'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { AdminRestart, Restart } from '../../src/pages/admin/System'
import { useSession } from '../../src/store/session'
import { FakeElement, installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const session = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)

const base = (over: Partial<RestartStatus> = {}): RestartStatus => ({
  options: { server: true, ai: true }, now: true, running: 2, waiting: null, last: null, failed: null, blocked: null, watchdogGaveUp: null, ...over,
})
let status: RestartStatus = base()
const sent: { method: string; path: string; body: unknown }[] = []

const me = (role: 'owner' | 'admin'): Me => ({
  user: { id: 'pia', username: 'pia', name: 'Pia', email: null, role, locale: 'en', localeChoice: null, mustChangePassword: false, hasPassword: true, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self' },
} as unknown as Me)

beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (url.pathname.startsWith('/api/admin/restart')) {
      if (method !== 'GET') sent.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method === 'POST' && url.pathname === '/api/admin/restart') {
        const b = JSON.parse(String(init!.body)) as { what: 'ai' | 'server'; when: string }
        status = { ...status, waiting: b.when === 'idle' ? { what: b.what, since: '2026-11-27T01:00:00.000Z', until: '2026-11-27T01:10:00.000Z', mayCancel: true } : null }
        return json(status, 202)
      }
      if (method === 'DELETE') { status = { ...status, waiting: null }; return json(status) }
      if (method === 'POST' && url.pathname === '/api/admin/restart/now') { status = { ...status, waiting: status.waiting && { ...status.waiting, going: true, mayCancel: false } }; return json(status) }
      return json(status)
    }
    return json({ error: { code: 'not_found', message: url.pathname } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => { sent.length = 0; status = base(); useSession.setState({ status: session }) })
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale }) })

describe('the restart row', () => {
  test('the owner: both choices, both whens, the request carries the password and the choice', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('owner') } })
    const m = await mount(<MemoryRouter><Restart /></MemoryRouter>)
    try {
      const line = await m.until(() => m.find('restart-line'), 'the row')
      expect(line.textContent).toBe(en('system.restart.idle'))
      await m.click('restart-open')
      await m.until(() => m.find('restart-dialog'), 'the dialog')
      expect(m.find('restart-what-ai')).not.toBeNull()
      expect(m.find('restart-what-server')).not.toBeNull()
      // a count only, never whose
      expect(m.get('restart-running').textContent).toBe(en('system.restart.running', { count: 2 }))
      expect(m.find('restart-now-confirm')).not.toBeNull()
      // a browser checks the radio before the click's handlers run (React reads it there)
      Object.getOwnPropertyDescriptor(FakeElement.prototype, 'checked')!.set!.call(m.get('restart-what-server'), true)
      await m.click('restart-what-server')
      await m.type('reauth-password', 'river stone')
      await m.click('reauth-confirm')
      await m.until(() => sent.length, 'the request')
      expect(sent[0]).toEqual({ method: 'POST', path: '/api/admin/restart', body: { password: 'river stone', what: 'server', when: 'idle' } })
      // waiting: the count, Restart now and Don't restart
      const waiting = await m.until(() => m.find('restart-cancel') && m.find('restart-line'), 'the waiting line')
      expect(waiting.textContent).toBe(en('system.restart.waiting', { count: 2 }))
      expect(m.find('restart-now')).not.toBeNull()
      await m.click('restart-cancel')
      await m.until(() => sent.length === 2, 'the cancel')
      expect(sent[1]).toMatchObject({ method: 'DELETE', path: '/api/admin/restart' })
      await m.until(() => m.find('restart-open'), 'the button again')
    } finally { await m.unmount() }
  })

  test('an admin: its own card, only "when answers finish", and no Restart now while one waits', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } })
    status = base({ now: false, options: { server: true, ai: false } })
    const m = await mount(<MemoryRouter><AdminRestart /></MemoryRouter>)
    try {
      await m.until(() => m.find('system-health'), 'the card')
      await m.click('restart-open')
      await m.until(() => m.find('restart-dialog'), 'the dialog')
      expect(m.find('restart-what-ai')).toBeNull() // one choice: no radio
      expect(m.get('restart-dialog').textContent).toContain(en('system.restart.server'))
      expect(m.find('restart-now-confirm')).toBeNull()
      await m.type('reauth-password', 'river stone')
      await m.click('reauth-confirm')
      await m.until(() => m.find('restart-cancel'), 'waiting')
      expect(m.find('restart-now')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the owner: Restart now while one waits asks for the password again', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('owner') } })
    status = base({ waiting: { what: 'server', since: '2026-11-27T01:00:00.000Z', until: '2026-11-27T01:10:00.000Z', mayCancel: true } })
    const m = await mount(<MemoryRouter><Restart /></MemoryRouter>)
    try {
      await m.until(() => m.find('restart-now'), 'Restart now')
      await m.click('restart-now')
      await m.until(() => m.find('restart-now-dialog'), 'the password dialog')
      expect(sent).toHaveLength(0)
      await m.type('reauth-password', 'river stone')
      await m.click('reauth-confirm')
      await m.until(() => sent.length, 'the request')
      expect(sent[0]).toEqual({ method: 'POST', path: '/api/admin/restart/now', body: { password: 'river stone' } })
      await m.until(() => !m.find('restart-now-dialog') && m.get('restart-line').textContent === en('system.restart.started'), 'going')
    } finally { await m.unmount() }
  })

  test('an admin cannot call off a restart someone else asked for', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('admin') } })
    status = base({ now: false, waiting: { what: 'server', since: '2026-11-27T01:00:00.000Z', until: '2026-11-27T01:10:00.000Z', mayCancel: false } })
    const m = await mount(<MemoryRouter><AdminRestart /></MemoryRouter>)
    try {
      await m.until(() => m.find('restart-line'), 'the row')
      expect(m.find('restart-cancel')).toBeNull()
      expect(m.find('restart-now')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a refusal and a watchdog give-up are said; the button waits; no restart offered: no row', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me('owner') } })
    status = base({ blocked: 'An update is under way.', watchdogGaveUp: { since: '2026-11-27T01:00:00.000Z' } })
    const m = await mount(<MemoryRouter><Restart /></MemoryRouter>)
    try {
      await m.until(() => m.find('restart-blocked'), 'the refusal')
      expect(m.get('restart-blocked').textContent).toBe('An update is under way.')
      expect(m.get('restart-open').disabled).toBe(true)
      expect(m.get('restart-gave-up').textContent).toBe(en('system.restart.gaveUp'))
    } finally { await m.unmount() }
    status = base({ options: { server: false, ai: false } })
    const none = await mount(<MemoryRouter><AdminRestart /></MemoryRouter>)
    try {
      await none.settle(100)
      expect(none.find('system-health')).toBeNull()
    } finally { await none.unmount() }
  })
})
