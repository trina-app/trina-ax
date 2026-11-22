// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md; src/lib/freeRoam.ts, src/store/demo.ts,
// src/components/demo/FreeRoam.tsx). The server says it is one through GET /api/demo (kind "freeRoam", used, cap,
// signupUrl) while `me.server.dev` is false; here: who is asked, the bar and its suggestions, the meter from 80 %, the
// limit (dialog once, the message boxes stop), the neutral words, the hidden AI-account sections, the sign-in page.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DemoInfo, Locale, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { DemoBar, useDemoInfo } from '../../src/components/demo/Demo'
import { DemoLimitDialog, DemoLimitNotice, FreeRoamChips, FreeRoamStart, FreeRoamUnavailable } from '../../src/components/demo/FreeRoam'
import { api, API, ApiError, errorText } from '../../src/lib/api'
import { demoAnswerKey, demoMeter, demoQuestionsLeft, demoReason, FREE_ROAM_HIDDEN_PAGES, freeRoamSuggestions, mayBeDemoServer, resumeFreeRoam } from '../../src/lib/freeRoam'
import { micState } from '../../src/lib/voice'
import { settingsTabs } from '../../src/pages/settingsTabs'
import { demoAnswerEnded, freeRoamNow, freshStart, useDemo } from '../../src/store/demo'
import { takeFreshStart } from '../../src/lib/freeRoam'
import { cjkTight, formatRelative } from '../../src/lib/format'
import { canChooseEngine, teamDefaultLocale, useSession } from '../../src/store/session'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'
import { renderToStaticMarkup } from 'react-dom/server'
import { AvailableSkillsList } from '../../src/components/AvailableSkills'
import { AccountMenu } from '../../src/components/nav/AccountMenu'
import { LanguageSelect } from '../../src/components/LanguageSelect'
import { FREE_ROAM_LOCALES, freeRoamSignInLocales } from '../../src/lib/freeRoam'
import { LanguageSwitcher } from '../../src/pages/Auth'
import { useTeamSwitchWay } from '../../src/lib/teamSwitch'

const INFO: DemoInfo = {
  company: 'Steepling', sameQuestion: null, current: 'newHire', network: false, kind: 'freeRoam', used: 1_000, cap: 300_000, signupUrl: 'https://example.com/pricing',
  personas: [{ key: 'newHire', name: 'Mina', team: 'Marketing', intro: 'Your first day at Steepling.', questions: [] }],
}
const FEATURES_OFF = { connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false }
const FEATURES_SELF = { connectionChange: true, selfUpdate: true, officeUpdate: false, connectedFolders: true, apiEngineAnyUrl: true, hostDiagnostics: true, pluginFileInstall: true }
const me = (server: Partial<Me['server']>, o: { canChooseEngine?: boolean } = {}): Me => ({
  user: { id: 'mina', username: 'mina', name: 'Mina', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs: {}, ...(o.canChooseEngine ? { canChooseEngine: true } : {}) },
  groups: [], team: { name: 'Steepling', defaultLocale: 'en' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev: false, deployment: 'self', ...server },
} as unknown as Me)
const en = (key: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', key, p)

let requests: string[] = []
let demoAnswer: DemoInfo | null = INFO
let sendAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true } }
const realFetch = globalThis.fetch
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function Probe() {
  const { ready, info } = useDemoInfo()
  return <p data-testid="probe">{`${ready}:${info ? info.kind : 'none'}`}</p>
}

let localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  localeBefore = useLocaleStore.getState().locale
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/api/demo')) return demoAnswer ? json(200, demoAnswer) : json(404, { error: { code: 'not_found', message: 'not found' } })
    if (url.endsWith('/api/memories')) return json(sendAnswer.status, sendAnswer.body)
    return json(404, { error: { code: 'not_found', message: 'not found' } })
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})
beforeEach(() => {
  requests = []
  demoAnswer = INFO
  sendAnswer = { status: 200, body: { ok: true } }
  useDemo.setState({ loaded: false, info: null, out: false, limitOpen: false })
  sessionStorage.removeItem('mycel.demo.limitSeen')
})

describe('which server is asked', () => {
  test('signed out: every server; signed in: a development server or the free-roam feature row only', () => {
    expect(mayBeDemoServer(null)).toBe(true)
    expect(mayBeDemoServer(me({ dev: true }))).toBe(true)
    // a free-roam instance: dev false, every feature off on a self-installed server
    expect(mayBeDemoServer(me({ features: FEATURES_OFF }))).toBe(true)
    // a real self-installed server, an older server without features, the hosted service: never asked
    expect(mayBeDemoServer(me({ features: FEATURES_SELF }))).toBe(false)
    expect(mayBeDemoServer(me({}))).toBe(false)
    expect(mayBeDemoServer(me({ deployment: 'hosted', features: FEATURES_OFF }))).toBe(false)
  })

  test('a free-roam instance (dev false) is read as a demo; a self-installed server never asks', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_OFF }) } } as never)
    const m = await mount(<Probe />)
    try {
      await m.until(() => m.get('probe').textContent === 'true:freeRoam', 'free roam known')
      expect(requests).toEqual(['/api/demo'])
      expect(freeRoamNow()).toBe(true)
    } finally { await m.unmount() }
    useDemo.setState({ loaded: false, info: null })
    requests = []
    useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_SELF }) } } as never)
    const n = await mount(<Probe />)
    try {
      await n.settle()
      expect(n.get('probe').textContent).toBe('true:none')
      expect(requests).toEqual([])
    } finally { await n.unmount() }
  })
})

