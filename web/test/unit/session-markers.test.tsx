// Session markers (docs/DECISIONS.md "Session markers"; lib/sessionMarkers.ts, store/sessionMarkers.ts,
// components/chat/ChatState.tsx): one marker per row with its priority (? > spinner > dot) from phone-nav's
// Chat.waiting / Chat.unseen with Chat.lastOutcome, what clears in the window that shows the chat, the one count n
// (chats and rooms, each once, rooms by my level for them), the 트리나 기록 filter, the /seen this window sends (never in a
// loop: a fake server replays what the real one sends back), and the one rule for notifications and toasts: a live
// change with `notify`, never for the chat on screen, after the wait and only while it still holds; rooms by the
// server's own notice mark and the room's "?", one per room. The desktop app's notification click opens the chat.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, type Chat, type Me, type Room, type ServerEvent, type TurnRequest } from '@mycel/shared/api'
import { useLocaleStore } from '../../src/i18n'
import { roomWantsMe } from '../../src/lib/rooms'
import { attentionCount, markerOf, stillWorthTelling, waitingOrRunning } from '../../src/lib/sessionMarkers'
import { useChats } from '../../src/store/chats'
import { dispatch } from '../../src/store/live'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { currentCount, readToken, startSessionMarkers, stopSessionMarkers, tellTiming, useSessionMarkers } from '../../src/store/sessionMarkers'
import { useUi } from '../../src/store/ui'
import { SessionMarker } from '../../src/components/chat/ChatState'
import { UnreadBadge } from '../../src/components/rooms/SidebarRooms'
import { installDom, mount, removeDom } from './dom-host'
import { BEN, ME, message, room } from './rooms-fixtures'

const T0 = Date.parse('2026-11-06T01:00:00.000Z')
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
function chat(o: Partial<Chat> = {}): Chat {
  return { id: uuidv7(), projectId: null, title: 'Weekly report', engine: 'claude-code', model: null, createdAt: iso(0), updatedAt: iso(10), deletedAt: null, runState: 'idle', ...o }
}
const ask = (o: Partial<Chat> = {}) => chat({ waiting: true, runState: 'running', ...o })

describe('one marker per row', () => {
  test('priority: ? over the spinner over the dot; nothing on an idle seen chat', () => {
    expect(markerOf(ask())).toEqual({ kind: 'ask', reason: 'card' })
    expect(markerOf(chat({ unseen: true, lastOutcome: 'error' }))).toEqual({ kind: 'ask', reason: 'error' })
    expect(markerOf(chat({ unseen: true, lastOutcome: 'paused' }))).toEqual({ kind: 'ask', reason: 'paused' })
    expect(markerOf(chat({ runState: 'running' }))).toEqual({ kind: 'running', reason: 'running' })
    expect(markerOf(chat({ runState: 'queued' }))).toEqual({ kind: 'running', reason: 'queued' })
    expect(markerOf(chat({ unseen: true }))).toEqual({ kind: 'new', reason: 'new' })
    // a card open in this window (a card one desktop window shows alone is in no list): "?" too
    expect(markerOf(chat({ runState: 'running' }), { card: true })).toEqual({ kind: 'ask', reason: 'card' })
    // a new run puts the older answer behind it: the spinner, not its dot or its failure
    expect(markerOf(chat({ unseen: true, runState: 'running' }))).toEqual({ kind: 'running', reason: 'running' })
    expect(markerOf(chat({ unseen: true, lastOutcome: 'error', runState: 'queued' }))).toEqual({ kind: 'running', reason: 'queued' })
    // seen: the outcome alone says nothing
    expect(markerOf(chat({ lastOutcome: 'error' }))).toBeNull()
    expect(markerOf(chat())).toBeNull()
  })

  test('on screen in a visible window: a new answer and a failed or paused one clear at once; a card stays', () => {
    expect(markerOf(chat({ unseen: true }), { here: true })).toBeNull()
    expect(markerOf(chat({ unseen: true, lastOutcome: 'error' }), { here: true })).toBeNull()
    expect(markerOf(chat({ unseen: true, lastOutcome: 'paused' }), { here: true })).toBeNull()
    expect(markerOf(ask(), { here: true })).toEqual({ kind: 'ask', reason: 'card' })
    expect(markerOf(chat({ runState: 'running' }), { here: true })).toEqual({ kind: 'running', reason: 'running' })
  })

  test('the 트리나 기록 filter "답변 중이거나 내 답을 기다림": spinner and "?" rows, failed and paused included, never a new answer', () => {
    expect(waitingOrRunning(chat({ runState: 'running' }))).toBe(true)
    expect(waitingOrRunning(chat({ runState: 'queued' }))).toBe(true)
    expect(waitingOrRunning(ask())).toBe(true)
    expect(waitingOrRunning(chat({ unseen: true, lastOutcome: 'error' }))).toBe(true)
    expect(waitingOrRunning(chat({ unseen: true, lastOutcome: 'paused' }))).toBe(true)
    expect(waitingOrRunning(chat({ unseen: true }))).toBe(false)
    expect(waitingOrRunning(chat())).toBe(false)
  })
})

