// Engine launches go through a start gate (ChatRuntime.launch: START_BURST per START_SPREAD_MS, first in first out).
// Only TurnExec.run waits: the claim, the running set, the round-robin ticket and every limit are what they are with no
// gate, so queue order, fairness, queuePosition and the per-person limits match a server without it (QA TC-277: 15
// engines launched in one instant froze a 2-core server for 0.5-1.3 s).
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, START_BURST, START_SPREAD_MS, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { setAvailableMemoryForTests } from '../../server/src/system/limits'

let h: Harness | null = null, rt: ChatRuntime
// at: the gate's own launch time (its clock when it let the turn go); stopped turns leaving the gate have none
let launches: { exec: TurnExec; at: number; stopped: boolean }[] = []
let fakeRun: ReturnType<typeof spyOn> | null = null
const ended = new Set<string>()
// a fake gate clock (o.clock): it moves only by advance(), so what a test asserts right after a dispatch does not depend
// on how long the dispatch took (a slow machine passes START_SPREAD_MS inside one schedule() and the gate correctly
// launches more). The real timer the gate arms finds nothing to launch until the test moves the clock.
let fakeNow = 0
function advance(ms: number) { fakeNow += ms; (rt as any).launchGated() }
async function setup(name: string, people: number, concurrency: number, o: { burst?: number; clock?: boolean } = {}) {
  launches = []; ended.clear(); fakeNow = 1000
  setAvailableMemoryForTests(null)
  // a fake engine: a turn launched after a stop only ends, as TurnExec.run does (no engine once stopReason is set)
  fakeRun = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) {
    const stopped = !!this.stopReason
    launches.push({ exec: this, at: stopped ? NaN : (rt as any).recentLaunches.at(-1), stopped })
    if (this.stopReason) finish(this)
  })
  h = await harness(`gate-${name}-${Math.random().toString(36).slice(2)}`); await withOwner(h)
  rt = getChatRuntime(h.ctx)
  if (o.burst !== undefined) rt.startBurst = o.burst
  if (o.clock) rt.gateNow = () => fakeNow
  for (let i = 1; i < people; i++) h.ctx.db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(`u${i}`, `u${i}`, `U${i}`)
  setSetting(h.ctx.db, 'concurrency', concurrency); rt.schedule()
}
const olga = () => (h!.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
function send(userId: string) {
  const id = newId()
  h!.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, userId)
  const t = rt.createTurn({ chat: rt.store.chatRow(id)!, userId, locale: 'en', windowId: null, clientKind: 'web', engine: 'claude-code', model: null,
    user: { content: 'synthetic request', parentId: null, attachments: [], clientMessageId: crypto.randomUUID() } })
  return { ...t, chatId: id }
}
function finish(exec: TurnExec) {
  if (ended.has(exec.id)) return
  ended.add(exec.id)
  h!.ctx.db.query("UPDATE turns SET status='done' WHERE id=?").run(exec.id)
  h!.ctx.db.query("UPDATE messages SET status='done' WHERE id=?").run(exec.spec.assistantId)
  rt.turnFinished(exec)
  ;(exec as any).resolveDone()
}
const running = (): Map<string, TurnExec> => (rt as any).running
const gated = (): TurnExec[] => (rt as any).startGate
const waitFor = async (cond: () => boolean, ms = 15000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(10)
  expect(cond()).toBe(true)
}
async function close() {
  if (!h) return
  void rt.drain(0); for (const e of [...running().values()]) finish(e)
  await h.close(); h = null
  fakeRun?.mockRestore(); fakeRun = null
  setAvailableMemoryForTests(undefined)
}
afterEach(close)
const fifteen = () => [olga(), ...Array.from({ length: 14 }, (_, i) => `u${i + 1}`)]

