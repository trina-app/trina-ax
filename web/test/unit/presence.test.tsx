// Online status in the web app (docs/DECISIONS.md "접속 상태"):
// - lib/presence.ts: this window's activity. A computer goes idle after 10 minutes without input and is in use again at
//   the next input or when the page comes back; a phone is idle as soon as the page is hidden and in use when visible.
//   Only changes are sent (many inputs send nothing more), and the current state again after each hello.
// - lib/realtime.ts: the `presence` control frame reaches onPresence (it is no event: no seq is taken); this window's
//   own `presence` frame is never queued while disconnected (a browser result still is).
// - store/presence.ts: the whole list replaces, changes merge, offline takes a person out.
// - components/Presence.tsx and RoomIcon: a filled dot while online, a hollow one while away, none while offline; the
//   words after the name for screen readers (offline only where asked) and as a tooltip on a computer; a DM's picture
//   has the dot, a group chat's and the AI's never.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Room, WindowActivity } from '@mycel/shared/api'
import { ActivityTracker, IDLE_AFTER_MS, type ActivityEnv } from '../../src/lib/presence'
import { RealtimeClient, type Timers, type WsLike } from '../../src/lib/realtime'
import { usePresence } from '../../src/store/presence'
import { PresenceFace, PresenceText } from '../../src/components/Presence'
import { RoomIcon } from '../../src/components/rooms/RoomIcon'
import { AiFace } from '../../src/components/rooms/AiFace'
import { TOOLTIP_DELAY_MS } from '../../src/components/Tooltip'
import { useLocaleStore } from '../../src/i18n'
import { FakeEvent, installDom, mount, removeDom } from './dom-host'

