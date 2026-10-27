import { describe, expect, test } from 'bun:test'
import { openDb } from '../../server/src/db'
import { fairOrder, selectFairHead, type FairEntry } from '../../server/src/chat/fair-queue'
import { QueueStore } from '../../server/src/chat/queue-store'

const entries = (...users: string[]): FairEntry[] => users.map((userId, i) => ({ turnId: `${userId}${i}`, userId, chatId: `c${i}`, queueSeq: i + 1 }))

describe('people fair selection', () => {
  test('FIFO within each user, minimum active before ticket, and pure display order', () => {
    const q = entries('a', 'a', 'a', 'b', 'c')
    const tickets = new Map([['a', 1], ['b', 2], ['c', 3]])
    const active = new Map<string, number>()
    expect(fairOrder(q, active, tickets).map(x => x.userId)).toEqual(['a', 'b', 'c', 'a', 'a'])
    expect(selectFairHead(q, new Map([['a', 2], ['b', 1]]), tickets)?.userId).toBe('c')
    expect([...tickets]).toEqual([['a', 1], ['b', 2], ['c', 3]])
    expect(active.size).toBe(0)
  })
  test('blocked head cannot be overtaken by same user; another person proceeds', () => {
    const q = entries('a', 'a', 'b')
    const busy = new Set(['c0'])
    expect(selectFairHead(q, new Map(), new Map([['a', 1], ['b', 2]]), busy)?.userId).toBe('b')
    expect(fairOrder(q, new Map(), new Map([['a', 1], ['b', 2]]), busy).map(x => x.turnId)).toEqual(['b2', 'a0', 'a1'])
  })
  test('40/60 people x 3 requests, C=1/3/4/8: all run, no FIFO violation or unused slot', () => {
    for (const n of [40, 60]) for (const c of [1, 3, 4, 8]) {
      const q = entries(...Array.from({ length: n }, (_, i) => [`u${i}`, `u${i}`, `u${i}`]).flat())
      const tickets = new Map(Array.from({ length: n }, (_, i) => [`u${i}`, i]))
      let clock = n, rounds = 0, started = 0
      const last = new Map<string, number>()
      while (q.length) {
        const active = new Map<string, number>()
        for (let slot = 0; slot < c && q.length; slot++) {
          const x = selectFairHead(q, active, tickets)!
          expect(x).toBeDefined()
          expect(x.queueSeq).toBeGreaterThan(last.get(x.userId) ?? 0)
          last.set(x.userId, x.queueSeq)
          q.splice(q.indexOf(x), 1); tickets.set(x.userId, ++clock)
          active.set(x.userId, (active.get(x.userId) ?? 0) + 1); started++
        }
        rounds++
      }
      expect(started).toBe(n * 3)
      expect(rounds).toBe(Math.ceil(n * 3 / c))
    }
  })
  test('10,000 seeded arrivals/completions/cancels/account/capacity changes agree with an independent user oracle', () => {
    function simulate() {
      let seed = 7319, seq = 0, ticket = 0, capacity = 3, dispatched = 0, digest = 0
      const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
      const q: FairEntry[] = [], live: FairEntry[] = []
      const users = Array.from({ length: 60 }, (_, i) => `u${i}`), enabled = new Set(users)
      const queues = new Map(users.map(u => [u, [] as FairEntry[]]))
      const tickets = new Map<string, number>(), last = new Map<string, number>()
      const settle = (u: string) => { if (!queues.get(u)!.length) tickets.delete(u) }
      const remove = (x: FairEntry) => { q.splice(q.indexOf(x), 1); const own = queues.get(x.userId)!; own.splice(own.indexOf(x), 1); settle(x.userId) }
      for (let action = 0; action < 10_000; action++) {
        const op = random(10), u = users[random(users.length)]!
        if (op < 5 && enabled.has(u) && queues.get(u)!.length < 3) {
          const x = { turnId: `t${++seq}`, chatId: `c${seq}`, userId: u, queueSeq: seq }
          q.push(x); queues.get(u)!.push(x); if (!tickets.has(u)) tickets.set(u, ++ticket)
        } else if (op < 7 && live.length) live.splice(random(live.length), 1)
        else if (op === 7 && q.length) remove(q[random(q.length)]!)
        else if (op === 8) {
          if (enabled.delete(u)) { for (const x of [...queues.get(u)!]) remove(x); for (let i = live.length - 1; i >= 0; i--) if (live[i]!.userId === u) live.splice(i, 1) }
          else enabled.add(u)
        } else if (op === 9) capacity = [1, 3, 4, 8][random(4)]!
        while (live.length < capacity && q.length) {
          const active = new Map(users.map(u => [u, live.filter(x => x.userId === u).length]))
          // Oracle starts with independent per-user lists, then sorts one candidate per person.
          const expected = users.filter(u => queues.get(u)!.length).sort((a, b) =>
            active.get(a)! - active.get(b)! || tickets.get(a)! - tickets.get(b)! || a.localeCompare(b))[0]!
          const x = selectFairHead(q, active, tickets)!
          expect(x.turnId).toBe(queues.get(expected)![0]!.turnId)
          expect(x.queueSeq).toBeGreaterThan(last.get(x.userId) ?? 0)
          last.set(x.userId, x.queueSeq); remove(x); live.push(x)
          if (queues.get(x.userId)!.length) tickets.set(x.userId, ++ticket)
          dispatched++; digest = (Math.imul(digest, 31) + x.queueSeq) >>> 0
        }
        if (action % 100 === 0) {
          const snapshot = JSON.stringify([...tickets]), pending = q.map(x => x.turnId)
          fairOrder(q, new Map(users.map(u => [u, live.filter(x => x.userId === u).length])), tickets)
          expect(JSON.stringify([...tickets])).toBe(snapshot); expect(q.map(x => x.turnId)).toEqual(pending)
        }
      }
      expect(dispatched).toBeGreaterThan(1000)
      return { dispatched, digest }
    }
    expect(simulate()).toEqual(simulate())
  })
})

