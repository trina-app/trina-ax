// Demo mode on screen (src/components/demo/Demo.tsx, src/store/demo.ts; docs/DECISIONS.md "Demo company: a new hire at
// 트리나"; the people below are the open example's, scripts/demo/acme): off a development server nothing is asked and
// nothing shows; a server without the demo (404) shows nothing either; on a demo server the bar names the person and
// switches through the server, Home shows one line and the questions, and the sign-in page has one primary action.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import type { DemoInfo, Me } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { DemoBar, DemoIntro, DemoQuestions, DemoStart, useDemoInfo } from '../../src/components/demo/Demo'
import { useDemo } from '../../src/store/demo'
import { useSession } from '../../src/store/session'
import { installDom, mount, removeDom } from './dom-host'

const INFO: DemoInfo = {
  company: 'Acme', sameQuestion: "Summarize this quarter's budget", current: 'newHire', network: true,
  personas: [
    { key: 'newHire', name: 'Alex Kim', team: 'Marketing', intro: "I'm Alex Kim. I joined Acme's Marketing team today.", questions: ['What is our leave policy?', "List my tasks from this week's marketing meeting", 'What should I do in my first week?'] },
    { key: 'lead', name: 'Sam Ortiz', team: 'Marketing', intro: "I'm Sam Ortiz, Marketing lead at Acme.", questions: ["Summarize this quarter's budget"] },
    { key: 'ceo', name: 'Dana Brooks', team: null, intro: "I'm Dana Brooks, CEO of Acme.", questions: ["Summarize this quarter's budget", 'How is the sales pipeline looking?'] },
  ],
}
const me = (dev: boolean): Me => ({
  user: { id: 'alex', username: 'alex', name: 'Alex Kim', email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} },
  groups: [], team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' },
  server: { version: '0', dev, deployment: 'self' },
} as unknown as Me)

let requests: { method: string; url: string; body: string | null }[] = []
let demoAnswer: DemoInfo | null = INFO
const assigned: string[] = []
const realFetch = globalThis.fetch
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function Probe() {
  const { ready, info } = useDemoInfo()
  return <p data-testid="probe">{`${ready}:${info ? info.company : 'none'}`}</p>
}

let localeBefore = useLocaleStore.getState().locale
beforeAll(() => {
  installDom()
  localeBefore = useLocaleStore.getState().locale
  useLocaleStore.setState({ locale: 'ko' })
  Object.assign(globalThis, { location: { assign: (u: string) => void assigned.push(u), origin: 'http://team.localhost', href: 'http://team.localhost/' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null })
    if (url.endsWith('/api/demo')) return demoAnswer ? json(200, demoAnswer) : json(404, { error: { code: 'not_found', message: 'not found' } })
    if (url.endsWith('/api/demo/persona')) return json(200, { ok: true })
    return json(404, { error: { code: 'not_found', message: 'not found' } })
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { location?: unknown }).location
  // the files after this one start from the language they had before it
  useLocaleStore.setState({ locale: localeBefore })
  removeDom()
})
beforeEach(() => {
  requests = []
  assigned.length = 0
  demoAnswer = INFO
  useDemo.setState({ loaded: false, info: null })
  sessionStorage.removeItem('mycel.demo.switched')
})

describe('no demo', () => {
  test('signed in on a server that is not a development server: nothing is asked, nothing shows', async () => {
    useSession.setState({ status: { kind: 'signed-in', me: me(false) } } as never)
    const m = await mount(<><Probe /><DemoBar /></>)
    try {
      await m.settle()
      expect(m.get('probe').textContent).toBe('true:none')
      expect(m.find('demo-bar')).toBeNull()
      expect(requests).toEqual([])
    } finally { await m.unmount() }
  })

  test('a development server without the demo answers 404: nothing shows', async () => {
    demoAnswer = null
    useSession.setState({ status: { kind: 'signed-in', me: me(true) } } as never)
    const m = await mount(<><Probe /><DemoBar /></>)
    try {
      await m.settle()
      expect(requests.map((r) => r.url)).toEqual(['/api/demo'])
      expect(m.get('probe').textContent).toBe('true:none')
      expect(m.find('demo-bar')).toBeNull()
    } finally { await m.unmount() }
  })
})