class FakeTimers implements Timers {
  t = 0
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

function tracker(phone: boolean) {
  const timers = new FakeTimers()
  let visible = true
  const sent: WindowActivity[] = []
  const env: ActivityEnv = { now: () => timers.now(), setTimeout: (f, ms) => timers.setTimeout(f, ms), clearTimeout: (id) => timers.clearTimeout(id), visible: () => visible, phone }
  const t = new ActivityTracker((s) => sent.push(s), env)
  return { t, timers, sent, show: (v: boolean) => { visible = v; t.visibility() } }
}

describe('this window\'s activity (lib/presence.ts)', () => {
  test('a computer: idle after 10 minutes without input, in use at the next input; only changes are sent', () => {
    const a = tracker(false)
    expect(a.t.current).toBe('active')
    expect(a.sent).toEqual([])
    // input keeps it in use; the pointer moving many times a second sends nothing
    for (let i = 0; i < 50; i++) { a.timers.advance(100); a.t.input() }
    a.timers.advance(IDLE_AFTER_MS - 1000)
    expect(a.sent).toEqual([])
    a.timers.advance(2000)
    expect(a.sent).toEqual(['idle'])
    // more time changes nothing
    a.timers.advance(IDLE_AFTER_MS * 3)
    expect(a.sent).toEqual(['idle'])
    a.t.input()
    a.t.input()
    expect(a.sent).toEqual(['idle', 'active'])
  })

  test('a computer: a hidden page is not idle by itself; 10 minutes on it is; coming back is in use', () => {
    const a = tracker(false)
    a.show(false)
    a.timers.advance(60_000)
    expect(a.sent).toEqual([])
    a.timers.advance(IDLE_AFTER_MS)
    expect(a.sent).toEqual(['idle'])
    a.show(true)
    expect(a.sent).toEqual(['idle', 'active'])
  })

  test('a phone: hidden is idle at once, visible is in use, whatever the time since the last touch', () => {
    const a = tracker(true)
    a.timers.advance(IDLE_AFTER_MS * 2)
    expect(a.sent).toEqual([])
    a.show(false)
    expect(a.sent).toEqual(['idle'])
    a.show(true)
    expect(a.sent).toEqual(['idle', 'active'])
  })

  test('after each hello the current state goes again; nothing after stop', () => {
    const a = tracker(false)
    a.t.connected()
    expect(a.sent).toEqual(['active'])
    a.timers.advance(IDLE_AFTER_MS + 100)
    a.t.connected()
    expect(a.sent).toEqual(['active', 'idle', 'idle'])
    a.t.stop()
    a.t.input()
    a.t.connected()
    expect(a.sent).toEqual(['active', 'idle', 'idle'])
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

describe('the presence frame on the socket (lib/realtime.ts)', () => {
  test('the list and its changes reach onPresence, take no seq; this window\'s own state is never queued', () => {
    const sockets: FakeSocket[] = []
    const frames: unknown[] = []
    const events: unknown[] = []
    const c = new RealtimeClient({
      baseUrl: 'ws://team.localhost', windowId: () => 'w1234567', renewWindowId: () => 'w7654321',
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      onEvent: (e) => events.push(e), onReload: () => {}, onPresence: (f) => frames.push(f), timers: new FakeTimers(), random: () => 0.5,
    })
    c.start()
    // not open yet: the state is dropped (it goes again after hello), a browser result waits
    c.send({ type: 'presence', state: 'idle' })
    c.send({ type: 'browser.ack', callId: 'c1' })
    expect(c.queued).toBe(1)
    const s = sockets[0]!
    s.open()
    s.recv({ type: 'hello', epoch: 'E1', seq: 3, resumed: false, windowId: 'w1234567', serverVersion: '1', pingIntervalMs: 20000 })
    expect(s.sent.map((x) => JSON.parse(x).type)).toEqual(['browser.ack'])
    s.recv({ type: 'presence', full: true, people: [{ id: 'bob', state: 'online' }] })
    s.recv({ type: 'presence', full: false, people: [{ id: 'bob', state: 'away' }] })
    expect(frames).toEqual([{ type: 'presence', full: true, people: [{ id: 'bob', state: 'online' }] }, { type: 'presence', full: false, people: [{ id: 'bob', state: 'away' }] }])
    expect(events).toEqual([])
    expect(c.position.seq).toBe(3)
    // open: it goes at once
    c.send({ type: 'presence', state: 'active' })
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ type: 'presence', state: 'active' })
    c.stop()
  })
})

describe('the store (store/presence.ts)', () => {
  test('the whole list replaces, changes merge, offline takes a person out', () => {
    usePresence.getState().apply({ type: 'presence', full: true, people: [{ id: 'bob', state: 'online' }, { id: 'cho', state: 'away' }] })
    usePresence.getState().apply({ type: 'presence', full: false, people: [{ id: 'cho', state: 'online' }, { id: 'dan', state: 'away' }] })
    expect(usePresence.getState().byId).toEqual({ bob: 'online', cho: 'online', dan: 'away' })
    usePresence.getState().apply({ type: 'presence', full: false, people: [{ id: 'bob', state: 'offline' }] })
    expect(usePresence.getState().byId).toEqual({ cho: 'online', dan: 'away' })
    usePresence.getState().apply({ type: 'presence', full: true, people: [] })
    expect(usePresence.getState().byId).toEqual({})
    usePresence.getState().clear()
  })
})

const locale = useLocaleStore.getState().locale
const media = (fine: boolean) => {
  ;(window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: fine && q.includes('fine'), addEventListener() {}, removeEventListener() {} } as never)
}
const realFetch = globalThis.fetch
beforeAll(() => {
  installDom()
  useLocaleStore.setState({ locale: 'ko' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ people: [] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
})
afterEach(() => {
  usePresence.getState().clear()
  media(false)
})
afterAll(() => {
  globalThis.fetch = realFetch
  useLocaleStore.setState({ locale })
  removeDom()
})

const BOB = { id: 'bob', name: 'Bob' }
const room = (kind: Room['kind'], peers = [BOB]) => ({
  id: '01900000-0000-7000-8000-0000000000d1', kind, name: kind === 'group' ? '디자인 리뷰' : null, peers, memberCount: peers.length + 1,
}) as unknown as Room
const set = (state: 'online' | 'away' | 'offline') => act(() => usePresence.getState().apply({ type: 'presence', full: true, people: state === 'offline' ? [] : [{ id: 'bob', state }] }))
const fire = (el: unknown, type: string, o: Record<string, unknown> = {}) => act(() => { (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(Object.assign(new FakeEvent(type, { bubbles: true, cancelable: true }), o)) })

describe('the dot (components/Presence.tsx)', () => {
  test('online: a filled dot; away: a hollow one; offline: none; the words after the name', async () => {
    const page = await mount(<span data-testid="row"><PresenceFace user={BOB} size={20} /><span>Bob</span><PresenceText userId="bob" /></span>)
    try {
      const face = () => page.get('presence-face')
      expect(face().getAttribute('data-presence')).toBe('offline')
      expect(page.find('presence-dot')).toBeNull()
      // in a list, offline is not said
      expect(page.find('presence-text')).toBeNull()
      await set('online')
      expect(face().getAttribute('data-presence')).toBe('online')
      const dot = page.get('presence-dot')
      expect(dot.getAttribute('data-presence-dot')).toBe('online')
      expect(dot.getAttribute('class')).toContain('presence-dot')
      // 8 px on a 20 px picture, on its lower right
      expect((dot as unknown as { style: { width: string } }).style.width).toBe('8px')
      expect(dot.getAttribute('class')).toContain('-right-px')
      // the picture says nothing itself: the name and the words after it do
      expect(face().getAttribute('aria-hidden')).toBe('true')
      expect(page.get('row').textContent).toBe('BBob, 접속 중')
      await set('away')
      expect(page.get('presence-dot').getAttribute('data-presence-dot')).toBe('away')
      expect(page.get('presence-text').textContent).toBe(', 자리 비움')
      await set('offline')
      expect(page.find('presence-dot')).toBeNull()
    } finally { await page.unmount() }
  })

  test('10 px on a 32 px picture; offline is said where asked (a header, a member list); five languages', async () => {
    await set('online')
    const page = await mount(<span><PresenceFace user={BOB} size={32} /><PresenceText userId="bob" offline /></span>)
    try {
      expect((page.get('presence-dot') as unknown as { style: { width: string } }).style.width).toBe('10px')
      await set('offline')
      expect(page.get('presence-text').textContent).toBe(', 오프라인')
      for (const [l, words] of [['en', 'Offline'], ['id', 'Offline'], ['ja', 'オフライン'], ['es', 'Desconectado']] as const) {
        await act(() => useLocaleStore.setState({ locale: l }))
        expect(page.get('presence-text').textContent).toBe(`, ${words}`)
      }
    } finally {
      useLocaleStore.setState({ locale: 'ko' })
      await page.unmount()
    }
  })

  test('on a computer the state is the picture\'s tooltip; none while offline', async () => {
    media(true)
    await set('away')
    const page = await mount(<PresenceFace user={BOB} size={24} />)
    try {
      fire(page.get('presence-face'), 'pointerover', { pointerType: 'mouse', relatedTarget: null })
      await page.settle(TOOLTIP_DELAY_MS + 50)
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('자리 비움')
      fire(page.get('presence-face'), 'pointerout', { pointerType: 'mouse', relatedTarget: null })
      await set('offline')
      fire(page.get('presence-face'), 'pointerover', { pointerType: 'mouse', relatedTarget: null })
      await page.settle(TOOLTIP_DELAY_MS + 50)
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
    } finally { await page.unmount() }
  })

  test('a DM\'s picture has the dot where asked; a group chat, a team room and the AI never', async () => {
    await set('online')
    const page = await mount(
      <MemoryRouter>
        <span data-testid="dm"><RoomIcon room={room('dm')} size={20} presence /></span>
        <span data-testid="dm-plain"><RoomIcon room={room('dm')} size={20} /></span>
        <span data-testid="group"><RoomIcon room={room('group', [BOB, { id: 'cho', name: 'Cho' }])} size={20} presence /></span>
        <span data-testid="team"><RoomIcon room={room('team')} size={20} presence /></span>
        <span data-testid="ai"><AiFace size={32} /></span>
      </MemoryRouter>,
    )
    try {
      await page.settle()
      expect(page.get('dm').querySelector('[data-testid="presence-dot"]')).not.toBeNull()
      for (const id of ['dm-plain', 'group', 'team', 'ai']) expect(page.get(id).querySelector('[data-testid="presence-dot"]')).toBeNull()
    } finally { await page.unmount() }
  })
})