describe('the counter', () => {
  test('out only at the limit; nothing known, not out (no % meter: QA 2026-11-22 F12)', () => {
    expect(demoMeter(0, 300_000)).toEqual({ out: false })
    expect(demoMeter(299_999, 300_000)).toEqual({ out: false })
    expect(demoMeter(300_000, 300_000)).toEqual({ out: true })
    expect(demoMeter(400_000, 300_000)).toEqual({ out: true })
    expect(demoMeter(undefined, undefined)).toEqual({ out: false })
  })
  test('questions left: floor(remaining / 35k) right to the end, 0 before out; nothing known or out, nothing said', () => {
    expect(demoQuestionsLeft(0, 300_000)).toBe(8)
    expect(demoQuestionsLeft(1_000, 300_000)).toBe(8)
    expect(demoQuestionsLeft(90_000, 300_000)).toBe(6)
    expect(demoQuestionsLeft(235_000, 300_000)).toBe(1)
    // 85 % used: still a count, no longer a share
    expect(demoQuestionsLeft(255_000, 300_000)).toBe(1)
    // 99 %: 0 while the AI still answers ("Almost out of questions")
    expect(demoQuestionsLeft(297_000, 300_000)).toBe(0)
    expect(demoQuestionsLeft(300_000, 300_000)).toBeNull()
    expect(demoQuestionsLeft(-5, 300_000)).toBe(8)
    expect(demoQuestionsLeft(0, 20_000)).toBe(0)
    expect(demoQuestionsLeft(undefined, 300_000)).toBeNull()
    expect(demoQuestionsLeft(0, undefined)).toBeNull()
    expect(demoQuestionsLeft(0, 0)).toBeNull()
  })
  test('the words: questions, never tokens; one and many; ko', () => {
    expect(en('demo.free.left', { n: 8 })).toBe('About 8 questions left')
    expect(en('demo.free.left', { n: 1 })).toBe('About 1 question left')
    expect(translate('ko', 'demo.free.left', { n: 8 })).toBe('질문 8번 정도 남았어요')
    for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) expect(translate(l, 'demo.free.left', { n: 8 })).not.toMatch(/token|토큰|トークン|令牌/i)
    // zh: a space between the number and the words around it
    expect(translate('zh', 'demo.free.left', { n: 8 })).toBe('还能问大约 8 个问题')
  })
  test('the end words say the questions are used up, and promise nothing about people (the teammates are made up)', () => {
    expect(en('demo.free.almostOut')).toBe('Almost out of questions')
    expect(translate('ko', 'demo.free.almostOut')).toBe('질문을 거의 다 썼어요')
    expect(en('demo.free.limit.title')).toBe("You've used all your questions")
    expect(translate('ko', 'demo.free.limit.title')).toBe('질문을 다 썼어요')
    expect(en('demo.free.out')).toBe("You've used all your questions. You can still look around everything here.")
    expect(translate('ko', 'demo.free.out')).toBe('질문을 다 썼어요. 둘러보기는 계속할 수 있어요.')
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
      for (const k of ['demo.free.almostOut', 'demo.free.limit.title', 'demo.free.out', 'demo.free.left'] as const) expect(translate(l, k, { n: 3 }), `${l} ${k}`).not.toMatch(/%|\bAI\b/)
      if (l !== 'en') for (const k of ['demo.free.almostOut', 'demo.free.out', 'demo.free.backHome'] as const) expect(translate(l, k), `${l} ${k}`).not.toBe(en(k))
    }
  })

})

describe('the suggestions', () => {
  const t = (k: Parameters<typeof translate>[1]) => translate('en', k)
  test('the demo\'s own by language, else the person\'s questions, else the built-in ones', () => {
    const s = (label: string, prompt = label) => ({ label, prompt })
    const own = { freeRoam: { suggestions: [s('Posts', 'Make next week\'s posts with our skill'), s('Reply', 'Check Chris\'s reply'), s('Assets', 'List Brand assets'), s('Fourth')] } }
    expect(freeRoamSuggestions({ ...INFO, ...own }, t)).toEqual([s('Posts', 'Make next week\'s posts with our skill'), s('Reply', 'Check Chris\'s reply'), s('Assets', 'List Brand assets')])
    // a broken entry is skipped, an empty list falls back
    expect(freeRoamSuggestions({ ...INFO, freeRoam: { suggestions: [{ label: '', prompt: 'x' }, s('Ok')] } } as DemoInfo, t)).toEqual([s('Ok')])
    expect(freeRoamSuggestions({ ...INFO, personas: [{ ...INFO.personas[0]!, questions: ['Q1', 'Q2'] }] }, t)).toEqual([s('Q1'), s('Q2')])
    expect(freeRoamSuggestions(INFO, t)).toEqual([s("Make next week's social posts"), s("Check Chris's reply"), s("What's in our Brand assets folder?")])
    expect(freeRoamSuggestions(INFO, (k) => translate('ko', k)).map((x) => x.label)).toEqual(['다음 주 SNS 게시물 만들어 줘', '크리스 답장 확인해 줘', '브랜드 자료 폴더에 뭐가 있어?'])
  })
})

