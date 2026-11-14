// The way back to the welcome steps from a page one of them linked to (components/onboarding/SetupReturn.tsx,
// lib/welcome.ts setupReturnState): the AI step's "Other AI services … Admin › AI accounts" and 팀 파일's "Open" of the
// project it made carry the step in the history entry's state; that page shows one control:
// - "← 시작 설정으로 돌아가기" → /welcome (which resumes by itself), owner only, nothing without the state or once finished;
// - after the AI step, once AI answers (an account added there), "설정 이어서 하기" in the accent instead; a failed check
//   (the store's "usable" without an answer) does not count;
// - the links pass the state only on /welcome (Home's no-AI card links to the same page without it).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { type WelcomeProgress } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { SetupReturn } from '../../src/components/onboarding/SetupReturn'
import { ConnectAiPanel } from '../../src/components/onboarding/ConnectAi'
import { setupReturnState, setupReturnStep } from '../../src/lib/welcome'
import { useAiAccess } from '../../src/store/aiAccess'
import { enginesChanged } from '../../src/store/live'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const open = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({
  startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
  steps: { ai: 'skipped', profile: null, result: null, skills: null, files: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
  ...over,
} as WelcomeProgress)

let progress: WelcomeProgress | null = null
let ai = { usable: false, action: 'connect_team', requested: false }
let aiFails = false
const routes: Record<string, () => Response> = {
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'GET /api/me/ai-access': () => aiFails ? json(503, { error: { code: 'unavailable', message: 'down' } }) : json(200, ai),
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
}

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    return routes[key]?.() ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  aiFails = false
  progress = null
  ai = { usable: false, action: 'connect_team', requested: false }
  useWelcome.getState().reset()
  useAiAccess.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  useSession.setState({ status: sessionBefore } as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
function Where() { const l = useLocation(); return <p data-testid="where">{`${l.pathname}|${JSON.stringify(l.state ?? null)}`}</p> }
const at = (path: string, state: unknown) => mount(
  <MemoryRouter initialEntries={[{ pathname: path, state }]}>
    <Routes><Route path="*" element={<><SetupReturn /><Where /></>} /></Routes>
  </MemoryRouter>,
)
const leftClick = () => Object.assign(new FakeEvent('click', { bubbles: true, cancelable: true }), { button: 0 })

describe('the way back to the welcome steps', () => {
  test('the state names a step the steps have; anything else is none', () => {
    expect(setupReturnStep(setupReturnState('ai'))).toBe('ai')
    expect(setupReturnStep(setupReturnState('files'))).toBe('files')
    for (const s of [null, undefined, {}, { setupStep: 'nope' }, { setupStep: 3 }, { step: 'invite' }]) expect(setupReturnStep(s)).toBeNull()
  })

  test('opened from the AI step: "← 시작 설정으로 돌아가기" goes to /welcome', async () => {
    signIn('owner')
    progress = open()
    const m = await at('/admin/providers', setupReturnState('ai'))
    try {
      await m.until(() => m.find('setup-return-button'), 'the control')
      await m.until(() => useAiAccess.getState().loaded, 'the AI check')
      expect(m.get('setup-return').getAttribute('data-state')).toBe('back')
      expect(m.get('setup-return-button').textContent).toContain('시작 설정으로 돌아가기')
      await act(async () => { m.get('setup-return-button').dispatchEvent(leftClick()) })
      await m.until(() => m.find('where')?.textContent?.startsWith('/welcome|'), 'the steps')
    } finally { await m.unmount() }
  })

  test('AI answers after an account was added on the page: "설정 이어서 하기" in the accent', async () => {
    signIn('owner')
    progress = open()
    const m = await at('/admin/providers', setupReturnState('ai'))
    try {
      await m.until(() => m.find('setup-return')?.getAttribute('data-state') === 'back' && useAiAccess.getState().loaded, 'not yet')
      ai = { usable: true, action: 'connect_team', requested: false }
      await act(async () => { enginesChanged.emit() })
      await m.until(() => m.find('setup-return')?.getAttribute('data-state') === 'continue', 'continue')
      expect(m.get('setup-return-button').textContent).toContain('설정 이어서 하기')
      await act(async () => { m.get('setup-return-button').dispatchEvent(leftClick()) })
      await m.until(() => m.find('where')?.textContent?.startsWith('/welcome|'), 'the steps')
    } finally { await m.unmount() }
  })

  test('a failed AI check is no "AI works": the control stays "back"', async () => {
    signIn('owner')
    progress = open()
    aiFails = true
    const m = await at('/admin/providers', setupReturnState('ai'))
    try {
      await m.until(() => m.find('setup-return') && useAiAccess.getState().loaded, 'the failed check')
      await m.settle(30)
      // the store reads a failure as usable (nothing warns), but it was not answered
      expect(useAiAccess.getState().usable).toBe(true)
      expect(useAiAccess.getState().answered).toBe(false)
      expect(m.get('setup-return').getAttribute('data-state')).toBe('back')
    } finally { await m.unmount() }
  })

  test('nothing without the state, for anyone but the owner, or once the steps are finished', async () => {
    const cases: [role: 'owner' | 'admin' | 'member', state: unknown, p: WelcomeProgress][] = [
      ['owner', null, open()],
      ['admin', setupReturnState('ai'), open()],
      ['member', setupReturnState('files'), open()],
      ['owner', setupReturnState('files'), open({ finishedAt: '2026-11-04T00:03:00.000Z' })],
    ]
    for (const [role, state, p] of cases) {
      signIn(role)
      progress = p
      const m = await at('/admin/providers', state)
      try {
        await m.settle(40)
        if (role === 'owner' && state) await m.until(() => useWelcome.getState().loaded, 'read')
        await m.settle(20)
        expect(m.find('setup-return')).toBeNull()
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      useAiAccess.getState().reset()
    }
  })

  test('the AI step\'s engines line carries the step only on /welcome', async () => {
    signIn('owner')
    for (const [path, carried] of [['/welcome', true], ['/', false]] as const) {
      const m = await mount(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/admin/providers" element={<Where />} />
            <Route path="*" element={<ConnectAiPanel />} />
          </Routes>
        </MemoryRouter>,
      )
      try {
        await m.until(() => m.find('welcome-ai-engines'), 'the line')
        expect(m.get('welcome-ai-engines').getAttribute('href')).toBe('/admin/providers')
        await act(async () => { m.get('welcome-ai-engines').dispatchEvent(leftClick()) })
        await m.until(() => m.find('where'), 'the engines page')
        expect(m.get('where').textContent).toBe(`/admin/providers|${carried ? JSON.stringify(setupReturnState('ai')) : 'null'}`)
      } finally { await m.unmount() }
    }
  })
})
