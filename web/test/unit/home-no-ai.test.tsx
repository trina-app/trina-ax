// Home while no AI answers the person (pages/Home.tsx, components/onboarding/ConnectAi.tsx NoAiCard; docs/DECISIONS.md
// "W2 — AI connection first", "Y — Home shows one thing at a time"): ONE card instead of the top row, the suggestions
// and the line above the box. The owner who put the AI step off ("나중에 하기") gets the card, not "시작 설정 이어하기
// (0/3)" (which only led back to the AI step); once AI answers, the row comes back, the AI step recorded done, so it
// counts 1/3 and leads on to 회사 소개.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { WelcomeProgress, WelcomeUpdate } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
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
    const m = await home()
    try {
      await m.until(() => m.find('welcome-resume'), 'the row')
      expect(m.get('welcome-resume-link').textContent).toContain(ko('home.setupResume', { n: 1, total: 2 }))
      expect(m.find('no-ai-card')).toBeNull()
      expect(called('PATCH /api/onboarding/welcome')).toEqual([])
    } finally { await m.unmount() }
  })

  test('a member (an admin too): "팀장이 AI를 연결하면 바로 쓸 수 있어요" alone; their own connection only where allowed', async () => {
    for (const [role, action] of [['member', 'ask_owner'], ['admin', 'connect_own']] as const) {
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