describe('the bar', () => {
  beforeEach(() => useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_OFF }) } } as never))

  test('who you are, the questions left, the practice label and Start free; no chips (they are on Home); no person switcher', async () => {
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-bar'), 'the bar')
      expect(m.get('free-roam-who').textContent).toBe("You're Mina at Steepling, a made-up company.")
      expect(m.get('free-roam-left').textContent).toBe('About 8 questions left')
      expect(m.get('free-roam-practice').textContent).toBe('Gmail, Drive, Higgsfield: practice only')
      // the chips moved under Home's box (owner, QA 2026-11-22 F9)
      expect(m.find('free-roam-chips')).toBeNull()
      expect(m.find('free-roam-chip')).toBeNull()
      expect(m.html()).not.toContain('%')
      expect(m.find('demo-switch')).toBeNull()
      expect(m.find('demo-bar')).toBeNull()
    } finally { await m.unmount() }
  })

  test('one quiet Start free at the end, to the sign-up address in a new tab; none without one, none once out', async () => {
    let m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-bar-start-free'), 'Start free')
      const a = m.get('free-roam-bar-start-free')
      expect(a.textContent).toBe('Start free')
      expect(a.getAttribute('href')).toBe('https://example.com/pricing')
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
      // a text link, not a button: no button look (no border, no fill)
      expect(a.getAttribute('class')).not.toContain('bg-accent ')
      expect(a.getAttribute('class')).toContain('ml-auto')
    } finally { await m.unmount() }
    useDemo.setState({ loaded: false, info: null, out: false })
    demoAnswer = { ...INFO, signupUrl: undefined }
    m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-bar'), 'the bar')
      expect(m.find('free-roam-bar-start-free')).toBeNull()
    } finally { await m.unmount() }
    useDemo.setState({ loaded: false, info: null, out: false })
    demoAnswer = { ...INFO, used: 300_000 }
    m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-bar'), 'the bar')
      // out: the limit dialog and the line under the box have their own Start free
      expect(m.find('free-roam-bar-start-free')).toBeNull()
      expect(m.find('free-roam-left')).toBeNull()
    } finally { await m.unmount() }
  })

  test('Gmail, Drive and Higgsfield are practice: the label says it; a tap opens the whole sentence, Esc or a tap outside closes it', async () => {
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-practice'), 'the label')
      const label = m.get('free-roam-practice')
      // a real button (a touch screen never shows a tooltip: QA 2026-11-22 F3)
      expect(label.tagName.toLowerCase()).toBe('button')
      expect(label.getAttribute('aria-expanded')).toBe('false')
      expect(m.find('free-roam-practice-tip')).toBeNull()
      expect(m.get('free-roam-bar').contains(label)).toBe(true)
      // a tap (a click in the browser after a touch)
      await m.click('free-roam-practice')
      expect(m.get('free-roam-practice').getAttribute('aria-expanded')).toBe('true')
      expect(m.get('free-roam-practice-tip').textContent).toBe(en('demo.free.practiceTip'))
      expect(m.get('free-roam-practice').getAttribute('aria-controls')).toBe(m.get('free-roam-practice-tip').getAttribute('id'))
      // Esc closes it
      await act(() => { document.dispatchEvent(new FakeEvent('keydown', { key: 'Escape', bubbles: true }) as never) })
      expect(m.find('free-roam-practice-tip')).toBeNull()
      // a tap again opens; a tap outside closes
      await m.click('free-roam-practice')
      expect(m.find('free-roam-practice-tip')).not.toBeNull()
      await act(() => { m.get('free-roam-who').dispatchEvent(new FakeEvent('pointerdown', { bubbles: true }) as never) })
      expect(m.find('free-roam-practice-tip')).toBeNull()
      // a second tap on the label closes it too
      await m.click('free-roam-practice')
      await m.click('free-roam-practice')
      expect(m.find('free-roam-practice-tip')).toBeNull()
    } finally { await m.unmount() }
    expect(translate('en', 'demo.free.practice')).toBe('Gmail, Drive, Higgsfield: practice only')
    expect(translate('ko', 'demo.free.practice')).toBe('Gmail·Drive·Higgsfield는 연습용')
    expect(translate('en', 'demo.free.practiceTip')).toBe('Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.')
    expect(translate('ko', 'demo.free.practiceTip')).toBe('여기 Gmail·Google Drive·Higgsfield는 연습용이에요. 메일은 실제로 보내지 않고, 새 사진은 준비된 사진 중에서 골라요.')
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
      // the label names the three services in every language; the sentence too
      for (const name of ['Gmail', 'Drive', 'Higgsfield']) expect(translate(l, 'demo.free.practice'), l).toContain(name)
      expect(translate(l, 'demo.free.practice').length, l).toBeLessThanOrEqual(42)
      for (const name of ['Gmail', 'Google', 'Higgsfield']) expect(translate(l, 'demo.free.practiceTip'), l).toContain(name)
      if (l !== 'en') expect(translate(l, 'demo.free.practiceTip'), l).not.toBe(translate('en', 'demo.free.practiceTip'))
      // who you are: never without the made-up company
      expect(translate(l, 'demo.free.bar', { name: 'Mina', company: 'Steepling' }), l).toContain('Steepling')
    }
    expect(translate('en', 'demo.free.bar', { name: 'Mina', company: 'Steepling' })).toBe("You're Mina at Steepling, a made-up company.")
    expect(translate('ja', 'demo.free.bar', { name: 'Mina', company: 'Steepling' })).toBe('いまは架空の会社SteeplingのMinaさんです。')
  })

  test('the questions left follow what is used', async () => {
    demoAnswer = { ...INFO, used: 90_000 }
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-left'), 'the count')
      expect(m.get('free-roam-left').textContent).toBe('About 6 questions left')
      expect(m.find('free-roam-meter')).toBeNull()
    } finally { await m.unmount() }
  })

  test('to the end in questions: 85 % "About 1 question left", 99 % "Almost out of questions"; never a %', async () => {
    demoAnswer = { ...INFO, used: 255_000 }
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-left'), 'the count')
      expect(m.get('free-roam-left').textContent).toBe('About 1 question left')
      expect(m.get('free-roam-bar').textContent).not.toContain('%')
    } finally { await m.unmount() }
    useDemo.setState({ loaded: false, info: null, out: false })
    demoAnswer = { ...INFO, used: 297_000 }
    const n = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await n.until(() => n.find('free-roam-left'), 'the count')
      expect(n.get('free-roam-left').textContent).toBe('Almost out of questions')
      expect(n.get('free-roam-bar').textContent).not.toContain('%')
    } finally { await n.unmount() }
  })
})

