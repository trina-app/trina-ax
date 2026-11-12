// "Alice is typing…" in the web app (docs/DECISIONS.md "입력 중 표시"):
// - lib/roomTyping.ts: the words (one name, two, several; Korean with 님, a name that has one already gets none more);
//   the sender's throttle (one "typing" per ROOM_TYPING_EVERY_MS) and its "stopped" (only while a "typing" still shows).
// - store/typing.ts: a person runs out ROOM_TYPING_EXPIRES_MS after their last ping; "stopped" and their message take them
//   off at once; each place (the room's box, a thread's box) on its own.
// - lib/realtime.ts: the `room.typing` control frame reaches onTyping without taking a seq; this window's own frame is
//   never queued while disconnected.
// - RoomComposer: typing sends "typing" for its place (the room, or the thread); a send says "stopped" before the
//   message goes, emptying the box and leaving it say it too; the line over the box names the others writing in that
//   place only, never me, with aria-live polite.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { ROOM_TYPING_EVERY_MS, ROOM_TYPING_EXPIRES_MS, uuidv7, type Me } from '@mycel/shared/api'
import { RoomComposer } from '../../src/components/rooms/RoomComposer'
import { translate, useLocaleStore } from '../../src/i18n'
import { RealtimeClient, type Timers, type WsLike } from '../../src/lib/realtime'
import { setTypingOut, TypingSender, typingWords } from '../../src/lib/roomTyping'
import { useRooms } from '../../src/store/rooms'
import { useSession } from '../../src/store/session'
import { setTypingTimers, typingPlace, useTyping } from '../../src/store/typing'
import { FakeElement, FakeEvent, installDom, mount, removeDom } from './dom-host'
import { BEN, CY, ME, message, room } from './rooms-fixtures'

class FakeTimers implements Timers {
  t = 1_000_000
  q: { id: number; at: number; fn: () => void }[] = []
  n = 0
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ id, at: this.t + ms, fn }); return id }
  clearTimeout(id: unknown) { this.q = this.q.filter((x) => x.id !== id) }
  now() { return this.t }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.q.sort((a, b) => a.at - b.at)
      const next = this.q[0]
      if (!next || next.at > end) break
      this.q.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
}

const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
const ko = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('ko', k, p)

describe('the words (lib/roomTyping.ts typingWords)', () => {
  test('English: one, two, three or more; nobody is no line', () => {
    expect(typingWords(en, [])).toBeNull()
    expect(typingWords(en, ['Alice'])).toBe('Alice is typing…')
    expect(typingWords(en, ['Alice', 'Carol'])).toBe('Alice and Carol are typing…')
    expect(typingWords(en, ['Alice', 'Carol', 'Dan'])).toBe('Several people are typing…')
  })
  test('Korean: 님 after each name, none more after a name that has one', () => {
    expect(typingWords(ko, ['김소라'])).toBe('김소라님이 입력 중…')
    expect(typingWords(ko, ['김소라', '이민수'])).toBe('김소라님과 이민수님이 입력 중…')
    expect(typingWords(ko, ['a', 'b', 'c', 'd'])).toBe('여러 명이 입력 중…')
    expect(typingWords(ko, ['대표님'])).toBe('대표님이 입력 중…')
  })
})

describe('the sender (lib/roomTyping.ts TypingSender)', () => {
  test('"typing" at most every 3 s while the text changes; "stopped" once, only while it still shows', () => {
    let now = 0
    const sent: boolean[] = []
    const s = new TypingSender((on) => sent.push(on), () => now)
    s.input('h')
    s.input('he')
    now += ROOM_TYPING_EVERY_MS - 1
    s.input('hel')
    expect(sent).toEqual([true])
    now += 1
    s.input('hell')
    expect(sent).toEqual([true, true])
    // emptied: stopped at once, and only once
    s.input('   ')
    s.stop()
    expect(sent).toEqual([true, true, false])
    // typing again right after a stop says so at once
    s.input('x')
    expect(sent).toEqual([true, true, false, true])
    // a "typing" that already ran out on the receivers needs no stop
    now += ROOM_TYPING_EXPIRES_MS
    s.stop()
    expect(sent).toEqual([true, true, false, true])
    // nothing typed: nothing to stop
    new TypingSender((on) => sent.push(on), () => now).stop()
    expect(sent).toHaveLength(4)
  })
})

