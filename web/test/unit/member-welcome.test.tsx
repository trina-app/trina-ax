// The welcome card for invited people on Home (components/onboarding/MemberWelcome.tsx, store/memberWelcome.ts;
// docs/DECISIONS.md "A welcome for invited people"): who invited them and how many people are here (without "invited
// you" when nobody did), the four rows and their done states, Hide, "You're all set", a phone (under the box, no frame,
// 44 px targets), and while no AI answers: the no-AI way out as the last row (connect their own, or tell the owner
// once), no separate no-AI card, and the question back once AI answers. While the card shows, "Ready in your team" stays
// out. Also the join pages' title (Auth.tsx joinTitle) and the room's one-time ✦ line (components/rooms/RoomAskHint.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { MemberWelcome } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import Home from '../../src/pages/Home'
import { joinTitle } from '../../src/pages/Auth'
import { firstName, roomList } from '../../src/components/onboarding/MemberWelcome'
import { RoomAskHint, useRoomAskHint } from '../../src/components/rooms/RoomAskHint'
import { useAiAccess } from '../../src/store/aiAccess'
import { useChats } from '../../src/store/chats'
import { useMemberWelcome } from '../../src/store/memberWelcome'
import { useSession } from '../../src/store/session'
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
  steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false, ...over,
})

let welcome: MemberWelcome | null = card()
let access: Record<string, unknown> = { usable: true, action: 'ask_owner', requested: false }
let calls: { key: string; body: any }[] = []
const routes: Record<string, (body: any) => Response> = {
  'GET /api/me/welcome': () => json(200, { welcome }),
  'PATCH /api/me/welcome': (b: { hide?: true; asked?: true }) => {
    if (b.hide) welcome = null
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
      expect(text(m, 'member-welcome-line')).toBe('Alex Kim invited you · 6 people are here')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 3')
      expect(m.get('member-welcome-rooms').getAttribute('data-done')).toBe('true')
      expect(text(m, 'member-welcome-rooms')).toContain("You're in Everyone and # Sales")
      expect(m.get('member-welcome-rooms-open').getAttribute('href')).toBe('/rooms')
      expect(m.get('member-welcome-hi').getAttribute('data-done')).toBeNull()
      expect(text(m, 'member-welcome-hi-button')).toBe("👋 Hi, I'm Mina")
      expect(m.get('member-welcome-photo').getAttribute('data-optional')).toBe('true')
      expect(text(m, 'member-welcome-ask')).toContain('Ask Trina what you can do here')
      // no second list of skills, no no-AI card
      await new Promise((r) => setTimeout(r, 20))
      expect(m.find('team-prepared')).toBeNull()
      expect(m.find('no-ai-card')).toBeNull()
      // the card sits above the greeting on a computer
      expect(m.get('home-head').querySelector('[data-testid="member-welcome"]')).not.toBeNull()
    } finally { m.unmount() }
  })

  test('no inviter ("Add directly"): the line without "invited you"', async () => {
    signIn()
    welcome = card({ inviter: null, people: 1 })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(text(m, 'member-welcome-line')).toBe('1 person is here')
    } finally { m.unmount() }
  })

  test('say hi: posts "👋 Hi, I\'m Mina" in the everyone room as them; the row is done and opens that room', async () => {
    signIn()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-hi-button'), 'the button')
      await m.click('member-welcome-hi-button')
      await m.until(() => m.find('member-welcome-hi-open'), 'done')
      expect(called(`POST /api/rooms/${EVERYONE}/messages`).map((c) => c.body.body)).toEqual(["👋 Hi, I'm Mina"])
      expect(m.get('member-welcome-hi').getAttribute('data-done')).toBe('true')
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 2 of 3')
      expect(m.get('member-welcome-hi-open').getAttribute('href')).toBe(`/rooms/${EVERYONE}`)
    } finally { m.unmount() }
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
    } finally { m.unmount() }
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
    } finally { m.unmount() }
  })

  test('done rows: hi, photo and asked show done; all done: "You\'re all set", Close hides it for good', async () => {
    signIn()
    welcome = card({ steps: { rooms: true, hi: true, photo: true, asked: false } })
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('member-welcome-photo').getAttribute('data-done')).toBe('true')
      expect(m.find('member-welcome-photo-button')).toBeNull()
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 2 of 3')
    } finally { m.unmount() }
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
    } finally { n.unmount() }
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
    } finally { m.unmount() }
  })

  test('a phone: the same card under the box, without a frame, 44 px targets', async () => {
    signIn()
    phoneWidth()
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome'), 'the card')
      expect(m.get('home-tail').querySelector('[data-testid="member-welcome"]')).not.toBeNull()
      expect(m.get('home-head').querySelector('[data-testid="member-welcome"]')).toBeNull()
      expect(m.get('member-welcome').getAttribute('class')).toContain('md:border')
      expect(m.get('member-welcome').getAttribute('class')).not.toMatch(/(^| )border( |$)/)
      for (const id of ['member-welcome-hide', 'member-welcome-hi-button', 'member-welcome-photo-button', 'member-welcome-rooms-open'])
        expect(m.get(id).getAttribute('class')).toContain('max-md:min-h-11')
      expect(text(m, 'member-welcome-rooms')).toContain('Your team\'s rooms are in Chats')
    } finally { m.unmount() }
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
      expect(text(m, 'member-welcome-tell')).toBe('Tell Olga')
      expect(m.find('no-ai-card')).toBeNull()
      expect(m.find('member-welcome-ask-button')).toBeNull()
      await m.click('member-welcome-tell')
      await m.until(() => m.find('member-welcome-told'), 'told')
      expect(text(m, 'member-welcome-told')).toBe('Told them')
      expect(m.find('member-welcome-tell')).toBeNull()
      expect(called('POST /api/me/ai-access/request')).toHaveLength(1)
      // the other rows work the same
      expect(m.find('member-welcome-hi-button')).not.toBeNull()
    } finally { m.unmount() }
  })

  test('their own AI allowed: the row connects it; the trial credit\'s line when that is why', async () => {
    signIn()
    access = { usable: false, action: 'connect_own', requested: false, trial: 'used' }
    const m = await home()
    try {
      await m.until(() => m.find('member-welcome-connect'), 'the row')
      expect(text(m, 'member-welcome-ask')).toContain('Connect your AI so Trina can help you')
      expect(text(m, 'member-welcome-ask')).toContain(en('aiAccess.banner.trialUsed'))
      expect(m.get('member-welcome-connect').getAttribute('data-action')).toBe('connect_own')
      expect(text(m, 'member-welcome-connect')).toBe('Connect my AI')
      expect(m.find('no-ai-card')).toBeNull()
    } finally { m.unmount() }
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
      expect(text(m, 'member-welcome-progress')).toBe('Get started · 1 of 3')
    } finally { m.unmount() }
  })
})