describe('Home\'s suggestions', () => {
  beforeEach(() => useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_OFF }) } } as never))

  test('three round chips; none once the questions are used up', async () => {
    await useDemo.getState().load()
    const m = await mount(<MemoryRouter><FreeRoamChips info={INFO} /></MemoryRouter>)
    try {
      expect(m.get('free-roam-chips').querySelectorAll('button').length).toBe(3)
      expect(m.get('free-roam-chips').getAttribute('aria-label')).toBe('Things to try')
      expect(m.find('free-roam-chip-busy')).toBeNull()
      // the phone keyboard up (lib/viewport.ts .keyboard-open): the chips go (review of #293; e2e demo-free-roam.spec.ts)
      expect(m.get('free-roam-chips').getAttribute('class')).toContain('in-[.keyboard-open]:hidden')
    } finally { await m.unmount() }
    useDemo.setState({ out: true })
    const n = await mount(<MemoryRouter><FreeRoamChips info={INFO} /></MemoryRouter>)
    try { expect(n.find('free-roam-chips')).toBeNull() } finally { await n.unmount() }
  })

  test('the tapped chip spins while its chat is made; the others dim', async () => {
    await useDemo.getState().load()
    let release: () => void = () => {}
    const { useChats } = await import('../../src/store/chats')
    const send = useChats.getState().send
    useChats.setState({ send: (() => new Promise((_, reject) => { release = () => reject(new Error('stop')) })) as never })
    const m = await mount(<MemoryRouter><FreeRoamChips info={INFO} /></MemoryRouter>)
    try {
      const chips = () => [...m.get('free-roam-chips').querySelectorAll('button')]
      await m.click(chips()[1]! as never)
      expect(chips()[1]!.getAttribute('aria-busy')).toBe('true')
      expect(chips()[1]!.querySelector('[data-testid="free-roam-chip-busy"]')).not.toBeNull()
      expect(chips()[0]!.getAttribute('class')).toContain('opacity-50')
      expect(chips()[0]!.hasAttribute('disabled')).toBe(true)
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 10)) })
      expect(m.find('free-roam-chip-busy')).toBeNull()
    } finally {
      await m.unmount()
      useChats.setState({ send })
    }
  })
})

