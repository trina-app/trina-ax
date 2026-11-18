// Who waits in a shared chat, and since when (server/src/chat/shared-waiting.ts): the order waiting messages of
// different people go in, the count the others see, and a place nobody refreshed that stops holding the others back.
import { describe, expect, test } from 'bun:test'
import { SharedWaiting, WAITING_TTL_MS } from '../../server/src/chat/shared-waiting'

describe('shared waiting', () => {
  test('first queued goes first; a send moves the sender to the back; a refresh keeps the place', () => {
    let t = 1_000
    const w = new SharedWaiting(() => t)
    expect(w.ahead('c', 'alice')).toBeNull()
    expect(w.declare('c', 'bob', 2)).toBe(true)
    t += 10
    w.declare('c', 'alice', 1)
    expect(w.ahead('c', 'alice')).toBe('bob')
    expect(w.ahead('c', 'bob')).toBeNull()
    // someone who does not wait at all goes after everyone who does
    expect(w.ahead('c', 'carol')).toBe('bob')
    // a refresh with the same count changes nothing the others see, and keeps bob first
    t += 10
    expect(w.declare('c', 'bob', 2)).toBe(false)
    expect(w.ahead('c', 'alice')).toBe('bob')
    expect(w.othersCount('c', 'alice')).toBe(2)
    expect(w.othersCount('c', 'carol')).toBe(3)
    expect(w.sent('c', 'bob')).toBe(true)
    expect(w.ahead('c', 'alice')).toBeNull()
    t += 10
    w.declare('c', 'bob', 1)
    expect(w.ahead('c', 'bob')).toBe('alice')
    expect(w.declare('c', 'alice', 0)).toBe(true)
    expect(w.ahead('c', 'bob')).toBeNull()
    // other chats are separate
    expect(w.othersCount('d', 'alice')).toBe(0)
  })

  test('a place not refreshed for 45 s stops counting; its next say starts at the back', () => {
    let t = 0
    const w = new SharedWaiting(() => t)
    w.declare('c', 'bob', 1)
    t += 5
    w.declare('c', 'alice', 1)
    t += WAITING_TTL_MS - 10
    w.declare('c', 'alice', 1)
    expect(w.ahead('c', 'alice')).toBe('bob')
    t += 20
    expect(w.ahead('c', 'alice')).toBeNull()
    expect(w.othersCount('c', 'alice')).toBe(0)
    w.declare('c', 'bob', 1)
    expect(w.ahead('c', 'bob')).toBe('alice')
    // counts are bounded
    w.declare('c', 'carol', 10_000)
    expect(w.othersCount('c', 'alice')).toBe(51)
  })
})
