// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md; src/lib/freeRoam.ts, src/store/demo.ts,
// src/components/demo/FreeRoam.tsx). The server says it is one through GET /api/demo (kind "freeRoam", used, cap,
// signupUrl) while `me.server.dev` is false; here: who is asked, the bar and its suggestions, the meter from 80 %, the
// limit (dialog once, the message boxes stop), the neutral words, the hidden AI-account sections, the sign-in page.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { DemoInfo, Me } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import { DemoBar, useDemoInfo } from '../../src/components/demo/Demo'
import { DemoLimitDialog, DemoLimitNotice, FreeRoamStart } from '../../src/components/demo/FreeRoam'
import { api, API, ApiError, errorText } from '../../src/lib/api'
import { demoAnswerKey, demoMeter, demoReason, freeRoamSuggestions, mayBeDemoServer, resumeFreeRoam } from '../../src/lib/freeRoam'
import { settingsTabs } from '../../src/pages/settingsTabs'
import { demoAnswerEnded, freeRoamNow, useDemo } from '../../src/store/demo'
import { canChooseEngine, useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

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
      expect(m.get('free-roam-who').textContent).toBe("You're Mina at Steepling, a made-up company. Try anything.")
      expect(m.get('free-roam-chips').querySelectorAll('button').length).toBe(3)
      expect(m.find('free-roam-meter')).toBeNull()
      expect(m.find('demo-switch')).toBeNull()
      expect(m.find('demo-bar')).toBeNull()
    } finally { await m.unmount() }
  })

  test('from 80 %: one quiet line with what is left; at the limit the suggestions go', async () => {
    demoAnswer = { ...INFO, used: 241_000 }
    const m = await mount(<MemoryRouter><DemoBar /></MemoryRouter>)
    try {
      await m.until(() => m.find('free-roam-meter'), 'the meter')
      expect(m.get('free-roam-meter').textContent).toBe('About 20% of your demo AI left')
      expect(m.get('free-roam-meter').textContent).not.toMatch(/token/i)
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
})

describe('words and hidden surfaces', () => {
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

  test('Settings has no usage, AI providers, AI apps or dev environment sections; nobody picks the AI', async () => {
    const ids = (freeRoam: boolean) => settingsTabs(false, true, true, false, false, freeRoam).map((x) => x.id)
    expect(ids(false)).toEqual(expect.arrayContaining(['usage', 'providers', 'ai-apps', 'dev-env-sites']))
    expect(ids(true).filter((x) => ['usage', 'providers', 'ai-apps', 'dev-env-sites'].includes(x))).toEqual([])
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