describe('a new visitor (?fresh=1)', () => {
  test('the gate\'s new start: drafts, queued sends and the tab\'s keys go; the parameter leaves the address', () => {
    localStorage.setItem('mycel.draft:mina:new', 'the last visitor\'s words')
    localStorage.setItem('mycel.queue:mina:01900000-0000-7000-8000-0000000000c1', '{"items":[]}')
    localStorage.setItem('mycel.locale', 'ko')
    sessionStorage.setItem('mycel.chips:mina:new', '[{"name":"brief.pdf"}]')
    sessionStorage.setItem('mycel.draftChat:mina:new', 'c1')
    sessionStorage.setItem('mycel.demo.limitSeen', '1')
    const replaced: unknown[][] = []
    const history = { state: { usr: null, key: 'k1', idx: 0 }, replaceState: (...a: unknown[]) => { replaced.push(a) } }
    expect(freshStart({ loc: { href: 'https://demo.trina.app/?fresh=1&x=2#top' }, history })).toBe(true)
    expect(localStorage.getItem('mycel.draft:mina:new')).toBeNull()
    expect(localStorage.getItem('mycel.queue:mina:01900000-0000-7000-8000-0000000000c1')).toBeNull()
    // the browser's own choices stay (the language)
    expect(localStorage.getItem('mycel.locale')).toBe('ko')
    expect(sessionStorage.getItem('mycel.chips:mina:new')).toBeNull()
    expect(sessionStorage.getItem('mycel.draftChat:mina:new')).toBeNull()
    expect(sessionStorage.getItem('mycel.demo.limitSeen')).toBeNull()
    // the router's state kept, the other parameters and the hash too
    expect(replaced).toEqual([[{ usr: null, key: 'k1', idx: 0 }, '', '/?x=2#top']])
    localStorage.removeItem('mycel.locale')
  })

  test('without the parameter (a reload, any later page): nothing is touched', () => {
    localStorage.setItem('mycel.draft:mina:new', 'mine')
    const replaced: unknown[] = []
    const history = { state: null, replaceState: (...a: unknown[]) => { replaced.push(a) } }
    for (const href of ['https://demo.trina.app/', 'https://demo.trina.app/?fresh=0', 'https://demo.trina.app/c/1?freshness=1']) {
      expect(freshStart({ loc: { href }, history })).toBe(false)
    }
    expect(localStorage.getItem('mycel.draft:mina:new')).toBe('mine')
    expect(replaced).toEqual([])
    expect(takeFreshStart(undefined, history)).toBe(false)
    localStorage.removeItem('mycel.draft:mina:new')
  })

  test('only a free-roam instance runs it, when the demo info is read', async () => {
    const before = (globalThis as { location?: unknown }).location
    const prevHistory = (globalThis as { history?: unknown }).history
    const replaced: string[] = []
    Object.assign(globalThis, { location: { href: 'https://demo.trina.app/?fresh=1' }, history: { state: null, replaceState: (_s: unknown, _t: string, u: string) => { replaced.push(u) } } })
    try {
      localStorage.setItem('mycel.draft:mina:new', 'the last visitor\'s words')
      demoAnswer = { ...INFO, kind: 'scripted', used: undefined, cap: undefined }
      await useDemo.getState().load()
      expect(localStorage.getItem('mycel.draft:mina:new')).not.toBeNull()
      expect(replaced).toEqual([])
      useDemo.setState({ loaded: false, info: null })
      demoAnswer = INFO
      await useDemo.getState().load()
      expect(localStorage.getItem('mycel.draft:mina:new')).toBeNull()
      expect(replaced).toEqual(['/'])
    } finally {
      Object.assign(globalThis, { location: before, history: prevHistory })
    }
  })
})

describe('the limit', () => {
  beforeEach(() => useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_OFF }) } } as never))

  test('read at the limit: the dialog once (title, body, Start free to the sign-up address, Look around closes it)', async () => {
    demoAnswer = { ...INFO, used: 300_000 }
    await useDemo.getState().load()
    expect(useDemo.getState().out).toBe(true)
    expect(useDemo.getState().limitOpen).toBe(true)
    const m = await mount(<DemoLimitDialog />)
    try {
      expect(m.html()).toContain("You've used all your questions")
      expect(m.get('free-roam-limit').textContent).toBe('Everything you made stays here to look around.')
      expect(m.get('free-roam-start-free').getAttribute('href')).toBe('https://example.com/pricing')
      expect(m.get('free-roam-start-free').textContent).toBe('Start free')
      await m.click('free-roam-look-around')
      expect(useDemo.getState().limitOpen).toBe(false)
      expect(m.find('free-roam-limit')).toBeNull()
    } finally { await m.unmount() }
    // a reload in the same tab: the line under the box, not the dialog again
    useDemo.setState({ loaded: false, info: null, out: false, limitOpen: false })
    await useDemo.getState().load()
    expect(useDemo.getState().out).toBe(true)
    expect(useDemo.getState().limitOpen).toBe(false)
  })

  test('a send refused at the limit (403 demo_limit) marks it, wherever it came from', async () => {
    await useDemo.getState().load()
    expect(useDemo.getState().out).toBe(false)
    sendAnswer = { status: 403, body: { error: { code: 'budget_exceeded', message: "You've used this demo's AI.", params: { reason: 'demo_limit', used: 300_000, cap: 300_000 } } } }
    await api.call(API.createMemory, { body: { text: 'x' } }).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    expect(useDemo.getState().out).toBe(true)
    expect(useDemo.getState().limitOpen).toBe(true)
  })

  test('an answer that ended at the limit marks it; any other reads the use again', async () => {
    await useDemo.getState().load()
    requests = []
    demoAnswerEnded(null)
    await new Promise((r) => setTimeout(r, 900))
    expect(requests).toEqual(['/api/demo'])
    demoAnswerEnded({ params: { reason: 'demo_limit' } })
    expect(useDemo.getState().out).toBe(true)
  })

  test('a turn that ends just over the limit opens the sheet once, also in a tab that showed it before (QA TC-5575)', async () => {
    useLocaleStore.setState({ locale: 'ko' })
    try {
      // this tab showed the sheet on an earlier instance of the same demo address
      sessionStorage.setItem('mycel.demo.limitSeen', '1')
      demoAnswer = { ...INFO, used: 299_000 }
      await useDemo.getState().load()
      expect(useDemo.getState().out).toBe(false)
      // the answer ends; the use read again is just over the cap
      demoAnswer = { ...INFO, used: 300_400 }
      demoAnswerEnded(null)
      await new Promise((r) => setTimeout(r, 900))
      expect(useDemo.getState().out).toBe(true)
      expect(useDemo.getState().limitOpen).toBe(true)
      const m = await mount(<DemoLimitDialog />)
      try {
        expect(m.find('free-roam-limit')).not.toBeNull()
        await m.click('free-roam-look-around')
        // once: more answers and refusals at the limit leave it closed
        demoAnswerEnded({ params: { reason: 'demo_limit' } })
        useDemo.getState().hitLimit()
        expect(useDemo.getState().limitOpen).toBe(false)
        expect(m.find('free-roam-limit')).toBeNull()
      } finally { await m.unmount() }
      // a reload at the limit: the line under the box, not the sheet again
      useDemo.setState({ loaded: false, info: null, out: false, limitOpen: false })
      await useDemo.getState().load()
      expect(useDemo.getState().out).toBe(true)
      expect(useDemo.getState().limitOpen).toBe(false)
    } finally { useLocaleStore.setState({ locale: 'en' }) }
  })

  test('an answer refused at the limit opens the sheet too, once', async () => {
    sessionStorage.setItem('mycel.demo.limitSeen', '1')
    await useDemo.getState().load()
    demoAnswerEnded({ params: { reason: 'demo_limit' } })
    expect(useDemo.getState().out).toBe(true)
    expect(useDemo.getState().limitOpen).toBe(true)
  })

  test('not a free-roam demo: nothing is marked and nothing shows', async () => {
    demoAnswer = { ...INFO, kind: 'scripted', used: undefined, cap: undefined }
    await useDemo.getState().load()
    useDemo.getState().hitLimit()
    expect(useDemo.getState().out).toBe(false)
    const m = await mount(<><DemoLimitDialog /><DemoLimitNotice /></>)
    try { expect(m.html()).toBe('<div></div>') } finally { await m.unmount() }
  })

  test('under a message box: one calm line and Start free', async () => {
    await useDemo.getState().load()
    const m = await mount(<DemoLimitNotice />)
    try {
      expect(m.get('free-roam-out').textContent).toContain("You've used all your questions. You can still look around everything here.")
      expect(m.get('free-roam-start-free').getAttribute('href')).toBe('https://example.com/pricing')
    } finally { await m.unmount() }
  })

  test('the dialog starts on its one action: Start free, else Look around (never ✕ and its tooltip)', async () => {
    demoAnswer = { ...INFO, used: 300_000 }
    await useDemo.getState().load()
    let m = await mount(<DemoLimitDialog />)
    try {
      expect(m.get('free-roam-start-free').hasAttribute('data-autofocus')).toBe(true)
      expect(m.get('free-roam-look-around').hasAttribute('data-autofocus')).toBe(false)
    } finally { await m.unmount() }
    useDemo.setState({ info: { ...INFO, used: 300_000, signupUrl: undefined }, limitOpen: true })
    m = await mount(<DemoLimitDialog />)
    try {
      expect(m.find('free-roam-start-free')).toBeNull()
      expect(m.get('free-roam-look-around').hasAttribute('data-autofocus')).toBe(true)
    } finally { await m.unmount() }
  })
})

