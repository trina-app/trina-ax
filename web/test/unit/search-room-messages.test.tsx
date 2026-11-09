// Room messages in ⌘K (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"; components/SearchDialog.tsx): a "대화방 메시지"
// section after the chat records on the 전체 tab, its first five hits and "메시지 더 보기" (more in place, then the next
// page), each row with the sender, the room, "스레드" for a reply, the time and the text around the match marked;
// choosing one opens the room at it (a reply: its thread). And the timeline as a window around an older message
// (store/rooms.ts loadAround / loadNewer): new messages wait until it reaches the newest, sending goes back there.
// Also the 최근 section with pinned chats: the newest by date, though the list's first page starts with the pins
// (docs/DECISIONS.md "Pinned chats").
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { RoomSearchPage, uuidv7, type Chat, type Me, type RoomSearchHit } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import SearchDialog, { hitHref, hitText, MESSAGES_FEW } from '../../src/components/SearchDialog'
import { useRooms, withMessage, type RoomsData } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, mount, removeDom, type FakeElement } from './dom-host'
import { at, BEN, ME, message, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

const TEAM = uuidv7(), DM = uuidv7(), ROOT = uuidv7()
const hit = (o: Partial<RoomSearchHit> & { snippet: string }): RoomSearchHit => ({ id: uuidv7(), roomId: TEAM, threadRootId: null, authorKind: 'user', author: BEN, askedBy: null, markdown: false, createdAt: at(-5), ...o })
const HITS = [
  hit({ snippet: '견적서를 내일까지 보내드릴게요' }),
  hit({ snippet: '스레드에서 견적 다시 볼게요', threadRootId: ROOT }),
  hit({ snippet: '**견적** 정리: 세 가지', authorKind: 'ai', author: null, askedBy: ME, markdown: true }),
  hit({ snippet: 'DM 견적 하나', roomId: DM, author: ME }),
  hit({ snippet: '견적 넷' }),
  hit({ snippet: '견적 다섯' }),
  hit({ snippet: '견적 여섯' }),
]
const MORE = [hit({ snippet: '견적 다음 페이지' })]
const ROOMS = [{ id: TEAM, kind: 'team', name: 'acme-design', peers: [BEN], memberCount: 3 }, { id: DM, kind: 'dm', name: null, peers: [BEN], memberCount: 2 }]

const asked: string[] = []
/** GET /api/chats's first page (the 최근 test sets it) */
let chatList: Chat[] = []
const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s, supports: () => false }
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x')
    asked.push(`${url.pathname}${url.search}`)
    switch (url.pathname) {
      case '/api/chats': return json({ items: chatList, nextCursor: null })
      case '/api/projects': case '/api/skills': case '/api/schedules': return json({ items: [] })
      case '/api/integrations': return json({ items: [], personalAllowed: false })
      case '/api/notifications': return json({ items: [], unreadCount: 0, nextCursor: null })
      case '/api/files/find': return json({ items: [], truncated: false })
      case '/api/people': return json({ items: [] })
      case '/api/room-messages': {
        const page = url.searchParams.get('cursor') ? { items: MORE, rooms: ROOMS, nextCursor: null } : { items: url.searchParams.get('q') === 'zzz' ? [] : HITS, rooms: ROOMS, nextCursor: url.searchParams.get('q') === 'zzz' ? null : 'next-page' }
        return json(RoomSearchPage.parse(page))
      }
      default: return json({ error: { code: 'not_found', message: url.pathname } }, 404)
    }
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  useSession.setState({ status })
  removeDom()
})
afterEach(() => { asked.length = 0; chatList = []; useUi.setState({ searchOpen: false }) })

function Where() {
  const l = useLocation()
  return <span data-testid="where">{l.pathname + l.search}</span>
}
async function openPalette() {
  useUi.setState({ searchOpen: true })
  const v = await mount(
    <MemoryRouter initialEntries={['/']}>
      <SearchDialog />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  )
  const input = v.container.ownerDocument!.body.querySelector('input[role="combobox"]') as FakeElement
  return { v, input }
}
const rowsIn = (section: FakeElement) => section.querySelectorAll('[role="option"]')