describe('the one count n', () => {
  test('chats showing ? or a dot and rooms that want me, each once; running chats do not count; amber with a ?', () => {
    const shown = chat({ unseen: true })
    const chats = [ask(), chat({ unseen: true }), chat({ runState: 'running' }), chat(), shown, chat({ unseen: true, lastOutcome: 'error' })]
    const rooms = [room({ kind: 'dm', unreadCount: 4 }), room({ kind: 'team', unreadCount: 12 }), room({ kind: 'all', unreadCount: 2, mentioned: true }), room({ kind: 'group', unreadCount: 3, muted: true })]
    expect(attentionCount(chats, rooms)).toEqual({ n: 6, ask: true, chats: 4, chatAsk: true })
    // the chat on screen here is seen
    expect(attentionCount(chats, rooms, { here: shown.id })).toMatchObject({ n: 5, chats: 3 })
    expect(attentionCount([chat({ unseen: true })], [])).toEqual({ n: 1, ask: false, chats: 1, chatAsk: false })
    // a room whose AI waits on me is a "?" (amber), counted once even with unread messages and a mention; not the ☰ part
    expect(attentionCount([], [room({ kind: 'dm', unreadCount: 9, mentioned: true, aiWaits: true })])).toEqual({ n: 1, ask: true, chats: 0, chatAsk: false })
    expect(attentionCount([], [])).toEqual({ n: 0, ask: false, chats: 0, chatAsk: false })
  })

  test('a room wants me by my level for it (the server\'s notice rule): DMs and group chats by default, mentions, followed replies', () => {
    expect(roomWantsMe(room({ kind: 'dm', unreadCount: 1 }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'group', unreadCount: 1 }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'team', unreadCount: 5 }))).toBe(false)
    expect(roomWantsMe(room({ kind: 'team', unreadCount: 5, mentioned: true }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'team', threadsUnread: 1 }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'team', threadsUnread: 1 }), false)).toBe(false)
    // the room's own level: 모든 메시지 for a team room, 끄기 for a DM (mentions included)
    expect(roomWantsMe(room({ kind: 'team', unreadCount: 2, notify: { own: 'all', byDefault: 'mentions', level: 'all' } }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'dm', unreadCount: 2, mentioned: true, notify: { own: 'off', byDefault: 'all', level: 'off' } }))).toBe(false)
    // its AI waiting on me always counts
    expect(roomWantsMe(room({ kind: 'team', aiWaits: true, notify: { own: 'off', byDefault: 'mentions', level: 'off' } }))).toBe(true)
    expect(roomWantsMe(room({ kind: 'dm' }))).toBe(false)
  })

  test('after the wait: an answer only while still unseen, a card only while still open, never on screen here', () => {
    const done = chat({ unseen: true })
    expect(stillWorthTelling(done, { notify: 'answer', here: false })).toBe(true)
    expect(stillWorthTelling(chat(), { notify: 'answer', here: false })).toBe(false)
    expect(stillWorthTelling(done, { notify: 'answer', here: true })).toBe(false)
    expect(stillWorthTelling(ask(), { notify: 'card', here: false })).toBe(true)
    expect(stillWorthTelling(chat({ runState: 'running' }), { notify: 'card', here: false })).toBe(false)
    expect(stillWorthTelling(chat({ runState: 'running' }), { notify: 'card', here: false, card: true })).toBe(true)
    expect(stillWorthTelling(undefined, { notify: 'answer', here: false })).toBe(false)
  })
})

