// The one-time dev environment offer for a team from before it came (QA TC-4911, pages/admin/DevEnvOfferNotice.tsx):
// shown to an owner or admin while the server offers it and can run it, in plain words with the way to the switch;
// closed with ✕ it is saved as seen (PATCH /api/me) and never shows again; a member never sees it.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { DevEnvOfferNotice, offerShown } from '../../src/pages/admin/DevEnvOfferNotice'
import { translate, useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const en = (k: Parameters<typeof translate>[1]) => translate('en', k, {})
const meWith = (o: { role?: 'member' | 'admin'; seen?: boolean; devEnv?: boolean } = {}) => ({
  user: { id: 'carol', username: 'carol', name: 'Carol', email: null, role: o.role ?? 'admin', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: o.seen ? { devEnvOffer: 'seen' } : {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'en', chatTrashRetentionDays: 14 },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self', ...(o.devEnv === false ? {} : { devEnv: true }) },
}) as unknown as Me

let offer = true
const calls: { method: string; url: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const status = useSession.getState().status
const team = () => ({
  setting: { enabled: false, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: { cpus: 1, memoryMiB: 1024, pids: 256, idleStopMin: 30 }, extraDomains: [], consent: null },
  defaultDomains: [], plan: null, warningVersion: 2, availability: { available: true }, offer,
})
beforeAll(() => {
  installDom()
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('/api/admin/dev-env')) return json(team())
    if (url.startsWith('/api/me') && method === 'PATCH') return json(meWith({ seen: true }))
    return json({})
  }) as unknown as typeof fetch
})
beforeEach(() => { calls.length = 0; offer = true; useLocaleStore.setState({ locale: 'en' }) })
afterEach(() => useSession.setState({ status }))
afterAll(() => { globalThis.fetch = realFetch; removeDom() })

test('offerShown: only an offer the server can carry out', () => {
  expect(offerShown(null)).toBe(false)
  expect(offerShown({ offer: true, availability: { available: true } } as never)).toBe(true)
  expect(offerShown({ offer: true } as never)).toBe(true)
  expect(offerShown({ offer: true, availability: { available: false, reason: 'platform' } } as never)).toBe(false)
  expect(offerShown({ offer: false, availability: { available: true } } as never)).toBe(false)
})

test('an admin reads it in plain words with the way to the switch; ✕ saves it as seen', async () => {
  useSession.setState({ status: { kind: 'signed-in', me: meWith() } } as never)
  const m = await mount(<MemoryRouter><DevEnvOfferNotice /></MemoryRouter>)
  try {
    const n = await m.until(() => m.find('admin-dev-env-offer'), 'the offer')
    expect(n.textContent).toContain(en('adminHome.devEnvOffer'))
    expect(n.textContent).toContain(en('devEnvOffer.body'))
    expect(m.get('admin-dev-env-offer-open').getAttribute('href')).toBe('/admin/settings#dev-env')
    await m.click('admin-dev-env-offer-close')
    expect(m.find('admin-dev-env-offer')).toBeNull()
    await m.until(() => calls.find((c) => c.method === 'PATCH'), 'the save')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ prefs: { devEnvOffer: 'seen' } })
  } finally { await m.unmount() }
})

test('nothing for a member, once seen, without the dev environment, or when the server does not offer it', async () => {
  for (const me of [meWith({ role: 'member' }), meWith({ seen: true }), meWith({ devEnv: false })]) {
    useSession.setState({ status: { kind: 'signed-in', me } } as never)
    const m = await mount(<MemoryRouter><DevEnvOfferNotice /></MemoryRouter>)
    try {
      await m.settle(60)
      expect(m.find('admin-dev-env-offer')).toBeNull()
      expect(calls.some((c) => c.url.startsWith('/api/admin/dev-env'))).toBe(false)
    } finally { await m.unmount() }
  }
  offer = false
  useSession.setState({ status: { kind: 'signed-in', me: meWith() } } as never)
  const m = await mount(<MemoryRouter><DevEnvOfferNotice /></MemoryRouter>)
  try {
    await m.until(() => calls.some((c) => c.url.startsWith('/api/admin/dev-env')), 'the read')
    await m.settle(60)
    expect(m.find('admin-dev-env-offer')).toBeNull()
  } finally { await m.unmount() }
})
