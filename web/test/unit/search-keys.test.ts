// ⌘K and ⌘F, the Slack way (web/src/lib/searchKeys.ts; docs/decisions/20261120-search-shortcuts-slack.md): which key
// opens search, where ⌘F opens it on "This conversation", where it stays the browser's find, the second press, a Mac's
// Ctrl, Korean input (e.key 'ㄹ' with e.code 'KeyF'), and the unread rows of an empty search.
import { describe, expect, test } from 'bun:test'
import { keyLetter, nativeFindPath, roomOfPath, searchShortcut, type SearchKeyEvent, type SearchKeyState } from '../../src/lib/searchKeys'
import { unreadRooms } from '../../src/components/SearchDialog'

const ROOM = '01900000-0000-7000-8000-0000000000aa'
const MSG = '01900000-0000-7000-8000-0000000000bb'
const key = (k: string, o: Partial<SearchKeyEvent> = {}): SearchKeyEvent => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : undefined, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...o })
const at = (path: string, o: Partial<SearchKeyState> = {}): SearchKeyState => ({ open: false, dialog: false, path, reading: false, mac: true, ...o })
const cmd = (k: string, o: Partial<SearchKeyEvent> = {}) => key(k, { metaKey: true, ...o })

describe('⌘K', () => {
  test('opens search anywhere, ⌘ or Ctrl, over another dialog too; open already: focus', () => {
    for (const path of ['/', `/rooms/${ROOM}`, '/c/abc', '/files/view', '/settings']) expect(searchShortcut(cmd('k'), at(path))).toEqual({ do: 'open' })
    expect(searchShortcut(key('k', { ctrlKey: true }), at('/', { mac: true }))).toEqual({ do: 'open' })
    expect(searchShortcut(key('K', { ctrlKey: true }), at('/', { mac: false }))).toEqual({ do: 'open' })
    expect(searchShortcut(cmd('k'), at('/', { dialog: true }))).toEqual({ do: 'open' })
    expect(searchShortcut(cmd('k'), at('/', { open: true }))).toEqual({ do: 'focus' })
    expect(searchShortcut(key('k'), at('/'))).toEqual({ do: 'pass' })
  })
})

describe('⌘F', () => {
  test('a room, a DM or group chat (same route) and a thread: open with This conversation', () => {
    expect(searchShortcut(cmd('f'), at(`/rooms/${ROOM}`))).toEqual({ do: 'open', here: ROOM })
    expect(searchShortcut(cmd('f'), at(`/rooms/${ROOM}/t/${MSG}`))).toEqual({ do: 'open', here: ROOM })
  })
  test('where the page has its own text: the browser\'s find', () => {
    for (const path of ['/c/abc', `/c/abc/t/${MSG}`, '/files/view', '/f/xyz', '/f/batch/xyz']) expect(searchShortcut(cmd('f'), at(path)), path).toEqual({ do: 'pass' })
    // a file or artifact open in the side panel, in a room too
    expect(searchShortcut(cmd('f'), at(`/rooms/${ROOM}`, { reading: true }))).toEqual({ do: 'pass' })
  })
  test('anywhere else: as ⌘K', () => {
    for (const path of ['/', '/rooms', '/files', '/activity', '/projects/p1', '/scheduled']) expect(searchShortcut(cmd('f'), at(path)), path).toEqual({ do: 'open' })
  })
  test('the second press focuses the open box (no page find over it); another dialog: nothing', () => {
    expect(searchShortcut(cmd('f'), at(`/rooms/${ROOM}`, { open: true }))).toEqual({ do: 'focus' })
    expect(searchShortcut(cmd('f'), at('/c/abc', { open: true }))).toEqual({ do: 'focus' })
    expect(searchShortcut(cmd('f'), at(`/rooms/${ROOM}`, { dialog: true }))).toEqual({ do: 'pass' })
  })
  test('a Mac: only ⌘ (Ctrl+F moves the caret); elsewhere only Ctrl; Shift or Alt: nothing', () => {
    expect(searchShortcut(key('f', { ctrlKey: true }), at('/', { mac: true }))).toEqual({ do: 'pass' })
    expect(searchShortcut(key('f', { metaKey: true, ctrlKey: true }), at('/', { mac: true }))).toEqual({ do: 'pass' })
    expect(searchShortcut(key('f', { ctrlKey: true }), at('/', { mac: false }))).toEqual({ do: 'open' })
    expect(searchShortcut(key('f', { metaKey: true }), at('/', { mac: false }))).toEqual({ do: 'pass' })
    expect(searchShortcut(cmd('f', { shiftKey: true }), at('/'))).toEqual({ do: 'pass' })
    expect(searchShortcut(cmd('f', { altKey: true }), at('/'))).toEqual({ do: 'pass' })
    expect(searchShortcut(key('f'), at('/'))).toEqual({ do: 'pass' })
    // ⌘G stays the desktop app's Find Next
    expect(searchShortcut(cmd('g'), at(`/rooms/${ROOM}`))).toEqual({ do: 'pass' })
  })
})

describe('Korean and other input methods', () => {
  test('a letter of the input source falls back to the key\'s place; nothing while composing', () => {
    expect(keyLetter({ key: 'ㄹ', code: 'KeyF' })).toBe('f')
    expect(keyLetter({ key: 'ㅏ', code: 'KeyK' })).toBe('k')
    expect(keyLetter({ key: 'F', code: 'KeyF' })).toBe('f')
    expect(keyLetter({ key: 'Process', code: 'Digit1' })).toBe('')
    expect(searchShortcut(cmd('ㄹ', { code: 'KeyF' }), at(`/rooms/${ROOM}`))).toEqual({ do: 'open', here: ROOM })
    expect(searchShortcut(cmd('ㅏ', { code: 'KeyK' }), at('/c/abc'))).toEqual({ do: 'open' })
    expect(searchShortcut(cmd('f', { isComposing: true }), at(`/rooms/${ROOM}`))).toEqual({ do: 'pass' })
    expect(searchShortcut(cmd('k', { isComposing: true }), at('/'))).toEqual({ do: 'pass' })
  })
})

describe('paths', () => {
  test('roomOfPath and nativeFindPath', () => {
    expect(roomOfPath(`/rooms/${ROOM}`)).toBe(ROOM)
    expect(roomOfPath(`/rooms/${ROOM}/t/${MSG}`)).toBe(ROOM)
    expect(roomOfPath('/rooms')).toBeNull()
    expect(nativeFindPath('/c/x')).toBe(true)
    expect(nativeFindPath('/files')).toBe(false)
  })
})

describe('unread rows of an empty search', () => {
  const r = (id: string, o: Partial<{ unreadCount: number; mentioned: boolean; muted: boolean; hidden: true; activityAt: string }> = {}) =>
    ({ id, unreadCount: 2, mentioned: false, muted: false, activityAt: '2026-11-20T00:00:00.000Z', ...o })
  test('at most 3; muted and hidden ones out; mentions first, then the latest', () => {
    const rooms = [
      r('old', { activityAt: '2026-11-18T00:00:00.000Z' }), r('new', { activityAt: '2026-11-20T01:00:00.000Z' }), r('read', { unreadCount: 0 }),
      r('muted', { muted: true, mentioned: true }), r('hidden', { hidden: true }), r('ment', { mentioned: true, activityAt: '2026-11-01T00:00:00.000Z' }), r('mid'),
    ]
    expect(unreadRooms(rooms).map((x) => x.id)).toEqual(['ment', 'new', 'mid'])
    expect(unreadRooms([r('read', { unreadCount: 0 })])).toEqual([])
  })
})