describe('a demo server', () => {
  beforeEach(() => useSession.setState({ status: { kind: 'signed-in', me: me(true) } } as never))

  test('the bar: demo, the company and who you are now; one button opens the three people; a pick signs in through the server', async () => {
    const m = await mount(<DemoBar />)
    try {
      await m.settle()
      expect(m.get('demo-bar').textContent).toBe('데모 · 가상 회사 Acme · 신입 Alex Kim사람 바꾸기')
      expect(m.get('demo-bar').querySelectorAll('button').length).toBe(1)
      await m.click('demo-switch')
      const sheet = m.get('demo-personas')
      expect(sheet.textContent).toContain('신입 · Alex Kim · Marketing')
      expect(sheet.textContent).toContain('팀장 · Sam Ortiz · Marketing')
      expect(sheet.textContent).toContain('대표 · Dana Brooks')
      expect(m.get('demo-persona-newHire').getAttribute('aria-current')).toBe('true')
      // the development-mode notice moved into the sheet, with who else can use this demo
      expect(m.html()).toContain('개발 모드')
      expect(m.get('demo-network').textContent).toContain('이 맥이 연결된 모든 네트워크(Wi-Fi, VPN, Tailscale)의 누구나')
      await m.click('demo-persona-lead')
      await m.settle()
      const sw = requests.find((r) => r.url.endsWith('/api/demo/persona'))!
      expect(sw.method).toBe('POST')
      expect(JSON.parse(sw.body!)).toEqual({ key: 'lead' })
      expect(assigned).toEqual(['/'])
      expect(sessionStorage.getItem('mycel.demo.switched')).toBe('1')
    } finally { await m.unmount() }
  })

  test('a demo that listens on this Mac only does not warn about the network', async () => {
    demoAnswer = { ...INFO, network: false }
    const m = await mount(<DemoBar />)
    try {
      await m.settle()
      await m.click('demo-switch')
      expect(m.find('demo-network')).toBeNull()
    } finally { await m.unmount() }
  })

  test('Home for the new hire: one line and exactly the three questions; for the lead the same-question line', async () => {
    const m = await mount(<MemoryRouter><DemoIntro persona={INFO.personas[0]!} /><DemoQuestions info={INFO} persona={INFO.personas[0]!} /></MemoryRouter>)
    try {
      expect(m.get('demo-intro').textContent).toBe("I'm Alex Kim. I joined Acme's Marketing team today.")
      expect(m.get('demo-questions').querySelectorAll('button').length).toBe(3)
      expect(m.get('demo-questions').textContent).not.toContain('같은 질문')
    } finally { await m.unmount() }
    const lead = await mount(<MemoryRouter><DemoQuestions info={{ ...INFO, current: 'lead' }} persona={INFO.personas[1]!} /></MemoryRouter>)
    try {
      expect(lead.get('demo-questions').textContent).toContain('같은 질문을 다른 사람으로도 해 보세요')
      expect(lead.get('demo-questions').querySelectorAll('button').length).toBe(1)
    } finally { await lead.unmount() }
  })

  test('after a switch the new hire also gets the same question', async () => {
    sessionStorage.setItem('mycel.demo.switched', '1')
    const m = await mount(<MemoryRouter><DemoQuestions info={INFO} persona={INFO.personas[0]!} /></MemoryRouter>)
    try {
      const buttons = m.get('demo-questions').querySelectorAll('button')
      expect(buttons.length).toBe(4)
      expect(buttons[3]!.textContent).toBe("Summarize this quarter's budget")
    } finally {
      await m.unmount()
      sessionStorage.removeItem('mycel.demo.switched')
    }
  })

  test('the sign-in page: the new hire\'s line and one primary button; the usual form is a quiet link away', async () => {
    let other = 0
    const m = await mount(<DemoStart info={{ ...INFO, current: null }} onOtherAccount={() => other++} />)
    try {
      expect(m.get('demo-start').textContent).toContain("I'm Alex Kim. I joined Acme's Marketing team today.")
      expect(m.get('demo-start-button').textContent).toBe('Alex Kim 님으로 시작하기')
      expect(m.html().match(/bg-accent /g)?.length ?? 0).toBe(1)
      await m.click('demo-start-button')
      await m.settle()
      expect(JSON.parse(requests.find((r) => r.url.endsWith('/api/demo/persona'))!.body!)).toEqual({ key: 'newHire' })
      expect(assigned).toEqual(['/'])
      // starting is not a switch: the new hire's screen keeps its three questions
      expect(sessionStorage.getItem('mycel.demo.switched')).toBeNull()
      expect(other).toBe(0)
    } finally { await m.unmount() }
  })
})
