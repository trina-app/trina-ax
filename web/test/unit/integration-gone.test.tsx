// A connection that went while the page was open (an admin changed the app or the address of the template it was made
// from, or deleted it; QA on dev 1565b39f1, tc020-member-stale-retry): the server tells the member's pages with a quiet
// notice (integrations_changed) and the Connectors page reads its lists again; an action on the old row that comes back
// 404 does the same, with a plain "no longer here", instead of "not found or no access" on a row that stays
// (components/integrations/IntegrationRow.tsx useIntegrationActions, useSignIn).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { Integration, ServerEvent } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { useIntegrationActions, type IntegrationActions } from '../../src/components/integrations/IntegrationRow'
import { dispatch, integrationsChanged } from '../../src/store/live'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const GONE = { id: '01900000-0000-7000-8000-0000000000aa', name: 'Acme Works' } as Integration
let calls: string[] = []

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  calls = []
  useLocaleStore.setState({ locale: 'ko' })
  useUi.setState({ toasts: [] })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://team.localhost')
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    return json({ error: { code: 'not_found', message: '찾을 수 없거나 접근 권한이 없어요.' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

/** the page's actions with a counted reload */
async function withActions() {
  const box: { a: IntegrationActions | null; reloads: number } = { a: null, reloads: 0 }
  function Probe() {
    box.a = useIntegrationActions({ add: () => {}, replace: () => {}, reload: () => { box.reloads++ } })
    return <span data-testid="sign-in-state">{box.a.signIn.state?.state ?? 'none'}</span>
  }
  const m = await mount(<Probe />)
  return { box, m }
}
const toastTexts = () => useUi.getState().toasts.map((x) => x.text)

describe('an action on a connection that is gone', () => {
  test('check again: the lists load again, and the toast says it is no longer here', async () => {
    const { box, m } = await withActions()
    try {
      await act(() => box.a!.refresh(GONE))
      await m.settle()
      expect(calls).toContain(`POST /api/integrations/${GONE.id}/refresh`)
      expect(box.reloads).toBe(1)
      expect(toastTexts()).toEqual([translate('ko', 'integrations.gone')])
      expect(toastTexts().join()).not.toContain('접근 권한')
    } finally { await m.unmount() }
  })

  test('sign in (the row\'s "다시 시도"): no failed state stays on the row; the lists load again', async () => {
    const { box, m } = await withActions()
    try {
      await act(() => box.a!.signIn.start(GONE.id, null))
      await m.settle()
      expect(calls).toContain(`POST /api/integrations/${GONE.id}/authorize`)
      expect(box.a!.signIn.state).toBeNull()
      expect(m.get('sign-in-state').textContent).toBe('none')
      expect(box.reloads).toBe(1)
      expect(toastTexts()).toEqual([translate('ko', 'integrations.gone')])
    } finally { await m.unmount() }
  })

  test('a tool switch and delete too; another error keeps its own words and loads nothing', async () => {
    const { box, m } = await withActions()
    try {
      await act(() => box.a!.setTool(GONE, 'search', false))
      expect(box.reloads).toBe(1)
      globalThis.fetch = (async () => json({ error: { code: 'internal', message: '서버 오류가 발생했어요.' } }, 500)) as unknown as typeof fetch
      useUi.setState({ toasts: [] })
      await act(() => box.a!.refresh(GONE))
      await m.settle()
      expect(box.reloads).toBe(1)
      expect(toastTexts()).not.toContain(translate('ko', 'integrations.gone'))
    } finally { await m.unmount() }
  })
})

describe('the server says a connection went', () => {
  test('integrations_changed: the Connectors page is told, quietly (no toast)', () => {
    let told = 0
    const off = integrationsChanged.on(() => { told++ })
    try {
      const ev: ServerEvent = { type: 'notice', seq: 9, at: Date.now(), data: { level: 'info', code: 'integrations_changed', message: '' } }
      dispatch(ev)
      expect(told).toBe(1)
      expect(useUi.getState().toasts).toEqual([])
    } finally { off() }
  })
})
