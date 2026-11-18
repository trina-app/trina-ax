// Who waits in a shared chat, and since when (server/src/chat/shared-waiting.ts): the order waiting messages of
// different people go in, how many people the others are told wait, a place nobody refreshed, a first place nobody
// uses (the grace period), a late refresh after a send, and places dropped with the chat or the person.
import { describe, expect, test } from 'bun:test'
import { SharedWaiting, WAITING_AFTER_SEND_MS, WAITING_GRACE_MS, WAITING_TTL_MS } from '../../server/src/chat/shared-waiting'

describe('shared waiting', () => {
  test('first queued goes first; a send moves the sender to the back; a refresh keeps the place', () => {
    let t = 1_000
    const w = new SharedWaiting(() => t)
    expect(w.ahead('c', 'alice')).toBeNull()
    // someone starts waiting: the others are told (people, not messages)
    expect(w.declare('c', 'bob', 2)).toBe(true)
    t += 10
    expect(w.declare('c', 'alice', 1)).toBe(true)
    expect(w.ahead('c', 'alice')).toBe('bob')
    expect(w.ahead('c', 'bob')).toBeNull()
    // someone who does not wait at all goes after everyone who does
    expect(w.ahead('c', 'carol')).toBe('bob')
    // a refresh, or another count, changes nothing the others are told, and keeps bob first
    t += 10
    expect(w.declare('c', 'bob', 3)).toBe(false)
    expect(w.ahead('c', 'alice')).toBe('bob')
    expect(w.othersCount('c', 'alice')).toBe(1)
    expect(w.othersCount('c', 'carol')).toBe(2)
    expect(w.sent('c', 'bob')).toBe(true)
    expect(w.ahead('c', 'alice')).toBeNull()
    t += WAITING_AFTER_SEND_MS
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
  })

  test('a holder who never sends: after the grace period from the first refusal they go to the back, and keep refreshing in vain', () => {
    let t = 0
    const w = new SharedWaiting(() => t)
    w.declare('c', 'bob', 1)
    t += 1
    w.declare('c', 'alice', 1)
    // the answer ended: alice is held back, bob's grace period starts now
    expect(w.ahead('c', 'alice')).toBe('bob')
    t += WAITING_GRACE_MS - 1
    w.declare('c', 'bob', 1)
    w.declare('c', 'alice', 1)
    expect(w.ahead('c', 'alice')).toBe('bob')
    t += 2
    // past it: bob goes behind alice; alice may send, and carol (not waiting) is now held back by alice
    expect(w.ahead('c', 'alice')).toBeNull()
    expect(w.ahead('c', 'bob')).toBe('alice')
    // bob's refreshes keep him at the back
    w.declare('c', 'bob', 1)
    expect(w.ahead('c', 'alice')).toBeNull()
    // a place that ran out holds nobody back any more, also those who do not wait
    w.declare('c', 'alice', 0)
    expect(w.ahead('c', 'carol')).toBeNull()
    // a new one in line gets its own grace period, and a turn starting gives the next quiet moment a fresh one
    w.declare('c', 'dan', 1)
    expect(w.ahead('c', 'carol')).toBe('dan')
    t += WAITING_GRACE_MS - 1
    w.turnStarted('c')
    t += 2
    expect(w.ahead('c', 'carol')).toBe('dan')
    t += WAITING_GRACE_MS + 1
    expect(w.ahead('c', 'carol')).toBeNull()
    // bob sends: his place (and its "passed") is gone; waiting again later he is in line as anyone
    w.sent('c', 'bob')
    t += WAITING_AFTER_SEND_MS
    w.declare('c', 'bob', 1)
    expect(w.ahead('c', 'carol')).toBe('bob')
  })

  test('a late refresh just after a send gives no new place; drop and dropUser clear places', () => {
    let t = 0
    const w = new SharedWaiting(() => t)
    w.declare('c', 'bob', 1)
    w.sent('c', 'bob')
    t += WAITING_AFTER_SEND_MS - 1
    expect(w.declare('c', 'bob', 1)).toBe(false)
    expect(w.othersCount('c', 'alice')).toBe(0)
    t += 2
    expect(w.declare('c', 'bob', 1)).toBe(true)
    w.declare('c', 'carol', 1)
    w.declare('d', 'bob', 1)
    w.dropUser('bob', ['c'])
    expect(w.othersCount('c', 'alice')).toBe(1)
    expect(w.othersCount('d', 'alice')).toBe(1)
    w.drop('c')
    expect(w.othersCount('c', 'alice')).toBe(0)
    // counts are bounded
    w.declare('e', 'carol', 10_000)
    expect(w.ahead('e', 'alice')).toBe('carol')
  })
})
