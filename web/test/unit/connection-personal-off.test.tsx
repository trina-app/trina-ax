// A member's own connection while the team has "Members can add their own connections" off (QA TC-2930): it is kept,
// but not used in chats and not signed in again (server store.ts offByTeam). Its line in Your connectors says "Off"
// instead of "Connected" (lib/integrations.ts connectionRowStatus), and its page says "Off", one line on why, and has no
// Sign in again (components/integrations/ConnectionPage.tsx).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Integration } from '@mycel/shared/api'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import { connectionRowStatus } from '../../src/lib/integrations'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { ConnectionPage } from '../../src/components/integrations/ConnectionPage'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const now = new Date().toISOString()
const mine: Integration = {
  id: '01900000-0000-7000-8000-0000000000c1', scope: 'personal', kind: 'mcp', name: 'Notes', slug: 'notes', url: 'https://notes.example.com/mcp',
  auth: 'oauth', authHeader: null, hasSecret: true, account: null, notes: null, writePolicy: 'ask', status: 'connected', lastError: null, tools: [],
  toolsUpdatedAt: null, access: null, createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: null, canManage: true,
}

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

async function page(i: Integration) {
  function Page() {
    const actions = useIntegrationActions({ add: () => {}, replace: () => {}, reload: () => {} })
    return <MemoryRouter><ConnectionPage i={i} actions={actions} onEdit={() => {}} about="" /></MemoryRouter>
  }
  return mount(<Page />)
}

test('its line in Your connectors: Off, whatever its state; without the mark as before', () => {
  expect(connectionRowStatus({ ...mine, personalOff: true })).toBe('off')
  expect(connectionRowStatus({ ...mine, status: 'needs_auth', personalOff: true })).toBe('off')
  expect(connectionRowStatus({ ...mine, hasSecret: false, status: 'needs_auth', personalOff: true })).toBe('off')
  expect(connectionRowStatus(mine)).toBe('connected')
})

test('its page: Off, the line why, no Sign in again; the same connection without the mark says Connected and offers it', async () => {
  const off = await page({ ...mine, personalOff: true })
  try {
    expect(off.get('connection-status').getAttribute('data-state')).toBe('personal-off')
    expect(off.get('connection-status').textContent).toBe(translate('en', 'appConnectors.off'))
    expect(off.get('integration-personal-off').textContent).toBe(translate('en', 'connectors.page.personalOff'))
    await off.click('connection-menu')
    expect(off.find('integration-signin-again')).toBeNull()
    expect(off.find('integration-delete')).not.toBeNull()
  } finally { await off.unmount() }
  const on = await page(mine)
  try {
    expect(on.get('connection-status').getAttribute('data-state')).toBe('connected')
    expect(on.find('integration-personal-off')).toBeNull()
    await on.click('connection-menu')
    expect(on.find('integration-signin-again')).not.toBeNull()
  } finally { await on.unmount() }
})

test('a sign-in that is waiting: no Sign in button while off, the status says Off', async () => {
  const m = await page({ ...mine, status: 'needs_auth', personalOff: true })
  try {
    expect(m.find('integration-signin-start')).toBeNull()
    expect(m.get('connection-status').textContent).toBe(translate('en', 'appConnectors.off'))
  } finally { await m.unmount() }
})

test('the switch\'s hint in Team settings says what keeps working while it is off: template connections and the Google apps (QA TC-2931)', () => {
  const words: Record<string, string[]> = { en: ['team template', 'Google apps', 'keep working'], ko: ['팀 템플릿', 'Google 앱', '그대로'], id: ['templat tim', 'aplikasi Google'], ja: ['テンプレート', 'Googleアプリ'], es: ['plantilla del equipo', 'apps de Google'], zh: ['团队模板', 'Google 应用'] }
  for (const [l, want] of Object.entries(words)) {
    const hint = translate(l as 'en', 'teamSettings.personalIntegrationsHint')
    for (const w of want) expect(hint, `${l}: ${w}`).toContain(w)
  }
})
