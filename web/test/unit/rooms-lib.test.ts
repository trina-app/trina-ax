// Pure room helpers (lib/rooms.ts): runs of one author, the "@" being typed, the members that fit it, and the parts
// of a sent text.
import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { aiMatches, aiMentionNames, groupRuns, insertMention, keptMentions, matchMembers, mentionAt, mentionParts, roomTitle, runActive, totalUnread, withRun, withRunPosition, withRunStep, roomStepWords } from '../../src/lib/rooms'
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

  test('picking writes "@name " and only names still in the text are sent', () => {
    expect(insertMention('hi @c', 3, 5, 'Cy Park')).toEqual({ text: 'hi @Cy Park ', caret: 12 })
    expect(keptMentions('hi @Cy Park and @Ben', [CY, BEN, BEN])).toEqual([CY.id, BEN.id])
    expect(keptMentions('hi Ben', [BEN])).toEqual([])
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
  expect(totalUnread([{ unreadCount: 2 }, { unreadCount: 0 }, { unreadCount: 5 }])).toBe(7)
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