test('15 answers released in one dispatch: all 15 run (claimed, position 0) at once; engines launch 3 per START_SPREAD_MS in order', async () => {
  await setup('fifteen', 15, 15, { clock: true })
  const people = fifteen()
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  const sent = people.map((u) => send(u))
  paused.mockRestore()
  const t0 = fakeNow
  rt.schedule()
  // the queue is as with no gate: every turn holds its slot and is not "queued"
  expect(rt.runningCount()).toBe(15); expect(rt.queuedCount()).toBe(0)
  for (const s of sent) expect(rt.queuePosition(s.turnId)).toBe(0)
  expect(launches.length).toBe(START_BURST)
  for (let n = START_BURST; n < 15; n += START_BURST) {
    advance(START_SPREAD_MS - 1); expect(launches.length).toBe(n)
    advance(1); expect(launches.length).toBe(n + START_BURST)
  }
  expect(launches.map((l) => l.exec.spec.userId)).toEqual(people)
  expect(launches.map((l) => l.at - t0)).toEqual(people.map((_, i) => Math.floor(i / START_BURST) * START_SPREAD_MS))
  expect(gated()).toHaveLength(0)
  // the timer armed while the gate held turns fires once more, finds the gate empty and is not armed again
  await waitFor(() => (rt as any).launchTimer === null)
  expect(launches).toHaveLength(15)
})

test('15 sends one after another: never more than START_BURST launches within START_SPREAD_MS', async () => {
  await setup('sends', 15, 15)
  const people = fifteen()
  for (const u of people) send(u)
  expect(rt.runningCount()).toBe(15)
  await waitFor(() => launches.length === 15)
  expect(launches.map((l) => l.exec.spec.userId)).toEqual(people)
  for (let i = START_BURST; i < launches.length; i++) expect(launches[i]!.at - launches[i - START_BURST]!.at).toBeGreaterThanOrEqual(START_SPREAD_MS)
})

test('one to three answers launch with no delay; a slot freed later launches the next one at once', async () => {
  await setup('few', 3, 2, { clock: true })
  send(olga()); expect(launches.length).toBe(1)
  send('u1'); expect(launches.length).toBe(2)
  const third = send('u2')
  expect(launches.length).toBe(2); expect(rt.queuePosition(third.turnId)).toBe(1)
  advance(START_SPREAD_MS + 20)
  finish(launches[0]!.exec)
  expect(launches.length).toBe(3); expect(launches[2]!.exec.spec.userId).toBe('u2')
})

test('with the gate off (startSpreadMs 0, or startBurst 0) all launch in one go, same order', async () => {
  for (const off of [{ ms: 0 }, { burst: 0 }]) {
    await setup('off', 15, 15, off.burst === 0 ? { burst: 0 } : {})
    if (off.ms === 0) rt.startSpreadMs = 0
    const people = fifteen()
    for (const u of people) send(u)
    expect(launches.map((l) => l.exec.spec.userId)).toEqual(people)
    await close()
  }
})

test('Stop on a turn in the start gate: it ends at once (no engine), its slot goes to the next queued answer, the gate order holds', async () => {
  await setup('stop', 6, 5, { clock: true })
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  const sent = [olga(), 'u1', 'u2', 'u3', 'u4', 'u5'].map((u) => send(u))
  paused.mockRestore(); rt.schedule()
  expect(launches.length).toBe(START_BURST); expect(gated().map((e) => e.spec.userId)).toEqual(['u3', 'u4'])
  expect(rt.queuePosition(sent[5]!.turnId)).toBe(1)
  expect(rt.stopChat(sent[3]!.chatId)).toBe(sent[3]!.turnId)
  await Promise.resolve(); await Promise.resolve()
  // u3 ended without an engine; u5 took its slot (claimed now, as with no gate) and waits in the gate behind u4
  expect(launches.find((l) => l.exec.spec.userId === 'u3')).toMatchObject({ stopped: true })
  expect(running().has(sent[3]!.turnId)).toBe(false)
  expect(rt.queuePosition(sent[5]!.turnId)).toBe(0)
  expect(gated().map((e) => e.spec.userId)).toEqual(['u4', 'u5'])
  expect(launches.filter((l) => !l.stopped)).toHaveLength(START_BURST)
  advance(START_SPREAD_MS)
  expect(launches.filter((l) => !l.stopped).map((l) => l.exec.spec.userId)).toEqual([olga(), 'u1', 'u2', 'u4', 'u5'])
})

