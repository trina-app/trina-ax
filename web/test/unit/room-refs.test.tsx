// "#" rooms in the AI chat's message box (lib/roomRefs.ts, components/chat/RoomRefMenu.tsx; docs/DECISIONS.md "내 AI
// 채팅에서 대화방 읽기"): which "#word" opens the list, which rooms it lists, what picking writes, what is sent (the room's
// id with its title), a token taken whole by Backspace, the chips in a sent message, and the room steps under an answer
// in the language on screen.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { roomRefToken, type Locale, type Room, type Step } from '@mycel/shared/api'
import { roomRefTitle } from '@mycel/shared/api'
import { deleteToken, fromWire, insertRoomRef, keepPicked, matchRooms, outsideToken, roomMenuWanted, roomRefAt, tokenRanges, toWire } from '../../src/lib/roomRefs'
import { TokenLayer, WithRoomRefs } from '../../src/components/chat/RoomRefMenu'
import Steps from '../../src/components/chat/Steps'
import { translate, useLocaleStore } from '../../src/i18n'
import { installDom, mount, removeDom } from './dom-host'

const id = (n: number) => `0195f3c2-8a3e-7b1c-9d2e-${String(n).padStart(12, '0')}`
const room = (n: number, kind: Room['kind'], name: string | null, peers: string[] = [], activityAt = `2026-11-0${n}T10:00:00.000Z`): Room => ({
  id: id(n), kind, name, canRename: false, managerId: null, groupId: null, memberCount: peers.length + 1, peers: peers.map((p, i) => ({ id: `u${n}${i}`, name: p })),
  unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, createdAt: activityAt, activityAt,
})
const rooms = [room(1, 'team', '마케팅'), room(2, 'group', '주간 회의', ['김민지', '이수진']), room(3, 'dm', null, ['김민지']), room(4, 'all', null), room(5, 'team', '마케팅 디자인')]
const title = (r: Room) => (r.kind === 'dm' ? r.peers[0]!.name : r.name ?? '전체')

describe('the "#" list', () => {
  test('opens after "#" at the start or after a space; not in a word, a heading or across a line', () => {
    expect(roomRefAt('#', 1)).toEqual({ start: 0, query: '' })
    expect(roomRefAt('요약해줘 #마케', 8)).toEqual({ start: 5, query: '마케' })
    expect(roomRefAt('#주간 회', 5)).toEqual({ start: 0, query: '주간 회' })
    expect(roomRefAt('C#', 2)).toBeNull()
    expect(roomRefAt('## 제목', 2)).toBeNull()
    expect(roomRefAt('# 제목', 2)).toBeNull()
    expect(roomRefAt('#마케\n팅', 6)).toBeNull()
  })

  test('not in a confidential chat (no room is read there), nor while its state is unknown; Esc closes it for that text', () => {
    const at = roomRefAt('#', 1)
    expect(roomMenuWanted({ enabled: true, at, closedFor: null, text: '#' })).toBe(true)
    expect(roomMenuWanted({ enabled: false, at, closedFor: null, text: '#' })).toBe(false)
    expect(roomMenuWanted({ enabled: true, at, closedFor: '#', text: '#' })).toBe(false)
    expect(roomMenuWanted({ enabled: true, at: null, closedFor: null, text: 'x' })).toBe(false)
  })

  test('a title never carries an address into the message (any member names a group chat)', () => {
    expect(roomRefTitle('https://evil.example/x 공지')).toBe('https: //evil.example/x 공지')
    expect(roomRefToken(id(1), 'https://evil.example/x')).not.toContain('://')
  })

  test('filters as I type: titles, a 1:1 chat or group chat by a member\'s name; titles that start with it first', () => {
    expect(matchRooms(rooms, '', title).map((r) => r.id)).toEqual([id(5), id(4), id(3), id(2), id(1)])
    expect(matchRooms(rooms, '마케', title).map((r) => r.id)).toEqual([id(5), id(1)])
    expect(matchRooms(rooms, '디자인', title).map((r) => r.id)).toEqual([id(5)])
    expect(matchRooms(rooms, '김민지', title).map((r) => r.id)).toEqual([id(3), id(2)])
    expect(matchRooms(rooms, '주간회의', title).map((r) => r.id)).toEqual([id(2)])
    expect(matchRooms(rooms, '없는 방', title)).toEqual([])
  })
})

