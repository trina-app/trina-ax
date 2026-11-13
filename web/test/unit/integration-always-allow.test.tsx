// A connection the person chose Always allow for on a write card (QA TC-130, components/integrations/ConnectionPage.tsx):
// its page says so (the line on what the AI may do, with that a chat that read something from outside still asks) and ⋯
// has "Ask every time": on a team connection it ends only the person's own choice (DELETE
// /api/integrations/:id/always-allow, never the team's rule); on their own connection it sets the write rule back to
// "ask". A team connection set to "Run without asking" by an admin says so in its own words and offers no such item.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Integration } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { MemoryRouter } from 'react-router-dom'
import { useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { ConnectionPage } from '../../src/components/integrations/ConnectionPage'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const now = new Date().toISOString()
const base: Integration = {
  id: '01900000-0000-7000-8000-0000000000b1', scope: 'team', kind: 'mcp', name: 'Team board', slug: 'teamboard', url: 'https://board.example.com/mcp',
  auth: 'none', authHeader: null, hasSecret: false, account: null, notes: null, writePolicy: 'ask', status: 'connected', lastError: null, tools: [],
  toolsUpdatedAt: null, access: null, createdBy: null, createdAt: now, updatedAt: now, lastUsedAt: null, canManage: false,
}
// one tool that changes things, so the page's line is about changes
const writeTool = { name: 'create_card', title: 'Create card', description: '', readOnly: false }
let calls: { method: string; path: string; body: any }[] = []

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  calls = []
  useLocaleStore.setState({ locale: 'en' })
  useUi.setState({ toasts: [] })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body })
    return json({ ...base, alwaysAllowedByMe: false })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

async function row(i: Integration, readOnly = false) {
  const box: { replaced: Integration[] } = { replaced: [] }
  function Page() {
    const actions = useIntegrationActions({ add: () => {}, replace: (x) => { box.replaced.push(x) }, reload: () => {} })
    return <MemoryRouter><ConnectionPage i={i} actions={actions} readOnly={readOnly} onEdit={() => {}} about="" /></MemoryRouter>
  }
  const m = await mount(<Page />)
  return { m, box }
}

describe('Always allow on a connection\'s page', () => {
  test('a team connection: the badge, what it means, and "Ask every time" ends only my own choice', async () => {
    const { m, box } = await row({ ...base, tools: [writeTool], alwaysAllowedByMe: true }, true)
    try {
      expect(m.get('app-abilities').textContent).toBe(translate('en', 'gapps.changeAllowLine'))
      await m.click('connection-menu')
      await m.click('integration-always-allow-stop')
      await m.until(() => box.replaced.length, 'the row replaced')
      expect(calls).toEqual([{ method: 'DELETE', path: `/api/integrations/${base.id}/always-allow`, body: undefined }])
      expect(useUi.getState().toasts.map((x) => x.text)).toEqual([translate('en', 'integrations.alwaysAllow.stopped', { name: 'Team board' })])
    } finally { await m.unmount() }
  })

  test('my own connection set to allow: "Ask every time" sets its write rule back to ask', async () => {
    const mine: Integration = { ...base, id: '01900000-0000-7000-8000-0000000000b2', scope: 'personal', name: 'Tasks', writePolicy: 'allow', canManage: true, tools: [writeTool] }
    const { m, box } = await row(mine)
    try {
      expect(m.get('app-abilities').textContent).toBe(translate('en', 'gapps.changeAllowLine'))
      await m.click('connection-menu')
      await m.click('integration-always-allow-stop')
      await m.until(() => box.replaced.length, 'the row replaced')
      expect(calls).toEqual([{ method: 'PATCH', path: `/api/integrations/${mine.id}`, body: { writePolicy: 'ask' } }])
    } finally { await m.unmount() }
  })

  test('a team connection the admin set to "Run without asking": the team\'s words, no item for the member', async () => {
    const { m } = await row({ ...base, tools: [writeTool], writePolicy: 'allow' }, true)
    try {
      expect(m.get('app-abilities').textContent).toBe(translate('en', 'connectors.page.teamAllowLine'))
      expect(m.find('connection-menu')).toBeNull()
      expect(m.find('integration-always-allow-stop')).toBeNull()
    } finally { await m.unmount() }
  })
})

// QA retest 2026-11-12: a connection whose call was tried and failed does not say "Not used yet"
describe('when it was last used', () => {
  test('failing with a last attempt: "Last tried"; working: "Last used"; never tried: "Not used yet"', async () => {
    const at = '2026-11-12T09:00:00.000Z'
    const cases: [Partial<Integration>, string][] = [
      [{ status: 'error', lastError: 'Could not reach the service.', lastUsedAt: at }, 'connectors.page.lastTried'],
      [{ status: 'connected', lastUsedAt: at }, 'connectors.page.lastUsed'],
      [{ status: 'error', lastError: 'Could not reach the service.', lastUsedAt: null }, 'integrations.neverUsed'],
    ]
    for (const [over, key] of cases) {
      const { m } = await row({ ...base, ...over }, true)
      try {
        const text = m.get('integration-meta').textContent ?? ''
        const label = translate('en', key as Parameters<typeof translate>[1], { date: '' }).trim()
        expect({ key, has: text.includes(label) }).toEqual({ key, has: true })
        if (key !== 'integrations.neverUsed') expect(text).not.toContain(translate('en', 'integrations.neverUsed'))
      } finally { await m.unmount() }
    }
  })
})