describe('words and hidden surfaces', () => {
  test('no mic in any message box once the demo is known (voice is fenced); a normal server keeps its mic', async () => {
    const m = me({ features: FEATURES_OFF })
    ;(m.team as { voiceInput?: boolean }).voiceInput = true
    expect(micState(m)).toBe('on')
    await useDemo.getState().load()
    expect(micState(m)).toBe('hidden')
  })

  test('a stopped or failed answer reads the demo\'s plain line', () => {
    expect(demoReason({ params: { reason: 'demo_busy' } })).toBe('demo_busy')
    expect(demoReason({ params: { reason: 'usage_used_up' } })).toBeNull()
    expect(en(demoAnswerKey({ params: { reason: 'demo_rest' } })!)).toBe('The live demo is resting, try again later.')
    expect(en(demoAnswerKey({ params: { reason: 'demo_busy' } })!)).toBe('The demo is busy, try again in a bit.')
    expect(en(demoAnswerKey({ params: { reason: 'demo_limit' } })!)).toBe("You've used all your questions")
  })

  test('a fenced action says "Not available in the demo" instead of the server\'s error', () => {
    const e = new ApiError(403, { code: 'forbidden', message: "Not in the demo: inviting people isn't available.", params: { reason: 'demo_fenced', area: 'invite' } })
    expect(errorText(e, 'en', 'network')).toBe('Not available in the demo')
    const busy = new ApiError(503, { code: 'unavailable', message: 'x', params: { reason: 'demo_busy' } })
    expect(errorText(busy, 'en', 'network')).toBe('The demo is busy, try again in a bit.')
  })

  test('Settings has no usage, AI providers, AI apps, dev environment, Security & devices or Apps sections; nobody picks the AI', async () => {
    const ids = (freeRoam: boolean) => settingsTabs(false, true, true, false, false, freeRoam).map((x) => x.id)
    const hidden = ['usage', 'providers', 'ai-apps', 'dev-env-sites', 'security', 'apps']
    expect(ids(false)).toEqual(expect.arrayContaining(hidden))
    expect(ids(true).filter((x) => hidden.includes(x))).toEqual([])
    // and the pages under the sections, by address: the account deletion, the password, the devices
    expect([...FREE_ROAM_HIDDEN_PAGES].sort()).toEqual(['account-delete', 'security-devices', 'security-password'])
    expect(ids(true)).toEqual(expect.arrayContaining(['profile', 'memory', 'connectors', 'notifications', 'about']))
    const chooser = me({ features: FEATURES_OFF }, { canChooseEngine: true })
    expect(canChooseEngine(chooser)).toBe(true)
    await useDemo.getState().load()
    expect(canChooseEngine(chooser)).toBe(false)
  })

  test('the sign-in page: only "Continue as Mina", which asks the gate to sign the visitor back in', async () => {
    const went: string[] = []
    const m = await mount(<FreeRoamStart info={{ ...INFO, current: null }} go={(to) => went.push(to)} />)
    try {
      const go = m.get('free-roam-continue')
      expect(go.textContent).toBe('Continue as Mina')
      expect(m.get('free-roam-start').querySelectorAll('a').length + m.get('free-roam-start').querySelectorAll('button').length).toBe(1)
      // the test fetch answers 404 for /__demo/resume: the gate's start instead
      await m.click(go)
      await m.until(() => went.length > 0, 'a way on')
      expect(requests).toContain('/__demo/resume')
      expect(went).toEqual(['/__demo/start'])
    } finally { await m.unmount() }
  })

  test('the gate\'s resume: a POST on the same origin; 2xx opens the app, anything else (or no answer) the start', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const answer = (r: Response | Error) => (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); if (r instanceof Error) throw r; return r }) as typeof fetch
    const went: string[] = []
    await resumeFreeRoam({ fetch: answer(new Response('<html>', { status: 200 })), go: (to) => went.push(to) })
    expect(calls[0]).toMatchObject({ url: '/__demo/resume', init: { method: 'POST', credentials: 'same-origin' } })
    await resumeFreeRoam({ fetch: answer(json(502, { error: { code: 'internal' } })), go: (to) => went.push(to) })
    await resumeFreeRoam({ fetch: answer(new TypeError('Failed to fetch')), go: (to) => went.push(to) })
    expect(went).toEqual(['/', '/__demo/start', '/__demo/start'])
  })
})

