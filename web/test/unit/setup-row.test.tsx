// The setup row (components/onboarding/SetupRow.tsx, docs/DECISIONS.md "W5 — Onboarding v5"): the owner's one way back
// to the welcome steps from every page, in the sidebar above Recents (the ☰ drawer on a phone):
// - "설정 이어서 하기 · n/4" (the steps done; put off is not done) → /welcome, owner only; never on /welcome, once
//   finished, or hidden; one step left here is named instead ("남은 일: 팀 파일"), the same words as a phone's Home row;
// - ✕ hides it with an undo toast; while no AI answers, "AI 연결하기" opens the connect dialog, not on Home (its no-AI
//   card); on a phone not on Home (Home's own quiet row), elsewhere yes;
// - Admin › Home: its own checklist hides while the steps are unfinished; "시작 설정 다시 보기" brings a hidden row back.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { GENERAL_BRIEF_SKILL, GENERAL_DECK_SKILL, GENERAL_TASKS_SKILL, type WelcomeProgress, type WelcomeUpdate } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { SetupRow } from '../../src/components/onboarding/SetupRow'
import { WelcomeResume } from '../../src/components/onboarding/WelcomeResume'
import Sidebar from '../../src/components/Sidebar'
import { OwnerSetup } from '../../src/pages/admin/OwnerChecklist'
import { stepTotal } from '../../src/lib/welcome'
import { useAiAccess } from '../../src/store/aiAccess'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { useWelcome } from '../../src/store/welcome'
import { FakeEvent, installDom, mount, removeDom, type Mounted } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const GENERAL = { at: '2026-11-04T00:00:00.000Z', tasksPath: GENERAL_TASKS_SKILL, briefPath: GENERAL_BRIEF_SKILL, introDeckPath: GENERAL_DECK_SKILL }
/** 회사 소개 put off and 내 스킬 done: 1 of 4 done (put off is not done), 팀 파일 next */
const half = (over: Partial<WelcomeProgress> = {}): WelcomeProgress => ({
  startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: null,
  steps: { profile: 'skipped', result: null, skills: 'done', files: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
  general: GENERAL, ...over,
})

let progress: WelcomeProgress | null = null
let ai = { usable: true, action: 'connect_team', requested: false }
let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'PATCH /api/onboarding/welcome': (b: WelcomeUpdate) => {
    if (progress && b.dismissed !== undefined) progress = { ...progress, dismissedAt: b.dismissed ? '2026-11-04T00:02:00.000Z' : null }
    return json(200, { progress })
  },
  'GET /api/me/ai-access': () => json(200, ai),
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
}
const called = (key: string) => calls.filter((c) => c.key === key)

const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
const g = globalThis as Record<string, unknown>
const computerMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
const phoneWidth = () => { g.matchMedia = (q: string) => ({ ...computerMedia(), matches: q === '(max-width: 767.98px)' }) }
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
afterEach(() => {
  progress = null
  ai = { usable: true, action: 'connect_team', requested: false }
  calls = []
  g.matchMedia = computerMedia
  useWelcome.getState().reset()
  useAiAccess.getState().reset()
  useUi.setState({ toasts: [] })
})
afterAll(() => {
  globalThis.fetch = realFetch
  g.matchMedia = computerMedia
  useSession.setState({ status: sessionBefore } as never)
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})

const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p> }
const row = (path: string) => mount(
  <MemoryRouter initialEntries={[path]}>
    <SetupRow />
    <Routes><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>,
)
/** the row's state once the progress and the AI check are read (null: no row) */
async function stateAt(m: Mounted) {
  await m.until(() => useWelcome.getState().loaded && useAiAccess.getState().loaded, 'read')
  await m.settle(30)
  return m.find('setup-row')?.getAttribute('data-state') ?? null
}