test('shutdown: turns still in the gate end without an engine, nothing launches after it', async () => {
  await setup('shutdown', 6, 6, { clock: true })
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  for (const u of [olga(), 'u1', 'u2', 'u3', 'u4', 'u5']) send(u)
  paused.mockRestore(); rt.schedule()
  expect(launches.length).toBe(START_BURST)
  void rt.shutdown()
  await Promise.resolve(); await Promise.resolve()
  expect(gated()).toHaveLength(0); expect((rt as any).launchTimer).toBeNull()
  advance(10 * START_SPREAD_MS); await Bun.sleep(START_SPREAD_MS + 100)
  expect(launches.filter((l) => !l.stopped)).toHaveLength(START_BURST)
  expect(launches.filter((l) => l.stopped)).toHaveLength(3)
})

test('drain waits for gated turns too: they launch and finish, drain resolves true', async () => {
  await setup('drain', 6, 6, { clock: true })
  for (const u of [olga(), 'u1', 'u2', 'u3', 'u4', 'u5']) send(u)
  expect(launches).toHaveLength(START_BURST)
  const d = rt.drain(5000)
  advance(START_SPREAD_MS)
  expect(launches).toHaveLength(6)
  for (const l of launches) finish(l.exec)
  expect(await d).toBe(true)
  rt.resume()
})

test('one person, concurrency 10, 7 sends: all accepted and running, at most START_BURST launches per START_SPREAD_MS', async () => {
  await setup('one-person', 1, 10)
  const me = olga()
  for (let i = 0; i < 7; i++) expect(() => send(me)).not.toThrow()
  expect(rt.runningCount()).toBe(7)
  await waitFor(() => launches.length === 7)
  for (let i = START_BURST; i < launches.length; i++) expect(launches[i]!.at - launches[i - START_BURST]!.at).toBeGreaterThanOrEqual(START_SPREAD_MS)
})

// QA rev2 repro for #463: holding turns in the queue for the spread moved round-robin tickets. Concurrency 3, after a
// warm-up burst: A sends A1, A2; B sends B1; then B2 and A3. When A2 ends, B's older B2 starts (as with no gate).
async function twoPeople(burst: number) {
  await setup(`two-${burst}`, 2, 3, { burst })
  const a = olga(), b = 'u1'
  const names = new Map<string, string>()
  const sendAs = (u: string, n: string) => names.set(send(u).turnId, n)
  const now = () => [...running().keys()].map((id) => names.get(id)).sort().join(',')
  const end = (n: string) => { const id = [...names].find(([, x]) => x === n)![0]; finish(running().get(id)!) }
  sendAs(a, 'w1'); sendAs(a, 'w2'); sendAs(b, 'w3')
  await waitFor(() => !gated().length); end('w1'); end('w2'); end('w3')
  sendAs(a, 'A1'); sendAs(a, 'A2'); sendAs(b, 'B1'); sendAs(b, 'B2'); sendAs(a, 'A3')
  const first = now()
  const tickets = [...(rt as any).queueStore.tickets().entries()].sort((x: any, y: any) => x[1] - y[1]).map((e: any) => e[0] === a ? 'A' : 'B').join('<')
  await waitFor(() => !gated().length && !(rt as any).launchTimer)
  end('A2')
  const out = { first, tickets, after: now() }
  await close()
  return out
}
test('two people, fixed order (A1,A2 / B1 / B2,A3): the same running set and tickets as with no gate', async () => {
  const dev = await twoPeople(0)
  const gate = await twoPeople(START_BURST)
  expect(dev).toEqual({ first: 'A1,A2,B1', tickets: dev.tickets, after: 'A1,B1,B2' })
  expect(gate).toEqual(dev)
})
