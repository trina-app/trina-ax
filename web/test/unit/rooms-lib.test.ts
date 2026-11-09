// Pure room helpers (lib/rooms.ts): runs of one author, the "@" being typed, the members that fit it, and the parts
// of a sent text.
import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { aiMatches, aiMentionNames, eventText, groupRuns, insertMention, matchMembers, mentionAt, mentionParts, mentionsIn, mentionTokens, tokenMentions, plainLine, roomBadge, roomTitle, runActive, threadClosing, threadOpening, totalUnread, withRun, withRunPosition, withRunStep, roomStepWords } from '../../src/lib/rooms'
import { at, BEN, CY, ME, message, room } from './rooms-fixtures'

const R = uuidv7()
const day = (iso: string) => iso.slice(0, 10)

describe('runs of one author', () => {
  test('consecutive messages of one author close together share one run', () => {
    const ms = [message({ roomId: R, seq: 1 }), message({ roomId: R, seq: 2 }), message({ roomId: R, seq: 3, author: ME }), message({ roomId: R, seq: 4, author: ME }), message({ roomId: R, seq: 5 })]
    expect(groupRuns(ms, day).map((r) => r.messages.map((m) => m.seq))).toEqual([[1, 2], [3, 4], [5]])
  })

  test('a pause of more than five minutes or a new day starts a new run; only a new day is marked', () => {
    const ms = [message({ roomId: R, seq: 1, createdAt: at(0) }), message({ roomId: R, seq: 2, createdAt: at(5) }), message({ roomId: R, seq: 3, createdAt: at(11) }), message({ roomId: R, seq: 4, createdAt: at(24 * 60) })]
    const runs = groupRuns(ms, day)
    expect(runs.map((r) => r.messages.map((m) => m.seq))).toEqual([[1, 2], [3], [4]])
    expect(runs.map((r) => r.newDay)).toEqual([true, false, true])
  })

  test('two people whose accounts are gone are never one run', () => {
    const ms = [message({ roomId: R, seq: 1, author: null }), message({ roomId: R, seq: 2, author: null })]
    expect(groupRuns(ms, day)).toHaveLength(2)
  })
})

