// One suggestion under a result (components/onboarding/ResultSuggestion.tsx; docs/DECISIONS.md "X — Lean onboarding"):
// the lead's first result keeps the welcome invite bar and nothing else; otherwise what the server says for the newest
// answer (tests/unit/b-result-suggestions.test.ts checks the server): schedule the same request every week at this
// time, make a team skill of an owner's or admin's work (the skill card, docs/DECISIONS.md "W3"), or make a PPT;
// closing one asks the server to keep it closed for this person.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { WELCOME_RESULT_SKILL, type ResultSuggestion as Suggestion, type WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { ResultSuggestion, weeklyAt } from '../../src/components/onboarding/ResultSuggestion'
import { forgetSkillDrafts } from '../../src/components/onboarding/SkillShareCard'
import { useSession } from '../../src/store/session'
import type { ViewMessage } from '../../src/store/thread'
import { useWelcome } from '../../src/store/welcome'
import { installDom, mount, removeDom } from './dom-host'

const CHAT = '01900000-0000-7000-8000-0000000000c1'
const ASK = '01900000-0000-7000-8000-0000000000a1'
const ANSWER = '01900000-0000-7000-8000-0000000000a2'
const DRAFT = '01900000-0000-7000-8000-0000000000d1'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const meOf = (role: 'owner' | 'member') => ({ user: { id: 'olga', username: 'olga', name: '올가', role, locale: 'ko', prefs: {} }, groups: [], team: { name: 'Acme', defaultLocale: 'ko' } })
const msg = (id: string, role: 'user' | 'assistant', content: string, over: Partial<ViewMessage> = {}): ViewMessage => ({
  id, chatId: CHAT, parentId: role === 'assistant' ? ASK : null, role, author: null, content, attachments: [], steps: [], status: 'done', error: null, turnId: null,
  engine: null, model: null, files: null, usage: null, createdAt: '2026-11-04T00:00:00.000Z', branch: { index: 0, count: 1, siblingIds: [id] }, ...over,
})
const REQUEST = '/ad-copy\n알릴 제품·서비스: 종이 플래너\n\n어디에 실을까요: 인스타그램 피드'
const thread = (over: Partial<ViewMessage> = {}) => [msg(ASK, 'user', REQUEST), msg(ANSWER, 'assistant', '3안', over)]

let suggestion: Suggestion | null = null
let progress: WelcomeProgress | null = null
let calls: { key: string; body: unknown }[] = []
const realFetch = globalThis.fetch
const localeBefore = useLocaleStore.getState().locale
const sessionBefore = useSession.getState().status
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const [path, query] = String(input).split('?')
    const key = `${init?.method ?? 'GET'} ${path}`
    calls.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : query })
    if (key === 'GET /api/onboarding/suggestion') return json(200, { suggestion })
    if (key === 'POST /api/onboarding/suggestion/dismiss') return new Response(null, { status: 204 })
    if (key === 'GET /api/onboarding/welcome') return json(200, { progress })
    // the skill card of a team-skill suggestion: the draft, then the save
    if (key === 'POST /api/onboarding/skill-draft') return json(201, { draftChatId: DRAFT })
    if (key === `GET /api/onboarding/skill-draft/${DRAFT}`) return json(200, { status: 'done', draft: { title: '용어집 정리', description: '팀 용어집으로 새 글의 용어를 맞춰요', inputs: [], files: [{ path: 'shared/glossary.md', latest: false }], recurring: false }, problem: null, saved: null })
    if (key === `POST /api/onboarding/skill-draft/${DRAFT}/save`) return json(200, { path: 'skills/general/yongeojip-jeongri/SKILL.md', name: 'yongeojip-jeongri', title: '용어집 정리' })
    return json(404, { error: { code: 'not_found', message: key } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  forgetSkillDrafts()
  suggestion = null
  progress = null
  calls = []
  useWelcome.getState().reset()
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: localeBefore })
  useSession.setState({ status: sessionBefore })
})
const signIn = (role: 'owner' | 'member') => useSession.setState({ status: { kind: 'signed-in', me: meOf(role) } } as never)
const called = (key: string) => calls.filter((c) => c.key === key)

