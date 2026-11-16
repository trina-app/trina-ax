// "Using Trina" for the phone rule with the desktop app in the back (docs/decisions/20261116-away-os-idle.md;
// server/src/realtime/presence.ts inUse + computer, notifications/away.ts phoneDecision).
// The bug (owner, 2026-11-16): the Mac app open behind other windows, the owner working on the computer, and every
// notice rang the phone too. A covered or minimized window is throttled by the browser engine: its 20 s ping can stop
// for minutes, so the server left the window out after 60 s silent and sent the phone push. The desktop app's main
// process now reports the computer's own idle time and lock (POST /api/me/computer) and that decides.
//   1. Presence on a fake clock: a background window silent past the cut-off, with recent OS input → in use; OS idle
//      past 10 minutes → not; a locked screen → not, even with a window still "active"; no window and no report → not;
//      an old report (the app quit, the computer slept) → not; manual away wins; a browser tab hidden is idle (the page
//      says so: current behaviour, here as the window's own word).
//   2. On the real app: POST /api/me/computer (the caller's own, strict body, CSRF), then phoneDecision cancel / send.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Presence, PRESENCE_COMPUTER_FRESH_MS, PRESENCE_COMPUTER_IDLE_MS, PRESENCE_SILENT_MS, type PresenceClock } from '../../server/src/realtime/presence'
import { phoneDecision } from '../../server/src/notifications/away'
import { presenceFor } from '../../server/src/realtime/presence'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(60_000)

class FakeClock implements PresenceClock {
  t = 1_000_000
  private n = 0
  private q: { id: number; at: number; fn: () => void }[] = []
  now() { return this.t }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ id, at: this.t + ms, fn }); return id }
  clearTimeout(id: unknown) { this.q = this.q.filter((x) => x.id !== id) }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.q[0]
      if (!next || next.at > end) break
      this.q.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
}

function machine(o: { away?: string[] } = {}) {
  const clock = new FakeClock()
  const away = new Set(o.away ?? [])
  const p = new Presence({
    send: () => {},
    recipients: () => ['ana', 'bob'],
    isPerson: (id) => id === 'ana' || id === 'bob',
    activeIds: () => new Set(['ana', 'bob']),
    awayOf: (id) => away.has(id),
    clock,
    warmupMs: 0,
  })
  return { p, clock, away }
}

describe('presence: the computer in use, Trina in the back', () => {
  test('a background desktop window silent past the cut-off, with recent OS input: in use (the phone push is cancelled)', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    // the window went behind other apps: throttled, it sends nothing (not even its ping) for minutes
    m.clock.advance(PRESENCE_SILENT_MS + 5 * 60_000)
    // before the fix: left out as silent
    expect(m.p.inUse('ana')).toBe(false)
    // the desktop app's main process: input 4 s ago, screen unlocked
    m.p.computer('ana', { idleMs: 4000, locked: false })
    expect(m.p.inUse('ana')).toBe(true)
    // still in use 50 s later (the next report comes every 30 s)
    m.clock.advance(50_000)
    expect(m.p.inUse('ana')).toBe(true)
  })

  test('the desktop app running with no window connected at all (the socket dropped): recent OS input still counts', () => {
    const m = machine()
    m.p.computer('ana', { idleMs: 0, locked: false })
    expect(m.p.inUse('ana')).toBe(true)
  })

  test('OS idle past 10 minutes: not in use (the phone push goes), also when it crosses the line between reports', () => {
    const m = machine()
    m.p.open('ana', 'w1')
    m.clock.advance(PRESENCE_SILENT_MS + 1)
    m.p.computer('ana', { idleMs: PRESENCE_COMPUTER_IDLE_MS + 1000, locked: false })
    expect(m.p.inUse('ana')).toBe(false)
    m.p.computer('ana', { idleMs: PRESENCE_COMPUTER_IDLE_MS - 10_000, locked: false })
    expect(m.p.inUse('ana')).toBe(true)
    // 20 s later (no new report yet) the computer has been idle for 10 minutes and 10 s
    m.clock.advance(20_000)
    expect(m.p.inUse('ana')).toBe(false)
  })

  test('a locked screen is away, even with a window that still counts as active', () => {
    const m = machine()
    m.p.open('ana', 'w1') // active and heard from just now
    expect(m.p.inUse('ana')).toBe(true)
    m.p.computer('ana', { idleMs: 0, locked: true })
    expect(m.p.inUse('ana')).toBe(false)
    // unlocked: in use again
    m.p.computer('ana', { idleMs: 0, locked: false })
    expect(m.p.inUse('ana')).toBe(true)
  })

  test('no window and no report: not in use; an old report (the app quit, the computer slept) counts no more', () => {
    const m = machine()
    expect(m.p.inUse('ana')).toBe(false)
    m.p.computer('ana', { idleMs: 0, locked: false })
    m.clock.advance(PRESENCE_COMPUTER_FRESH_MS + 1)
    expect(m.p.inUse('ana')).toBe(false)
    // an old locked report does not keep a window in use away either
    m.p.computer('ana', { idleMs: 0, locked: true })
    m.clock.advance(PRESENCE_COMPUTER_FRESH_MS + 1)
    m.p.open('ana', 'w1')
    expect(m.p.inUse('ana')).toBe(true)
  })

  test('manual away wins over the computer, with or without a window; one person\'s computer never counts for another', () => {
    const m = machine({ away: ['ana'] })
    m.p.computer('ana', { idleMs: 0, locked: false })
    expect(m.p.inUse('ana')).toBe(false)
    m.p.open('ana', 'w1')
    expect(m.p.inUse('ana')).toBe(false)
    m.p.computer('bob', { idleMs: 0, locked: false })
    expect(m.p.inUse('bob')).toBe(true)
    // a report for a non-account (the AI, a deleted account) never makes anyone in use
    m.p.computer('ghost', { idleMs: 0, locked: false })
    expect(m.p.inUse('ghost')).toBe(false)
  })

  test('a browser tab hidden: its page says idle at once (web/src/lib/presence.ts), so not in use: current behaviour', () => {
    const m = machine()
    m.p.open('ana', 'tab')
    m.p.activity('ana', 'tab', 'idle')
    expect(m.p.inUse('ana')).toBe(false)
  })

  test('the computer report changes no dot: only the phone rule reads it', () => {
    const m = machine()
    m.p.computer('ana', { idleMs: 0, locked: false })
    m.clock.advance(10_000)
    expect(m.p.current('ana')).toBe('offline')
    expect(m.p.list()).toEqual([])
  })
})