describe('@mentions', () => {
  test('the "@word" right before the caret', () => {
    expect(mentionAt('hi @be', 6)).toEqual({ start: 3, query: 'be' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('mail ada@acme.example', 21)).toBeNull()
    expect(mentionAt('@ben hi', 7)).toBeNull()
    expect(mentionAt('@ben\nhi', 7)).toBeNull()
    expect(mentionAt('no at sign', 10)).toBeNull()
  })

  test('members whose name holds the query, names that start with it first, never me', () => {
    const members = [ME, BEN, CY, { id: 'abe', name: 'Abe' }, { id: 'bea', name: 'Bea' }]
    expect(matchMembers(members, 'be', ME.id).map((m) => m.name)).toEqual(['Bea', 'Ben', 'Abe'])
    expect(matchMembers(members, '', ME.id).map((m) => m.id)).not.toContain(ME.id)
    expect(matchMembers(members, 'PARK', ME.id).map((m) => m.name)).toEqual(['Cy Park'])
    expect(matchMembers(members, '', ME.id, 2)).toHaveLength(2)
    expect(matchMembers(members, 'zz', ME.id)).toEqual([])
  })

  test('picking writes "@name "', () => {
    expect(insertMention('hi @c', 3, 5, 'Cy Park')).toEqual({ text: 'hi @Cy Park ', caret: 12 })
  })

  test('the box\'s mentions: picked people whose "@name" is whole where it was put; what is sent is exactly them', () => {
    const cy = { start: 3, end: 11, id: CY.id, name: CY.name }
    const ben = { start: 16, end: 20, id: BEN.id, name: BEN.name }
    const text = 'hi @Cy Park and @Ben'
    expect(mentionTokens(text, [cy, ben], false)).toEqual([{ start: 3, end: 11, kind: 'person', id: CY.id }, { start: 16, end: 20, kind: 'person', id: BEN.id }])
    expect(tokenMentions(mentionTokens(text, [cy, ben, { ...ben }], false))).toEqual([CY.id, BEN.id])
    // the text there changed (the range no longer holds "@Ben"): not a mention
    expect(mentionTokens('hi @Cy Park and @Bex', [cy, ben], false).map((x) => x.id)).toEqual([CY.id])
    // a letter right before the "@" pauses it (the message would show it as text, as mentionParts does)
    expect(mentionTokens('hi x@Cy Park', [{ ...cy, start: 4, end: 12 }], false)).toEqual([])
    expect(mentionTokens('hi (@Cy Park)', [{ ...cy, start: 4, end: 12 }], false)).toHaveLength(1)
    // text that only looks like a mention (pasted, typed) is none
    expect(mentionTokens('hi @Cy Park', [], false)).toEqual([])
  })

  test('"@트리나" stands out where the server takes it as a call, unless a picked person has that name', () => {
    expect(mentionTokens('@트리나 정리해 줘', [], true)).toEqual([{ start: 0, end: 4, kind: 'ai', id: '@ai' }])
    expect(mentionTokens('@트리나 정리해 줘', [], false)).toEqual([])
    expect(mentionTokens('@트리나야 안녕', [], true)).toEqual([])
    expect(mentionTokens('메일 a@트리나', [], true)).toEqual([])
    expect(mentionTokens('ask @trina, please', [], true)).toEqual([{ start: 4, end: 10, kind: 'ai', id: '@ai' }])
    // a person called 트리나 was picked: the server asks no AI for any "@트리나" of this message
    const person = { start: 0, end: 4, id: 'tri', name: '트리나' }
    expect(mentionTokens('@트리나 @트리나', [person], true)).toEqual([{ start: 0, end: 4, kind: 'person', id: 'tri' }])
    // a person whose name goes on from an AI name keeps it (the server asks no AI there either)
    expect(mentionTokens('@Trina Kim hi', [{ start: 0, end: 10, id: 'tk', name: 'Trina Kim' }], true).map((x) => x.kind)).toEqual(['person'])
    // a shorter name an AI name runs past: the call wins and the person is not sent
    const tri = mentionTokens('@트리나 hi', [{ start: 0, end: 3, id: 'tri', name: '트리' }], true)
    expect(tri).toEqual([{ start: 0, end: 4, kind: 'ai', id: '@ai' }])
    expect(tokenMentions(tri)).toEqual([])
  })

  test('a text\'s mentions as picked ones again (an edit, a send that came back), as the message marks them', () => {
    expect(mentionsIn('hi @Cy Park and @Ben', [CY, BEN])).toEqual([{ start: 3, end: 11, id: CY.id, name: CY.name }, { start: 16, end: 20, id: BEN.id, name: BEN.name }])
    expect(mentionsIn('ben@Ben', [BEN])).toEqual([])
  })

  test('a sent text: the @names of the people it mentions, the rest as plain text', () => {
    expect(mentionParts('@Cy Park see this, @Cy', [{ id: 'cy', name: 'Cy Park' }, { id: 'c', name: 'Cy' }])).toEqual([
      { text: '@Cy Park', userId: 'cy' },
      { text: ' see this, ' },
      { text: '@Cy', userId: 'c' },
    ])
    // not a mention: someone not mentioned, or inside an address
    expect(mentionParts('@Ben and ben@acme.example', [{ id: 'cy', name: 'Cy Park' }])).toEqual([{ text: '@Ben and ben@acme.example' }])
    expect(mentionParts('ben@Ben', [BEN])).toEqual([{ text: 'ben@Ben' }])
    // HTML stays text
    expect(mentionParts('<b>@Ben</b>', [BEN])).toEqual([{ text: '<b>@Ben</b>' }])
  })
})

test('titles and the tab total', () => {
  const words = { all: 'Everyone', gone: 'Unknown person' }
  expect(roomTitle(room({ name: 'acme-design' }), words)).toBe('acme-design')
  expect(roomTitle(room({ kind: 'all', name: null, groupId: null }), words)).toBe('Everyone')
  expect(roomTitle(room({ kind: 'dm', name: null, groupId: null, peers: [BEN] }), words)).toBe('Ben')
  expect(roomTitle(room({ kind: 'dm', name: null, groupId: null, peers: [] }), words)).toBe('Unknown person')
  expect(totalUnread([{ unreadCount: 2, muted: false }, { unreadCount: 0, muted: false }, { unreadCount: 5, muted: false }])).toBe(7)
  // a muted room's badge is grey and stays out of the 대화 tab's count
  expect(totalUnread([{ unreadCount: 2, muted: false }, { unreadCount: 5, muted: true }])).toBe(2)
  // "@" alone when one of them mentions me ("@2" read like two mentions)
  expect(roomBadge({ unreadCount: 2, mentioned: true })).toBe('@')
  expect(roomBadge({ unreadCount: 120, mentioned: false })).toBe('99+')
})

test("an AI answer's Markdown is one plain line in the rooms list", () => {
  expect(plainLine('## Changes\n\n- **one** and _two_\n- see [the plan](/files/view?path=a%2Fplan.md)')).toBe('Changes one and two see the plan')
  expect(plainLine('1. `code` ~~old~~ new\n> quoted')).toBe('code old new quoted')
  expect(plainLine('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2')
  // the excerpt may stop inside a link or bold
  expect(plainLine('see [the plan](/files/view?path=a%2Fpl')).toBe('see the plan')
  expect(plainLine('**광고비 합계는 3,0')).toBe('광고비 합계는 3,0')
  // not Markdown: snake_case and 2*3 stay
  expect(plainLine('file_name_here 2*3*4')).toBe('file_name_here 2*3*4')
})

// ---------------- the AI in a room ----------------
describe('the AI in a room', () => {
  test('its "@" entry fits the start of any of its names, and an empty query', () => {
    expect(aiMatches('')).toBe(true)
    expect(aiMatches('트')).toBe(true)
    expect(aiMatches('tri')).toBe(true)
    expect(aiMatches('bo')).toBe(false)
    expect(aiMentionNames('@트리나 hi').length).toBeGreaterThan(0)
    expect(aiMentionNames('no call here')).toEqual([])
  })
  test('runs: a state change keeps the steps, a step goes in its place, the queue moves a waiting run', () => {
    const base = { turnId: uuidv7(), roomId: uuidv7(), questionId: uuidv7(), state: 'queued' as const, position: 2, steps: [], error: null, createdAt: '2026-11-05T09:00:00.000Z' }
    const step = { id: 's1', kind: 'tool' as const, label: 'Read · a.md', status: 'running' as const, startedAt: base.createdAt, endedAt: null }
    let runs = withRun([], base)
    runs = withRunPosition(runs, base.turnId, 1)
    expect(runs[0]).toMatchObject({ state: 'queued', position: 1 })
    runs = withRunStep(runs, base.turnId, step)
    expect(runs[0]).toMatchObject({ state: 'running', position: 0, steps: [step] })
    runs = withRunStep(runs, base.turnId, { ...step, status: 'ok' })
    expect(runs[0]!.steps).toEqual([{ ...step, status: 'ok' }])
    runs = withRun(runs, { ...base, state: 'stopped', position: 0 })
    expect(runs[0]).toMatchObject({ state: 'stopped', steps: [{ ...step, status: 'ok' }] })
    expect(runActive(runs[0]!)).toBe(false)
  })
})

test('what my question is doing, in plain words: no search pattern or path, a document by its name only', () => {
  const s = (tool: string, label: string, kind: 'tool' | 'web_search' | 'thinking' = 'tool') => roomStepWords({ kind, tool, label })
  expect(s('glob', 'Find files "**/*경쟁*"')).toEqual({ kind: 'find' })
  expect(s('grep', 'Search "budget" · groups/marketing')).toEqual({ kind: 'find' })
  expect(s('read', '파일 읽기 · groups/마케팅팀/경쟁사/경쟁사-동향.md')).toEqual({ kind: 'read', name: '경쟁사-동향' })
  expect(s('read', 'Read · 예산.xlsx')).toEqual({ kind: 'read', name: '예산' })
  expect(s('read', 'Read')).toEqual({ kind: 'find' })
  expect(s('web_fetch', 'Fetch page · https://example.com/a')).toEqual({ kind: 'web' })
  expect(s('', 'Web search: q', 'web_search')).toEqual({ kind: 'web' })
  expect(s('make_file', 'Make file · users/a/x.docx')).toEqual({ kind: 'work' })
})

// ---------------- group chats and room names (docs/DECISIONS.md "그룹 대화와 방 이름") ----------------
describe('group chats and event lines', () => {
  const words = (loc: 'ko' | 'en' | 'ja') => ({
    all: translate(loc, 'rooms.all'), gone: translate(loc, 'rooms.goneUser'), alone: translate(loc, 'rooms.groupAlone'), sep: translate(loc, 'rooms.nameSep'),
    names: (names: string, n: number) => (n > 0 ? translate(loc, 'rooms.groupNamesMore', { names, n }) : names),
  })
  const p = (name: string) => ({ id: name.toLowerCase().replace(/[^a-z]/g, '') || 'x', name })
  test("an unnamed group chat is its other members' names, the first three and then how many more", () => {
    expect(roomTitle(room({ kind: 'group', name: null, peers: [p('가나님'), p('Ben')], memberCount: 3 }), words('ko'))).toBe('가나님, Ben')
    expect(roomTitle(room({ kind: 'group', name: null, peers: [p('A'), p('B'), p('C'), p('D')], memberCount: 9 }), words('ko'))).toBe('A, B, C 외 5명')
    expect(roomTitle(room({ kind: 'group', name: null, peers: [p('A'), p('B'), p('C'), p('D')], memberCount: 9 }), words('en'))).toBe('A, B, C and 5 more')
    expect(roomTitle(room({ kind: 'group', name: null, peers: [p('A'), p('B')], memberCount: 3 }), words('ja'))).toBe('A、B')
    expect(roomTitle(room({ kind: 'group', name: null, peers: [], memberCount: 1 }), words('ko'))).toBe('대화 상대 없음')
    // its own name wins; a team room's own name too; a DM is always the other person
    expect(roomTitle(room({ kind: 'group', name: '주간 회의', peers: [p('A'), p('B')] }), words('ko'))).toBe('주간 회의')
    expect(roomTitle(room({ kind: 'dm', name: null, peers: [BEN] }), words('ko'))).toBe('Ben')
  })

  test('event lines read as a sentence: one honorific per name, the particle fitting the last name, a quoted name', () => {
    const w = (loc: 'ko' | 'en' | 'ja') => ({ t: (k: any, params?: any) => translate(loc, k, params), nameOf: (u: { name: string } | null) => u?.name ?? '?' })
    const boss = { id: 'boss', name: '대표님' }
    const kim = { id: 'kim', name: '김민지 씨' }
    expect(eventText({ type: 'added', users: [BEN, CY] }, boss, w('ko'))).toBe('대표님이 Ben님, Cy Park님을 초대했어요')
    expect(eventText({ type: 'added', users: [BEN, boss] }, ME, w('ko'))).toBe('Ada님이 Ben님, 대표님을 초대했어요')
    expect(eventText({ type: 'added', users: [kim] }, ME, w('ko'))).toBe('Ada님이 김민지 씨를 초대했어요')
    expect(eventText({ type: 'created', users: [p('A'), p('B'), p('C'), p('D'), p('E')] }, ME, w('ko'))).toBe('Ada님이 A님, B님, C님 외 2명을 초대했어요')
    expect(eventText({ type: 'added', users: [BEN, CY] }, ME, w('en'))).toBe('Ada invited Ben, Cy Park')
    expect(eventText({ type: 'added', users: [BEN] }, ME, w('ja'))).toBe('AdaさんがBenさんを招待しました')
    expect(eventText({ type: 'renamed', name: '주간 회의' }, boss, w('ko'))).toBe("대표님이 방 이름을 '주간 회의'로 바꿨어요")
    expect(eventText({ type: 'renamed', name: '디자인팀' }, ME, w('ko'))).toBe("Ada님이 방 이름을 '디자인팀'으로 바꿨어요")
    expect(eventText({ type: 'renamed', name: 'Plan' }, ME, w('en'))).toBe('Ada renamed the chat to “Plan”')
    expect(eventText({ type: 'renamed', name: null }, ME, w('ko'))).toBe('Ada님이 방 이름을 원래대로 바꿨어요')
    expect(eventText({ type: 'left' }, boss, w('ko'))).toBe('대표님이 나갔어요')
    expect(eventText({ type: 'removed', user: kim }, boss, w('ko'))).toBe('대표님이 김민지 씨를 내보냈어요')
    expect(eventText({ type: 'removed', user: null }, ME, w('en'))).toBe('Ada removed ?')
    // a line this build cannot read: neutral, nobody named
    expect(eventText({ type: 'unknown' }, null, w('ko'))).toBe('대화방 정보가 바뀌었어요')
  })

  test('an event line is a run of its own and ends the run before it', () => {
    const ms = [message({ roomId: R, seq: 1 }), message({ roomId: R, seq: 2, author: BEN, body: '', event: { type: 'left' } }), message({ roomId: R, seq: 3 })]
    expect(groupRuns(ms, day).map((r) => r.messages.map((m) => m.seq))).toEqual([[1], [2], [3]])
  })
})

describe('thread navigation (pages/Room.tsx)', () => {
  // a browser history: entries with their state, and where we are
  type Entry = { path: string; fromRoom: boolean }
  const history = (first: Entry) => {
    const h = { entries: [first], i: 0 }
    const at = () => h.entries[h.i]!
    const threadOf = (path: string) => path.split('/t/')[1] ?? null
    return {
      at,
      open(rootId: string) {
        const to = threadOpening('R', rootId, { threadId: threadOf(at().path), fromRoom: at().fromRoom })
        const e = { path: to.path, fromRoom: to.state.fromRoom }
        if (to.replace) h.entries[h.i] = e
        else { h.entries = [...h.entries.slice(0, h.i + 1), e]; h.i++ }
      },
      close() {
        const to = threadClosing('R', at().fromRoom)
        if (to === -1) h.i--
        else h.entries[h.i] = { path: to.path, fromRoom: false }
      },
    }
  }
  test('from the room: a thread is one step forward, another thread replaces it, closing steps back to the room', () => {
    const h = history({ path: '/rooms/R', fromRoom: false })
    h.open('A')
    expect(h.at()).toEqual({ path: '/rooms/R/t/A', fromRoom: true })
    h.open('B')
    h.close()
    expect(h.at().path).toBe('/rooms/R')
  })
  test('from a link or a notice: switching threads and closing stays in the room, never steps out of it', () => {
    // a notice opened /rooms/R/t/A: an entry without the mark
    const h = history({ path: '/rooms/R/t/A', fromRoom: false })
    h.open('B')
    expect(h.at()).toEqual({ path: '/rooms/R/t/B', fromRoom: false })
    h.close()
    expect(h.at().path).toBe('/rooms/R')
  })
})