describe('who is typing where (store/typing.ts)', () => {
  const timers = new FakeTimers()
  beforeAll(() => setTypingTimers(timers))
  beforeEach(() => useTyping.getState().clear())
  const R = uuidv7(), ROOT = uuidv7()
  const ids = (thread: string | null) => Object.keys(useTyping.getState().byPlace[typingPlace(R, thread)] ?? {})

  test('a person runs out 5 s after their last ping; a new ping keeps them and their place in the order', () => {
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: null, userId: 'ben', typing: true })
    timers.advance(1000)
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: null, userId: 'cy', typing: true })
    expect(ids(null)).toEqual(['ben', 'cy'])
    timers.advance(ROOM_TYPING_EXPIRES_MS - 1500)
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: null, userId: 'ben', typing: true })
    timers.advance(1500)
    // cy's last ping was 5 s ago; ben pinged 1.5 s ago
    expect(ids(null)).toEqual(['ben'])
    timers.advance(ROOM_TYPING_EXPIRES_MS)
    expect(ids(null)).toEqual([])
    expect(useTyping.getState().byPlace).toEqual({})
  })

  test('a thread and the room are separate places; "stopped" and the person\'s message take them off there only', () => {
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: ROOT, userId: 'ben', typing: true })
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: null, userId: 'cy', typing: true })
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: null, userId: 'ben', typing: true })
    expect(ids(ROOT)).toEqual(['ben'])
    expect(ids(null)).toEqual(['cy', 'ben'])
    useTyping.getState().apply({ type: 'room.typing', roomId: R, threadRootId: ROOT, userId: 'ben', typing: false })
    expect(ids(ROOT)).toEqual([])
    expect(ids(null)).toEqual(['cy', 'ben'])
    // cy's message arrived in the room
    useTyping.getState().sent(R, null, 'cy')
    expect(ids(null)).toEqual(['ben'])
  })
})

class FakeSocket implements WsLike {
  readyState = 0
  sent: string[] = []
  onopen: WsLike['onopen'] = null
  onclose: WsLike['onclose'] = null
  onmessage: WsLike['onmessage'] = null
  onerror: WsLike['onerror'] = null
  send(d: string) { this.sent.push(d) }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.({}) }
  recv(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}

describe('the frame on the socket (lib/realtime.ts)', () => {
  test('room.typing reaches onTyping, takes no seq; this window\'s own is never queued while disconnected', () => {
    const sockets: FakeSocket[] = []
    const typing: unknown[] = []
    const events: unknown[] = []
    const c = new RealtimeClient({
      baseUrl: 'ws://team.localhost', windowId: () => 'w1234567', renewWindowId: () => 'w7654321',
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      onEvent: (e) => events.push(e), onReload: () => {}, onTyping: (f) => typing.push(f), timers: new FakeTimers(), random: () => 0.5,
    })
    c.start()
    const R = uuidv7()
    c.send({ type: 'room.typing', roomId: R, threadRootId: null, typing: true })
    expect(c.queued).toBe(0)
    const s = sockets[0]!
    s.open()
    s.recv({ type: 'hello', epoch: 'E1', seq: 3, resumed: false, windowId: 'w1234567', serverVersion: '1', pingIntervalMs: 20000 })
    expect(s.sent).toEqual([])
    const f = { type: 'room.typing', roomId: R, threadRootId: null, userId: 'ben', typing: true }
    s.recv(f)
    expect(typing).toEqual([f])
    expect(events).toEqual([])
    expect(c.position.seq).toBe(3)
    c.send({ type: 'room.typing', roomId: R, threadRootId: null, typing: false })
    expect(s.sent.map((x) => JSON.parse(x))).toEqual([{ type: 'room.typing', roomId: R, threadRootId: null, typing: false }])
    c.stop()
  })
})

