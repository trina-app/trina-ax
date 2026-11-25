// An app on the person's computer in Settings (components/integrations/LocalApp.tsx, ConnectionPage.tsx): its page says
// it works only from the desktop app, shows what runs, and in the desktop app whether it runs now and Stop; it has no
// address and no Edit. The settings lines a person types are NAME=value only.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { DESKTOP_BRIDGE_GLOBAL } from '@mycel/shared'
import type { Integration } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { checkAgainFixes, ConnectionPage } from '../../src/components/integrations/ConnectionPage'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { settingLines } from '../../src/components/integrations/LocalApp'
import { connectionRowStatus } from '../../src/lib/integrations'
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
    // Aside is a listed app: its own logo and line, not the generic ones
    expect(m.html()).toContain('/icons/connectors/aside.png')
    expect(m.html()).toContain(translate('en', 'localApps.aside.line'))
    expect(m.html()).not.toContain(translate('en', 'localApps.title'))
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

test('on the web, its check failed for being away from that computer: one note says so, not two; no sign-in row', async () => {
  const offline: Integration = { ...aside, status: 'error', lastError: 'This works only from the desktop app on the computer where you added it.', lastErrorReason: 'local_offline' }
  const m = await mount(<Page i={offline} />)
  try {
    expect(m.get('local-app-where').textContent).toContain('desktop app on the computer where it was added')
    expect(m.find('integration-error')).toBeNull()
    expect(m.html()).not.toContain(translate('en', 'gapps.signIn'))
    // not a fault: a neutral "Works only in the desktop app", never a red "Error"
    expect(m.get('connection-status').getAttribute('data-state')).toBe('elsewhere')
    expect(m.get('connection-status').textContent).toBe(translate('en', 'localApps.status.desktopOnly'))
    expect(m.get('connection-status').getAttribute('class')).not.toContain('text-danger')
  } finally { await m.unmount() }
})

test('in the desktop app: each setting says in words whether this computer keeps its value', async () => {
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = {
    bridgeVersion: 1,
    localApps: { version: 1, run: async () => ({}), cancel() {}, stop() {}, running: async () => [], onRunning: () => () => {}, setSettings: async () => 'saved', settingNames: async () => ['ASIDE_TOKEN'] },
  }
  const m = await mount(<Page i={aside} />)
  try {
    for (let i = 0; i < 20 && !m.get('local-app-settings-state').textContent?.includes(translate('en', 'localApps.settingSaved')); i++) await new Promise((r) => setTimeout(r, 10))
    expect(m.get('local-app-settings-state').textContent).toContain(`ASIDE_TOKEN${translate('en', 'localApps.settingSaved')}`)
  } finally { await m.unmount() }
})

test('in the desktop app, last checked from another computer: "On another computer"; a real failure stays an error', async () => {
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = {
    bridgeVersion: 1,
    localApps: { version: 1, run: async () => ({}), cancel() {}, stop() {}, running: async () => [], onRunning: () => () => {}, setSettings: async () => 'saved', settingNames: async () => [] },
  }
  const away = await mount(<Page i={{ ...aside, status: 'error', lastError: 'x', lastErrorReason: 'local_offline' }} />)
  try {
    expect(away.get('connection-status').getAttribute('data-state')).toBe('elsewhere')
    expect(away.get('connection-status').textContent).toBe(translate('en', 'localApps.status.otherComputer'))
  } finally { await away.unmount() }
  const failed = await mount(<Page i={{ ...aside, status: 'error', lastError: 'The program could not start on this computer.', lastErrorReason: 'local_failed' }} />)
  try {
    expect(failed.get('connection-status').getAttribute('data-state')).toBe('error')
    expect(failed.get('connection-status').textContent).toBe(translate('en', 'integrations.status.error'))
    expect(failed.find('integration-error')).not.toBeNull()
  } finally { await failed.unmount() }
})

test('the list row: away from its computer is neutral, a failure needs attention', () => {
  const base: Integration = { ...aside, status: 'error' }
  expect(connectionRowStatus({ ...base, lastErrorReason: 'local_offline' })).toBe('elsewhere')
  expect(connectionRowStatus({ ...base, lastErrorReason: 'local_failed' })).toBe('attention')
  expect(connectionRowStatus({ ...base, kind: 'mcp', lastErrorReason: 'local_offline' })).toBe('attention')
})

test('on the web, an app that works on its computer ("Connected" there): "Works only in the desktop app" on its page and its row', async () => {
  const working: Integration = { ...aside, status: 'connected', lastError: null, lastErrorReason: null }
  expect(connectionRowStatus(working)).toBe('elsewhere')
  expect(connectionRowStatus({ ...working, kind: 'mcp' })).toBe('connected')
  const m = await mount(<Page i={working} />)
  try {
    expect(m.get('connection-status').getAttribute('data-state')).toBe('elsewhere')
    expect(m.get('connection-status').textContent).toBe(translate('en', 'localApps.status.desktopOnly'))
  } finally { await m.unmount() }
  // in the desktop app it is what the computer said
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] = {
    bridgeVersion: 1,
    localApps: { version: 1, run: async () => ({}), cancel() {}, stop() {}, running: async () => [], onRunning: () => () => {}, setSettings: async () => 'saved', settingNames: async () => [] },
  }
  expect(connectionRowStatus(working)).toBe('connected')
  const d = await mount(<Page i={working} />)
  try { expect(d.get('connection-status').getAttribute('data-state')).toBe('connected') } finally { await d.unmount() }
})

test('settings lines: NAME=value only', () => {
  expect(settingLines('A_KEY=x=1\n\n  B=  ')).toEqual({ A_KEY: 'x=1', B: '' })
  expect(settingLines('not a line')).toBeNull()
  expect(settingLines('1A=x')).toBeNull()
})

test('a program the person typed (not Aside or ego lite) keeps the generic line', async () => {
  const other: Integration = { ...aside, name: 'Playwright', local: { adapter: 'mcp', command: 'npx', args: ['@playwright/mcp@latest'], env: [] } }
  const m = await mount(<Page i={other} />)
  try {
    expect(m.html()).toContain(translate('en', 'localApps.title'))
    expect(m.html()).not.toContain('/icons/connectors/aside.png')
  } finally { await m.unmount() }
})

test('a failed check whose fix is to check again: a Check again button by its words, not only in ⋯ (QA TC-9009)', async () => {
  for (const reason of ['local_failed', 'local_missing', 'local_declined']) {
    const m = await mount(<Page i={{ ...aside, status: 'error', lastError: 'x', lastErrorReason: reason }} />)
    try {
      expect(m.get('integration-error-refresh').textContent).toBe(translate('en', 'integrations.refresh'))
    } finally { await m.unmount() }
  }
  // its fix is elsewhere (add it again, confirm on the computer): no button that cannot help
  for (const reason of ['local_share', 'local_unsafe', 'local_confirm']) {
    const m = await mount(<Page i={{ ...aside, status: 'error', lastError: 'x', lastErrorReason: reason }} />)
    try { expect(m.find('integration-error-refresh')).toBeNull() } finally { await m.unmount() }
  }
  // a reader who does not manage it: no button
  expect(checkAgainFixes({ kind: 'local', lastError: 'x', lastErrorReason: 'local_failed' }, false)).toBe(false)
  // a slow service: the step names the button that is now there
  expect(checkAgainFixes({ kind: 'mcp', lastError: 'x', lastErrorReason: 'timeout' }, true)).toBe(true)
  expect(translate('en', 'connectors.step.checkAgain')).not.toContain('⋯')
})