describe('the token', () => {
  test('picking writes "#<title> "; what is sent carries the room id; a reload gets it back', () => {
    const typed = '봐줘 #마케'
    const next = insertRoomRef(typed, 3, typed.length, '마케팅')
    expect(next).toEqual({ text: '봐줘 #마케팅 ', caret: 8 })
    const picked = [{ id: id(1), title: '마케팅' }]
    expect(toWire(next.text, picked)).toBe(`봐줘 ${roomRefToken(id(1), '마케팅')} `)
    // with a skill: the command stays in front, the room is its input
    expect(toWire('/회의록 #마케팅', picked)).toBe(`/회의록 #[마케팅](room:${id(1)})`)
    expect(fromWire(`/회의록 #[마케팅](room:${id(1)}) 정리`)).toEqual({ text: '/회의록 #마케팅 정리', picked })
    // a "#마케팅" typed by hand (never picked) or one that goes on into a word is plain text
    expect(toWire('#마케팅', [])).toBe('#마케팅')
    expect(toWire('#마케팅팀 회의', picked)).toBe('#마케팅팀 회의')
    expect(toWire('#마케팅, #마케팅!', picked)).toBe(`${roomRefToken(id(1), '마케팅')}, ${roomRefToken(id(1), '마케팅')}!`)
  })

  test('a title with brackets, double spaces or over 80 characters keeps its room (the box shows the token\'s own title)', () => {
    for (const raw of ['[공지] 마케팅', '주간  회의', 'x'.repeat(90)]) {
      const title = roomRefTitle(raw)
      const next = insertRoomRef('#', 0, 1, raw)
      const picked = [{ id: id(1), title }]
      expect(tokenRanges(next.text, picked)).toHaveLength(1)
      expect(fromWire(toWire(next.text, picked)).picked).toEqual(picked)
    }
  })

  test('rooms whose token went away are forgotten; one room per title', () => {
    const a = { id: id(1), title: '김민지' }, b = { id: id(3), title: '김민지' }
    expect(keepPicked([a], '토큰 지움')).toEqual([])
    expect(keepPicked([a], '#김민지 봐줘')).toEqual([a])
    // picking another room of the same title replaces the first (the menu keeps one per title)
    const picked = keepPicked([...[a].filter((x) => x.title !== b.title), b], '#김민지 봐줘')
    expect(toWire('#김민지 봐줘', picked)).toBe(`${roomRefToken(id(3), '김민지')} 봐줘`)
  })

  test('the longest title wins where two overlap; Backspace and Delete take a token whole; the caret never stops in one', () => {
    const picked = [{ id: id(1), title: '마케팅' }, { id: id(5), title: '마케팅 디자인' }]
    const text = '#마케팅 디자인 하고 #마케팅 봐줘'
    const ranges = tokenRanges(text, picked)
    expect(ranges.map((r) => [r.start, r.end, r.room.id])).toEqual([[0, 8, id(5)], [12, 16, id(1)]])
    expect(deleteToken(text, 8, 8, 'Backspace', ranges)).toEqual({ text: ' 하고 #마케팅 봐줘', caret: 0 })
    expect(deleteToken(text, 12, 12, 'Delete', ranges)).toEqual({ text: '#마케팅 디자인 하고  봐줘', caret: 12 })
    expect(deleteToken(text, 10, 10, 'Backspace', ranges)).toBeNull()
    expect(deleteToken(text, 2, 6, 'Backspace', ranges)).toBeNull()
    expect(outsideToken(3, ranges)).toBe(8)
    expect(outsideToken(9, ranges)).toBe(9)
  })
})

describe('in the message and the box', () => {
  test('a sent message shows its rooms as chips; the box\'s layer marks the tokens, the rest as typed', () => {
    const html = renderToStaticMarkup(<WithRoomRefs text={`요약 ${roomRefToken(id(1), '마케팅')} 부탁`} />)
    expect(html).toContain('data-testid="room-ref-chip"')
    expect(html).toContain('#마케팅')
    expect(html).not.toContain('room:')
    expect(renderToStaticMarkup(<WithRoomRefs text="그냥 #해시태그" />)).toBe('그냥 #해시태그')
    const layer = renderToStaticMarkup(<TokenLayer text={'봐줘 #마케팅 \n'} ranges={tokenRanges('봐줘 #마케팅 \n', [{ id: id(1), title: '마케팅' }])} scrollTop={0} className="pl-5" />)
    expect(layer).toContain('aria-hidden="true"')
    expect(layer).toContain('<span class="rounded-[4px] bg-accent-soft text-accent-text')
    expect(layer).toContain('>#마케팅</span>')
    expect(layer).toContain('​')
  })
})

describe('room steps under an answer', () => {
  const before = useLocaleStore.getState().locale
  beforeAll(() => installDom())
  afterAll(() => { removeDom(); useLocaleStore.setState({ locale: before }) })
  const step = (o: Partial<Step>): Step => ({ id: 's', kind: 'tool', tool: 'room_read', label: '대화방 읽기 · 마케팅', status: 'ok', startedAt: '2026-11-06T10:00:00.000Z', endedAt: '2026-11-06T10:00:01.000Z', ...o })
  const steps = [step({ id: 'a', tool: 'rooms', label: '대화방 찾기' }), step({ id: 'b' }), step({ id: 'c', tool: 'room_file', label: '대화방 파일 읽기 · 보고서.pdf' })]
  const want: Record<Locale, string[]> = {
    ko: ['대화방 찾기', '대화방 읽기 · 마케팅', '대화방 파일 읽기 · 보고서.pdf'],
    en: ['Find in conversations', 'Read conversation · 마케팅', 'Read conversation file · 보고서.pdf'],
    id: ['Cari di ruang obrolan', 'Baca ruang obrolan · 마케팅', 'Baca berkas ruang obrolan · 보고서.pdf'],
    ja: ['トークルームを探す', 'トークルームを読む · 마케팅', 'トークルームのファイルを読む · 보고서.pdf'],
    es: ['Buscar en salas de chat', 'Leer sala de chat · 마케팅', 'Leer archivo de sala de chat · 보고서.pdf'],
  }
  for (const L of Object.keys(want) as Locale[]) {
    test(`in plain words (${L})`, async () => {
      useLocaleStore.setState({ locale: L })
      const m = await mount(<Steps steps={steps} streaming={false} />)
      try {
        await m.click(m.container.querySelector('button')!)
        const text = m.html()
        for (const w of want[L]) expect(text).toContain(w)
        expect(text).toContain(translate(L, 'steps.summary', { n: 3 }))
      } finally { await m.unmount() }
    })
  }
})
