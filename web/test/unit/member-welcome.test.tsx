// The welcome card for invited people on Home (components/onboarding/MemberWelcome.tsx, store/memberWelcome.ts;
// docs/DECISIONS.md "A welcome for invited people"): who invited them and how many people are here (without "invited
// you" when nobody did), the four rows and their done states, Hide, "You're all set", a phone (under the box, no frame,
// 44 px targets), and while no AI answers: the no-AI way out as the last row (connect their own, or tell the owner
// once), no separate no-AI card, and the question back once AI answers. While the card shows, "Ready in your team" stays
// out. Also the join pages' title (Auth.tsx joinTitle) and the room's one-time ✦ line (components/rooms/RoomAskHint.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { MemberWelcome, WelcomeProgress } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { joinTitle } from '../../src/pages/Auth'
import { roomList } from '../../src/components/onboarding/MemberWelcome'
import { greetName } from '../../src/lib/greetName'
import { RoomAskHint, useRoomAskHint } from '../../src/components/rooms/RoomAskHint'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useMemberWelcome } from '../../src/store/memberWelcome'
import { useSession } from '../../src/store/session'
import { useWelcome } from '../../src/store/welcome'
import { useUi } from '../../src/store/ui'
import { forgetStepsSeen, markStepsSeen } from '../../src/lib/welcome'
import { OrganizeTeamFiles } from '../../src/components/onboarding/OrganizeTeamFiles'
import { MySetupShowAgain } from '../../src/components/onboarding/CardHide'
import { ALL_SET_SHOW_MS } from '../../src/components/onboarding/MemberWelcome'
import { installDom, mount, removeDom } from './dom-host'
import { message } from './rooms-fixtures'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const en = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('en', k, p)
const EVERYONE = '01900000-0000-7000-8000-0000000000a1'
const SALES = '01900000-0000-7000-8000-0000000000a2'
const meOf = (prefs: Record<string, unknown> = {}) => ({
  user: { id: 'mina', username: 'mina', name: 'Mina Park', email: null, role: 'member', locale: 'en', localeChoice: null, mustChangePassword: false, prefs },
  groups: [], team: { name: 'Acme', defaultLocale: 'en' },
  session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: true },
})
const card = (over: Partial<MemberWelcome> = {}): MemberWelcome => ({
  team: 'Acme', inviter: { id: 'alex', name: 'Alex Kim' }, people: 6,
  rooms: [{ id: EVERYONE, kind: 'all', name: null }, { id: SALES, kind: 'team', name: 'Sales' }],
  owner: { id: 'olga', name: 'Olga Berg' },
  steps: { rooms: true, hi: false, photo: false, asked: false, tools: false }, allSet: false, ...over,
})

let welcome: MemberWelcome | null = card()
/** what PATCH { show } brings back (the card that was hidden) */
let shown: MemberWelcome | null = null
/** the answer's other fields (hidden, organizeFiles) */
let extra: Record<string, unknown> = {}
let access: Record<string, unknown> = { usable: true, action: 'ask_owner', requested: false }
let calls: { key: string; body: any }[] = []
/** the team setup's progress (GET /api/onboarding/welcome): the owner card's setup row reads it */
let progress: WelcomeProgress | null = null
/** started: 회사 소개 done, the rest open */
const started = (): WelcomeProgress => ({
  startedAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z', teamType: null,
  steps: { profile: 'done', result: null, skills: null, files: null, tools: null, invite: null }, resultChatId: null, inviteShownAt: null, site: null, dismissedAt: null, finishedAt: null,
})
/** made by the setup for the owner and never opened (a server we set up for a customer) */
const neverOpened = (): WelcomeProgress => ({ ...started(), steps: { profile: null, result: null, skills: null, files: null, tools: null, invite: null } })
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/welcome': () => json(200, { welcome, ...extra }),
  'PATCH /api/me/welcome': (b: { hide?: true; show?: true; asked?: true; tools?: true }) => {
    if (b.tools && welcome) welcome = { ...welcome, steps: { ...welcome.steps, tools: true } }
    if (b.hide) { extra = { hidden: true }; welcome = null }
    if (b.show) { extra = {}; welcome = shown ?? card() }
    if (b.asked && welcome) welcome = { ...welcome, steps: { ...welcome.steps, asked: true } }
    return json(200, { welcome })
  },
  'GET /api/me/ai-access': () => json(200, access),
  'POST /api/me/ai-access/request': () => json(200, { requested: true, already: false }),
  [`POST /api/rooms/${EVERYONE}/messages`]: (b: any) => {
    // the server counts it: "Say hi" done, and all set when "asked" was done already
    if (welcome) { const steps = { ...welcome.steps, hi: true }; welcome = { ...welcome, steps, allSet: steps.hi && steps.asked } }
    return json(201, message({ roomId: EVERYONE, seq: 3, body: b.body, author: { id: 'mina', name: 'Mina Park' } }))
  },
  'GET /api/onboarding/goal': () => json(200, { goal: null }),
  'GET /api/questions/frequent': () => json(200, { items: [] }),
  'GET /api/skills/popular': () => json(200, { items: [], days: 30 }),
  'GET /api/skills/examples': () => json(200, { skills: [{ path: 'skills/quote/SKILL.md', name: 'quote', title: 'Customer quote', summary: 'A quote for a customer', source: { kind: 'team' } }], teamFolder: null, landing: null, ranTeamSkill: false, hasProfile: false }),
  'GET /api/files/tree': () => json(200, { path: '', access: 'read', entries: [], nextCursor: null }),
  'GET /api/me/credentials': () => json(200, { items: [], allowedKinds: ['anthropic-api-key'], anthropicGateway: null }),
  'GET /api/onboarding/welcome': () => json(200, { progress }),
  'GET /api/admin/credentials': () => json(200, { items: [], memberOwn: false, sharedSubscriptions: true, allowedKinds: ['anthropic-oauth', 'anthropic-api-key'], pricesAsOf: '2026-11-01', anthropicGateway: null }),
}
const called = (key: string) => calls.filter((c) => c.key === key)
const g = globalThis as Record<string, unknown>
const computerMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
const phoneWidth = () => { g.matchMedia = (q: string) => ({ ...computerMedia(), matches: q === '(max-width: 767.98px)' }) }