// the empty-chats audit of the live demo (2026-11-20): what a visitor cannot use is not offered at all
describe('what a free-roam visitor is not offered', () => {
  beforeEach(() => useSession.setState({ status: { kind: 'signed-in', me: me({ features: FEATURES_OFF }) } } as never))
  const asFreeRoam = (on: boolean) => useDemo.setState({ loaded: true, info: on ? INFO : null })

  function SwitchProbe() {
    return <p data-testid="switch-way">{useTeamSwitchWay() ?? 'none'}</p>
  }
  test('no "Switch team" (QA TC-5612): a plain browser has its dialog, a free-roam demo none', async () => {
    for (const [on, way] of [[false, 'browser'], [true, 'none']] as const) {
      asFreeRoam(on)
      const m = await mount(<SwitchProbe />)
      try {
        expect(m.get('switch-way').textContent).toBe(way)
      } finally { await m.unmount() }
    }
  })

  test('Team skills: no "Bring my skills" (QA TC-5613) and no "Move" in a skill\'s menu (QA TC-5616); a normal server keeps both', async () => {
    const items = [{ path: 'skills/brand-guide/SKILL.md', name: 'brand-guide', description: 'Our brand guide' }]
    for (const on of [false, true]) {
      asFreeRoam(on)
      const m = await mount(<MemoryRouter><AvailableSkillsList items={items} /></MemoryRouter>)
      try {
        expect(!!(m.find('skill-bring') ?? m.find('skill-bring-phone'))).toBe(!on)
        await m.click('skill-more')
        expect(m.find('skill-file')).not.toBeNull()
        expect(!!m.find('skill-move-open')).toBe(!on)
      } finally { await m.unmount() }
    }
  })

  test('no sign-out in the account menu (QA TC-5623); a normal server keeps it', async () => {
    for (const on of [false, true]) {
      asFreeRoam(on)
      const m = await mount(<MemoryRouter><AccountMenu /></MemoryRouter>)
      try {
        await m.click('account-menu')
        expect(m.find('account-settings')).not.toBeNull()
        expect(!!m.find('logout')).toBe(!on)
      } finally { await m.unmount() }
    }
  })

  test('the sign-in page\'s languages: only the demo\'s own (QA TC-5621), the current one kept; every one elsewhere', () => {
    const langs = (only?: readonly Locale[], value: Locale = 'en') =>
      [...renderToStaticMarkup(<LanguageSelect value={value} onChange={() => {}} only={only} />).matchAll(/<option value="([a-z]+)"/g)].map((x) => x[1])
    expect(FREE_ROAM_LOCALES).toEqual(['en', 'ko', 'ja', 'zh', 'es', 'id'])
    expect(langs(FREE_ROAM_LOCALES).sort()).toEqual([...FREE_ROAM_LOCALES].sort())
    expect(langs(['en', 'ko'], 'ja').sort()).toEqual(['en', 'ja', 'ko'])
    expect(langs().length).toBeGreaterThan(2)
  })

  test('one instance offers its own language and English, not all six (demo-gate runs only some live)', async () => {
    expect(freeRoamSignInLocales('ko')).toEqual(['en', 'ko'])
    expect(freeRoamSignInLocales('ja')).toEqual(['en', 'ja'])
    expect(freeRoamSignInLocales('en')).toEqual(['en'])
    expect(freeRoamSignInLocales(null)).toEqual(['en'])
    expect(freeRoamSignInLocales(undefined)).toEqual(['en'])
    for (const l of FREE_ROAM_LOCALES) for (const x of freeRoamSignInLocales(l)) expect(FREE_ROAM_LOCALES).toContain(x)

    // the switcher itself, on a live ko instance: no ja, zh, es or id screens offered; a normal server keeps every one
    const options = async () => {
      const m = await mount(<LanguageSwitcher />)
      try { return [...m.html().matchAll(/<option value="([a-z]+)"/g)].map((x) => x[1]).sort() } finally { await m.unmount() }
    }
    useSession.setState({ status: { kind: 'signed-in', me: { ...me({ features: FEATURES_OFF }), team: { name: 'Steepling', defaultLocale: 'ko' } } } } as never)
    useLocaleStore.getState().setLocale('ko')
    try {
      asFreeRoam(true)
      expect(await options()).toEqual(['en', 'ko'])
      asFreeRoam(false)
      expect((await options()).length).toBeGreaterThan(2)
    } finally { useLocaleStore.getState().setLocale('en') }
  })

  test('signed out on a ja instance behind the gate: GET /api/setup denied, the language comes from GET /api/demo (QA TC-6790)', async () => {
    // the gate as deployed: /api/setup is "Not available in the demo." (demo-gate DENY_PATHS), /api/demo goes through
    const before = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      asked.push(new URL(url, 'http://x').pathname)
      if (url.includes('/api/me')) return json(401, { error: { code: 'unauthorized', message: 'sign in' } })
      if (url.includes('/api/setup')) return json(404, { error: { code: 'not_found', message: 'Not available in the demo.' } })
      if (url.endsWith('/api/demo')) return json(200, { ...INFO, current: null, locale: 'ja' })
      return json(404, { error: { code: 'not_found', message: 'not found' } })
    }) as typeof fetch
    try {
      useSession.getState().reset()
      useSession.setState({ status: { kind: 'loading' } } as never)
      await useSession.getState().load()
      expect(asked).toContain('/api/setup')
      expect(asked).toContain('/api/demo')
      expect(useSession.getState().status.kind).toBe('signed-out')
      expect(teamDefaultLocale()).toBe('ja')
      expect(useLocaleStore.getState().locale).toBe('ja')
      const m = await mount(<LanguageSwitcher />)
      try { expect([...m.html().matchAll(/<option value="([a-z]+)"/g)].map((x) => x[1]).sort()).toEqual(['en', 'ja']) } finally { await m.unmount() }
    } finally {
      globalThis.fetch = before
      useSession.getState().reset()
      useLocaleStore.getState().setLocale('en')
    }
  })
})

