// Settings › Allowed for Trina lists the sites allowed for good (docs/decisions/20261122-always-allow-holds-everywhere.md
// B3): "이 사이트 항상 허용" on the AI's address card (web) and the in-app browser's office-network "항상 허용" (office),
// each with its own words and a Remove that calls DELETE /api/ai-allowances/:id; the dev environment login card's kind
// (M2) has its own line too.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AiAllowance } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { AiAllowances } from '../../src/components/settings/AiAllowances'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const items: AiAllowance[] = [
  { kind: 'site', id: 'site:d2Vi', site: 'example.co.kr', place: 'web', createdAt: '2026-11-22T10:00:00.000Z' },
  { kind: 'site', id: 'site:b2ZmaWNl', site: '10.0.0.5', place: 'office', createdAt: '2026-11-21T10:00:00.000Z' },
  { kind: 'card', id: 'card:dev_login', card: 'dev_login', createdAt: '2026-11-20T10:00:00.000Z' },
]
let calls: { method: string; path: string }[] = []

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  calls = []
  useLocaleStore.setState({ locale: 'en' })
  useUi.setState({ toasts: [] })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    calls.push({ method: init?.method ?? 'GET', path: url.pathname })
    if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 })
    return json({ items })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

describe('sites in Settings › Allowed for Trina', () => {
  test('a web site and an office-network address, each with its words; Remove deletes that one', async () => {
    const m = await mount(<AiAllowances />)
    try {
      await m.until(() => m.container.querySelectorAll('[data-testid="allowance-row"]').length === 3, 'three rows')
      const sites = [...m.container.querySelectorAll('[data-testid="allowance-site"]')].map((e) => e.textContent)
      expect(sites).toEqual([`example.co.kr·${translate('en', 'allowances.siteWeb')}`, `10.0.0.5·${translate('en', 'allowances.siteOffice')}`])
      expect(m.html()).toContain(translate('en', 'allowances.card.dev_login'))
      const remove = m.container.querySelectorAll('[data-testid="allowance-delete"]')[1]!
      await m.click(remove as never)
      await m.until(() => m.container.querySelectorAll('[data-testid="allowance-row"]').length === 2, 'the row gone')
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path))).toEqual(['/api/ai-allowances/site:b2ZmaWNl'])
    } finally { await m.unmount() }
  })

  test('every app language names both places and the login card', () => {
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      for (const k of ['allowances.siteWeb', 'allowances.siteOffice', 'allowances.card.dev_login'] as const) expect(translate(L, k)).not.toBe(k)
    }
  })
})

// "<connector> 전체 항상 허용" (docs/decisions/20261123-one-always-allow.md): one entry per connection, removable
describe('a whole connection in Settings › Allowed for Trina', () => {
  test('"Aside · All tools", one row; Remove deletes it; every app language names it', async () => {
    const all: AiAllowance[] = [{ kind: 'connector_tool', id: 'tool:YWxs', connection: 'Aside', tool: 'All tools', all: true, createdAt: '2026-11-23T10:00:00.000Z' }]
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://team.localhost')
      calls.push({ method: init?.method ?? 'GET', path: url.pathname })
      if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 })
      return json({ items: all })
    }) as typeof fetch
    const m = await mount(<AiAllowances />)
    try {
      await m.until(() => m.container.querySelectorAll('[data-testid="allowance-row"]').length === 1, 'one row')
      expect(m.html()).toContain(translate('en', 'allowances.connectorAll'))
      await m.click(m.container.querySelector('[data-testid="allowance-delete"]') as never)
      await m.until(() => calls.some((c) => c.method === 'DELETE'), 'the delete')
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => decodeURIComponent(c.path))).toEqual(['/api/ai-allowances/tool:YWxs'])
    } finally { await m.unmount() }
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) expect(translate(L, 'allowances.connectorAll')).not.toBe('allowances.connectorAll')
  })
})