const realFetch = globalThis.fetch
const before = { locale: useLocaleStore.getState().locale, status: useSession.getState().status, send: useChats.getState().send }
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'en' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ key, body })
    return routes[key]?.(body) ?? json(404, { error: { code: 'not_found', message: `no route ${key}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  welcome = card()
  shown = null
  progress = null
  useWelcome.getState().reset()
  forgetStepsSeen()
  useUi.setState({ toasts: [] })
  extra = {}
  access = { usable: true, action: 'ask_owner', requested: false }
  calls = []
  localStorage.clear()
  useChats.getState().reset()
  useChats.setState({ send: before.send })
  useAiAccess.getState().reset()
  useMemberWelcome.getState().reset()
  g.matchMedia = computerMedia
})
afterAll(() => {
  globalThis.fetch = realFetch
  removeDom()
  useLocaleStore.setState({ locale: before.locale })
  useSession.setState({ status: before.status })
})

const signIn = (prefs: Record<string, unknown> = {}) => useSession.setState({ status: { kind: 'signed-in', me: meOf(prefs) } } as never)
/** an owner or admin; the steps were on screen in this tab already, so a landing on Home stays on Home */
const signInAs = (role: 'owner' | 'admin') => { markStepsSeen('mina'); useSession.setState({ status: { kind: 'signed-in', me: { ...meOf(), user: { ...meOf().user, role } } } } as never) }
const order = (m: Awaited<ReturnType<typeof mount>>) => [...m.get('member-welcome-rows').children].map((li) => li.getAttribute('data-testid'))
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p> }
const home = () => mount(<MemoryRouter><Routes><Route path="/" element={<Home />} /><Route path="*" element={<Where />} /></Routes></MemoryRouter>)
const text = (m: Awaited<ReturnType<typeof home>>, id: string) => m.get(id).textContent ?? ''

describe('the card on Home', () => {
  test('who invited them, how many are here, the rows; the one thing at the top ("Ready in your team" out)', async () => {
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(text(m, 'member-welcome-title')).toBe('Welcome to Acme, Mina')
      // the rooms are one line under the title now, a link to Chats (docs/decisions/20261120-my-setup-card.md)
      expect(text(m, 'member-welcome-line')).toBe("Alex Kim invited you · 6 people are here · You're in Everyone and # Sales")
      expect(m.get('member-welcome-rooms').getAttribute('href')).toBe('/rooms')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 0 of 3 required')
      // the rows, in order: tools first; no rooms row any more
      expect([...m.get('member-welcome-rows').children].map((li) => li.getAttribute('data-testid'))).toEqual(['member-welcome-tools', 'member-welcome-hi', 'member-welcome-ask', 'member-welcome-photo'])
      expect(text(m, 'member-welcome-tools')).toContain('Connect your tools')
      expect(m.get('member-welcome-tools').getAttribute('data-optional')).toBeNull()
      expect(m.get('member-welcome-hi').getAttribute('data-done')).toBeNull()
      // posted to the everyone room: the whole display name, not the greeting's first name
      expect(text(m, 'member-welcome-hi-button')).toBe("👋 Hi, I'm Mina Park")
      expect(m.get('member-welcome-photo').getAttribute('data-optional')).toBe('true')
      expect(text(m, 'member-welcome-ask')).toContain('Ask Trina what you can do here')
      // no second list of skills, no no-AI card
      await new Promise((r) => setTimeout(r, 20))
      expect(m.find('team-prepared')).toBeNull()
      expect(m.find('no-ai-card')).toBeNull()
      // the card sits above the greeting on a computer
      expect(m.get('home-top').querySelector('[data-testid="member-welcome"]')).not.toBeNull()
      expect(m.get('home-top').nextSibling).toBe(m.get('home-head'))
    } finally { await m.unmount() }
  })

  test('Hide sits on the title\'s line (it closes the whole card); the count line is a plain label', async () => {
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      const hide = m.get('member-welcome-hide')
      expect(hide.parentElement).toBe(m.get('member-welcome-title').parentElement)
      expect(m.get('member-welcome-progress').querySelector('button')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a demo (scripted, free roam): no tools row and no files row; the count is hi and ask only', async () => {
    signIn()
    welcome = card({ demo: true, steps: { rooms: true, hi: true, photo: false, asked: false, tools: true } })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect([...m.get('member-welcome-rows').children].map((li) => li.getAttribute('data-testid'))).toEqual(['member-welcome-hi', 'member-welcome-ask', 'member-welcome-photo'])
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 2 required')
    } finally { await m.unmount() }
  })

  test('the owner\'s card once the team setup is over: its own words, tools and ask counted, no hi, no setup row', async () => {
    signInAs('owner')
    welcome = card({ kind: 'owner', inviter: null })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('member-welcome').getAttribute('data-kind')).toBe('owner')
      expect(text(m, 'member-welcome-title')).toBe('Your turn now, Mina')
      expect(text(m, 'member-welcome-line')).toBe('The team is set up. These are just for you.')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 0 of 2 required')
      expect(order(m)).toEqual(['member-welcome-tools', 'member-welcome-ask', 'member-welcome-photo'])
      expect(m.find('member-welcome-setup')).toBeNull()
      expect(m.find('member-welcome-rooms')).toBeNull()
      // the one thing at the top: no goal card, no standalone setup row under it
      await new Promise((r) => setTimeout(r, 20))
      expect(m.find('team-goal')).toBeNull()
      expect(m.find('welcome-resume')).toBeNull()
    } finally { await m.unmount() }
  })

  test('the owner\'s card while the team setup is open: "Let\'s get you started", the setup row first ("Continue team setup · 2/5" to /welcome), one card on Home', async () => {
    signInAs('owner')
    welcome = card({ kind: 'owner', inviter: null, setupOpen: true })
    progress = started()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-setup'), 'the setup row')
      expect(text(m, 'member-welcome-title')).toBe("Let's get you started, Mina")
      expect(text(m, 'member-welcome-line')).toBe('These are just for you.')
      expect(m.get('member-welcome-setup').getAttribute('data-state')).toBe('resume')
      expect(text(m, 'member-welcome-setup-text')).toBe('Continue team setup · 2/5')
      expect(m.get('member-welcome-setup-button').getAttribute('href')).toBe('/welcome')
      expect(text(m, 'member-welcome-setup-button')).toBe('Continue')
      // the setup row sits over the count, outside the rows
      expect(m.get('member-welcome-setup').nextSibling).toBe(m.get('member-welcome-progress'))
      expect(order(m)).toEqual(['member-welcome-tools', 'member-welcome-ask', 'member-welcome-photo'])
      // one card on Home: the standalone setup row and the goal stay out
      await new Promise((r) => setTimeout(r, 20))
      expect(m.find('welcome-resume')).toBeNull()
      expect(m.find('team-goal')).toBeNull()
      expect(m.get('home-column').querySelectorAll('[data-testid="member-welcome"]').length).toBe(1)
      expect(m.find('no-ai-card')).toBeNull()
    } finally { await m.unmount() }
  })

  test('a setup nobody opened yet: "Start team setup · 1/5"; both personal rows done while it is open: the card stays, not all set', async () => {
    signInAs('owner')
    welcome = card({ kind: 'owner', inviter: null, setupOpen: true, steps: { rooms: true, hi: false, photo: false, asked: true, tools: true } })
    progress = neverOpened()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-setup'), 'the setup row')
      expect(m.get('member-welcome-setup').getAttribute('data-state')).toBe('start')
      expect(text(m, 'member-welcome-setup-text')).toBe('Start team setup · 1/5')
      expect(text(m, 'member-welcome-setup-button')).toBe('Start')
      expect(text(m, 'member-welcome-progress')).toBe('Your setup is done · the team setup is left')
      expect(m.get('member-welcome').getAttribute('data-state')).toBe('open')
    } finally { await m.unmount() }
  })

  test('a phone with only 내 스킬 left, put off for a computer: the setup row says so, no button', async () => {
    signInAs('owner')
    phoneWidth()
    welcome = card({ kind: 'owner', inviter: null, setupOpen: true })
    progress = { ...started(), skillsLater: true, steps: { profile: 'done', result: null, skills: 'skipped', files: 'done', tools: 'skipped', invite: 'done' } } as WelcomeProgress
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-setup'), 'the setup row')
      expect(m.get('member-welcome-setup').getAttribute('data-state')).toBe('computer')
      expect(text(m, 'member-welcome-setup')).toBe('Continue the team setup on your computer')
      expect(m.find('member-welcome-setup-button')).toBeNull()
    } finally { await m.unmount() }
  })

  test('no AI and the owner can connect it: the card shows, the AI row first in the team\'s words with Home\'s button; no setup row, no no-AI line', async () => {
    signInAs('owner')
    welcome = card({ kind: 'owner', inviter: null, setupOpen: true })
    progress = neverOpened()
    access = { usable: false, action: 'connect_team', requested: false }
    const m = await home()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI row\'s button')
      expect(order(m)).toEqual(['member-welcome-ask', 'member-welcome-tools', 'member-welcome-photo'])
      expect(text(m, 'member-welcome-ask')).toContain('Connect an AI so Trina can help you right away')
      expect(text(m, 'welcome-ai-claude')).toBe('Connect Claude')
      expect(m.find('member-welcome-setup')).toBeNull()
      expect(m.find('no-ai-card')).toBeNull()
    } finally { await m.unmount() }
  })

  test('no AI, an admin: the AI row first too (a member\'s "Tell {owner}" stays in its place)', async () => {
    signInAs('admin')
    access = { usable: false, action: 'connect_team', requested: false }
    const m = await home()
    try {
      await m.until(() => m.find('welcome-ai-claude'), 'the AI row\'s button')
      expect(order(m)).toEqual(['member-welcome-ask', 'member-welcome-tools', 'member-welcome-hi', 'member-welcome-photo'])
    } finally { await m.unmount() }
  })

  test('Hide: an undo toast; Undo brings the card back', async () => {
    signIn()
    shown = card()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      await act(async () => { m.get('member-welcome-hide').click() })
      await m.until(() => !m.find('member-welcome') && useUi.getState().toasts.length > 0, 'hidden, with a toast')
      const t = useUi.getState().toasts.at(-1)!
      expect(t.text).toBe(en('homeCards.hiddenMySetup'))
      expect(t.action?.label).toBe(en('common.undo'))
      expect(called('PATCH /api/me/welcome').at(-1)?.body).toEqual({ hide: true })
      await act(async () => { t.action!.run() })
      await m.until(() => m.find('member-welcome'), 'the card back')
      expect(called('PATCH /api/me/welcome').at(-1)?.body).toEqual({ show: true })
    } finally { await m.unmount() }
  })

  test('no inviter ("Add directly"): the line without "invited you"', async () => {
    signIn()
    welcome = card({ inviter: null, people: 1 })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(text(m, 'member-welcome-line')).toBe("1 person is here · You're in Everyone and # Sales")
    } finally { await m.unmount() }
  })

  test('say hi: posts "👋 Hi, I\'m Mina" in the everyone room as them; the row is done and opens that room', async () => {
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-hi-button'), 'the button')
      await m.click('member-welcome-hi-button')
      await m.until(() => m.find('member-welcome-hi-open'), 'done')
      expect(called(`POST /api/rooms/${EVERYONE}/messages`).map((c) => c.body.body)).toEqual(["👋 Hi, I'm Mina Park"])
      expect(m.get('member-welcome-hi').getAttribute('data-done')).toBe('true')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 3 required')
      expect(m.get('member-welcome-hi-open').getAttribute('href')).toBe(`/rooms/${EVERYONE}`)
    } finally { await m.unmount() }
  })

  test('say hi as the last row: the card reads the server again and says "You\'re all set" without reopening Home', async () => {
    signIn()
    welcome = card({ steps: { rooms: true, hi: false, photo: false, asked: true } })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-hi-button'), 'the button')
      await m.click('member-welcome-hi-button')
      await m.until(() => m.get('member-welcome').getAttribute('data-state') === 'all-set' || null, 'all set')
      expect(called('GET /api/me/welcome').length).toBeGreaterThanOrEqual(2)
    } finally { await m.unmount() }
  })

  test('ask: one tap starts a normal chat with the fixed question, records it, and opens the chat', async () => {
    signIn()
    const sent: string[] = []
    useChats.setState({ send: (async (o: { content: string }) => { sent.push(o.content); return { chatId: 'chat-1', sent: Promise.resolve() } }) as never })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-ask-button')?.getAttribute('disabled') === null ? m.find('member-welcome-ask-button') : null, 'the button')
      await m.click('member-welcome-ask-button')
      await m.until(() => m.find('where'), 'the chat')
      expect(text(m, 'where')).toBe('/c/chat-1')
      expect(sent).toEqual([en('memberWelcome.askQuestion')])
      await m.until(() => called('PATCH /api/me/welcome').length > 0 || null, 'recorded')
      expect(called('PATCH /api/me/welcome')[0]!.body).toEqual({ asked: true })
    } finally { await m.unmount() }
  })

  test('done rows: hi, photo and asked show done; all done: "You\'re all set", Close hides it for good', async () => {
    signIn()
    welcome = card({ steps: { rooms: true, hi: true, photo: true, asked: false } })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('member-welcome-photo').getAttribute('data-done')).toBe('true')
      expect(m.find('member-welcome-photo-button')).toBeNull()
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 2 of 3 required')
    } finally { await m.unmount() }
    useMemberWelcome.getState().reset()
    welcome = card({ steps: { rooms: true, hi: true, photo: false, asked: true }, allSet: true })
    const n = await home()
    try {
      await n.until(() => n.find('member-welcome'), 'the card')
      expect(n.get('member-welcome').getAttribute('data-state')).toBe('all-set')
      expect(text(n, 'member-welcome')).toContain("You're all set")
      await n.click('member-welcome-close')
      expect(n.find('member-welcome')).toBeNull()
      expect(called('PATCH /api/me/welcome').map((c) => c.body)).toEqual([{ hide: true }])
    } finally { await n.unmount() }
  })

  test('Hide: gone at once and for good; "Ready in your team" comes back', async () => {
    signIn()
    useChats.setState({ chats: [], chatsLoaded: true })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-hide'), 'the card')
      await m.click('member-welcome-hide')
      expect(m.find('member-welcome')).toBeNull()
      expect(called('PATCH /api/me/welcome').map((c) => c.body)).toEqual([{ hide: true }])
      await m.until(() => m.find('team-prepared'), 'the block')
    } finally { await m.unmount() }
  })

  test('a phone: the same card at the top of Home (the 트리나 tab), without a frame, 44 px targets', async () => {
    signIn()
    phoneWidth()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      // on a phone / is Home, the 트리나 tab: the card is the one thing on its top
      expect(m.get('home-top').querySelector('[data-testid="member-welcome"]')).not.toBeNull()
      expect(m.get('member-welcome').getAttribute('class')).toContain('md:border')
      expect(m.get('member-welcome').getAttribute('class')).not.toMatch(/(^| )border( |$)/)
      for (const id of ['member-welcome-hide', 'member-welcome-hi-button', 'member-welcome-photo-button'])
        expect(m.get(id).getAttribute('class')).toContain('max-md:min-h-11')
    } finally { await m.unmount() }
  })

  test('a phone: one greeting, the card\'s; the big one only for screen readers, back for "You\'re all set"; a computer keeps it', async () => {
    signIn()
    const greeting = (m: Awaited<ReturnType<typeof home>>) => m.container.querySelector('h1')
    phoneWidth()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(text(m, 'member-welcome')).toContain('Welcome to')
      expect(greeting(m)?.getAttribute('class')).toContain('sr-only')
    } finally { await m.unmount() }
    useMemberWelcome.getState().reset()
    welcome = card({ steps: { rooms: true, hi: true, photo: false, asked: true }, allSet: true })
    const n = await home()
    try {
      await n.until(() => n.find('member-welcome'), 'the card')
      expect(n.get('member-welcome').getAttribute('data-state')).toBe('all-set')
      expect(greeting(n)?.getAttribute('class')).not.toContain('sr-only')
    } finally { await n.unmount() }
    useMemberWelcome.getState().reset()
    welcome = card()
    g.matchMedia = computerMedia
    const c = await home()
    try {
      await c.until(() => c.find('member-welcome'), 'the card')
      expect(greeting(c)?.getAttribute('class')).not.toContain('sr-only')
    } finally { await c.unmount() }
  })
})

describe('"Connect your tools" (docs/decisions/20261120-my-setup-card.md)', () => {
  const NOTION = { id: 'int-notion', scope: 'personal', kind: 'mcp', name: 'Notion', slug: 'notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', authHeader: null, hasSecret: false, account: null, notes: null, writePolicy: 'ask', status: 'needs_auth', lastError: null, tools: [], toolsUpdatedAt: null, access: null, createdBy: null, createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', lastUsedAt: null, canManage: true }
  const app = (id: string, o: Record<string, unknown> = {}) => ({ id, available: true, reason: null, status: 'disconnected', account: null, writePolicy: 'ask', serviceDown: false, tools: [], shared: null, ...o })
  let items: unknown[] = []
  let recommendedTools: string[] | undefined
  const KEYS = ['GET /api/integrations', 'GET /api/integrations/google-drive', 'GET /api/integrations/google-apps', 'POST /api/integrations', 'POST /api/integrations/int-notion/authorize', 'GET /api/integrations/flows/flow-n']
  const setRoutes = (apps: unknown[] = [app('gmail'), app('calendar', { available: false }), app('docs'), app('sheets')]) => {
    routes['GET /api/integrations'] = () => json(200, { items, personalAllowed: true, ...(recommendedTools !== undefined ? { recommendedTools } : {}) })
    routes['GET /api/integrations/google-drive'] = () => json(200, { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, personalAllowed: true, teamShares: [] })
    routes['GET /api/integrations/google-apps'] = () => json(200, { apps })
  }
  const press = (e: { click(): void } | null | undefined) => act(async () => { e!.click() })
  /** one tool's line, and its parts (the fake document has no descendant selectors) */
  const item = (m: Awaited<ReturnType<typeof home>>, id: string) => [...m.container.querySelectorAll('[data-testid="my-tools-item"]')].find((li) => li.getAttribute('data-id') === id)
  const part = (m: Awaited<ReturnType<typeof home>>, id: string, testId: string) => item(m, id)?.querySelector(`[data-testid="${testId}"]`) ?? null
  const tools = (m: Awaited<ReturnType<typeof home>>) => [...m.container.querySelectorAll('[data-testid="my-tools-item"]')].map((li) => `${li.getAttribute('data-id')}:${li.getAttribute('data-state')}`)
  afterEach(() => { for (const k of KEYS) delete routes[k]; items = []; recommendedTools = undefined; delete g.open })

  test('the usual tools when the team recommends none (an older server): Drive, Gmail, Notion; a Google app that is off is left out', async () => {
    signIn()
    setRoutes()
    const m = await home()
    try {
      await m.until(() => m.find('my-tools'), 'the tools')
      expect(tools(m)).toEqual(['google-drive:open', 'gmail:open', 'notion:open'])
      // a Google tool opens its page in Settings › Connectors (its own sign-in)
      await press(part(m, 'google-drive', 'my-tools-connect'))
      await m.until(() => m.find('where'), 'Settings')
      expect(text(m, 'where')).toBe('/settings/connectors/google-drive')
    } finally { await m.unmount() }
  })

  test('the team\'s recommended tools first, then the usual ones, for a member too (nothing gated); one the team connected for everyone says so, no button', async () => {
    signIn()
    recommendedTools = ['linear']
    items = [{ ...NOTION, id: 'team-notion', scope: 'team', status: 'connected', hasSecret: true }]
    setRoutes()
    const m = await home()
    try {
      await m.until(() => m.find('my-tools'), 'the tools')
      expect(tools(m)).toEqual(['linear:open', 'google-drive:open', 'gmail:open', 'notion:team'])
      expect(part(m, 'notion', 'my-tools-team')!.textContent).toBe('Team connected')
      expect(part(m, 'notion', 'my-tools-connect')).toBeNull()
    } finally { await m.unmount() }
  })

  test('every tool offered is the team\'s for everyone: nothing left to connect, the row is recorded done', async () => {
    signIn()
    items = [{ ...NOTION, id: 'team-notion', scope: 'team', status: 'connected', hasSecret: true }]
    // no Drive here, Gmail the team's, the other Google apps off
    routes['GET /api/integrations'] = () => json(200, { items, personalAllowed: false })
    routes['GET /api/integrations/google-drive'] = () => json(200, { configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null, personalAllowed: true, teamShares: [] })
    routes['GET /api/integrations/google-apps'] = () => json(200, { apps: [app('gmail', { available: false, shared: { id: 'g', account: { email: 'team@acme.example', name: 'Acme' }, status: 'connected', alwaysAllowed: false } }), app('calendar', { available: false })] })
    const m = await home()
    try {
      await m.until(() => m.find('my-tools'), 'the tools')
      expect(tools(m)).toEqual(['gmail:team', 'notion:team'])
      await m.until(() => called('PATCH /api/me/welcome').length > 0 || null, 'recorded')
      expect(called('PATCH /api/me/welcome').map((c) => c.body)).toEqual([{ tools: true }])
      await m.until(() => m.get('member-welcome-tools').getAttribute('data-done') === 'true' || null, 'done')
    } finally { await m.unmount() }
  })

  test('a listed service in place: the person\'s own connection from the list, its sign-in in the window reserved during the click; connected: the row is done', async () => {
    signIn()
    setRoutes([])
    let opened = 0
    routes['POST /api/integrations'] = () => { items = [NOTION]; return json(201, NOTION) }
    routes['POST /api/integrations/int-notion/authorize'] = () => json(200, { flowId: 'flow-n', authorizationUrl: 'https://mcp.notion.com/authorize?state=x', expiresAt: '2099-01-01T00:00:00.000Z' })
    // the server counts it once it is connected
    routes['GET /api/integrations/flows/flow-n'] = () => { items = [{ ...NOTION, hasSecret: true, status: 'connected' }]; welcome = card({ steps: { rooms: true, hi: false, photo: false, asked: false, tools: true } }); return json(200, { flowId: 'flow-n', state: 'completed', expiresAt: '2099-01-01T00:00:00.000Z', reason: null }) }
    g.open = () => { opened++; return { opener: {}, close() {}, closed: false, location: { replace() {} } } }
    const m = await home()
    try {
      await m.until(() => part(m, 'notion', 'my-tools-connect'), 'Notion')
      await press(part(m, 'notion', 'my-tools-connect'))
      expect(opened).toBe(1)
      await m.until(() => called('POST /api/integrations/int-notion/authorize').length > 0, 'the sign-in started')
      expect(called('POST /api/integrations').map((c) => c.body)).toEqual([{ kind: 'mcp', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', writePolicy: 'ask' }])
      await m.until(() => item(m, 'notion')?.getAttribute('data-state') === 'mine' || null, 'connected', 6000)
      await m.until(() => m.get('member-welcome-tools').getAttribute('data-done') === 'true' || null, 'the row done')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 3 required')
    } finally { await m.unmount() }
  }, 20_000)
})

describe('when the card goes', () => {
  test('"You\'re all set" a few seconds, then gone without a write; Hide offers it again in Settings › Profile', async () => {
    signIn()
    welcome = card({ steps: { rooms: true, hi: true, photo: false, asked: true, tools: true }, allSet: true })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('member-welcome').getAttribute('data-state')).toBe('all-set')
      expect(ALL_SET_SHOW_MS).toBeLessThanOrEqual(10_000)
      await m.until(() => (m.find('member-welcome') ? null : true), 'gone', ALL_SET_SHOW_MS + 2000)
      expect(called('PATCH /api/me/welcome')).toEqual([])
    } finally { await m.unmount() }
    useMemberWelcome.getState().reset()
    welcome = card()
    const n = await home()
    try {
      await n.until(() => n.find('member-welcome-hide'), 'the card')
      await n.click('member-welcome-hide')
      expect(useMemberWelcome.getState().hidden).toBe(true)
    } finally { await n.unmount() }
    const s = await mount(<MemoryRouter><MySetupShowAgain /></MemoryRouter>)
    try {
      await s.until(() => s.find('profile-my-setup-show'), 'the row')
      expect(text(s, 'profile-my-setup-show')).toBe('Show my setup on Home again')
      await s.click('profile-my-setup-show')
      await s.until(() => (s.find('profile-my-setup') ? null : true), 'shown again')
      expect(called('PATCH /api/me/welcome').map((c) => c.body)).toEqual([{ hide: true }, { show: true }])
      expect(useMemberWelcome.getState().welcome).not.toBeNull()
    } finally { await s.unmount() }
  }, 20_000)

  test('an admin\'s "Sort the team\'s files" is on Admin › Home, only while the server says so', async () => {
    signIn()
    extra = { organizeFiles: true }
    routes['GET /api/onboarding/welcome'] = () => json(200, { progress: null })
    const m = await mount(<MemoryRouter><OrganizeTeamFiles /></MemoryRouter>)
    try {
      await m.until(() => m.find('admin-organize-files'), 'the row')
      expect(text(m, 'admin-organize-files')).toContain("Sort the team's files")
      expect(text(m, 'admin-organize-files')).toContain('Company-wide')
    } finally { await m.unmount(); delete routes['GET /api/onboarding/welcome'] }
    useMemberWelcome.getState().reset()
    extra = {}
    const n = await mount(<MemoryRouter><OrganizeTeamFiles /></MemoryRouter>)
    try {
      await n.until(() => useMemberWelcome.getState().loaded || null, 'read')
      expect(n.find('admin-organize-files')).toBeNull()
    } finally { await n.unmount() }
  })
})

describe('the desktop app\'s files row (optional, not counted)', () => {
  const bridge = (version = 1, scan: () => Promise<unknown> = async () => ({ state: 'cancelled' })) => ({
    bridgeVersion: 1,
    workFiles: { version, scan, stop() {}, read: async () => ({ ok: false, reason: 'unknown' }), onProgress: () => () => {}, openSettings() {} },
  })
  const setApp = (b: unknown) => { g.mycelDesktop = b }
  afterEach(() => { delete g.mycelDesktop })

  test('a browser (no desktop app): no row; "0 of 3"', async () => {
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.find('member-welcome-files')).toBeNull()
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 0 of 3 required')
    } finally { await m.unmount() }
  })

  test('an older desktop app (another bridge version) or one without workFiles (the Mac App Store build): no row', async () => {
    for (const b of [bridge(99), { bridgeVersion: 1 }]) {
      setApp(b)
      signIn()
      const m = await home()
      try {
        await m.until(() => m.find('member-welcome'), 'the card')
        expect(m.find('member-welcome-files')).toBeNull()
      } finally { await m.unmount() }
      useMemberWelcome.getState().reset()
    }
  })

  test('the desktop app: the row, optional, and still "0 of 3"; a phone\'s width: no row', async () => {
    setApp(bridge())
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-files'), 'the files row')
      expect(m.get('member-welcome-files').getAttribute('data-optional')).toBe('true')
      expect(m.get('member-welcome-files').getAttribute('data-done')).toBeNull()
      expect(text(m, 'member-welcome-files')).toContain('Bring work files from this computer')
      expect(text(m, 'member-welcome-files')).toContain('only you see them, in My files › From this computer')
      expect(text(m, 'member-welcome-files-button')).toBe('Find files')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 0 of 3 required')
    } finally { await m.unmount() }
    useMemberWelcome.getState().reset()
    phoneWidth()
    const p = await home()
    try {
      await p.until(() => p.find('member-welcome'), 'the card')
      expect(p.find('member-welcome-files')).toBeNull()
      expect(text(p, 'member-welcome-progress')).toBe('Get started · 0 of 3 required')
    } finally { await p.unmount() }
  })

  test('done once a file is there (the server says): done, Open goes to My files › From this computer; never counted', async () => {
    setApp(bridge())
    welcome = card({ steps: { rooms: true, hi: false, photo: false, asked: false, files: true } })
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-files'), 'the files row')
      expect(m.get('member-welcome-files').getAttribute('data-done')).toBe('true')
      expect(m.find('member-welcome-files-button')).toBeNull()
      expect(m.get('member-welcome-files-open').getAttribute('href')).toBe('/files?path=users%2Fmina%2FFrom%20this%20computer')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 3 required')
    } finally { await m.unmount() }
  })

  test('the all-set card (the server\'s allSet, which never counts files: tests/unit/b-member-welcome) shows no files row', async () => {
    setApp(bridge())
    welcome = card({ steps: { rooms: true, hi: true, photo: false, asked: true, files: false }, allSet: true })
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('member-welcome').getAttribute('data-state')).toBe('all-set')
      expect(m.find('member-welcome-files')).toBeNull()
    } finally { await m.unmount() }
  })

  test('Find files opens My files\' dialog; Cancel in the app\'s own window comes back to the card, which reads its rows again', async () => {
    let answer: (v: unknown) => void = () => {}
    setApp(bridge(1, () => new Promise((ok) => { answer = ok })))
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-files-button'), 'the button')
      const reads = called('GET /api/me/welcome').length
      await act(async () => { m.get('member-welcome-files-button').click() })
      await m.until(() => document.querySelector('[data-testid="find-work"][data-screen="asking"]'), 'the app asks first')
      await act(async () => { answer({ state: 'cancelled' }) })
      await m.until(() => !document.querySelector('[data-testid="find-work"]'), 'the dialog closed')
      expect(m.find('member-welcome-files')).not.toBeNull()
      await m.until(() => called('GET /api/me/welcome').length > reads, 'the card read again')
    } finally { await m.unmount() }
  })
})

describe('no AI for the person', () => {
  test('ask the owner: the last row says so and tells them once ("Told them"); no separate no-AI card', async () => {
    signIn()
    access = { usable: false, action: 'ask_owner', requested: false }
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-tell'), 'the row')
      expect(text(m, 'member-welcome-ask')).toContain("Trina isn't ready for you yet")
      // a third person: the owner's whole display name, on the button and in the hint
      expect(text(m, 'member-welcome-tell')).toBe('Tell Olga Berg')
      expect(text(m, 'member-welcome-ask')).toContain('You can start as soon as Olga Berg connects an AI for the team')
      expect(m.find('no-ai-card')).toBeNull()
      expect(m.find('member-welcome-ask-button')).toBeNull()
      await m.click('member-welcome-tell')
      await m.until(() => m.find('member-welcome-told'), 'told')
      expect(text(m, 'member-welcome-told')).toBe('Told them')
      expect(m.find('member-welcome-tell')).toBeNull()
      expect(called('POST /api/me/ai-access/request')).toHaveLength(1)
      // the other rows work the same
      expect(m.find('member-welcome-hi-button')).not.toBeNull()
    } finally { await m.unmount() }
  })

  test('their own AI allowed: the row connects it', async () => {
    signIn()
    access = { usable: false, action: 'connect_own', requested: false }
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-connect'), 'the row')
      expect(text(m, 'member-welcome-ask')).toContain('Connect your AI so Trina can help you')
      expect(m.get('member-welcome-connect').getAttribute('data-action')).toBe('connect_own')
      expect(text(m, 'member-welcome-connect')).toBe('Connect my AI')
      expect(m.find('no-ai-card')).toBeNull()
    } finally { await m.unmount() }
  })

  test('AI answers now: the row is back to the question, not done yet', async () => {
    signIn()
    access = { usable: false, action: 'ask_owner', requested: true }
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-told'), 'the asked row')
      access = { usable: true, action: 'ask_owner', requested: false }
      await act(async () => { await useAiAccess.getState().load(true) })
      await m.until(() => m.find('member-welcome-ask-button'), 'the question')
      expect(m.get('member-welcome-ask').getAttribute('data-done')).toBeNull()
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 0 of 3 required')
    } finally { await m.unmount() }
  })
})

describe('the words', () => {
  test('the name to greet by (lib/greetName): the whole name in Korean, Japanese and Chinese, the first name otherwise', () => {
    // Korean: the whole display name with 님 ("QA Member님", QA: it said "QA님"); a Korean name stays whole (the convention)
    expect(greetName('QA Member', 'ko')).toBe('QA Member')
    expect(greetName('Mina Park', 'ko')).toBe('Mina Park')
    expect(greetName('홍길동', 'ko')).toBe('홍길동')
    expect(greetName('김민지', 'en')).toBe('김민지')
    expect(greetName('김 민지', 'en')).toBe('김 민지')
    expect(greetName('QA Member', 'ja')).toBe('QA Member')
    expect(greetName('QA Member', 'zh-CN')).toBe('QA Member')
    // English and the other languages: the first name
    expect(greetName('Mina Park', 'en')).toBe('Mina')
    expect(greetName('QA Member', 'en-US')).toBe('QA')
    expect(greetName('María José García', 'es')).toBe('María')
    expect(greetName('Budi Santoso', 'id')).toBe('Budi')
    // one word
    expect(greetName('  QA  ', 'en')).toBe('QA')
    expect(greetName('QA', 'ko')).toBe('QA')
    expect(greetName('Raka', 'en')).toBe('Raka')
    // emoji: left out of the name; a name of emoji only stays as it is
    expect(greetName('🦊 Mina Park', 'en')).toBe('Mina')
    expect(greetName('Mina Park 🦊', 'ko')).toBe('Mina Park')
    expect(greetName('홍길동 🌸', 'ko')).toBe('홍길동')
    expect(greetName('Mina🦊 Park', 'en')).toBe('Mina🦊')
    expect(greetName('🦊', 'ko')).toBe('🦊')
    expect(greetName('🦊 🌸', 'en')).toBe('🦊 🌸')
    expect(greetName('', 'en')).toBe('')
    // titles, initials, tags and one-letter words (the review of #163)
    expect(greetName('Dr. Kim', 'en')).toBe('Kim')
    expect(greetName('Dr. Kim', 'ko')).toBe('Dr. Kim')
    expect(greetName('J. R. R. Tolkien', 'en')).toBe('Tolkien')
    expect(greetName('A Park', 'en')).toBe('A Park')
    expect(greetName('A', 'en')).toBe('A')
    expect(greetName('(QA) Mina', 'en')).toBe('Mina')
    expect(greetName('(QA) Mina', 'ko')).toBe('(QA) Mina')
    // whole-name mode keeps the name as written, punctuation too; only emoji words go
    expect(greetName('QA · Member', 'ko')).toBe('QA · Member')
    expect(greetName('QA · Member 🌸', 'ko')).toBe('QA · Member')
    expect(greetName('Kim Minsu', 'en')).toBe('Kim')
  })

  test('the rooms, the join page', () => {
    expect(roomList([{ id: EVERYONE, kind: 'all', name: null }], 'Everyone', 'en')).toBe('Everyone')
    expect(roomList([{ id: EVERYONE, kind: 'all', name: null }, { id: SALES, kind: 'team', name: 'Sales' }, { id: EVERYONE, kind: 'team', name: 'Ops' }], 'Everyone', 'en')).toBe('Everyone, # Sales, and # Ops')
    const t = ((k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => en(k, p)) as never
    expect(joinTitle(t, 'Acme', 'Alex Kim')).toBe('Alex Kim invited you to Acme')
    expect(joinTitle(t, 'Acme', null)).toBe('Join Acme')
    expect(joinTitle(t, 'Acme', undefined)).toBe('Join Acme')
  })
})

describe('the ✦ line in a room', () => {
  function Hint() {
    const h = useRoomAskHint()
    return h.show ? <RoomAskHint onAsk={h.seen} onClose={h.seen} /> : <p data-testid="no-hint" />
  }
  test('shown until closed, then never again (saved for the person)', async () => {
    signIn()
    routes['PATCH /api/me'] = (b: any) => json(200, meOf(b.prefs))
    const m = await mount(<Hint />)
    try {
      await m.until(() => m.find('room-ask-hint'), 'the line')
      expect(text(m, 'room-ask-hint')).toContain('✦ Ask Trina about this conversation. Only you see it.')
      await m.click('room-ask-hint-close')
      expect(m.find('room-ask-hint')).toBeNull()
      await m.until(() => called('PATCH /api/me').length > 0 || null, 'saved')
      expect(called('PATCH /api/me')[0]!.body).toEqual({ prefs: { roomAskHint: 'seen' } })
    } finally { await m.unmount() }
    // seen (another device, a reload): not shown
    signIn({ roomAskHint: 'seen' })
    const n = await mount(<Hint />)
    try { expect(n.find('room-ask-hint')).toBeNull() } finally { await n.unmount() }
  })
  test('using ✦ from the line counts too', async () => {
    signIn()
    const m = await mount(<Hint />)
    try {
      await m.until(() => m.find('room-ask-hint'), 'the line')
      await m.click('room-ask-hint-open')
      expect(m.find('room-ask-hint')).toBeNull()
    } finally { await m.unmount() }
  })
  test('for an owner too, but not while the AI cannot answer them (and it is not used up)', async () => {
    signIn()
    access = { usable: false, action: 'connect_own', requested: false }
    const m = await mount(<Hint />)
    try {
      await m.until(() => useAiAccess.getState().loaded || null, 'AI access read')
      await new Promise((r) => setTimeout(r, 20))
      expect(m.find('room-ask-hint')).toBeNull()
      expect(called('PATCH /api/me')).toHaveLength(0)
    } finally { await m.unmount() }
    useAiAccess.getState().reset()
    useSession.setState({ status: { kind: 'signed-in', me: { ...meOf(), user: { ...meOf().user, role: 'owner' } } } } as never)
    access = { usable: true, action: 'ask_owner', requested: false }
    const n = await mount(<Hint />)
    try { await n.until(() => n.find('room-ask-hint'), 'the line for an owner') } finally { await n.unmount() }
  })
})