describe('on the real app: POST /api/me/computer and phoneDecision', () => {
  let h: Harness | undefined
  afterEach(async () => { await h?.close(); h = undefined })

  test('recent OS input with no window: cancel; idle past 10 minutes: send; locked: send; nothing told: send', async () => {
    h = await harness('presence-computer')
    const owner = await withOwner(h)
    const nora = await addMember(h, owner, { username: 'nora' })
    getChatRuntime(h.ctx)
    const pr = presenceFor(h.ctx)!
    // the warm-up after a start: wait (decided at its end)
    while (pr.warmingUntil() !== null) await new Promise((r) => setTimeout(r, 200))
    expect(phoneDecision(h.ctx, nora.id)).toEqual({ kind: 'send' })
    await nora.client.call('POST', '/api/me/computer', { idleMs: 3000, locked: false })
    expect(phoneDecision(h.ctx, nora.id)).toEqual({ kind: 'cancel' })
    // someone else's computer never quiets nora's phone
    expect(phoneDecision(h.ctx, owner.id)).toEqual({ kind: 'send' })
    await nora.client.call('POST', '/api/me/computer', { idleMs: PRESENCE_COMPUTER_IDLE_MS + 1, locked: false })
    expect(phoneDecision(h.ctx, nora.id)).toEqual({ kind: 'send' })
    await nora.client.call('POST', '/api/me/computer', { idleMs: 0, locked: true })
    expect(phoneDecision(h.ctx, nora.id)).toEqual({ kind: 'send' })
    // only the caller's own: another person's id in the body changes nothing for them
    await nora.client.try('POST', '/api/me/computer', { idleMs: 0, locked: false, userId: owner.id })
    expect(phoneDecision(h.ctx, owner.id)).toEqual({ kind: 'send' })
    // a bad body is refused and the last report stands
    await nora.client.call('POST', '/api/me/computer', { idleMs: 0, locked: true })
    expect((await nora.client.try('POST', '/api/me/computer', { idleMs: -5, locked: false })).status).toBe(400)
    expect((await nora.client.try('POST', '/api/me/computer', { idleMs: 0 })).status).toBe(400)
    // a page on another site cannot post it for nora (no CSRF header)
    const forged = await nora.client.raw('POST', '/api/me/computer', { idleMs: 0, locked: false }, { 'x-mycel-csrf': '' })
    expect(forged.status).toBe(403)
    expect(phoneDecision(h.ctx, nora.id)).toEqual({ kind: 'send' })
    // signed out: refused
    const anon = await h.fetch('/api/me/computer', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mycel-csrf': '1' }, body: JSON.stringify({ idleMs: 0, locked: false }) })
    expect(anon.status).toBe(401)
  }, 60_000)
})