describe('the setup row', () => {
  test('the owner\'s "설정 이어서 하기 · n/4" opens /welcome, where it is not shown', async () => {
    signIn('owner')
    progress = half()
    const m = await row('/c/abc')
    try {
      await m.until(() => m.find('setup-row-link'), 'the row')
      expect(m.get('setup-row').getAttribute('data-state')).toBe('resume')
      expect(m.get('setup-row-link').textContent).toBe(`${translate('ko', 'setupRow.resume')}· 1/${stepTotal()}`)
      expect(m.get('setup-row-link').textContent).toContain('설정 이어서 하기')
      expect(m.get('setup-row-count').textContent).toBe('· 1/4')
      expect(m.get('setup-row-link').getAttribute('href')).toBe('/welcome')
      // a left click (react-router's Link follows only button 0)
      const click = Object.assign(new FakeEvent('click', { bubbles: true, cancelable: true }), { button: 0 })
      await act(async () => { m.get('setup-row-link').dispatchEvent(click) })
      await m.until(() => m.find('where')?.textContent === '/welcome', 'the steps')
      await m.settle(30)
      expect(m.find('setup-row')).toBeNull()
    } finally { await m.unmount() }
  }, 20_000)

  test('only the owner; never once finished, hidden, never started, or on /welcome', async () => {
    for (const role of ['admin', 'member'] as const) {
      signIn(role)
      progress = half()
      const m = await row('/c/abc')
      try {
        await m.settle(40)
        expect(m.find('setup-row')).toBeNull()
        expect(called('GET /api/onboarding/welcome')).toEqual([])
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
    signIn('owner')
    for (const [p, path] of [[half({ finishedAt: '2026-11-04T00:03:00.000Z' }), '/c/abc'], [half({ dismissedAt: '2026-11-04T00:02:00.000Z' }), '/c/abc'], [null, '/c/abc'], [half(), '/welcome']] as const) {
      progress = p
      const m = await row(path)
      try {
        expect(await stateAt(m)).toBeNull()
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      useAiAccess.getState().reset()
    }
  })

  test('a hidden row reads the progress once: page changes past the 5 s freshness read it again only while it shows', async () => {
    signIn('owner')
    let go: (path: string) => void = () => {}
    function Nav() { const n = useNavigate(); go = n; return null }
    const realNow = Date.now
    let shift = 0
    Date.now = () => realNow() + shift
    try {
      for (const [p, reads] of [[half({ dismissedAt: '2026-11-04T00:02:00.000Z' }), 1], [half(), 3]] as const) {
        progress = p
        const m = await mount(<MemoryRouter initialEntries={['/c/abc']}><SetupRow /><Nav /></MemoryRouter>)
        try {
          await m.until(() => useWelcome.getState().loaded, 'read')
          for (const path of ['/rooms', '/files']) {
            shift += 10_000
            await act(async () => { go(path) })
            await m.settle(30)
          }
          expect({ dismissed: !!p.dismissedAt, reads: called('GET /api/onboarding/welcome').length }).toEqual({ dismissed: !!p.dismissedAt, reads })
        } finally { await m.unmount() }
        useWelcome.getState().reset()
        calls = []
      }
    } finally { Date.now = realNow }
  })

  test('✕ hides it with an undo toast; undo brings it back', async () => {
    signIn('owner')
    progress = half()
    const m = await row('/c/abc')
    try {
      await m.until(() => m.find('setup-row-hide'), 'the row')
      expect(m.get('setup-row-hide').getAttribute('aria-label')).toBe('시작 설정 숨기기')
      await m.click('setup-row-hide')
      await m.until(() => !m.find('setup-row'), 'hidden')
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body)).toEqual([{ dismissed: true }])
      const toast = useUi.getState().toasts.find((x) => x.text === '시작 설정을 숨겼어요 · 관리자 홈에서 다시 볼 수 있어요')
      expect(toast?.action?.label).toBe(translate('ko', 'common.undo'))
      await act(async () => { toast!.action!.run() })
      await m.until(() => m.find('setup-row'), 'back')
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body)).toEqual([{ dismissed: true }, { dismissed: false }])
    } finally { await m.unmount() }
  }, 20_000)

  test('while no AI answers: "AI 연결하기" opens the dialog "AI 연결" with the welcome step\'s three ways (not "계정 추가" on Claude alone), and Home (its no-AI card) has no row', async () => {
    signIn('owner')
    ai = { usable: false, action: 'connect_team', requested: false }
    progress = half()
    let m = await row('/c/abc')
    try {
      await m.until(() => m.find('setup-row-ai'), 'the row')
      expect(m.get('setup-row').getAttribute('data-state')).toBe('ai')
      expect(m.get('setup-row-ai').textContent).toBe('AI 연결하기')
      expect(m.find('setup-row-link')).toBeNull()
      await m.click('setup-row-ai')
      await m.until(() => m.find('welcome-ai-keys'), 'the connect dialog with its ways')
      const dialog = (globalThis.document as any).body.querySelector('[role="dialog"]')
      expect(dialog.querySelector('h2').textContent).toBe('AI 연결')
      expect(['welcome-ai-claude', 'welcome-ai-chatgpt', 'welcome-ai-keys'].map((id) => !!m.find(id))).toEqual([true, true, true])
      expect(m.get('welcome-ai-claude').textContent).toContain(translate('ko', 'welcome.ai.claude'))
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    m = await row('/')
    try {
      expect(await stateAt(m)).toBeNull()
    } finally { await m.unmount() }
  }, 20_000)

  test('on a computer the row is on Home too (it replaces Home\'s row); on a phone not on Home, elsewhere in the drawer', async () => {
    signIn('owner')
    progress = half()
    let m = await row('/')
    try {
      expect(await stateAt(m)).toBe('resume')
    } finally { await m.unmount() }
    phoneWidth()
    for (const [path, want] of [['/', null], ['/rooms', 'resume'], ['/c/abc', 'resume']] as const) {
      useWelcome.getState().reset()
      m = await row(path)
      try {
        expect(await stateAt(m)).toBe(want)
      } finally { await m.unmount() }
    }
  })

  // the recheck of onboarding v5: a phone's Home read "설정 이어서 하기 · 4/4" with 팀 파일 put off and 내 스킬 waiting
  // for a computer, as if nothing were left
  test('with one step left here the row names it ("남은 일: 팀 파일"), no count; a phone\'s Home row and its drawer say the same; a computer counts the steps done', async () => {
    signIn('owner')
    progress = half({ resultChatId: '01900000-0000-7000-8000-0000000000c1', skillsLater: true, steps: { profile: 'done', result: null, skills: 'skipped', files: 'skipped', invite: 'done' } })
    phoneWidth()
    let m = await mount(<MemoryRouter initialEntries={['/']}><WelcomeResume /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-resume-text'), 'Home\'s row')
      expect(m.get('welcome-resume-text').textContent).toBe('남은 일: 팀 파일')
    } finally { await m.unmount() }
    // the drawer (anywhere but Home on a phone): the same words
    m = await row('/c/abc')
    try {
      await m.until(() => m.find('setup-row-link'), 'the drawer\'s row')
      expect(m.get('setup-row-link').textContent).toBe('남은 일: 팀 파일')
      expect(m.find('setup-row-count')).toBeNull()
    } finally { await m.unmount() }
    // a computer: 내 스킬 is left there too; the count is the steps done, never "4/4"
    g.matchMedia = computerMedia
    useWelcome.getState().reset()
    m = await row('/c/abc')
    try {
      await m.until(() => m.find('setup-row-link'), 'the row')
      expect(m.get('setup-row-link').textContent).toBe('설정 이어서 하기· 2/4')
    } finally { await m.unmount() }
  }, 20_000)

  test('it sits in the sidebar above Recents', async () => {
    signIn('owner')
    progress = half()
    const m = await mount(<MemoryRouter initialEntries={['/c/abc']}><Sidebar /></MemoryRouter>)
    try {
      await m.until(() => m.find('setup-row') && m.find('recents-toggle'), 'the sidebar with the row')
      expect(m.html().indexOf('data-testid="setup-row"')).toBeLessThan(m.html().indexOf('data-testid="recents-toggle"'))
    } finally { await m.unmount() }
  }, 20_000)
})

