// "AI 연결" wherever no AI answers (components/onboarding/ConnectAi.tsx; docs/DECISIONS.md "W2 — AI connection first"):
// - "AI 연결하기" (the chat error, the line above the composer) opens Admin › AI connections' own dialog in place, in
//   its simple form: Claude chosen, the whole team (no target), named "Claude" (no name field), the provider's terms in
//   one line, the password again (the server checks it on every team add); "다른 방법" shows every way;
// - "내 AI 연결하기" opens one's own dialog (no password, as in Settings);
// - Admin › AI connections keeps the full dialog (name, target, the whole notice).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { translate, useLocaleStore } from '../../src/i18n'
import AiAccessButton from '../../src/components/chat/AiAccessButton'
import { ConnectAiButton } from '../../src/components/onboarding/ConnectAi'
import { AddCredential } from '../../src/pages/admin/Credentials'
import { useAiAccess } from '../../src/store/aiAccess'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const KINDS = ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key']
let shared = true
let calls: { key: string; body: any }[] = []
const LOGIN = { loginId: 'login-0123456789abcdef', kind: 'anthropic-oauth', state: 'starting', url: null, code: null, expiresAt: '2026-11-05T01:00:00.000Z', credential: null, reason: null }
const routes: Record<string, (body: any) => Response> = {
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: shared, allowedKinds: KINDS, pricesAsOf: '2026-11-01', anthropicGateway: null }),
  'GET /api/me/credentials': () => json(200, { allowed: true, allowedKinds: KINDS, items: [], anthropicGateway: null }),
  'GET /api/me/ai-access': () => json(200, { usable: false, action: 'connect_team', requested: false }),
  'POST /api/admin/credential-logins': () => json(202, LOGIN),
  'POST /api/me/credential-logins': () => json(202, LOGIN),
  'POST /api/me/ai-access/request': () => json(200, { requested: true, already: false }),
}
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => { shared = true; calls = []; useAiAccess.getState().reset() })
afterAll(() => { globalThis.fetch = realFetch; useLocaleStore.setState({ locale: localeBefore }); removeDom() })

const body = () => (globalThis.document as any).body as FakeElement
const q = (id: string) => body().querySelector(`[data-testid="${id}"]`)
const submit = () => q('credential-submit')!
/** a browser checks a box or a radio before the click's listeners run, past React's value tracker (this small DOM does
 * not): the click a person makes */
const tick = (id: string) => {
  const input = q(id)!
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'checked')!.set!.call(input, !(input as unknown as { checked: boolean }).checked)
  return input
}

describe('the simple dialog', () => {
  test('AI 연결하기: Claude chosen, no name, no target, the terms in one line, the password again; the sign-in goes to the whole team as "Claude"', async () => {
    const m = await mount(<MemoryRouter><ConnectAiButton data-testid="go" /></MemoryRouter>)
    try {
      expect(m.get('go').textContent).toBe(ko('aiAccess.connectTeam'))
      await m.click('go')
      await m.until(() => q('claude-login-how'), 'the Claude dialog')
      expect(q('kind-chatgpt')).toBeNull()
      expect(q('credential-label')).toBeNull()
      expect(m.html()).not.toContain(ko('credentials.target.pick'))
      // the terms: one line with the yes the server needs, Trina's "it cannot grant that permission" kept
      expect(q('plan-notice')!.textContent).toBe(ko('aiConnect.terms', { product: 'Trina AX' }))
      expect(m.html()).not.toContain(ko('credentials.planNotice'))
      expect(m.html()).toContain(ko('aiConnect.password'))
      expect(submit().disabled).toBe(true)
      await m.click(tick('plan-notice-ack'))
      expect(submit().disabled).toBe(true)
      await m.type('credential-password', 'pw-1')
      expect(submit().disabled).toBe(false)
      await m.click(submit())
      await m.until(() => q('claude-starting'), 'the sign-in started')
      const start = calls.find((c) => c.key === 'POST /api/admin/credential-logins')!
      expect(start.body).toEqual({ kind: 'anthropic-oauth', label: 'Claude', acknowledgedPlanNotice: true, assignments: [], password: 'pw-1' })
    } finally { await m.unmount() }
  })

  test('"다른 방법" in the dialog shows every way; a key is named after its kind', async () => {
    const m = await mount(<MemoryRouter><ConnectAiButton data-testid="go" /></MemoryRouter>)
    try {
      await m.click('go')
      await m.until(() => q('credential-other-ways'), 'the dialog')
      await m.click('credential-other-ways')
      expect(q('kind-chatgpt')).not.toBeNull()
      expect(q('credential-other-ways')).toBeNull()
      // still the simple form: no name, no target
      await m.click(tick('kind-openai-api-key'))
      expect(q('credential-label')).toBeNull()
      expect(m.html()).not.toContain(ko('credentials.target.pick'))
      expect(q('credential-password')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('no shared Claude subscription on this team: every way at once', async () => {
    shared = false
    const m = await mount(<MemoryRouter><ConnectAiButton data-testid="go" /></MemoryRouter>)
    try {
      await m.click('go')
      await m.until(() => q('kind-anthropic-api-key'), 'every way')
      expect(q('claude-login-how')).toBeNull()
      expect(q('credential-other-ways')).toBeNull()
    } finally { await m.unmount() }
  })

  test('내 AI 연결하기: one\'s own dialog, every way, no password', async () => {
    const m = await mount(<MemoryRouter><ConnectAiButton personal data-testid="go" /></MemoryRouter>)
    try {
      expect(m.get('go').textContent).toBe(ko('aiAccess.connectOwn'))
      await m.click('go')
      await m.until(() => q('kind-anthropic-oauth'), 'one\'s own dialog')
      expect(calls.some((c) => c.key === 'GET /api/me/credentials')).toBe(true)
      await m.click(tick('kind-anthropic-oauth'))
      expect(q('credential-password')).toBeNull()
      expect(q('credential-label')).toBeNull()
      await m.click(tick('plan-notice-ack'))
      await m.click(submit())
      await m.until(() => calls.find((c) => c.key === 'POST /api/me/credential-logins'), 'the own sign-in')
      expect(calls.find((c) => c.key === 'POST /api/me/credential-logins')!.body).toEqual({ kind: 'anthropic-oauth', label: 'Claude', acknowledgedPlanNotice: true })
    } finally { await m.unmount() }
  })

  test('Admin › AI connections keeps the full dialog: name, target, the whole notice', async () => {
    const m = await mount(
      <MemoryRouter>
        <AddCredential allowedKinds={KINDS as never} sharedSubscriptions groups={[]} users={[]} initialKind="anthropic-oauth" initialLabel="Claude" onClose={() => {}} onDone={() => {}} />
      </MemoryRouter>,
    )
    try {
      expect(q('credential-label')).not.toBeNull()
      expect(m.html()).toContain(ko('credentials.target.pick'))
      expect(q('plan-notice')!.textContent).toContain(ko('credentials.planNotice'))
      expect(m.html()).not.toContain(ko('aiConnect.password'))
      expect(q('credential-other-ways')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the chat\'s button opens the dialog in place, nowhere else', async () => {
    useAiAccess.setState({ loaded: true, usable: false, action: 'connect_team' })
    const m = await mount(<MemoryRouter><AiAccessButton /></MemoryRouter>)
    try {
      await m.until(() => m.find('ai-access-button'), 'the button')
      expect(m.get('ai-access-button').getAttribute('data-action')).toBe('connect_team')
      await m.click('ai-access-button')
      await m.until(() => q('claude-login-how'), 'the dialog')
    } finally { await m.unmount() }
  })
})
