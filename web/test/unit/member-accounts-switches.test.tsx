// Team settings › AI › members' own AI accounts (pages/admin/TeamAiSettings.tsx MemberAccounts): one save at a time. While
// a switch's change is being saved both switches are off, so two quick changes can't both go and come back the other way
// round, leaving the screen on a value the server did not keep.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { uuidv7, type Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { useSession } from '../../src/store/session'
import { MemberAccounts } from '../../src/pages/admin/TeamAiSettings'
import { useTeamCredentials } from '../../src/pages/admin/Credentials'
import { installDom, mount, removeDom } from './dom-host'

setDefaultTimeout(30_000)
const me = { user: { id: 'owner', username: 'owner', name: 'Owner', email: null, role: 'owner', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: uuidv7(), client: 'web', expiresAt: '2030-01-01T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
let settings = { memberOwn: false, sharedSubscriptions: false }
const patches: unknown[] = []
/** the answers to the saves, given by the test */
const answers: (() => void)[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    if (key === 'GET /api/admin/credentials') return json({ items: [], ...settings, allowedKinds: [], pricesAsOf: '2026-11-01' })
    if (key === 'GET /api/admin/trial-credit') return json({ credit: null })
    if (key === 'GET /api/admin/users') return json({ items: [] })
    if (key === 'GET /api/admin/groups') return json({ items: [] })
    if (key === 'PATCH /api/admin/credential-settings') {
      const body = JSON.parse(String(init!.body)) as Partial<typeof settings>
      patches.push(body)
      await new Promise<void>((r) => answers.push(r))
      settings = { ...settings, ...body }
      return json(settings)
    }
    return json({ error: { code: 'not_found', message: key } }, 404)
  }) as unknown as typeof fetch
})
afterEach(() => { patches.length = 0; answers.length = 0; useSession.setState({ status }) })
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale }) })

function Page() {
  const tc = useTeamCredentials()
  return <MemberAccounts tc={tc} />
}

test('while a switch saves, both are off; the screen ends on what the server kept', async () => {
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  settings = { memberOwn: false, sharedSubscriptions: false }
  const m = await mount(<MemoryRouter><Page /></MemoryRouter>)
  try {
    const own = () => m.get('member-own-switch') as unknown as { checked: boolean; disabled: boolean }
    const shared = () => m.get('shared-subscriptions-switch') as unknown as { checked: boolean; disabled: boolean }
    await m.until(() => m.find('member-own-switch'), 'the switch')
    expect(own().disabled).toBe(false)
    // turn members' own accounts on: the save is on its way
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(own()), 'checked')!.set!.call(own(), true)
    await m.click('member-own-switch')
    await m.until(() => patches.length === 1, 'the save')
    expect(patches).toEqual([{ memberOwn: true }])
    // both switches are off until its answer: a second click sends nothing
    expect(own().disabled).toBe(true)
    expect(shared().disabled).toBe(true)
    answers[0]!()
    await m.until(() => !own().disabled, 'the switch back on')
    expect(own().checked).toBe(true)
    expect(shared().disabled).toBe(false)
    expect(patches).toHaveLength(1)
  } finally { answers.forEach((a) => a()); await m.unmount() }
})
