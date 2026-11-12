// A connection the person chose Always allow for on a write card (QA TC-130, components/integrations/IntegrationRow.tsx):
// the row says so (a badge on the line, and in its details what it means and that a chat that read something from
// outside still asks) with "Ask every time": on a team connection it ends only the person's own choice (DELETE
// /api/integrations/:id/always-allow, never the team's rule); on their own connection it sets the write rule back to
// "ask". A team connection set to "Run without asking" by an admin keeps its own badge and offers no such button.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Integration } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { IntegrationRow, useIntegrationActions } from '../../src/components/integrations/IntegrationRow'
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
    return <ul><IntegrationRow i={i} actions={actions} readOnly={readOnly} onEdit={() => {}} /></ul>
  }
  const m = await mount(<Page />)
  return { m, box }
}

describe('Always allow on a connection\'s row', () => {
  test('a team connection: the badge, what it means, and "Ask every time" ends only my own choice', async () => {
    const { m, box } = await row({ ...base, alwaysAllowedByMe: true }, true)
    try {
      expect(m.html()).toContain(translate('en', 'integrations.alwaysAllow.badge'))
      await m.click('integration-toggle')
      expect(m.get('integration-always-allow').textContent).toContain(translate('en', 'integrations.alwaysAllow.line'))
      await m.click('integration-always-allow-stop')
      await m.until(() => box.replaced.length, 'the row replaced')
      expect(calls).toEqual([{ method: 'DELETE', path: `/api/integrations/${base.id}/always-allow`, body: undefined }])
      expect(useUi.getState().toasts.map((x) => x.text)).toEqual([translate('en', 'integrations.alwaysAllow.stopped', { name: 'Team board' })])
    } finally { await m.unmount() }
  })

  test('my own connection set to allow: "Ask every time" sets its write rule back to ask', async () => {
    const mine: Integration = { ...base, id: '01900000-0000-7000-8000-0000000000b2', scope: 'personal', name: 'Tasks', writePolicy: 'allow', canManage: true }
    const { m, box } = await row(mine)
    try {
      expect(m.html()).toContain(translate('en', 'integrations.alwaysAllow.badge'))
      expect(m.html()).not.toContain(translate('en', 'integrations.write.allow'))
      await m.click('integration-toggle')
      await m.click('integration-always-allow-stop')
      await m.until(() => box.replaced.length, 'the row replaced')
      expect(calls).toEqual([{ method: 'PATCH', path: `/api/integrations/${mine.id}`, body: { writePolicy: 'ask' } }])
    } finally { await m.unmount() }
  })

  test('a team connection the admin set to "Run without asking": its own badge, no line or button for the member', async () => {
    const { m } = await row({ ...base, writePolicy: 'allow' }, true)
    try {
      expect(m.html()).toContain(translate('en', 'integrations.write.allow'))
      await m.click('integration-toggle')
      expect(m.find('integration-always-allow')).toBeNull()
    } finally { await m.unmount() }
  })
})

// QA retest 2026-11-12: a connection whose call was tried and failed does not say "Not used yet"
describe('when it was last used', () => {
  test('failing with a last attempt: "Last tried"; working: "Last used"; never tried: "Not used yet"', async () => {
    const at = '2026-11-12T09:00:00.000Z'
    const cases: [Partial<Integration>, string][] = [
      [{ status: 'error', lastError: 'Could not reach the service.', lastUsedAt: at }, 'integrations.lastTried'],
      [{ status: 'connected', lastUsedAt: at }, 'integrations.lastUsed'],
      [{ status: 'error', lastError: 'Could not reach the service.', lastUsedAt: null }, 'integrations.neverUsed'],
    ]
    for (const [over, key] of cases) {
      const { m } = await row({ ...base, ...over }, true)
      try {
        await m.click('integration-toggle')
        const text = m.get('integration-details').textContent ?? ''
        const label = translate('en', key as Parameters<typeof translate>[1], { date: '' }).trim()
        expect({ key, has: text.includes(label) }).toEqual({ key, has: true })
        if (key !== 'integrations.neverUsed') expect(text).not.toContain(translate('en', 'integrations.neverUsed'))
      } finally { await m.unmount() }
    }
  })
})