describe('the admin pages\' one line', () => {
  test('one line and Back to Home (no dead end: QA 2026-11-22 F20)', async () => {
    const m = await mount(<MemoryRouter><FreeRoamUnavailable /></MemoryRouter>)
    try {
      expect(m.get('free-roam-unavailable').textContent).toBe('Not available in the demo')
      expect(m.get('free-roam-back-home').textContent).toBe('Back to Home')
      expect(m.get('free-roam-back-home').getAttribute('href')).toBe('/')
    } finally { await m.unmount() }
    expect(translate('ko', 'demo.free.backHome')).toBe('홈으로 돌아가기')
  })
})

describe('web strings of the QA pass', () => {
  test('the thread title is quoted; es and id stay formal', () => {
    expect(en('notifications.event.chat.thread_mentionNamed', { name: 'Ana', title: 'Launch' })).toBe('Ana mentioned you in a thread in “Launch”.')
    expect(translate('ko', 'notifications.event.chat.thread_mentionNamed', { name: '아나', title: '런칭' })).toBe('아나님이 ‘런칭’ 스레드에서 나를 언급했어요.')
    expect(translate('ja', 'notifications.event.chat.thread_mentionNamed', { name: 'Ana', title: 'Launch' })).toBe('Anaさんが「Launch」のスレッドであなたをメンションしました。')
    expect(translate('zh', 'notifications.event.chat.thread_mentionNamed', { name: 'Ana', title: 'Launch' })).toBe('Ana在“Launch”的话题中提到了你。')
    for (const l of ['es', 'id'] as const) expect(translate(l, 'notifications.event.chat.thread_mentionNamed', { name: 'Ana', title: 'Launch' })).toContain('“Launch”')
    expect(translate('id', 'home.greeting', { name: 'Mina' })).toBe('Halo Mina, ada yang bisa saya bantu?')
    expect(translate('id', 'feed.chats')).toBe('Sebutan & utas')
    expect(translate('id', 'activity.inChats')).toBe('Sebutan & utas ada di Obrolan')
    expect(translate('es', 'projectsPanel.fold.by', { names: 'Ana' })).toBe('Mención de Ana')
    for (const k of ['feed.chats', 'activity.inChats'] as const) expect(translate('id', k)).not.toMatch(/Mention|thread/)
  })

  test('ja and zh relative time: no space between the number and its word', () => {
    expect(cjkTight('3 時間前', 'ja')).toBe('3時間前')
    expect(cjkTight('3\u202f時間前', 'ja')).toBe('3時間前')
    expect(cjkTight('3 hours ago', 'en')).toBe('3 hours ago')
    expect(cjkTight('3 시간 전', 'ko')).toBe('3 시간 전')
    const now = Date.parse('2026-11-22T12:00:00Z')
    expect(formatRelative('2026-11-22T09:00:00Z', 'ja', now)).toBe('3時間前')
    expect(formatRelative('2026-11-22T09:00:00Z', 'zh', now)).not.toMatch(/\d\s/)
    expect(formatRelative('2026-11-22T09:00:00Z', 'en', now)).toBe('3 hours ago')
  })
})
