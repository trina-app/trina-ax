// The ⌘K palette (components/SearchDialog.tsx; docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): a result of an older text
// is never shown nor opened by Enter (every source the server answers); the highlighted row stays on its row when
// results arrive above it; 대화방·사람 finds rooms and people by name, initial consonants too, rooms and DMs first, a
// person with no DM opening the new-DM list with them ticked (no DM made); files sent in rooms show after the team's
// files (4 file rows on 전체) as one line with who, where and when, and open their message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { RoomFileSearchPage, RoomSearchPage, uuidv7, type Chat, type Me, type Person, type RoomFileSearchHit, type RoomSearchHit } from '@mycel/shared/api'
import { translate, useLocaleStore } from '../../src/i18n'
import SearchDialog, { FILES_FEW, NAMED_FEW, roomFileHref, roomsAndPeople, titleFirst, wordSpans } from '../../src/components/SearchDialog'
import { usePeople } from '../../src/store/people'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { FakeEvent, installDom, mount, removeDom, type FakeElement } from './dom-host'
import { at, BEN, ME, room } from './rooms-fixtures'

setDefaultTimeout(30_000)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const me = { user: { id: ME.id, username: ME.id, name: ME.name, email: null, role: 'member', locale: 'ko', localeChoice: null, mustChangePassword: false, prefs: {} }, groups: [],
  team: { name: 'Acme', defaultLocale: 'ko' }, session: { id: '01900000-0000-7000-8000-00000000000a', client: 'web', expiresAt: '2026-12-04T00:00:00.000Z' }, server: { version: '0', dev: false } } as unknown as Me

const chat = (title: string): Chat => ({ id: uuidv7(), projectId: null, title, engine: 'claude-code', model: null, createdAt: at(-100), updatedAt: at(-5), deletedAt: null, runState: 'idle' })
const QUOTE = chat('견적서 초안'), MINUTES = chat('회의록 정리'), OTHER = chat('다른 기록')
const TEAM = room({ name: '견적 요청', activityAt: at(-1) })
const DM = room({ kind: 'dm', name: null, peers: [BEN], memberCount: 2, groupId: null, activityAt: at(-2) })
const PEOPLE: Person[] = [{ id: ME.id, name: ME.name }, { id: BEN.id, name: BEN.name }, { id: 'minhee', name: '김민희', title: '디자이너' }]
const PROJECT = { id: uuidv7(), name: '견적 프로젝트', folderPath: 'projects/quote', instructions: '', createdBy: null, createdAt: at(-500), canEdit: false }
const msgHit = (snippet: string): RoomSearchHit => ({ id: uuidv7(), roomId: TEAM.id, threadRootId: null, authorKind: 'user', author: BEN, askedBy: null, markdown: false, snippet, createdAt: at(-3) })
const fileHit = (name: string, o: Partial<RoomFileSearchHit> = {}): RoomFileSearchHit => ({
  file: { id: uuidv7(), name, size: 10, mime: 'application/pdf', kind: 'pdf', thumb: false }, messageId: uuidv7(), roomId: TEAM.id, threadRootId: null, author: BEN, createdAt: at(-4), ...o,
})
const SEARCH_ROOMS = [{ id: TEAM.id, kind: 'team', name: '견적 요청', peers: [BEN], memberCount: 3 }, { id: DM.id, kind: 'dm', name: null, peers: [BEN], memberCount: 2 }]

/** a request the test lets through when it says so */
const gates = new Map<string, () => void>()
const gate = (name: string) => new Promise<void>((ok) => gates.set(name, ok))
const open = (name: string) => act(async () => { gates.get(name)?.(); await new Promise((r) => setTimeout(r, 20)) })
let hold = new Set<string>()
const asked: string[] = []
let roomFiles: RoomFileSearchHit[] = []
let teamFiles: { name: string; path: string; type: 'file' }[] = []

