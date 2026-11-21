// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md; src/lib/freeRoam.ts, src/store/demo.ts,
// src/components/demo/FreeRoam.tsx). The server says it is one through GET /api/demo (kind "freeRoam", used, cap,
// signupUrl) while `me.server.dev` is false; here: who is asked, the bar and its suggestions, the meter from 80 %, the
// limit (dialog once, the message boxes stop), the neutral words, the hidden AI-account sections, the sign-in page.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { DemoInfo, Locale, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { DemoBar, useDemoInfo } from '../../src/components/demo/Demo'
import { DemoLimitDialog, DemoLimitNotice, FreeRoamStart } from '../../src/components/demo/FreeRoam'
import { api, API, ApiError, errorText } from '../../src/lib/api'
import { demoAnswerKey, demoMeter, demoQuestionsLeft, demoReason, FREE_ROAM_HIDDEN_PAGES, freeRoamSuggestions, mayBeDemoServer, resumeFreeRoam } from '../../src/lib/freeRoam'
import { micState } from '../../src/lib/voice'
import { settingsTabs } from '../../src/pages/settingsTabs'
import { demoAnswerEnded, freeRoamNow, useDemo } from '../../src/store/demo'
import { canChooseEngine, teamDefaultLocale, useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'
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

describe('the meter', () => {
  test('quiet until 80 %, then "about N% left" in steps of 5, and out at the limit', () => {
    expect(demoMeter(0, 300_000)).toEqual({ out: false, low: false, leftPct: 20 })
    expect(demoMeter(239_999, 300_000).low).toBe(false)
    expect(demoMeter(240_000, 300_000)).toEqual({ out: false, low: true, leftPct: 20 })
    expect(demoMeter(279_000, 300_000)).toEqual({ out: false, low: true, leftPct: 10 })
    expect(demoMeter(299_000, 300_000)).toEqual({ out: false, low: true, leftPct: 5 })
    expect(demoMeter(300_000, 300_000)).toEqual({ out: true, low: true, leftPct: 0 })
    expect(demoMeter(400_000, 300_000).out).toBe(true)
    // nothing known: nothing said
    expect(demoMeter(undefined, undefined)).toEqual({ out: false, low: false, leftPct: 100 })
  })
  test('questions left: floor(remaining / 35k) until the meter takes over at 80 %; nothing known, nothing said', () => {
    expect(demoQuestionsLeft(0, 300_000)).toBe(8)
    expect(demoQuestionsLeft(1_000, 300_000)).toBe(8)
    expect(demoQuestionsLeft(90_000, 300_000)).toBe(6)
    expect(demoQuestionsLeft(235_000, 300_000)).toBe(1)
    expect(demoQuestionsLeft(239_999, 300_000)).toBe(1)
    expect(demoQuestionsLeft(240_000, 300_000)).toBeNull()
    expect(demoQuestionsLeft(300_000, 300_000)).toBeNull()
    expect(demoQuestionsLeft(-5, 300_000)).toBe(8)
    // a small limit: never below 0
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

  test('who you are, "Try anything", and three suggestions; no meter below 80 %; no person switcher', async () => {
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-bar'), 'the bar')
      expect(m.get('free-roam-who').textContent).toBe("You're Mina at Steepling, a made-up company. Try anything. About 8 questions left Practice connections")
      expect(m.get('free-roam-left').textContent).toBe('About 8 questions left')
      expect(m.get('free-roam-chips').querySelectorAll('button').length).toBe(3)
      expect(m.find('free-roam-meter')).toBeNull()
      expect(m.find('demo-switch')).toBeNull()
      expect(m.find('demo-bar')).toBeNull()
    } finally { await m.unmount() }
  })

  test('Gmail, Drive and Higgsfield are said to be practice copies: a short label, the whole sentence in its tooltip, in every language', async () => {
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-practice'), 'the label')
      const label = m.get('free-roam-practice')
      expect(label.textContent).toBe('Practice connections')
      expect(label.getAttribute('tabindex')).toBe('0')
      // no card, no banner: one quiet span inside the bar's first line
      expect(m.get('free-roam-who').contains(label)).toBe(true)
    } finally { await m.unmount() }
    expect(translate('en', 'demo.free.practiceTip')).toBe('Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.')
    expect(translate('ko', 'demo.free.practice')).toBe('연습용 연결')
    expect(translate('ko', 'demo.free.practiceTip')).toBe('여기 Gmail·Google Drive·Higgsfield는 연습용이에요. 메일은 실제로 보내지 않고, 새 사진은 준비된 사진 중에서 골라요.')
    for (const l of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
      // short enough for a 390px bar; the tooltip names every practice service
      expect(translate(l, 'demo.free.practice').length, l).toBeLessThanOrEqual(24)
      for (const name of ['Gmail', 'Google', 'Higgsfield']) expect(translate(l, 'demo.free.practiceTip'), l).toContain(name)
      if (l !== 'en') expect(translate(l, 'demo.free.practiceTip'), l).not.toBe(translate('en', 'demo.free.practiceTip'))
    }
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

  test('from 80 %: one quiet line with what is left; at the limit the suggestions go', async () => {
    demoAnswer = { ...INFO, used: 241_000 }
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-meter'), 'the meter')
      expect(m.get('free-roam-meter').textContent).toBe('About 20% of your demo AI left')
      expect(m.get('free-roam-meter').textContent).not.toMatch(/token/i)
      // one count at a time: the questions left give way to the meter
      expect(m.find('free-roam-left')).toBeNull()
    } finally { await m.unmount() }
    useDemo.setState({ loaded: false, info: null, out: false })
    demoAnswer = { ...INFO, used: 300_000 }
    const n = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await n.until(() => n.find('free-roam-bar'), 'the bar')
      expect(n.find('free-roam-chips')).toBeNull()
      expect(n.find('free-roam-meter')).toBeNull()
    } finally { await n.unmount() }
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
      expect(m.html()).toContain("You've used this demo's AI")
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
      expect(m.get('free-roam-out').textContent).toContain("You've used this demo's AI. Conversations with people still work.")
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
    expect(en(demoAnswerKey({ params: { reason: 'demo_limit' } })!)).toBe("You've used this demo's AI")
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