describe('Admin › Home', () => {
  test('the setup checklist hides while the steps are unfinished; "시작 설정 다시 보기" only when the row was hidden, and it brings it back', async () => {
    signIn('owner')
    progress = half()
    let m = await mount(<MemoryRouter><OwnerSetup /></MemoryRouter>)
    try {
      await m.until(() => useWelcome.getState().loaded, 'read')
      await m.settle(40)
      expect(m.find('owner-checklist')).toBeNull()
      expect(m.find('owner-setup')).toBeNull()
    } finally { await m.unmount() }
    useWelcome.getState().reset()
    progress = half({ dismissedAt: '2026-11-04T00:02:00.000Z' })
    m = await mount(<MemoryRouter><OwnerSetup /></MemoryRouter>)
    try {
      await m.until(() => m.find('owner-setup-show'), 'the way back')
      expect(m.get('owner-setup-show').textContent).toBe('시작 설정 다시 보기')
      expect(m.find('owner-checklist')).toBeNull()
      await m.click('owner-setup-show')
      await m.until(() => !m.find('owner-setup'), 'gone')
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body)).toEqual([{ dismissed: false }])
      expect(progress!.dismissedAt).toBeNull()
      expect(useUi.getState().toasts.some((x) => x.text === translate('ko', 'setupRow.back'))).toBe(true)
    } finally { await m.unmount() }
    // finished, or a team from before the steps: the checklist as before
    for (const p of [half({ finishedAt: '2026-11-04T00:03:00.000Z' }), null]) {
      useWelcome.getState().reset()
      progress = p
      m = await mount(<MemoryRouter><OwnerSetup /></MemoryRouter>)
      try {
        await m.until(() => m.find('owner-checklist'), 'the checklist')
        expect(m.find('owner-setup')).toBeNull()
      } finally { await m.unmount() }
    }
  })
})
