// Queue invariants under a mix of sends, stops, regenerates, edits and delete+restore on a few chats with a team
// limit of 2: afterwards nothing is queued or running, no turn row or answer is left in flight, every chat is idle and
// its visible path is a chain of parent links that alternates user / answer.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
/** small seeded PRNG: the same mix every run (timing still varies) */
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p1-queue-stress', concurrency: 2, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-p1-queue' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

test('80 overlapping requests on 8 chats settle cleanly', async () => {
  const api = h.api('alice')
  const chats = await Promise.all(Array.from({ length: 8 }, () => api.call(API.createChat, { body: {} })))
  const ops: Promise<unknown>[] = []
  const rand = mulberry32(20261021)
  const rnd = (n: number) => Math.floor(rand() * n)
  for (let i = 0; i < 80; i++) {
    const c = chats[rnd(chats.length)]!
    const k = rnd(10)
    const p = (async () => {
      try {
        if (k < 5) await api.call(API.sendMessage, { params: { id: c.id }, body: { content: fake({ say: 'hi ' + i }, { sleep: rnd(200) }, { say: ' bye' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
        else if (k < 7) await api.call(API.stop, { params: { id: c.id } })
        else if (k < 8) {
          const page = await api.call(API.listMessages, { params: { id: c.id } })
          const last = page.items.at(-1)
          if (last?.role === 'assistant') await api.call(API.regenerate, { params: { id: c.id, messageId: last.id }, body: {} })
        } else if (k < 9) {
          const page = await api.call(API.listMessages, { params: { id: c.id } })
          const u = page.items.findLast((m) => m.role === 'user')
          if (u) await api.call(API.editMessage, { params: { id: c.id, messageId: u.id }, body: { content: fake({ say: 'edited' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
        } else {
          await api.call(API.deleteChat, { params: { id: c.id } })
          await api.call(API.restoreChat, { params: { id: c.id } })
        }
      } catch (e) { if (!/conflict|409|turn|not_found|validation/i.test(String((e as Error).message) + JSON.stringify((e as any).body ?? ''))) throw e }
    })()
    ops.push(p)
    await Bun.sleep(rnd(30))
  }
  await Promise.all(ops)
  const rt = h.rt()
  await waitFor(() => rt.runningCount() === 0 && rt.queuedCount() === 0, { timeoutMs: 60_000 })
  expect(rt.runningCount()).toBe(0)
  expect(rt.queuedCount()).toBe(0)
  const stuckTurns = h.ctx.db.query("SELECT id, status FROM turns WHERE status IN ('queued','running')").all()
  expect(stuckTurns).toEqual([])
  const stuckMsgs = h.ctx.db.query("SELECT id, status FROM messages WHERE status = 'streaming'").all()
  expect(stuckMsgs).toEqual([])
  for (const c of chats) {
    const g = await api.call(API.getChat, { params: { id: c.id } })
    expect(g.runState).toBe('idle')
    // the active leaf is a real message of the chat, and the path is consistent
    const page = await api.call(API.listMessages, { params: { id: c.id } })
    for (let i = 1; i < page.items.length; i++) expect(page.items[i]!.parentId).toBe(page.items[i - 1]!.id)
  }
  // every done/stopped answer: user->assistant alternate
  const bad = h.ctx.db.query("SELECT a.id FROM messages a JOIN messages p ON p.id = a.parent_id WHERE a.role = p.role").all()
  expect(bad).toEqual([])
})