describe('the helpers', () => {
  test('a hit opens its room at it, a reply its thread', () => {
    expect(hitHref({ id: 'm1', roomId: 'r1', threadRootId: null })).toBe('/rooms/r1?m=m1')
    expect(hitHref({ id: 'm2', roomId: 'r1', threadRootId: 'root' })).toBe('/rooms/r1/t/root?m=m2')
  })
  test("a hit's line: an answer's Markdown as plain text, from a little before the match", () => {
    expect(hitText({ snippet: '**견적** 정리:\n- 하나', markdown: true }, '견적')).toBe('견적 정리: 하나')
    expect(hitText({ snippet: 'a  person\'s **text** stays', markdown: false }, 'text')).toBe("a person's **text** stays")
    const long = `${'가'.repeat(80)} 견적서 끝`
    expect(hitText({ snippet: long, markdown: false }, '견적').startsWith('…')).toBe(true)
    expect(hitText({ snippet: long, markdown: false }, '견적').indexOf('견적')).toBeLessThanOrEqual(18)
    expect(hitText({ snippet: 'no match here', markdown: false }, 'zzz')).toBe('no match here')
  })
})

describe('the palette', () => {
  test('a 대화방 메시지 section: sender, room, 스레드, time and the match marked; five, then 메시지 더 보기', async () => {
    const { v, input } = await openPalette()
    expect(input.getAttribute('placeholder')).toBe(ko('search.placeholder'))
    await v.type(input, '견적')
    const section = await v.until(() => v.find('search-section-messages'), 'the messages section')
    expect(section.textContent).toContain(ko('search.messages'))
    const rows = rowsIn(section)
    expect(rows).toHaveLength(MESSAGES_FEW + 1)
    expect(rows[0]!.textContent).toContain('Ben')
    expect(rows[0]!.querySelector('[data-testid="search-message-room"]')!.textContent).toBe('#acme-design')
    expect(rows[0]!.querySelector('mark')!.textContent).toBe('견적')
    expect(rows[1]!.querySelector('[data-testid="search-message-room"]')!.textContent).toBe(`#acme-design · ${ko('search.inThread')}`)
    // the AI's answer: its name and face, the Markdown as plain text
    expect(rows[2]!.querySelector('[data-testid="ai-face"]')).not.toBeNull()
    expect(rows[2]!.querySelector('[data-testid="search-message-text"]')!.textContent).toBe('견적 정리: 세 가지')
    // a 1:1 chat: said so, with the other person when I wrote it
    expect(rows[3]!.querySelector('[data-testid="search-message-room"]')!.textContent).toBe(`${ko('search.dm')} · Ben`)
    expect(rows[MESSAGES_FEW]!.textContent).toBe(ko('search.moreMessages'))
    // 더 보기: the rest of this page, then the next one (the dialog stays)
    await v.click(rows[MESSAGES_FEW]!)
    await v.until(() => rowsIn(v.get('search-section-messages')).length === HITS.length + MORE.length, 'the second page')
    expect(asked.filter((x) => x.startsWith('/api/room-messages')).some((x) => x.includes('cursor=next-page'))).toBe(true)
    expect(v.find('search-palette')).not.toBeNull()
    expect(rowsIn(v.get('search-section-messages')).at(-1)!.textContent).toContain('견적 다음 페이지')
    await v.unmount()
  })

  test('choosing a hit opens the room at it; a reply opens its thread', async () => {
    let { v, input } = await openPalette()
    await v.type(input, '견적')
    let section = await v.until(() => v.find('search-section-messages'), 'the messages section')
    await v.click(rowsIn(section)[0]!)
    expect(v.get('where').textContent).toBe(`/rooms/${TEAM}?m=${HITS[0]!.id}`)
    expect(v.find('search-palette')).toBeNull()
    await v.unmount()
    ;({ v, input } = await openPalette())
    await v.type(input, '견적')
    section = await v.until(() => v.find('search-section-messages'), 'the messages section')
    await v.click(rowsIn(section)[1]!)
    expect(v.get('where').textContent).toBe(`/rooms/${TEAM}/t/${ROOT}?m=${HITS[1]!.id}`)
    await v.unmount()
  })

  test('nothing found: no section (the file contents row stays); other tabs do not ask', async () => {
    const { v, input } = await openPalette()
    await v.type(input, 'zzz')
    await v.until(() => asked.some((x) => x.startsWith('/api/room-messages?q=zzz')), 'the search')
    await v.until(() => v.find('search-section-files'), 'the file contents row')
    await v.settle(100)
    expect(v.find('search-section-messages')).toBeNull()
    expect(v.find('search-messages-failed')).toBeNull()
    asked.length = 0
    await v.click('search-tab-projects')
    await v.settle(300)
    expect(asked.filter((x) => x.startsWith('/api/room-messages'))).toEqual([])
    await v.unmount()
  })
})