const realFetch = globalThis.fetch
const locale = useLocaleStore.getState().locale
const status = useSession.getState().status
beforeAll(() => {
  installDom()
  ;(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s, supports: () => false }
  useLocaleStore.setState({ locale: 'ko' })
  useSession.setState({ status: { kind: 'signed-in', me } } as never)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const q = url.searchParams.get('q') ?? ''
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const wait = async (name: string) => { if (hold.has(name)) await gate(name) }
    switch (url.pathname) {
      case '/api/chats':
        await wait(`chats:${q}`)
        return json({ items: q.includes('견적') ? [QUOTE, OTHER] : q.includes('회의록') ? [MINUTES] : [], nextCursor: null })
      case '/api/projects': return json({ items: [PROJECT] })
      case '/api/skills': case '/api/schedules': return json({ items: [] })
      case '/api/integrations': return json({ items: [], personalAllowed: false })
      case '/api/notifications': return json({ items: [], unreadCount: 0, nextCursor: null })
      case '/api/files/find': await wait(`find:${q}`); return json({ items: teamFiles.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).map((f) => ({ ...f, size: 1, mtime: at(-9), mime: 'application/pdf', access: 'read' })), truncated: false })
      case '/api/room-files': await wait(`roomfiles:${q}`); return json(RoomFileSearchPage.parse({ items: roomFiles.filter((f) => q.split(/\s+/).every((w) => f.file.name.toLowerCase().includes(w.toLowerCase()))), rooms: SEARCH_ROOMS, nextCursor: null }))
      case '/api/room-messages':
        await wait(`messages:${q}`)
        return json(RoomSearchPage.parse({ items: q.includes('견적') ? [msgHit('견적 메시지 하나'), msgHit('견적 메시지 둘')] : [], rooms: SEARCH_ROOMS, nextCursor: null }))
      case '/api/rooms': return json({ items: [TEAM, DM] })
      case '/api/groups': return json({ items: [] })
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
beforeEach(() => {
  useRooms.setState({ rooms: [TEAM, DM], loaded: true })
  usePeople.setState({ people: PEOPLE, loaded: true, byId: Object.fromEntries(PEOPLE.map((p) => [p.id, p])), failed: false })
})
afterEach(() => {
  asked.length = 0
  hold = new Set()
  for (const ok of gates.values()) ok()
  gates.clear()
  roomFiles = []
  teamFiles = []
  useUi.setState({ searchOpen: false })
  useRooms.setState({ rooms: [], loaded: false })
  usePeople.setState({ people: null, loaded: false, byId: {}, failed: false })
})

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
  const key = (k: string) => act(async () => { input.dispatchEvent(new FakeEvent('keydown', { bubbles: true, cancelable: true, key: k })) })
  return { v, input, key }
}
const rowsIn = (section: FakeElement) => section.querySelectorAll('[role="option"]')
const selected = (v: { container: FakeElement }) => v.container.ownerDocument!.body.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-key')

describe('the helpers', () => {
  const title = (r: { name: string | null; peers: { name: string }[]; kind: string }) => (r.kind === 'dm' ? r.peers[0]!.name : r.name ?? '')
  test('rooms and DMs first, then people with no DM (never me); initials; at most NAMED_FEW', () => {
    const near = room({ name: '우리 민희 팀', activityAt: at(-9) })
    const person = (id: string, name: string): Person => ({ id, name })
    // "민희" is the whole name of a person but only inside the room's: the room still comes first
    expect(roomsAndPeople([near], [person('m', '민희')], ME.id, '민희', title).map((x) => x.name)).toEqual(['우리 민희 팀', '민희'])
    expect(roomsAndPeople([TEAM, DM], PEOPLE, ME.id, 'ㄱㅈ', title).map((x) => x.name)).toEqual(['견적 요청'])
    expect(roomsAndPeople([TEAM, DM], PEOPLE, ME.id, 'ㅁㅎ', title).map((x) => ('person' in x ? x.person.id : x.room.id))).toEqual(['minhee'])
    // Ben has a DM: the DM stands for him; I am never listed
    expect(roomsAndPeople([TEAM, DM], PEOPLE, ME.id, 'ben', title).map((x) => ('room' in x ? x.room.id : x.person.id))).toEqual([DM.id])
    expect(roomsAndPeople([TEAM, DM], PEOPLE, ME.id, ME.name, title)).toEqual([])
    const many = Array.from({ length: 6 }, (_, i) => room({ name: `acme ${i}`, activityAt: at(-i) }))
    expect(roomsAndPeople(many, [], ME.id, 'acme', title).map((x) => x.name)).toEqual(['acme 0', 'acme 1', 'acme 2'].slice(0, NAMED_FEW))
    expect(roomsAndPeople(many, [], ME.id, '  ', title)).toEqual([])
  })
  test('every word marked once; nothing marked when lower case changes the length', () => {
    expect(wordSpans('견적서를 보내드렸어요', ['보내', '견적서'])).toEqual([[0, 3], [5, 7]])
    expect(wordSpans('Acme acme', ['acme', 'cm'])).toEqual([[0, 4]])
    expect(wordSpans('İstanbul', ['stan'])).toEqual([])
  })
  test('the chat whose title has every word first', () => {
    const a = chat('다른 기록'), b = chat('견적서 보낸 날')
    expect(titleFirst([a, b], ['보낸', '견적서']).map((c) => c.id)).toEqual([b.id, a.id])
    expect(titleFirst([a, b], '견적서 받은').map((c) => c.id)).toEqual([a.id, b.id])
  })
  test('a room file opens its message (a reply in its thread)', () => {
    expect(roomFileHref({ messageId: 'm1', roomId: 'r1', threadRootId: null })).toBe('/rooms/r1?m=m1')
    expect(roomFileHref({ messageId: 'm2', roomId: 'r1', threadRootId: 't' })).toBe('/rooms/r1/t/t?m=m2')
  })
})

describe('a result of an older text', () => {
  test('is never shown, and Enter never opens it', async () => {
    const { v, input, key } = await openPalette()
    await v.type(input, '견적서')
    const chats = await v.until(() => v.find('search-section-chats'), 'the chats of 견적서')
    expect(chats.textContent).toContain('견적서 초안')
    await v.until(() => v.find('search-section-messages'), 'the messages of 견적서')
    // the next text's answers are slow: nothing of 견적서 is left in the meantime
    hold = new Set(['chats:회의록', 'messages:회의록', 'find:회의록', 'roomfiles:회의록'])
    await v.type(input, '회의록')
    expect(v.find('search-section-chats')).toBeNull()
    expect(v.find('search-section-messages')).toBeNull()
    expect(v.html()).not.toContain('견적서 초안')
    await v.settle(300)
    expect(v.html()).not.toContain('견적서 초안')
    // Enter now: whatever it opens, never the old chat
    await key('Enter')
    expect(v.get('where').textContent).not.toBe(`/c/${QUOTE.id}`)
    await v.unmount()
  })

  test('the answer of an older text that comes last changes nothing', async () => {
    const { v, input, key } = await openPalette()
    hold = new Set(['chats:견적서'])
    await v.type(input, '견적서')
    await v.settle(300)
    await v.type(input, '회의록')
    await v.until(() => v.find('search-section-chats')?.textContent?.includes('회의록 정리'), 'the chats of 회의록')
    // 견적서's answer arrives after 회의록's
    await open('chats:견적서')
    await v.settle(50)
    const chats = v.get('search-section-chats')
    expect(chats.textContent).toContain('회의록 정리')
    expect(chats.textContent).not.toContain('견적서 초안')
    await key('Enter')
    expect(v.get('where').textContent).toBe(`/c/${MINUTES.id}`)
    await v.unmount()
  })

  test('a space more or a letter in another case keeps what is there, and asks nothing again', async () => {
    const { v, input } = await openPalette()
    await v.type(input, '견적서')
    await v.until(() => v.find('search-section-chats'), 'the chats')
    await v.settle(300)
    const before = asked.filter((x) => x.startsWith('GET /api/chats?')).length
    await v.type(input, '견적서 ')
    expect(v.find('search-section-chats')).not.toBeNull()
    await v.settle(300)
    expect(asked.filter((x) => x.startsWith('GET /api/chats?')).length).toBe(before)
    await v.unmount()
  })
})

describe('the highlighted row', () => {
  test('stays on its row when results arrive above it', async () => {
    const { v, input, key } = await openPalette()
    hold = new Set(['messages:견적'])
    await v.type(input, '견적')
    // the chats and the project are there; the messages come later, between them
    await v.until(() => v.find('search-section-chats') && v.find('search-section-projects'), 'chats and projects')
    const project = `project:${PROJECT.id}`
    for (let i = 0; i < 10 && selected(v) !== project; i++) await key('ArrowDown')
    expect(selected(v)).toBe(project)
    await open('messages:견적')
    await v.until(() => v.find('search-section-messages'), 'the messages')
    expect(selected(v)).toBe(project)
    await key('Enter')
    expect(v.get('where').textContent).toBe(`/projects/${PROJECT.id}`)
    await v.unmount()
  })

  test('typing again goes back to the first row', async () => {
    const { v, input, key } = await openPalette()
    await v.type(input, '견적')
    await v.until(() => v.find('search-section-messages'), 'the messages')
    await key('ArrowDown')
    await key('ArrowDown')
    const first = () => v.container.ownerDocument!.body.querySelector('[role="option"]')?.getAttribute('data-key')
    expect(selected(v)).not.toBe(first())
    await v.type(input, '견적서')
    expect(selected(v)).toBe(first())
    await v.unmount()
  })
})

describe('대화방·사람', () => {
  test('a room by its initials, first on 전체; Enter opens it', async () => {
    const { v, input, key } = await openPalette()
    await v.type(input, 'ㄱㅈ')
    const section = await v.until(() => v.find('search-section-people'), 'the rooms and people')
    expect(section.textContent).toContain(ko('search.roomsPeople'))
    expect(rowsIn(section).map((r) => r.textContent)).toEqual(['견적 요청'])
    expect(v.container.ownerDocument!.body.querySelector('[role="option"]')!.getAttribute('data-key')).toBe(`room:${TEAM.id}`)
    await key('Enter')
    expect(v.get('where').textContent).toBe(`/rooms/${TEAM.id}`)
    await v.unmount()
  })

  test('a person with a DM opens it; one with no DM opens the new-DM list with them ticked, and makes nothing', async () => {
    let { v, input } = await openPalette()
    await v.type(input, 'ben')
    let section = await v.until(() => v.find('search-section-people'), 'Ben')
    await v.click(rowsIn(section)[0]!)
    expect(v.get('where').textContent).toBe(`/rooms/${DM.id}`)
    await v.unmount()
    ;({ v, input } = await openPalette())
    await v.type(input, 'ㅁㅎ')
    section = await v.until(() => v.find('search-section-people'), '김민희')
    expect(rowsIn(section)[0]!.textContent).toContain('김민희')
    await v.click(rowsIn(section)[0]!)
    expect(v.find('search-palette')).toBeNull()
    const count = await v.until(() => v.find('picker-count'), 'the new-DM list')
    expect(count.textContent).toBe(ko('rooms.picker.selected', { n: 1 }))
    expect(asked.some((x) => x.startsWith('POST /api/rooms'))).toBe(false)
    expect(v.get('where').textContent).toBe('/')
    await v.unmount()
  })

  test('not before anything is typed, and only on 전체', async () => {
    const { v, input } = await openPalette()
    await v.until(() => v.find('search-section-actions'), 'the empty palette')
    expect(v.find('search-section-people')).toBeNull()
    await v.click('search-tab-chats')
    await v.type(input, 'ㄱㅈ')
    await v.settle(300)
    expect(v.find('search-section-people')).toBeNull()
    await v.unmount()
  })
})

describe('files sent in rooms', () => {
  test('after the team\'s files, 4 file rows in all on 전체, each as name, who, where and when; one opens its message', async () => {
    teamFiles = [{ name: 'acme 견적.pdf', path: 'shared/acme 견적.pdf', type: 'file' }, { name: 'acme 계약.pdf', path: 'shared/acme 계약.pdf', type: 'file' }]
    roomFiles = [fileHit('acme 견적서.pdf'), fileHit('acme 도면.png', { file: { id: uuidv7(), name: 'acme 도면.png', size: 10, mime: 'image/png', kind: 'image', thumb: true } }), fileHit('acme 메모.txt', { roomId: DM.id, author: { id: ME.id, name: ME.name } })]
    const { v, input } = await openPalette()
    await v.type(input, 'acme')
    const files = await v.until(() => { const s = v.find('search-section-files'); return s && s.querySelectorAll('[data-testid="search-room-file"]').length ? s : null }, 'the files')
    const rows = rowsIn(files)
    // 4 file rows (2 team files, then 2 room files), then the file contents row
    expect(rows).toHaveLength(FILES_FEW + 1)
    expect(rows.slice(0, 2).map((r) => r.getAttribute('data-key'))).toEqual(['file:shared/acme 견적.pdf', 'file:shared/acme 계약.pdf'])
    const roomRows = files.querySelectorAll('[data-testid="search-room-file"]')
    expect(roomRows).toHaveLength(2)
    expect(roomRows[0]!.querySelector('mark')!.textContent).toBe('acme')
    expect(roomRows[0]!.querySelector('[data-testid="search-room-file-where"]')!.textContent).toMatch(/^Ben · #견적 요청 · /)
    await v.click(roomRows[0]!)
    expect(v.get('where').textContent).toBe(`/rooms/${TEAM.id}?m=${roomFiles[0]!.messageId}`)
    await v.unmount()
  })

  test('the 파일 tab shows them all; a 1:1 chat names the other person', async () => {
    roomFiles = [fileHit('acme 견적서.pdf'), fileHit('acme 메모.txt', { roomId: DM.id, author: { id: ME.id, name: ME.name } })]
    const { v, input } = await openPalette()
    await v.click('search-tab-files')
    await v.type(input, 'acme 메모')
    const files = await v.until(() => { const s = v.find('search-section-files'); return s && s.querySelectorAll('[data-testid="search-room-file"]').length ? s : null }, 'the files')
    const where = files.querySelectorAll('[data-testid="search-room-file-where"]').map((x) => x.textContent)
    expect(where).toHaveLength(1)
    expect(where[0]).toMatch(new RegExp(`^${ME.name} · ${ko('search.dm')} · Ben · `))
    await v.unmount()
  })
})
