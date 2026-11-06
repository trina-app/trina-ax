// Home while no AI answers the person (pages/Home.tsx, components/onboarding/ConnectAi.tsx NoAiCard; docs/DECISIONS.md
// "W2 — AI connection first", "Y — Home shows one thing at a time"): ONE card instead of the top row, the suggestions
// and the line above the box. The owner who put the AI step off ("나중에 하기") gets the card, not "시작 설정 이어하기
// (0/3)" (which only led back to the AI step); once AI answers, the row comes back, the AI step recorded done, so it
// counts 1/3 and leads on to 회사 소개.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom'
import type { WelcomeProgress, WelcomeUpdate } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { forgetStepsSeen, LANDING_STATE, markStepsSeen, stepsSeen } from '../../src/lib/welcome'
import { installDom, mount, removeDom } from './dom-host'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ko = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('ko', k, p)
const meOf = (role: 'owner' | 'admin' | 'member') => ({
  user: { id: 'olga', username: 'olga', name: '올가', email: null, role, locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
/** after "나중에 하기" on the AI step: shown and put off, nothing else done */
const putOff = (): WelcomeProgress => ({
  startedAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', teamType: null,
  steps: { ai: 'skipped', profile: null, result: null, invite: null }, pack: null, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})

let access = { usable: false, action: 'connect_team', requested: false }
let progress: WelcomeProgress | null = null
let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/ai-access': () => json(200, access),
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key', 'chatgpt', 'openai-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'PATCH /api/onboarding/welcome': (u: WelcomeUpdate) => {
    if (progress && u.step) progress = { ...progress, steps: { ...progress.steps, [u.step.id]: u.step.state } }
    return json(200, { progress })
  },
  'GET /api/onboarding/goal': () => json(200, { goal: null }),
  'GET /api/skills': () => json(200, { items: [] }),
  'GET /api/questions/frequent': () => json(200, { items: [] }),
  'GET /api/skills/popular': () => json(200, { items: [] }),
}
const called = (key: string) => calls.filter((c) => c.key === key)

const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status }
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
  access = { usable: false, action: 'connect_team', requested: false }
  progress = null
  calls = []
  localStorage.clear()
  useChats.getState().reset()
  useAiAccess.getState().reset()
  useWelcome.getState().reset()
  forgetStepsSeen()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const signIn = (role: 'owner' | 'admin' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
const home = () => mount(<MemoryRouter><Routes><Route path="/" element={<Home />} /></Routes></MemoryRouter>)

describe('Home without AI', () => {
  test('the owner after "나중에 하기": the connect card alone, no "시작 설정 이어하기 (0/3)", no suggestions, no line above the box; AI answers: the row is back at 1/3', async () => {
    signIn('owner')
    progress = putOff()
    // the steps were on screen in this tab (put off there): Home stays Home
    markStepsSeen('olga')
    const m = await home()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the card')
      expect(m.get('no-ai-card').getAttribute('data-action')).toBe('connect_team')
      expect(m.get('no-ai-card').textContent).toContain(ko('welcome.ai.title'))
      expect(m.find('welcome-resume')).toBeNull()
      expect(m.find('team-goal')).toBeNull()
      expect(m.find('ai-access-banner')).toBeNull()
      expect(m.find('composer-input')).not.toBeNull()
      expect(called('GET /api/questions/frequent')).toEqual([])
      expect(called('GET /api/skills/popular')).toEqual([])
      // connected (the card's dialog, a chat, Admin, another tab): the row comes back, the AI step recorded done
      access = { usable: true, action: 'connect_team', requested: false }
      await act(async () => { await useAiAccess.getState().load(true) })
      await m.until(() => m.find('welcome-resume'), 'the row')
      expect(m.find('no-ai-card')).toBeNull()
      await m.until(() => progress!.steps.ai === 'done', 'the AI step done')
      await m.until(() => m.get('welcome-resume-link').textContent?.includes(ko('home.setupResume', { n: 1, total: 3 })), 'the row at 1/3')
      expect(called('PATCH /api/onboarding/welcome').map((c) => c.body)).toEqual([{ step: { id: 'ai', state: 'done' } }])
      await m.until(() => called('GET /api/questions/frequent').length > 0, 'the suggestions')
    } finally { await m.unmount() }
  })

  test('the owner with AI: the row as before, nothing recorded', async () => {
    signIn('owner')
    access = { usable: true, action: 'connect_team', requested: false }
    progress = { ...putOff(), steps: { profile: 'done', result: null, invite: null } }
    markStepsSeen('olga')
    const m = await home()
    try {
      await m.until(() => m.find('welcome-resume'), 'the row')
      expect(m.get('welcome-resume-link').textContent).toContain(ko('home.setupResume', { n: 1, total: 2 }))
      expect(m.find('no-ai-card')).toBeNull()
      expect(called('PATCH /api/onboarding/welcome')).toEqual([])
    } finally { await m.unmount() }
  })

  test('a member: "팀장이 AI를 연결하면 바로 쓸 수 있어요" alone; their own connection only where allowed (an admin connects for the team, like the owner)', async () => {
    for (const [role, action] of [['member', 'ask_owner'], ['member', 'connect_own']] as const) {
      signIn(role)
      access = { usable: false, action, requested: false }
      const m = await home()
      try {
        await m.until(() => m.find('no-ai-card'), 'the card')
        expect(m.get('no-ai-card').textContent).toContain(ko('aiConnect.member'))
        expect(m.get('ai-access-button').textContent).toBe(ko('aiAccess.askOwner'))
        expect(!!m.find('no-ai-own')).toBe(action === 'connect_own')
        expect(m.find('ai-access-banner')).toBeNull()
        expect(m.find('team-goal')).toBeNull()
        expect(called('GET /api/questions/frequent')).toEqual([])
      } finally { await m.unmount() }
      calls = []
      useAiAccess.getState().reset()
    }
  })
})

describe('coming back resumes the welcome steps (docs/DECISIONS.md "W4")', () => {
  function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p> }
  /** Home at the last entry: one entry is the tab's first page (a landing); after others, a page reached in the app */
  const open = (entries: InitialEntry[] = ['/']) => mount(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes><Route path="/" element={<Home />} /><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  )
  const where = (m: Awaited<ReturnType<typeof open>>) => m.find('where')?.textContent ?? (m.find('composer-input') ? '/' : null)
  /** 회사 소개 done, 첫 결과 open, AI answers */
  const unfinished = (): WelcomeProgress => ({ ...putOff(), steps: { ai: 'done', profile: 'done', result: null, invite: null } })
  const settled = async (m: Awaited<ReturnType<typeof open>>) => {
    await m.until(() => useWelcome.getState().loaded, 'the progress')
    await m.settle(40)
  }

  test('the owner opening the app on Home with unfinished steps lands on them (nothing of Home first), once per tab session', async () => {
    signIn('owner')
    access = { usable: true, action: 'connect_team', requested: false }
    progress = unfinished()
    let m = await open()
    try {
      // Home's box never shows first: the page waits for the progress, then goes
      expect(m.find('composer-input')).toBeNull()
      await m.until(() => where(m) === '/welcome', 'the steps')
      expect(stepsSeen('olga')).toBe(true)
    } finally { await m.unmount() }
    // the same tab again (a reload, "나중에 하기" back to Home): Home, with its row
    useWelcome.getState().reset()
    m = await open()
    try {
      await m.until(() => m.find('welcome-resume'), 'Home\'s row')
      expect(where(m)).toBe('/')
    } finally { await m.unmount() }
    // a new tab session: the steps again
    forgetStepsSeen()
    useWelcome.getState().reset()
    m = await open()
    try {
      await m.until(() => where(m) === '/welcome', 'the steps again')
    } finally { await m.unmount() }
  })

  test('a sign-in landing counts (no ?next: LANDING_STATE), a click on Home from elsewhere in the app does not', async () => {
    signIn('owner')
    access = { usable: true, action: 'connect_team', requested: false }
    progress = unfinished()
    let m = await open(['/login', { pathname: '/', state: LANDING_STATE }])
    try {
      await m.until(() => where(m) === '/welcome', 'the steps')
    } finally { await m.unmount() }
    forgetStepsSeen()
    useWelcome.getState().reset()
    // a chat opened first (a deep link), then Home: not a landing
    m = await open(['/c/0190', '/'])
    try {
      await m.until(() => m.find('welcome-resume'), 'Home\'s row')
      expect(where(m)).toBe('/')
      expect(stepsSeen('olga')).toBe(false)
    } finally { await m.unmount() }
  })

  test('never for a member or an admin (the steps are the owner\'s), and their Home does not wait for them', async () => {
    progress = unfinished()
    for (const role of ['member', 'admin'] as const) {
      signIn(role)
      access = { usable: true, action: 'connect_own', requested: false }
      const m = await open()
      try {
        expect(m.find('home-resuming')).toBeNull()
        await m.settle(40)
        expect(where(m)).toBe('/')
      } finally { await m.unmount() }
      useWelcome.getState().reset()
      calls = []
    }
  })

  test('never when the steps are hidden, finished, never started, or only a put-off invite is left', async () => {
    signIn('owner')
    access = { usable: true, action: 'connect_team', requested: false }
    const done = { ai: 'done', profile: 'done', result: 'done' } as const
    for (const p of [
      { ...unfinished(), dismissedAt: '2026-11-05T01:00:00.000Z' },
      { ...putOff(), steps: { ...done, invite: 'done' }, finishedAt: '2026-11-05T01:00:00.000Z' },
      null,
      { ...putOff(), steps: { ...done, invite: 'skipped' } },
    ] as (WelcomeProgress | null)[]) {
      progress = p
      const m = await open()
      try {
        await settled(m)
        expect(where(m)).toBe('/')
        expect(m.find('home-resuming')).toBeNull()
      } finally { await m.unmount() }
      useWelcome.getState().reset()
    }
    expect(stepsSeen('olga')).toBe(false)
  })

  test('without sessionStorage (refused by the browser) it is still once: the page keeps the mark', async () => {
    const g = globalThis as any
    const was = Object.getOwnPropertyDescriptor(g, 'sessionStorage')
    Object.defineProperty(g, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError') } })
    try {
      signIn('owner')
      access = { usable: true, action: 'connect_team', requested: false }
      progress = unfinished()
      let m = await open()
      try { await m.until(() => where(m) === '/welcome', 'the steps') } finally { await m.unmount() }
      useWelcome.getState().reset()
      m = await open()
      try {
        await m.until(() => m.find('welcome-resume'), 'Home\'s row')
        expect(where(m)).toBe('/')
      } finally { await m.unmount() }
    } finally {
      if (was) Object.defineProperty(g, 'sessionStorage', was)
      else delete g.sessionStorage
    }
  })
})