describe('최근 with pinned chats', () => {
  test('the newest chats by date, not the pins the first page starts with', async () => {
    const chat = (title: string, updatedAt: string, pinnedAt?: string): Chat => ({ id: uuidv7(), projectId: null, title, engine: 'claude-code', model: null, createdAt: at(-9000), updatedAt, deletedAt: null, runState: 'idle', ...(pinnedAt ? { pinnedAt } : {}) })
    // nine old pins first, as the server sends them, then the three newest chats
    chatList = [...Array.from({ length: 9 }, (_, i) => chat(`고정 ${i + 1}`, at(-5000 - i), at(-10 - i))), chat('새 기록 1', at(-3)), chat('새 기록 2', at(-4)), chat('새 기록 3', at(-5))]
    const { v } = await openPalette()
    const section = await v.until(() => v.find('search-section-recents'), 'the recents section')
    const rows = rowsIn(section).map((r) => r.textContent ?? '')
    expect(rows.slice(0, 3).map((x) => x.match(/새 기록 \d/)?.[0])).toEqual(['새 기록 1', '새 기록 2', '새 기록 3'])
    await v.unmount()
  })
})

describe('the timeline as a window around an older message', () => {
  const data = (o: Partial<RoomsData> = {}): RoomsData => ({ rooms: [], openRoomId: null, timeline: null, threadViews: {}, ...o })
  test('a new message is not added to a window that does not reach the newest; it is once it does', () => {
    const r = room()
    const old = message({ roomId: r.id, seq: 5 })
    const fresh = message({ roomId: r.id, seq: 900 })
    const window = { roomId: r.id, messages: [old], nextCursor: 'older', newerCursor: 'newer', loading: false, error: null }
    let d = withMessage(data({ rooms: [r], openRoomId: r.id, timeline: window }), r.id, fresh, ME.id)
    expect(d.timeline!.messages.map((m) => m.seq)).toEqual([5])
    // the room's list line still moves
    expect(d.rooms[0]!.lastMessage?.id).toBe(fresh.id)
    d = withMessage(data({ rooms: [r], openRoomId: r.id, timeline: { ...window, newerCursor: null } }), r.id, fresh, ME.id)
    expect(d.timeline!.messages.map((m) => m.seq)).toEqual([5, 900])
  })

  test('loadAround, loadNewer to the newest, and a send from the window goes back to the newest', async () => {
    const r = room()
    const pages: Record<string, unknown> = {
      around: { items: [message({ roomId: r.id, seq: 10 }), message({ roomId: r.id, seq: 11 })], nextCursor: 'o1', newerCursor: 'n1' },
      n1: { items: [message({ roomId: r.id, seq: 12 })], nextCursor: null, newerCursor: null },
      newest: { items: [message({ roomId: r.id, seq: 50 })], nextCursor: 'o9' },
    }
    const calls: string[] = []
    const prev = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (init?.method === 'POST') return json({ error: { code: 'internal', message: 'not here' } }, 500)
      const key = url.searchParams.get('around') ? 'around' : url.searchParams.get('cursor') ?? 'newest'
      return json(pages[key])
    }) as typeof fetch
    try {
      useRooms.setState({ rooms: [r], openRoomId: r.id, timeline: { roomId: r.id, messages: [], nextCursor: null, loading: false, error: null } })
      const target = (pages.around as { items: { id: string }[] }).items[0]!.id
      await useRooms.getState().loadAround(r.id, target)
      expect(calls.at(-1)).toContain(`around=${target}`)
      expect(useRooms.getState().timeline).toMatchObject({ nextCursor: 'o1', newerCursor: 'n1' })
      await useRooms.getState().loadNewer(r.id)
      expect(useRooms.getState().timeline!.messages.map((m) => m.seq)).toEqual([10, 11, 12])
      expect(useRooms.getState().timeline!.newerCursor).toBeNull()
      // back in a window, a send goes to the newest
      useRooms.setState((s) => ({ timeline: { ...s.timeline!, newerCursor: 'n1' } }))
      useRooms.getState().send(r.id, { body: 'hi', mentions: [], files: [] })
      await new Promise((ok) => setTimeout(ok, 30))
      expect(calls.some((c) => c === `GET /api/rooms/${r.id}/messages?limit=50`)).toBe(true)
      expect(useRooms.getState().timeline!.messages.map((m) => m.seq)).toEqual([50])
      expect(useRooms.getState().timeline!.newerCursor ?? null).toBeNull()
    } finally {
      globalThis.fetch = prev
      useRooms.setState({ rooms: [], openRoomId: null, timeline: null, pending: {} })
    }
  })
})
