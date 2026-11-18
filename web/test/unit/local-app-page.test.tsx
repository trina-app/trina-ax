// An app on the person's computer in Settings (components/integrations/LocalApp.tsx, ConnectionPage.tsx): its page says
// it works only from the desktop app, shows what runs, and in the desktop app whether it runs now and Stop; it has no
// address and no Edit. The settings lines a person types are NAME=value only.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { DESKTOP_BRIDGE_GLOBAL } from '@mycel/shared'
import type { Integration } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ConnectionPage } from '../../src/components/integrations/ConnectionPage'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { settingLines } from '../../src/components/integrations/LocalApp'
import { installDom, mount, removeDom } from './dom-host'

const locale = useLocaleStore.getState().locale
beforeAll(() => { installDom(); useLocaleStore.setState({ locale: 'en' }) })
afterAll(() => { removeDom(); useLocaleStore.setState({ locale }) })
afterEach(() => { delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] })

const now = new Date().toISOString()
const aside: Integration = {
  id: '01900000-0000-7000-8000-0000000000d1', scope: 'personal', kind: 'local', name: 'Aside', slug: 'aside', url: '',
  auth: 'none', authHeader: null, hasSecret: false, account: null, notes: null, writePolicy: 'ask', status: 'connected',
  lastError: null, tools: [{ name: 'repl', title: null, description: 'Run JavaScript', readOnly: false }], toolsUpdatedAt: now, access: null,
  createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: null, canManage: true, local: { adapter: 'mcp', command: 'aside', args: ['mcp'], env: ['ASIDE_TOKEN'] },
}
function Page({ i }: { i: Integration }) {
  const actions = useIntegrationActions({ add: () => {}, replace: () => {}, reload: () => {} })
  return <MemoryRouter><ConnectionPage inSettings i={i} actions={actions} onEdit={() => {}} about="" /></MemoryRouter>
}

test('on the web: works only from the desktop app on that computer; what runs; no address', async () => {
  const m = await mount(<Page i={aside} />)
  try {
    expect(m.get('local-app-where').textContent).toContain('desktop app on the computer where it was added')
    expect(m.get('local-app-command').textContent).toContain('aside mcp')
    expect(m.find('connector-address')).toBeNull()
    expect(m.find('local-app-stop')).toBeNull()
    expect(m.html()).toContain(translate('en', 'localApps.title'))
  } finally { await m.unmount() }
})

test('in the desktop app: running, and Stop reaches the app', async () => {
  const stopped: string[] = []
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = {
    bridgeVersion: 1,
    localApps: { version: 1, run: async () => ({}), cancel() {}, stop: (id: string) => stopped.push(id), running: async () => [aside.id], onRunning: () => () => {}, setSettings: async () => 'saved', settingNames: async () => ['ASIDE_TOKEN'] },
  }
  const m = await mount(<Page i={aside} />)
  try {
    for (let i = 0; i < 20 && !m.find('local-app-stop'); i++) await new Promise((r) => setTimeout(r, 10))
    expect(m.get('local-app-where').textContent).toContain('this desktop app on this computer')
    expect(m.get('local-app-state').textContent).toContain('Running')
    await m.click('local-app-stop')
    expect(stopped).toEqual([aside.id])
  } finally { await m.unmount() }
})

test('settings lines: NAME=value only', () => {
  expect(settingLines('A_KEY=x=1\n\n  B=  ')).toEqual({ A_KEY: 'x=1', B: '' })
  expect(settingLines('not a line')).toBeNull()
  expect(settingLines('1A=x')).toBeNull()
})
