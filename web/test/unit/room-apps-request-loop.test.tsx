// The apps dialog must not loop its requests (QA TC-2481): with it open on the list, one app's settings or a guide, the
// room's apps were read ~1,000 times a second, because the effect that loads them was keyed on useT()'s function, a
// new one on every render (and each load renders again). The dialog reads the list once when it opens; while an app
// waits for its first message, useLive reads it again every 4 s. Here the requests are counted over a few seconds of
// real time: a loop shows hundreds, the right behaviour one to three.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { useEffect, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { useLocaleStore, useT } from '../../src/i18n'
import { AppsDialog } from '../../src/components/rooms/apps/AppsDialog'
import { useRoomApps } from '../../src/store/roomApps'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const ROOM = '01900000-0000-7000-8000-0000000000a1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const app = (o: Record<string, unknown> = {}) => ({
  id: 'app-typeform', roomId: ROOM, kind: 'other', preset: 'typeform', name: 'Typeform', events: { response: true }, quiet: false, signed: false,
  createdBy: { id: 'mia', name: 'Mia' }, createdAt: new Date(Date.now() - 30_000).toISOString(), firstOkAt: null, lastOkAt: null, lastRefusal: null,
  pausedUntil: null, canResume: false, today: 0, eventsSeen: [], ...o,
})
let gets = 0
let items: unknown[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === `/api/rooms/${ROOM}/apps`) {
      gets++
      // a loop is stopped here (no more answers), so the test fails on its count instead of starving the event loop
      if (gets > 50) return new Promise<Response>(() => {})
      return json(200, { items, available: true, max: 10 })
    }
    if (method === 'GET' && path.endsWith('/address')) return json(200, { address: 'https://acme.example.com/in/tax_in_x' })
    return json(404, { error: { code: 'not_found', message: path } })
  }) as unknown as typeof fetch
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'mia', name: 'Mia', role: 'owner' }, groups: [], team: { name: 'Acme', defaultLocale: 'en', projectCreators: 'members' }, server: { version: '0', dev: false } } } } as never)
})
afterEach(() => { gets = 0; useRoomApps.setState({ lists: {}, dialog: null }) })
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('useT() is the same function until the language changes (an effect keyed on it does not run after every render)', async () => {
  const seen: unknown[] = []
  // three renders (each one sets state once more), the language the same
  function Probe() {
    const t = useT()
    const [n, setN] = useState(0)
    seen.push(t)
    useEffect(() => { if (n < 2) setN(n + 1) }, [n])
    return <p data-testid="t">{n}</p>
  }
  const m = await mount(<Probe />)
  await m.settle()
  expect(seen.length).toBeGreaterThanOrEqual(3)
  const first = seen[0]
  expect(seen.every((x) => x === first)).toBe(true)
  await m.unmount()
})

test('the list (an app that is connected): the apps are read once, not again and again', async () => {
  items = [app({ firstOkAt: new Date().toISOString(), lastOkAt: new Date().toISOString() })]
  const m = await mount(<MemoryRouter><AppsDialog roomId={ROOM} start={{ view: 'auto' }} /></MemoryRouter>)
  await m.until(() => m.find('apps-list'), 'the list', 3000)
  const at = gets
  await m.settle(2500)
  expect(gets - at).toBeLessThanOrEqual(1)
  expect(gets).toBeLessThanOrEqual(2)
  await m.unmount()
})

test('a guide and settings of an app that waits: read at open, then every 4 s, never in a loop', async () => {
  items = [app()]
  const g = await mount(<MemoryRouter><AppsDialog roomId={ROOM} start={{ view: 'guide', service: 'typeform', appId: 'app-typeform' }} /></MemoryRouter>)
  await g.until(() => g.find('apps-guide'), 'the guide', 3000)
  await g.settle(4500)
  // the first read and one poll (two at most, with timing slack)
  expect(gets).toBeLessThanOrEqual(3)
  await g.unmount()
  gets = 0
  const s = await mount(<MemoryRouter><AppsDialog roomId={ROOM} start={{ view: 'settings', appId: 'app-typeform' }} /></MemoryRouter>)
  await s.until(() => s.find('apps-settings'), 'settings', 3000)
  await wait(10)
  await s.settle(2500)
  expect(gets).toBeLessThanOrEqual(2)
  await s.unmount()
}, 20_000)
