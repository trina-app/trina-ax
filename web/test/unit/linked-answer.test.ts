// A notice, a push tap or a link that opens a thread shows what the thread is under in the middle, as Slack does: the
// room's timeline goes to the thread's first message (lib/rooms.ts timelineTarget), a chat to the answer its thread is
// under, reading older pages to find it (lib/linkedAnswer.ts). A thread opened by a click in the room or the chat leaves
// the middle as it was. A phone notification's path names the message as /m/<id> (no query): the same place as ?m=.
import { describe, expect, test } from 'bun:test'
import { highlightNow, pushedMessagePath, timelineTarget } from '../../src/lib/rooms'
import { LINKED_PAGES, focusInPlace, linkedAnswer, linkedStep } from '../../src/lib/linkedAnswer'
import { roomNoticeLink } from '../../src/components/settings/RoomNoticeRow'

const ROOM = '019a5f00-0000-7000-8000-000000000001'
const ROOT = '019a5f00-0000-7000-8000-000000000002'
const REPLY = '019a5f00-0000-7000-8000-000000000003'

describe("the room's timeline target", () => {
  test('no thread open: the message the link points at, or none', () => {
    expect(timelineTarget({ threadId: null, target: REPLY, openedHere: false })).toBe(REPLY)
    expect(timelineTarget({ threadId: null, target: null, openedHere: false })).toBeNull()
  })
  test("a thread from an Activity row (?m= is the reply): the thread's first message in the room, not the reply", () => {
    expect(timelineTarget({ threadId: ROOT, target: REPLY, openedHere: false })).toBe(ROOT)
  })
  test('a thread from a push tap or a bare link (no ?m=): its first message too', () => {
    expect(timelineTarget({ threadId: ROOT, target: null, openedHere: false })).toBe(ROOT)
  })
  test('a thread opened by a click in this room: the room stays as it was', () => {
    expect(timelineTarget({ threadId: ROOT, target: null, openedHere: true })).toBeNull()
    expect(timelineTarget({ threadId: ROOT, target: REPLY, openedHere: true })).toBeNull()
  })
  test("an Activity row's link names the thread and the reply, which the room reads as the thread's root", () => {
    const link = new URL(roomNoticeLink({ id: ROOM, thread: ROOT, message: REPLY }), 'https://team.example')
    const threadId = /\/t\/([^/]+)$/.exec(link.pathname)![1]!
    expect(timelineTarget({ threadId, target: link.searchParams.get('m'), openedHere: false })).toBe(ROOT)
  })
})

describe("a phone notification's path to a message", () => {
  test('/rooms/<room>/m/<message> is the room at that message', () => {
    expect(pushedMessagePath(ROOM, null, REPLY)).toBe(`/rooms/${ROOM}?m=${REPLY}`)
  })
  test('/rooms/<room>/t/<root>/m/<reply> is the thread at that reply', () => {
    expect(pushedMessagePath(ROOM, ROOT, REPLY)).toBe(`/rooms/${ROOM}/t/${ROOT}?m=${REPLY}`)
  })
  test('a message id that is not one (or the root itself): the room or the thread alone', () => {
    expect(pushedMessagePath(ROOM, null, 'evil')).toBe(`/rooms/${ROOM}`)
    expect(pushedMessagePath(ROOM, ROOT, '../x')).toBe(`/rooms/${ROOM}/t/${ROOT}`)
    expect(pushedMessagePath(ROOM, ROOT, ROOT)).toBe(`/rooms/${ROOM}/t/${ROOT}`)
  })
})

describe("a chat's linked answer", () => {
  test("a thread opened from outside the chat (Activity, a push, a link, a shared chat's notice): its answer", () => {
    expect(linkedAnswer(ROOT, false)).toBe(ROOT)
  })
  test('a thread opened in the chat, or no thread: none', () => {
    expect(linkedAnswer(ROOT, true)).toBeNull()
    expect(linkedAnswer(null, false)).toBeNull()
  })
  test('on the page: show; further back: read older pages, up to LINKED_PAGES; then leave the chat where it is', () => {
    expect(linkedStep({ id: ROOT, ids: ['a', ROOT, 'b'], hasOlder: true, tries: 0 })).toBe('show')
    expect(linkedStep({ id: ROOT, ids: ['a', 'b'], hasOlder: true, tries: 0 })).toBe('older')
    expect(linkedStep({ id: ROOT, ids: ['a', 'b'], hasOlder: true, tries: LINKED_PAGES - 1 })).toBe('older')
    expect(linkedStep({ id: ROOT, ids: ['a', 'b'], hasOlder: true, tries: LINKED_PAGES })).toBe('none')
    // the start of the chat reached (or another version of it: the thread panel says which)
    expect(linkedStep({ id: ROOT, ids: ['a', 'b'], hasOlder: false, tries: 0 })).toBe('none')
  })
})

describe('a linked message is picked out once for each place in the history', () => {
  test('back at the place that pointed at it (a thread opened there by a click, then closed): the room stays put', () => {
    const seen = new Set<string>()
    expect(highlightNow(seen, REPLY, 'k1')).toBe(true)
    // a thread opened by a click in the room: nothing to pick out
    expect(highlightNow(seen, null, 'k2')).toBe(false)
    // closed: one step back, to the same place (the same key), ?m= still in it
    expect(highlightNow(seen, REPLY, 'k1')).toBe(false)
  })
  test('the same notice clicked again (a new place): picked out again', () => {
    const seen = new Set<string>()
    expect(highlightNow(seen, REPLY, 'k1')).toBe(true)
    expect(highlightNow(seen, REPLY, 'k3')).toBe(true)
  })
})

describe('closing a chat thread', () => {
  test('the focus goes back to the answer without scrolling the chat to it', () => {
    const calls: unknown[] = []
    focusInPlace({ focus: (o: unknown) => calls.push(o) } as unknown as HTMLElement)
    expect(calls).toEqual([{ preventScroll: true }])
    expect(() => focusInPlace(null)).not.toThrow()
  })
})
