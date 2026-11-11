// Many answers that can start at once start a few at a time (ChatRuntime.startSpread: START_BURST per START_SPREAD_MS),
// the rest a moment later, in the same fair order; one to three start at once with no delay (QA TC-277: 15 engines
// starting in the same instant froze a 2-core server for 0.5-1.3 s).
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, START_BURST, START_SPREAD_MS, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { setAvailableMemoryForTests } from '../../server/src/system/limits'

let h: Harness, rt: ChatRuntime
let starts: { exec: TurnExec; at: number }[] = []
let fakeRun: ReturnType<typeof spyOn>
async function setup(name: string, people: number, concurrency: number) {
  starts = []
  setAvailableMemoryForTests(null)
  fakeRun = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) { starts.push({ exec: this, at: performance.now() }) })
  h = await harness(`spread-${name}`); await withOwner(h)
  rt = getChatRuntime(h.ctx)
  for (let i = 1; i < people; i++) h.ctx.db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(`u${i}`, `u${i}`, `U${i}`)
  setSetting(h.ctx.db, 'concurrency', concurrency); rt.schedule()
}
const olga = () => (h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
function send(userId: string) {
  const id = newId()
  h.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, userId)
  return rt.createTurn({ chat: rt.store.chatRow(id)!, userId, locale: 'en', windowId: null, clientKind: 'web', engine: 'claude-code', model: null,
    user: { content: 'synthetic request', parentId: null, attachments: [], clientMessageId: crypto.randomUUID() } })
}
function finish(exec: TurnExec) {
  h.ctx.db.query("UPDATE turns SET status='done' WHERE id=?").run(exec.id)
  h.ctx.db.query("UPDATE messages SET status='done' WHERE id=?").run(exec.spec.assistantId)
  rt.turnFinished(exec)
  ;(exec as any).resolveDone()
}
const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(10)
  expect(cond()).toBe(true)
}
afterEach(async () => {
  if (rt) { void rt.drain(0); for (const s of starts) finish(s.exec) }
  if (h) await h.close()
  fakeRun?.mockRestore()
  setAvailableMemoryForTests(undefined)
})

test('15 answers sent at once: 3 start now, the rest 3 every START_SPREAD_MS, in send order (one per person)', async () => {
  await setup('fifteen', 15, 15)
  const people = [olga(), ...Array.from({ length: 14 }, (_, i) => `u${i + 1}`)]
  // all 15 are in the queue, then one dispatch sees them together
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  const sent = people.map((u) => send(u))
  paused.mockRestore()
  const t0 = performance.now()
  rt.schedule()
  expect(starts.length).toBe(START_BURST)
  expect(rt.queuePosition(sent[START_BURST]!.turnId)).toBe(1)
  // the ones not started yet are queued, with their place in line
  await waitFor(() => starts.length === 15)
  // queue order is kept: they start in the order they were sent
  expect(starts.map((s) => s.exec.spec.userId)).toEqual(people)
  // never more than START_BURST within any START_SPREAD_MS window (a little timer slack)
  const at = starts.map((s) => s.at - t0)
  for (let i = START_BURST; i < at.length; i++) expect(at[i]! - at[i - START_BURST]!).toBeGreaterThanOrEqual(START_SPREAD_MS - 5)
  // 15 starts take about (15 / 3 - 1) spreads, not much more
  expect(at[14]!).toBeLessThan(4 * START_SPREAD_MS + 600)
  expect(rt.runningCount()).toBe(15); expect(rt.queuedCount()).toBe(0)
})

test('15 sends one after another: never more than START_BURST starts within START_SPREAD_MS', async () => {
  await setup('sends', 15, 15)
  const people = [olga(), ...Array.from({ length: 14 }, (_, i) => `u${i + 1}`)]
  for (const u of people) send(u)
  await waitFor(() => starts.length === 15)
  expect(starts.map((s) => s.exec.spec.userId)).toEqual(people)
  for (let i = START_BURST; i < starts.length; i++) expect(starts[i]!.at - starts[i - START_BURST]!.at).toBeGreaterThanOrEqual(START_SPREAD_MS - 5)
})

test('one to three answers at once start with no delay', async () => {
  await setup('few', 3, 15)
  const people = [olga(), 'u1', 'u2']
  for (const u of people) { send(u); expect(starts.length).toBe(people.indexOf(u) + 1) }
  expect(starts.map((s) => s.exec.spec.userId)).toEqual(people)
})

test('a slot freed later starts the next answer at once (no burst in the window)', async () => {
  await setup('later', 3, 2)
  const a = send(olga()); send('u1'); send('u2')
  expect(starts.length).toBe(2)
  expect(a.queuePosition).toBe(0)
  await Bun.sleep(START_SPREAD_MS + 20)
  finish(starts[0]!.exec)
  expect(starts.length).toBe(3)
  expect(starts[2]!.exec.spec.userId).toBe('u2')
})

test('with spreading off (startSpreadMs 0) all start in one go, same order', async () => {
  await setup('off', 15, 15)
  rt.startSpreadMs = 0
  const people = [olga(), ...Array.from({ length: 14 }, (_, i) => `u${i + 1}`)]
  for (const u of people) send(u)
  expect(starts.map((s) => s.exec.spec.userId)).toEqual(people)
})

test('shutdown cancels a pending spread: nothing starts after it', async () => {
  await setup('shutdown', 6, 6)
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  for (const u of [olga(), 'u1', 'u2', 'u3', 'u4', 'u5']) send(u)
  paused.mockRestore(); rt.schedule()
  expect(starts.length).toBe(START_BURST)
  void rt.shutdown()
  await Bun.sleep(START_SPREAD_MS + 100)
  expect(starts.length).toBe(START_BURST)
})