describe('the box and its line (RoomComposer, RoomTypingLine)', () => {
  const locale = useLocaleStore.getState().locale
  const realFetch = globalThis.fetch
  const out: { roomId: string; threadRootId: string | null; typing: boolean; posted: number }[] = []
  let posts = 0
  beforeAll(() => {
    installDom()
    setTypingTimers({ now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) })
    setTypingOut((roomId, threadRootId, typing) => out.push({ roomId, threadRootId, typing, posted: posts }))
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id, name: ME.name } } as unknown as Me } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://team.localhost').pathname
      const send = path.match(/^\/api\/rooms\/([^/]+)\/messages$/)
      if (send && init?.method === 'POST') {
        posts++
        const b = JSON.parse(String(init.body)) as { clientMessageId: string; body: string }
        return new Response(JSON.stringify(message({ roomId: send[1]!, seq: 10, author: ME, body: b.body, clientMessageId: b.clientMessageId })), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    setTypingOut(() => {})
    removeDom()
  })
  beforeEach(() => {
    useLocaleStore.setState({ locale: 'en' })
    out.length = 0
    posts = 0
    useTyping.getState().clear()
  })
  afterEach(() => useLocaleStore.setState({ locale }))
  const setValue = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'value')!.set!
  async function typeIn(box: FakeElement, text: string) {
    await act(async () => {
      box.focus()
      box.dispatchEvent(new FakeEvent('focusin', { bubbles: true }))
      setValue.call(box, text)
      box.dispatchEvent(new FakeEvent('input', { bubbles: true }))
      box.dispatchEvent(new FakeEvent('keyup', { bubbles: true }))
    })
  }

  test('typing says "typing" for the room; a send says "stopped" before the message goes', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN, CY]} meId={ME.id} onSent={() => {}} />)
    const box = m.get('room-input') as FakeElement & { value: string }
    await typeIn(box, 'h')
    await typeIn(box, 'he')
    await typeIn(box, 'hello')
    // once, however many keys within 3 s
    expect(out.map((x) => [x.roomId, x.threadRootId, x.typing])).toEqual([[r.id, null, true]])
    await m.click('room-send')
    await m.until(() => posts > 0, 'the send')
    expect(out.map((x) => x.typing)).toEqual([true, false])
    // the stop went before the message
    expect(out[1]!.posted).toBe(0)
    await m.unmount()
  }, 20_000)

  test('emptying the box, leaving it and closing the room each say "stopped"', async () => {
    const r = room()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
    const m = await mount(<RoomComposer roomId={r.id} members={[ME, BEN]} meId={ME.id} onSent={() => {}} />)
    const box = m.get('room-input') as FakeElement & { value: string }
    await typeIn(box, 'draft')
    await typeIn(box, '')
    expect(out.map((x) => x.typing)).toEqual([true, false])
    await typeIn(box, 'again')
    await act(async () => { box.dispatchEvent(new FakeEvent('focusout', { bubbles: true })) })
    expect(out.map((x) => x.typing)).toEqual([true, false, true, false])
    await typeIn(box, 'once more')
    await m.unmount()
    expect(out.map((x) => x.typing)).toEqual([true, false, true, false, true, false])
  }, 20_000)

  test('a thread\'s box speaks for its thread; the line shows only who writes in that place, never me', async () => {
    const r = room()
    const root = uuidv7()
    useRooms.setState({ rooms: [r], loaded: true, openRoomId: r.id })
    const main = await mount(<RoomComposer roomId={r.id} members={[ME, BEN, CY]} meId={ME.id} onSent={() => {}} />)
    const thread = await mount(<RoomComposer roomId={r.id} threadRootId={root} members={[ME, BEN, CY]} meId={ME.id} onSent={() => {}} />)
    const lines = () => [...(globalThis.document as unknown as { body: FakeElement }).body.querySelectorAll('[data-testid="room-typing-line"]')] as FakeElement[]
    const words = () => lines().map((l) => l.textContent)
    // (the second box on the page: the thread's)
    const boxes = [...(globalThis.document as unknown as { body: FakeElement }).body.querySelectorAll('[data-testid="room-input"]')] as FakeElement[]
    expect(boxes).toHaveLength(2)
    await typeIn(boxes[1]!, 'in the thread')
    expect(out.map((x) => [x.threadRootId, x.typing])).toEqual([[root, true]])
    // the line is a polite live region, there before anyone types (so its first words are heard)
    for (const l of lines()) expect(l.getAttribute('aria-live')).toBe('polite')
    expect(words()).toEqual(['', ''])
    await act(async () => {
      useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: null, userId: BEN.id, typing: true })
      useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: root, userId: CY.id, typing: true })
      // my own other window: never shown to me
      useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: null, userId: ME.id, typing: true })
    })
    expect(words()).toEqual(['Ben is typing…', 'Cy Park is typing…'])
    await act(async () => { useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: null, userId: CY.id, typing: true }) })
    expect(words()[0]).toBe('Ben and Cy Park are typing…')
    await act(async () => { useLocaleStore.setState({ locale: 'ko' }) })
    expect(words()[0]).toBe('Ben님과 Cy Park님이 입력 중…')
    await act(async () => { useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: null, userId: 'dan', typing: true }) })
    // someone this page cannot name is left out rather than shown as an id
    expect(words()[0]).toBe('Ben님과 Cy Park님이 입력 중…')
    await act(async () => { useTyping.getState().apply({ type: 'room.typing', roomId: r.id, threadRootId: null, userId: BEN.id, typing: false }) })
    expect(words()[0]).toBe('Cy Park님이 입력 중…')
    await main.unmount()
    await thread.unmount()
  }, 20_000)
})