describe('the words', () => {
  test('first names, the rooms, the join page', () => {
    expect(firstName('Mina Park')).toBe('Mina')
    expect(firstName('김민지')).toBe('김민지')
    expect(firstName('김 민지')).toBe('김 민지')
    expect(firstName('  QA  ')).toBe('QA')
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
      expect(text(m, 'room-ask-hint')).toContain('✦ Ask Trina about this room. Only you see it.')
      await m.click('room-ask-hint-close')
      expect(m.find('room-ask-hint')).toBeNull()
      await m.until(() => called('PATCH /api/me').length > 0 || null, 'saved')
      expect(called('PATCH /api/me')[0]!.body).toEqual({ prefs: { roomAskHint: 'seen' } })
    } finally { m.unmount() }
    // seen (another device, a reload): not shown
    signIn({ roomAskHint: 'seen' })
    const n = await mount(<Hint />)
    try { expect(n.find('room-ask-hint')).toBeNull() } finally { n.unmount() }
  })
  test('using ✦ from the line counts too', async () => {
    signIn()
    const m = await mount(<Hint />)
    try {
      await m.until(() => m.find('room-ask-hint'), 'the line')
      await m.click('room-ask-hint-open')
      expect(m.find('room-ask-hint')).toBeNull()
    } finally { m.unmount() }
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
    } finally { m.unmount() }
    useAiAccess.getState().reset()
    useSession.setState({ status: { kind: 'signed-in', me: { ...meOf(), user: { ...meOf().user, role: 'owner' } } } } as never)
    access = { usable: true, action: 'ask_owner', requested: false }
    const n = await mount(<Hint />)
    try { await n.until(() => n.find('room-ask-hint'), 'the line for an owner') } finally { n.unmount() }
  })
})