describe('durable queue claims', () => {
  function fixture() {
    const db = openDb(':memory:')
    for (const u of ['a', 'b']) db.query('INSERT INTO users (id, username, name, role) VALUES (?,?,?,?)').run(u, u, u, 'member')
    const store = new QueueStore(db)
    const add = (id: string, userId: string) => db.transaction(() => {
      const seq = store.admit(userId)
      db.query("INSERT INTO turns (id,chat_id,user_id,engine,status,queue_seq) VALUES (?,?,?,'claude-code','queued',?)").run(id, id, userId, seq)
      return seq
    })()
    return { db, store, add }
  }
  test('claim rotates persistently, never overwrites deadline or claims twice', () => {
    const { db, store, add } = fixture()
    try {
      add('a1', 'a'); add('a2', 'a'); add('b1', 'b')
      const before = store.tickets()
      expect(before.get('a')!).toBeLessThan(before.get('b')!)
      const claimed = store.claim('a1', 'a', 2700000, '2026-10-27T00:00:00.000Z')!
      expect(claimed.wallDeadlineAt).toBe('2026-10-27T00:45:00.000Z')
      expect(new QueueStore(db).tickets().get('a')!).toBeGreaterThan(before.get('b')!)
      expect(store.claim('a1', 'a', 2700000)).toBeNull()
      expect(db.query('SELECT status, dispatched_at FROM turns WHERE id=?').get('a1')).toEqual({ status: 'running', dispatched_at: claimed.dispatchedAt })
      store.claim('a2', 'a', 2700000)
      expect(store.tickets().has('a')).toBe(false)
      add('a3', 'a')
      expect(store.tickets().get('a')!).toBeGreaterThan(store.tickets().get('b')!)
    } finally { db.close() }
  })
  test('repair preserves valid tickets and backfills old queued rows deterministically', () => {
    const { db, store, add } = fixture()
    try {
      add('a1', 'a'); const ticket = store.tickets().get('a')
      db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,queued_at) VALUES('b1','b1','b','claude-code','queued','2026-01-01')").run()
      store.repair()
      expect(store.tickets().get('a')).toBe(ticket)
      expect(store.tickets().get('b')!).toBeGreaterThan(ticket!)
      expect((db.query('SELECT queue_seq FROM turns WHERE id=?').get('b1') as any).queue_seq).toBeGreaterThan(0)
      const before = [...store.tickets()]; store.repair(); expect([...store.tickets()]).toEqual(before)
    } finally { db.close() }
  })
  test('rollback admits neither a sequence nor a ticket; occurrence is unique across chats', () => {
    const { db, store, add } = fixture()
    try {
      expect(() => db.transaction(() => { add('a1', 'a'); throw new Error('crash') })()).toThrow('crash')
      expect(store.tickets().size).toBe(0)
      add('a1', 'a'); add('a2', 'a')
      db.query("UPDATE turns SET schedule_id='s', scheduled_for='due' WHERE id='a1'").run()
      expect(() => db.query("UPDATE turns SET schedule_id='s', scheduled_for='due' WHERE id='a2'").run()).toThrow()
    } finally { db.close() }
  })
  test('a crash during ticket rotation rolls the running claim and sequence back together', () => {
    const { db, store, add } = fixture()
    try {
      add('a1', 'a'); add('a2', 'a')
      const before = [...store.tickets()], sequence = db.query('SELECT next_seq FROM chat_queue_state').get()
      db.exec("CREATE TRIGGER fail_rotate BEFORE UPDATE ON chat_queue_users BEGIN SELECT RAISE(ABORT,'synthetic crash'); END")
      expect(() => store.claim('a1', 'a', 2700000)).toThrow('synthetic crash')
      expect(db.query("SELECT status,dispatched_at FROM turns WHERE id='a1'").get()).toEqual({ status: 'queued', dispatched_at: null })
      expect([...store.tickets()]).toEqual(before)
      expect(db.query('SELECT next_seq FROM chat_queue_state').get()).toEqual(sequence)
    } finally { db.close() }
  })
})
