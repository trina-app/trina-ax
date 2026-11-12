import { describe, expect, test } from 'bun:test'
import { HttpError } from '../../server/src/http/errors'
import { ChunkGate } from '../../server/src/uploads/chunk-gate'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('upload chunk gate', () => {
  test('at most max chunks at once; the next waits and gets the freed slot', async () => {
    const gate = new ChunkGate({ max: 2, queueMax: 4, rssLimit: Infinity, gc: () => {} })
    const a = await gate.enter()
    await gate.enter()
    let third = false
    const p = gate.enter().then((rel) => { third = true; return rel })
    await tick()
    expect(third).toBe(false)
    expect(gate.stats()).toEqual({ active: 2, waiting: 1 })
    a()
    a() // a second release does nothing
    await p
    expect(third).toBe(true)
    expect(gate.stats()).toEqual({ active: 2, waiting: 0 })
  })

  test('a full queue is refused with 503 unavailable and a retry time', async () => {
    const gate = new ChunkGate({ max: 1, queueMax: 1, rssLimit: Infinity, gc: () => {} })
    await gate.enter()
    void gate.enter()
    const e = await gate.enter().catch((x) => x)
    expect(e).toBeInstanceOf(HttpError)
    expect(e.status).toBe(503)
    expect(e.code).toBe('unavailable')
    expect(e.retryAfter).toBe(5)
  })

  test('over the memory limit: one forced collection, then refused if still over', async () => {
    let rss = 900
    const calls: boolean[] = []
    const gate = new ChunkGate({ max: 3, queueMax: 4, rssLimit: 500, rss: () => rss, gc: (f) => calls.push(f) })
    const e = await gate.enter().catch((x) => x)
    expect(e.code).toBe('unavailable')
    expect(calls).toEqual([true])
    // the collection freed enough: admitted, and a light collection after the chunk
    const gate2 = new ChunkGate({ max: 3, queueMax: 4, rssLimit: 500, rss: () => rss, gc: (f) => { calls.push(f); if (f) rss = 300 } })
    const rel = await gate2.enter()
    rel()
    expect(calls).toEqual([true, true, false])
  })
})