describe('the markers on screen', () => {
  beforeAll(() => { installDom() })
  afterAll(() => removeDom())
  const html = async (ui: Parameters<typeof mount>[0]) => { const p = await mount(ui); const h = p.html(); await p.unmount(); return h }

  test('"?" a 16 px amber pill, the running ring standing still with reduced motion, the 8 px accent dot; the reason is the label', async () => {
    const q = await html(<SessionMarker marker={{ kind: 'ask', reason: 'card' }} label="답을 기다려요" />)
    expect(q).toContain('role="img"')
    expect(q).toContain('aria-label="답을 기다려요"')
    expect(q).toMatch(/class="[^"]*\bh-4 min-w-4\b[^"]*\bbg-warn\b[^"]*text-canvas/)
    expect(q).toContain('>?<')
    const r = await html(<SessionMarker marker={{ kind: 'running', reason: 'running' }} label="답하는 중" />)
    expect(r).toMatch(/class="[^"]*\bsize-3\b[^"]*\banimate-spin\b[^"]*\bborder-faint\b[^"]*motion-reduce:animate-none/)
    const n = await html(<SessionMarker marker={{ kind: 'new', reason: 'new' }} label="새 답" />)
    expect(n).toMatch(/class="[^"]*\bsize-2\b[^"]*\bbg-accent\b/)
  })

  test('a room\'s one badge: ? over @ over the count', async () => {
    const live = useLocaleStore.getState().locale
    useLocaleStore.setState({ locale: 'ko' })
    try {
      const waits = await html(<UnreadBadge room={room({ kind: 'dm', unreadCount: 3, mentioned: true, aiWaits: true })} testId="b" />)
      expect(waits).toContain('data-ai-waits=""')
      expect(waits).toContain('>?<')
      expect(waits).toContain('트리나가 내 답을 기다려요')
      expect(waits).not.toContain('>@<')
      expect(await html(<UnreadBadge room={room({ unreadCount: 3, mentioned: true })} testId="b" />)).toContain('>@<')
      expect(await html(<UnreadBadge room={room({ unreadCount: 3 })} testId="b" />)).toContain('>3<')
      expect(await html(<UnreadBadge room={room({ unreadCount: 0 })} testId="b" />)).toBe('<div></div>')
    } finally { useLocaleStore.setState({ locale: live }) }
  })
})

describe('this window: /seen, notifications and toasts', () => {
  const g = globalThis as Record<string, unknown>
  let saved: Record<string, PropertyDescriptor | undefined> = {}
  const stub = (name: string, value: unknown) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const realFetch = globalThis.fetch
  let seenCalls: string[] = []
  /** what the fake server does on POST /seen (null: answers the chat, sends nothing) */
  let onSeen: ((chatId: string) => void) | null = null
  /** how long the fake server takes to answer POST /seen */
  let seenDelayMs = 0
  let notified: { title: string; body: string; tag?: string; open?: string; read?: string }[] = []
  let badges: number[] = []
  let openCb: ((p: string) => void) | null = null
  let readCb: ((t: string) => void) | null = null
  let went: string[] = []
  let narrow = false
  const live = useLocaleStore.getState().locale
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let seq = 100
  const updated = (c: Chat, notify?: 'card' | 'answer'): ServerEvent => ({ type: 'chat.updated', seq: ++seq, at: Date.now(), data: { chatId: c.id, change: 'updated', chat: c, ...(notify ? { notify } : {}) } })
  const card = (c: Chat, q = '어느 분기를 볼까요?'): ServerEvent => ({ type: 'turn.request', seq: ++seq, at: Date.now(), data: { turnId: uuidv7(), chatId: c.id, messageId: uuidv7(), request: { kind: 'ask_user', requestId: `q-${seq}`, question: q } as TurnRequest } })

  beforeEach(() => {
    saved = {}
    seenCalls = []
    onSeen = null
    seenDelayMs = 0
    notified = []
    badges = []
    went = []
    narrow = false
    openCb = null
    tellTiming.delayMs = 40
    useLocaleStore.setState({ locale: 'ko' })
    useChats.setState({ chats: [], requests: {}, chatsLoaded: true })
    useRooms.setState({ rooms: [], openRoomId: null, alerts: null })
    useUi.setState({ toasts: [], drawerOpen: false })
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as Me } })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input), 'http://team.localhost')
      if (u.pathname.endsWith('/seen')) {
        const id = u.pathname.split('/')[3]!
        seenCalls.push(id)
        // the server's chat.updated comes on the socket, after the reply (in order with the other events)
        if (onSeen) setTimeout(() => onSeen!(id), 1)
        if (seenDelayMs) await wait(seenDelayMs)
      }
      return new Response(JSON.stringify(chat()), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    stub('document', { visibilityState: 'visible', hidden: false, hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {} })
    stub('window', { matchMedia: (q: string) => ({ matches: q.includes('max-width') ? narrow : false }) })
    stub('location', { pathname: '/', assign: (to: string) => went.push(to) })
    stub('mycelDesktop', {
      bridgeVersion: 1,
      notify: (n: { title: string; body: string; tag?: string; open?: string; read?: string }) => notified.push(n),
      setBadgeCount: (n: number) => badges.push(n),
      onOpen: (cb: (p: string) => void) => { openCb = cb; return () => { openCb = null } },
      onRead: (cb: (t: string) => void) => { readCb = cb; return () => { readCb = null } },
    })
    startSessionMarkers()
    useSessionMarkers.setState({ visible: true, onScreen: null })
  })
  afterEach(() => {
    stopSessionMarkers()
    for (const [name, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, name, d)
      else delete g[name]
    }
    globalThis.fetch = realFetch
    tellTiming.delayMs = 3000
    useSessionMarkers.setState({ visible: false, onScreen: null })
    useChats.getState().reset()
    useRooms.setState({ rooms: [], openRoomId: null, alerts: null })
    useUi.setState({ toasts: [], drawerOpen: false })
    useLocaleStore.setState({ locale: live })
    useSession.getState().signedOut()
  })

  test('the chat on screen is seen while the list says it has an unseen answer, and again when the window comes back', async () => {
    const c = chat({ unseen: true })
    const plain = chat()
    useChats.setState({ chats: [c, plain] })
    useSessionMarkers.setState({ visible: false })
    useSessionMarkers.getState().setOnScreen(c.id)
    await wait(5)
    expect(seenCalls).toEqual([]) // hidden: not seen
    stopSessionMarkers()
    startSessionMarkers() // visible again (document.visibilityState is 'visible')
    await wait(5)
    expect(seenCalls).toEqual([c.id])
    // a chat with nothing unseen is not asked for
    useSessionMarkers.getState().setOnScreen(plain.id)
    await wait(5)
    expect(seenCalls).toEqual([c.id])
    // a chat not in the list (an old one opened by its address): asked for once
    const old = uuidv7()
    useSessionMarkers.getState().setOnScreen(old)
    await wait(5)
    useChats.setState({ chats: [c, plain] })
    await wait(5)
    expect(seenCalls).toEqual([c.id, old])
  })

  test('no /seen loop: the fake server replays what the server sends (MUST 1), the chat on screen with a card and an answer', async () => {
    // the fake server: /seen marks the chat seen and tells every window only when something was unseen (routes/chats.ts)
    const state = new Map<string, Chat>()
    const put = (c: Chat, notify?: 'card' | 'answer') => { state.set(c.id, c); dispatch(updated(c, notify)) }
    onSeen = (id) => {
      const c = state.get(id)!
      if (!c.unseen) return
      const next = { ...c }
      delete next.unseen
      put(next)
    }
    const c = chat({ runState: 'running' })
    useChats.setState({ chats: [c] })
    state.set(c.id, c)
    useSessionMarkers.getState().setOnScreen(c.id)
    await wait(5)
    seenCalls = []
    // a card every window shows opens (Chat.waiting, notify 'card'): no /seen for a card, nothing told on screen
    dispatch(card(c))
    put({ ...c, waiting: true }, 'card')
    await wait(20)
    expect(seenCalls).toEqual([])
    // a card this window shows alone (browser_site): the list says nothing, this window hears 'card'
    put({ ...c }, 'card')
    await wait(20)
    expect(seenCalls).toEqual([])
    // the card answered, the answer ends while the chat is on screen: one /seen, and the server's reply ends it
    put({ ...c, runState: 'idle', unseen: true, updatedAt: iso(30) }, 'answer')
    await wait(60)
    expect(seenCalls).toEqual([c.id])
    expect(useChats.getState().chats[0]!.unseen).toBeUndefined()
    // the next answer: one more
    put({ ...c, runState: 'idle', unseen: true, lastOutcome: 'error', updatedAt: iso(40) })
    await wait(60)
    expect(seenCalls).toEqual([c.id, c.id])
    expect(notified).toEqual([])
    expect(useUi.getState().toasts).toEqual([])
  })

  test('a newer answer that ends while a /seen is on its way is seen too, once that one is back', async () => {
    const c = chat({ unseen: true, updatedAt: iso(30) })
    useChats.setState({ chats: [c] })
    seenDelayMs = 60
    useSessionMarkers.getState().setOnScreen(c.id)
    await wait(5)
    expect(seenCalls).toEqual([c.id])
    // the next answer ends while the first /seen is still out (the server had not marked it yet)
    dispatch(updated({ ...c, unseen: true, updatedAt: iso(40) }))
    await wait(20)
    expect(seenCalls).toEqual([c.id])
    await wait(120)
    expect(seenCalls).toEqual([c.id, c.id])
    // and no more after that (the same state is never asked for twice)
    await wait(150)
    expect(seenCalls).toEqual([c.id, c.id])
  })

  test('no /seen loop either when a server keeps saying unseen after /seen and tells it every time (an answer dated ahead of its clock, an older server)', async () => {
    const c = chat({ unseen: true, updatedAt: iso(30) })
    useChats.setState({ chats: [c] })
    let told = 0
    onSeen = () => { if (told++ < 50) dispatch(updated({ ...c })) }
    useSessionMarkers.getState().setOnScreen(c.id)
    await wait(150)
    expect(seenCalls).toEqual([c.id])
    // the window comes back: one more go, not a loop
    useSessionMarkers.setState({ visible: false })
    stopSessionMarkers()
    startSessionMarkers()
    await wait(150)
    expect(seenCalls.length).toBeLessThanOrEqual(2)
  })

  test('a long answer that ended elsewhere: the desktop notification after the wait, one per chat; its click opens the chat', async () => {
    const c = chat({ runState: 'running', title: '주간 보고 초안' })
    useChats.setState({ chats: [c] })
    dispatch(updated({ ...c, runState: 'idle', unseen: true }, 'answer'))
    expect(notified).toEqual([])
    await wait(80)
    expect(notified).toEqual([{ title: '주간 보고 초안', body: '새 답', tag: `chat-${c.id}`, open: `/c/${c.id}` }])
    // a computer: the sidebar shows, no toast
    expect(useUi.getState().toasts).toEqual([])
    openCb!(`/c/${c.id}`)
    expect(went).toEqual([`/c/${c.id}`])
    // nothing but an app path is followed
    openCb!('https://evil.example/')
    expect(went).toEqual([`/c/${c.id}`])
  })

  test('a card that opened: told with the question; on a phone with the drawer closed also a toast with [열기]', async () => {
    narrow = true
    const c = chat({ runState: 'running', title: '경쟁사 분석' })
    useChats.setState({ chats: [c] })
    dispatch(card(c))
    dispatch(updated({ ...c, waiting: true }, 'card'))
    await wait(80)
    expect(notified).toEqual([{ title: '경쟁사 분석', body: '어느 분기를 볼까요?', tag: `chat-${c.id}`, open: `/c/${c.id}` }])
    const toasts = useUi.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ text: '경쟁사 분석', detail: '어느 분기를 볼까요?', action: { label: '열기', primary: true } })
    toasts[0]!.action!.run()
    expect(went).toEqual([`/c/${c.id}`])
  })

  test('a confidential chat: neither its title nor the AI\'s question leaves the page (review 10)', async () => {
    narrow = true
    const c = chat({ runState: 'running', title: '인수 협상 조건', confidential: true })
    useChats.setState({ chats: [c] })
    dispatch(card(c, '매각 가격을 얼마로 할까요?'))
    dispatch(updated({ ...c, waiting: true }, 'card'))
    await wait(80)
    expect(notified).toEqual([{ title: '기밀 대화', body: '답을 기다려요', tag: `chat-${c.id}`, open: `/c/${c.id}` }])
    expect(useUi.getState().toasts[0]).toMatchObject({ text: '기밀 대화', detail: '답을 기다려요' })
    expect(JSON.stringify([notified, useUi.getState().toasts])).not.toContain('인수')
  })

  test('no toast while the drawer is open (the sidebar shows); a failure and a pause say so', async () => {
    narrow = true
    useUi.setState({ drawerOpen: true })
    const a = chat({ runState: 'running' })
    const b = chat({ runState: 'running' })
    useChats.setState({ chats: [a, b] })
    dispatch(updated({ ...a, runState: 'idle', unseen: true, lastOutcome: 'error' }, 'answer'))
    dispatch(updated({ ...b, runState: 'idle', unseen: true, lastOutcome: 'paused' }, 'answer'))
    await wait(80)
    expect(useUi.getState().toasts).toEqual([])
    expect(notified.map((n) => n.body)).toEqual(['멈췄어요: 오류', '한도에서 멈췄어요'])
  })

  test('not told: a replay, a chat seen elsewhere meanwhile, a card answered meanwhile, the chat opened here, the chat on screen, a change without notify', async () => {
    const replayed = chat({ runState: 'running' })
    const seenElsewhere = chat({ runState: 'running' })
    const closed = chat({ runState: 'running' })
    const opened = chat({ runState: 'running' })
    const onScreen = chat({ runState: 'running' })
    const quiet = chat({ runState: 'running' })
    useChats.setState({ chats: [replayed, seenElsewhere, closed, opened, onScreen, quiet] })
    useSessionMarkers.getState().setOnScreen(onScreen.id)
    dispatch(updated({ ...replayed, runState: 'idle', unseen: true }, 'answer'), { replay: true })
    dispatch(updated({ ...seenElsewhere, runState: 'idle', unseen: true }, 'answer'))
    dispatch(updated({ ...closed, waiting: true }, 'card'))
    dispatch(updated({ ...opened, runState: 'idle', unseen: true }, 'answer'))
    dispatch(updated({ ...onScreen, runState: 'idle', unseen: true }, 'answer'))
    dispatch(updated({ ...quiet, runState: 'idle', unseen: true }))
    // the phone had it on screen (its /seen reached every window); the card was answered
    dispatch(updated({ ...seenElsewhere, runState: 'idle' }))
    dispatch(updated({ ...closed }))
    useSessionMarkers.getState().setOnScreen(opened.id)
    await wait(80)
    expect(notified).toEqual([])
  })

  test('a reload or a resync (the chat list read again) never tells, whatever it holds', async () => {
    useChats.setState({ chats: [] })
    useChats.setState({ chats: [chat({ unseen: true }), ask(), chat({ unseen: true, lastOutcome: 'error' })] })
    await wait(80)
    expect(notified).toEqual([])
    expect(useUi.getState().toasts).toEqual([])
  })

  test('the dock badge follows n (chats and rooms, each once), and clears when this window stops', async () => {
    expect(badges.at(-1)).toBe(0)
    const c = chat({ unseen: true })
    useChats.setState({ chats: [c, ask()] })
    useRooms.setState({ rooms: [room({ kind: 'dm', unreadCount: 2 }), room({ kind: 'team', unreadCount: 5 })] })
    expect(currentCount()).toMatchObject({ n: 3, ask: true })
    expect(badges.at(-1)).toBe(3)
    useSessionMarkers.getState().setOnScreen(c.id)
    expect(badges.at(-1)).toBe(2)
    stopSessionMarkers()
    expect(badges.at(-1)).toBe(0)
  })

  describe('rooms', () => {
    const at = (id: string) => expect.stringMatching(new RegExp(`^${id}@\\d+$`))
    const msg = (roomId: string, notice?: 'room.dm' | 'room.mention', o: Parameters<typeof message>[0] extends infer M ? Partial<M> : never = {}): ServerEvent =>
      ({ type: 'room.message', seq: ++seq, at: Date.now(), data: { roomId, message: message({ roomId, seq: seq, ...o }), ...(notice ? { notice } : {}) } })

    test('a message the server gave me a notice of: the desktop notification after the wait, one per room, its click opens the room; no toast', async () => {
      narrow = true
      const dm = room({ kind: 'dm', name: null, groupId: null, peers: [BEN], unreadCount: 2 })
      useRooms.setState({ rooms: [dm] })
      dispatch(msg(dm.id, 'room.dm'))
      dispatch(msg(dm.id))
      await wait(80)
      expect(notified).toEqual([{ title: 'Ben', body: '새 메시지가 왔어요', tag: `room-${dm.id}`, open: `/rooms/${dm.id}`, read: at(dm.id) }])
      expect(useUi.getState().toasts).toEqual([])
      openCb!(`/rooms/${dm.id}`)
      expect(went).toEqual([`/rooms/${dm.id}`])
    })

    test('my message preview on: the body is the message\'s first line (plain, one line); a private message or one with only files: the generic line', async () => {
      const dm = room({ kind: 'dm', name: null, groupId: null, peers: [BEN], unreadCount: 2 })
      const team = room({ kind: 'team', name: 'acme-design', unreadCount: 1, mentioned: true })
      const files = room({ kind: 'group', name: 'lunch', unreadCount: 1 })
      useRooms.setState({ rooms: [dm, team, files], alerts: { threadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false }, timeZone: 'UTC', messagePreview: true } })
      dispatch(msg(dm.id, 'room.dm', { body: '\n  **see** the\u202e plan\nsecond line' }))
      dispatch(msg(team.id, 'room.mention', { body: 'private words', visibility: 'private' }))
      dispatch(msg(files.id, 'room.dm', { body: '' }))
      await wait(80)
      expect(notified).toEqual([
        { title: 'Ben', body: 'see the plan', tag: `room-${dm.id}`, open: `/rooms/${dm.id}`, read: at(dm.id) },
        { title: 'acme-design', body: '나를 언급한 메시지가 있어요', tag: `room-${team.id}`, open: `/rooms/${team.id}`, read: at(team.id) },
        { title: 'lunch', body: '새 메시지가 왔어요', tag: `room-${files.id}`, open: `/rooms/${files.id}`, read: at(files.id) },
      ])
      // off: the generic line
      notified.length = 0
      useRooms.setState({ alerts: { ...useRooms.getState().alerts!, messagePreview: false } })
      dispatch(msg(dm.id, 'room.dm', { body: 'hello' }))
      await wait(80)
      expect(notified).toEqual([{ title: 'Ben', body: '새 메시지가 왔어요', tag: `room-${dm.id}`, open: `/rooms/${dm.id}`, read: at(dm.id) }])
    })

    test('"Mark as read" on the desktop notification (onRead): the room, or the thread, read up to the message; an odd token: nothing', async () => {
      const calls: unknown[][] = []
      const was = { markRead: useRooms.getState().markRead, markThreadRead: useRooms.getState().markThreadRead }
      useRooms.setState({ markRead: async (...a: unknown[]) => { calls.push(['room', ...a]) }, markThreadRead: async (...a: unknown[]) => { calls.push(['thread', ...a]) } } as never)
      try {
        const room = '01a1b10f-4c39-7478-a2d8-f2d048b335aa', root = '01a1b10f-4c39-7478-a2d8-f2d048b335bb'
        readCb!(`${room}@42`)
        readCb!(`${room}/${root}@43`)
        readCb!('../etc@1')
        readCb!(`${room}@x`)
        expect(calls).toEqual([['room', room, 42], ['thread', room, root, 43]])
        expect(readToken({ roomId: room, seq: 42 })).toBe(`${room}@42`)
        expect(readToken({ roomId: room, seq: 43, threadRootId: root })).toBe(`${room}/${root}@43`)
      } finally { useRooms.setState(was) }
    })

    test('the page never decides a notice itself (MUST 3): a DM message without the server\'s mark, a replay, one read meanwhile are not told', async () => {
      const team = room({ kind: 'team', name: 'acme-design', unreadCount: 1, mentioned: true })
      const off = room({ kind: 'dm', name: null, groupId: null, peers: [BEN], unreadCount: 3 })
      const read = room({ kind: 'group', name: 'lunch', unreadCount: 1 })
      useRooms.setState({ rooms: [team, off, read] })
      // the person's room setting off, quiet hours, one per unread run: the server sent no mark
      dispatch(msg(off.id))
      dispatch(msg(off.id, undefined, { mentions: [ME.id] }))
      dispatch(msg(team.id, 'room.mention'), { replay: true })
      dispatch(msg(read.id, 'room.dm'))
      // read on the phone meanwhile: nothing left unread
      useRooms.setState({ rooms: [team, off, { ...read, unreadCount: 0 }] })
      await wait(80)
      expect(notified).toEqual([])
      dispatch(msg(team.id, 'room.mention', { mentions: [ME.id] }))
      await wait(80)
      expect(notified).toEqual([{ title: 'acme-design', body: '나를 언급한 메시지가 있어요', tag: `room-${team.id}`, open: `/rooms/${team.id}`, read: at(team.id) }])
    })

    test('the room\'s AI waits on me (room.updated with aiWaits): told like a card, toast on a phone; not while I look at it', async () => {
      narrow = true
      const team = room({ kind: 'team', name: 'acme-design' })
      const open = room({ kind: 'team', name: 'open-room' })
      useRooms.setState({ rooms: [team, open], openRoomId: open.id })
      const upd = (r: Room): ServerEvent => ({ type: 'room.updated', seq: ++seq, at: Date.now(), data: { roomId: r.id, change: 'updated', room: r } })
      dispatch(upd({ ...team, aiWaits: true }))
      dispatch(upd({ ...open, aiWaits: true }))
      await wait(80)
      expect(notified).toEqual([{ title: 'acme-design', body: '트리나가 내 답을 기다려요', tag: `room-${team.id}`, open: `/rooms/${team.id}` }])
      expect(useUi.getState().toasts.map((x) => x.text)).toEqual(['acme-design'])
      expect(currentCount()).toMatchObject({ n: 2, ask: true, chats: 0 })
    })
  })
})
