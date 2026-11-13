// Admin › Connectors › a listed service › "Connect for the team" (QA TC-134 retest): who may use the team connection
// starts as the whole team. Saved without opening Advanced, the request says everyone; the admin may still narrow it.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { IntegrationDialog, TEAM_DEFAULT_ACCESS } from '../../src/components/integrations/IntegrationDialog'
import { CONNECTORS } from '../../src/lib/connectors'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
const realFetch = globalThis.fetch
const posted: unknown[] = []
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  useSession.setState({ status: { kind: 'signed-in', me: { user: { id: 'olga', username: 'olga', name: 'Olga', role: 'owner', prefs: {} }, team: { name: 'Acme', defaultLocale: 'en' }, groups: [], session: { id: 's', client: 'web' }, server: { version: '0', dev: true } } as unknown as Me } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    if (url.pathname === '/api/admin/integrations' && init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ error: { code: 'internal', message: 'stop here' } }), { status: 500, headers: { 'content-type': 'application/json' } }) }
    if (url.pathname.endsWith('/groups')) return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } })
    if (url.pathname.endsWith('/users')) return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch; removeDom(); useLocaleStore.setState({ locale }); useSession.setState({ status }) })

test('the default is the whole team', () => {
  expect(TEAM_DEFAULT_ACCESS).toEqual({ everyone: true, groups: [], users: [] })
})

test('"Connect for the team" saved without opening Advanced: the whole team may use it', async () => {
  const notion = CONNECTORS.find((c) => c.id === 'notion')!
  const m = await mount(<MemoryRouter><IntegrationDialog scope="team" connector={notion} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    expect(m.get('integration-advanced').getAttribute('aria-expanded')).toBe('false')
    await m.click('integration-save')
    await m.until(() => posted.length > 0, 'the save request')
    expect(posted[0]).toMatchObject({ name: 'Notion', url: notion.url, access: { everyone: true, groups: [], users: [] } })
  } finally { await m.unmount() }
})

test('who it is for shows without opening Advanced; Change opens the chooser under that line', async () => {
  const notion = CONNECTORS.find((c) => c.id === 'notion')!
  const m = await mount(<MemoryRouter><IntegrationDialog scope="team" connector={notion} onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try {
    expect(m.get('integration-for').textContent).toContain('For: Everyone in the team')
    expect(m.get('integration-advanced').getAttribute('aria-expanded')).toBe('false')
    // the sign-in note shares that line (QA TC-187)
    expect(m.get('integration-for').textContent).toContain('You sign in next, in a new window.')
    expect(m.find('integration-access')).toBeNull()
    await m.click('integration-for-change')
    // who may use it opens under the line, not again inside Advanced
    expect(m.get('integration-for-change').getAttribute('aria-expanded')).toBe('true')
    expect(m.find('integration-access')).not.toBeNull()
    expect(m.get('integration-advanced').getAttribute('aria-expanded')).toBe('false')
  } finally { await m.unmount() }
})

test('a member\'s own connection has no such line', async () => {
  const m = await mount(<MemoryRouter><IntegrationDialog scope="personal" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>)
  try { expect(m.find('integration-for')).toBeNull() } finally { await m.unmount() }
})