describe('the suggestion under a result', () => {
  test('the 2nd run of a skill: "every week at this time?" asks the AI to schedule the same request, then goes away', async () => {
    signIn('member')
    suggestion = { kind: 'schedule', key: `schedule:${WELCOME_RESULT_SKILL}`, skill: { path: WELCOME_RESULT_SKILL, name: 'ad-copy' } }
    const sent: string[] = []
    const m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      expect(m.get('result-suggestion').getAttribute('data-kind')).toBe('schedule')
      expect(m.get('result-suggestion').textContent).toContain('매주 이 시간에 자동으로 받을까요?')
      expect(m.get('result-suggestion-act').textContent).toBe('예약하기')
      expect(called('GET /api/onboarding/suggestion')[0]!.body).toBe(`chatId=${CHAT}&messageId=${ANSWER}`)
      await m.click('result-suggestion-act')
      expect(sent).toHaveLength(1)
      const { day, time } = weeklyAt(new Date(), 'ko')
      expect(sent[0]).toBe(translate('ko', 'resultTip.schedule.message', { day, time, request: REQUEST }))
      expect(sent[0]).toContain(`매주 ${day} ${time}에`)
      expect(m.find('result-suggestion')).toBeNull()
      // acting on it is not closing it for good
      expect(called('POST /api/onboarding/suggestion/dismiss')).toEqual([])
    } finally { await m.unmount() }
  })

  test('a report: [PPT로 만들기] sends the request; X closes it for good on the server', async () => {
    signIn('member')
    suggestion = { kind: 'ppt', key: 'ppt' }
    const sent: string[] = []
    let m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      expect(m.get('result-suggestion-act').textContent).toBe('PPT로 만들기')
      await m.click('result-suggestion-act')
      expect(sent).toEqual(['이 내용을 PPT로 만들어 줘'])
    } finally { await m.unmount() }
    m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-close')
      expect(m.find('result-suggestion')).toBeNull()
      await m.until(() => called('POST /api/onboarding/suggestion/dismiss').length, 'closed on the server')
      expect(called('POST /api/onboarding/suggestion/dismiss')[0]!.body).toEqual({ key: 'ppt' })
    } finally { await m.unmount() }
  })

  test('an owner\'s work with team files: "이 방식대로 팀 스킬로 만들까요?" opens the skill card, then the invite with the skill; X closes it for good', async () => {
    signIn('owner')
    suggestion = { kind: 'team-skill', key: 'team-skill' }
    const sent: string[] = []
    let m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      expect(m.get('result-suggestion').getAttribute('data-kind')).toBe('team-skill')
      expect(m.get('result-suggestion').textContent).toContain('이 방식대로 팀 스킬로 만들까요?')
      expect(m.get('result-suggestion-act').textContent).toBe('팀 스킬로 만들기')
      await m.click('result-suggestion-act')
      // the line goes; the card drafts from this chat and shows what it made
      expect(m.find('result-suggestion')).toBeNull()
      await m.until(() => m.find('skill-share')?.getAttribute('data-state') === 'ready', 'the card', 6000)
      expect(called('POST /api/onboarding/skill-draft')[0]!.body).toEqual({ chatId: CHAT })
      expect(m.get('skill-share-title').textContent).toBe('용어집 정리')
      await m.click('skill-share-share')
      await m.until(() => m.find('invite-step'), 'the invite with the skill')
      expect(called(`POST /api/onboarding/skill-draft/${DRAFT}/save`)[0]!.body).toEqual({ title: '용어집 정리' })
      // nothing was sent to the AI, nothing closed for good
      expect(sent).toEqual([])
      expect(called('POST /api/onboarding/suggestion/dismiss')).toEqual([])
      await m.click('invite-step-done')
      expect(m.find('invite-step')).toBeNull()
    } finally { await m.unmount() }
    m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-close')
      await m.until(() => called('POST /api/onboarding/suggestion/dismiss').length, 'closed on the server')
      expect(called('POST /api/onboarding/suggestion/dismiss')[0]!.body).toEqual({ key: 'team-skill' })
      expect(m.find('skill-share')).toBeNull()
    } finally { await m.unmount() }
    // a later answer of the same chat starts its own draft (the card never shows the earlier answer's)
    const later = '01900000-0000-7000-8000-0000000000a3'
    m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={[...thread(), msg(later, 'assistant', '다음 답', { parentId: ASK })]} busy={false} onSend={(t) => sent.push(t)} /></MemoryRouter>)
    try {
      await m.until(() => m.find('result-suggestion'), 'the line')
      await m.click('result-suggestion-act')
      await m.until(() => called('POST /api/onboarding/skill-draft').length === 2, 'a new draft')
    } finally { await m.unmount() }
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) expect([translate(l, 'resultTip.teamSkill.text'), translate(l, 'resultTip.teamSkill.act')].every((x) => x && !x.startsWith('resultTip'))).toBe(true)
  })

  test('nothing while the answer runs or failed, and nothing when the server has none', async () => {
    signIn('member')
    suggestion = { kind: 'ppt', key: 'ppt' }
    for (const [busy, over] of [[true, {}], [false, { status: 'streaming' }], [false, { status: 'error' }]] as const) {
      const m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread(over as Partial<ViewMessage>)} busy={busy} onSend={() => {}} /></MemoryRouter>)
      try {
        await m.settle(30)
        expect(m.find('result-suggestion')).toBeNull()
      } finally { await m.unmount() }
    }
    expect(called('GET /api/onboarding/suggestion')).toEqual([])
    // none, or the promo video from the intro deck (docs/DECISIONS.md "D2": not built yet, the server never sends it
    // while it is off): no line
    for (const s of [null, { kind: 'deck-video', key: 'deck-video' }] as const) {
      suggestion = s
      calls = []
      const m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={() => {}} /></MemoryRouter>)
      try {
        await m.until(() => called('GET /api/onboarding/suggestion').length, 'asked')
        await m.settle(30)
        expect(m.find('result-suggestion')).toBeNull()
      } finally { await m.unmount() }
    }
  })

  test('the lead\'s first result: the invite bar only, the server is not asked for another one', async () => {
    signIn('owner')
    suggestion = { kind: 'ppt', key: 'ppt' }
    progress = {
      startedAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', teamType: 'marketing', steps: { profile: 'done', result: 'done', invite: null },
      pack: { id: 'marketing', at: '2026-11-04T00:00:00.000Z', skillPath: WELCOME_RESULT_SKILL }, resultChatId: CHAT, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
    }
    const m = await mount(<MemoryRouter><ResultSuggestion chatId={CHAT} messages={thread()} busy={false} onSend={() => {}} /></MemoryRouter>)
    try {
      await m.until(() => m.find('welcome-invite-bar'), 'the invite bar')
      await m.settle(30)
      expect(m.find('result-suggestion')).toBeNull()
      expect(called('GET /api/onboarding/suggestion')).toEqual([])
    } finally { await m.unmount() }
    // the owner on another chat: the suggestion
    const other = await mount(<MemoryRouter><ResultSuggestion chatId="another-chat" messages={thread()} busy={false} onSend={() => {}} /></MemoryRouter>)
    try {
      await other.until(() => other.find('result-suggestion'), 'the line')
      expect(other.find('welcome-invite-bar')).toBeNull()
    } finally { await other.unmount() }
  })
})
