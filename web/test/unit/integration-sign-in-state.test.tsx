// A connection never signed in, and a sign-in window closed (QA TC-205): it is listed as "로그인 필요", not under
// "연결됨" (lib/integrations.ts awaitingFirstSignIn, pages/Connectors.tsx), and coming back to the page while the
// sign-in has not finished says so with 다시 시도 / 취소 instead of "finish in the new window"
// (components/integrations/IntegrationRow.tsx useSignIn, SignInPanel).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { translate, useLocaleStore } from '../../src/i18n'
import { awaitingFirstSignIn } from '../../src/lib/integrations'
import { SignInPanel, useSignIn, type SignInState } from '../../src/components/integrations/IntegrationRow'
import { installDom, mount, removeDom } from './dom-host'

const realFetch = globalThis.fetch
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const ID = '01900000-0000-7000-8000-0000000000bb'
let flowState = 'pending'

beforeAll(() => { installDom() })
afterAll(() => { removeDom() })
beforeEach(() => {
  useLocaleStore.setState({ locale: 'ko' })
  flowState = 'pending'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://team.localhost')
    if (url.pathname === `/api/integrations/${ID}/authorize`) return json({ flowId: 'flow-1', authorizationUrl: 'https://mcp.notion.com/authorize?x=1', expiresAt: '2026-11-12T01:00:00.000Z' })
    if (url.pathname === '/api/integrations/flows/flow-1') return json({ flowId: 'flow-1', state: flowState, reason: null, expiresAt: '2026-11-12T01:00:00.000Z' })
    return json({ error: { code: 'not_found', message: 'x' } }, 404)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })
/** the panel as the page shows it (in the DOM host, with the screen's language) */
async function panel(flow: SignInState) {
  const m = await mount(<SignInPanel flow={flow} onRetry={() => {}} onCancel={() => {}} />)
  try { return m.html() } finally { await m.unmount() }
}

test('never signed in: not connected yet; a lapsed sign-in (still stored) and a key connection are', () => {
  expect(awaitingFirstSignIn({ auth: 'oauth', hasSecret: false })).toBe(true)
  expect(awaitingFirstSignIn({ auth: 'oauth', hasSecret: true })).toBe(false)
  expect(awaitingFirstSignIn({ auth: 'bearer', hasSecret: false })).toBe(false)
  expect(awaitingFirstSignIn({ auth: 'none', hasSecret: false })).toBe(false)
})

test('back on the page with the sign-in not finished: "not finished yet", 다시 시도 and 취소; finishing late still completes', async () => {
  const box: { s: ReturnType<typeof useSignIn> | null; done: string[] } = { s: null, done: [] }
  function Probe() {
    box.s = useSignIn((id) => { box.done.push(id) })
    return <span data-testid="state">{box.s.state ? `${box.s.state.state}${box.s.state.away ? ' away' : ''}` : 'none'}</span>
  }
  const m = await mount(<Probe />)
  try {
    await act(() => box.s!.start(ID, null))
    await m.settle()
    expect(m.get('state').textContent).toBe('pending')
    // the person closed the window and came back here
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(m.get('state').textContent).toBe('pending away')
    const html = await panel(box.s!.state as SignInState)
    expect(html).toContain(translate('ko', 'integrations.signIn.notFinished'))
    expect(html).not.toContain(translate('ko', 'integrations.signIn.waiting'))
    expect(html).toContain('data-testid="integration-signin-retry"')
    expect(html).toContain(translate('ko', 'common.cancel'))
    // the sign-in was finished in the window after all: the poll still completes it
    flowState = 'completed'
    await m.until(() => box.done.length > 0, 'completed', 6000)
    expect(box.done).toEqual([ID])
    expect(m.get('state').textContent).toBe('none')
  } finally { await m.unmount() }
})

test('while still in the sign-in window (no return yet): the waiting line, no 다시 시도', async () => {
  const html = await panel({ id: ID, flowId: 'flow-1', url: 'https://mcp.notion.com/authorize', state: 'pending', reason: null })
  expect(html).toContain(translate('ko', 'integrations.signIn.waiting'))
  expect(html).not.toContain('integration-signin-retry')
})
