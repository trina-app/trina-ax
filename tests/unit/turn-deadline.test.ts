import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { openDb } from '../../server/src/db'
import { setApiEnginePublicOnly } from '../../server/src/system/egress'
import { TURN_STOP_GRACE_MS, TurnExec, type TurnSpec } from '../../server/src/chat/turn'
import { runApiAgent } from '../../server/src/engine/api-agent'
import type { ChatRuntime } from '../../server/src/chat/runtime'
import { TurnRegistry } from '../../server/src/turns'
import { silentLogger } from '../../server/src/log'

// The API-engine test below injects a transport for http://127.0.0.1:1: a self-hosted server, where the API engine may
// use any address. The cloud's public-https-only check is process-wide (system/egress.ts) and is turned on by any
// hosted app an earlier test file started in the same bun process; with it on, the call was refused before the
// transport ran (0 requests). Whether such a file ran first depended on the directory order bun reads (on the Linux
// server g-cloud-deployment.test.ts ran just before this file).
beforeAll(() => setApiEnginePublicOnly(false))
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
function setup(ms: number, at?: string) {
  const db = openDb(':memory:')
  // the deadline counts from here, after the migrations: opening the database is not part of the turn's time (it
  // took ~40 ms of a 60 ms deadline on a 2-vCPU server)
  const deadline = at ?? new Date(Date.now() + ms).toISOString()
  db.query("INSERT INTO users(id,username,name,role) VALUES('u','u','U','member')").run()
  db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,dispatched_at,wall_deadline_at) VALUES('t','c','u','api','running',?,?)").run(new Date().toISOString(), deadline)
  const events: any[] = [], released: string[] = [], quarantined: string[] = []
  const rt = {
    db, wallTimeoutMs: ms, turnTimeoutMs: 60_000, log: silentLogger,
    ctx: { config: { mode: 'dev', engine: {} } },
    hub: { publish: (_: string, event: any) => events.push(event) }, relay: { cancelTurn() {} },
    store: { touchChat() {}, messageRow: () => null, userRef: () => null },
    publishChat() {}, turnFinished: (e: TurnExec) => released.push(e.id),
    turnQuarantined: (e: TurnExec) => quarantined.push(e.id),
  } as unknown as ChatRuntime
  const spec: TurnSpec = { turnId: 't', chatId: 'c', userId: 'u', assistantId: 'a', userMessageId: 'm',
    engine: 'api', model: null, locale: 'en', windowId: null, clientKind: 'web', wallDeadlineAt: deadline }
  const exec = new TurnExec(rt, spec)
  cleanups.push(() => { exec.stop(); db.close() })
  return { db, rt, exec, events, released, quarantined }
}

test('expired dispatch deadline does not start an engine or reset the deadline', async () => {
  const f = setup(45 * 60_000, new Date(Date.now() - 1).toISOString())
  const execute = spyOn(f.exec as any, 'execute').mockImplementation(async () => {})
  await f.exec.run()
  expect(execute).not.toHaveBeenCalled()
  expect(f.exec.stopReason).toBe('timeout')
  expect(f.released).toEqual(['t'])
  expect(f.db.query("SELECT status FROM turns WHERE id='t'").get()).toEqual({ status: 'error' })
})

test('waiting for a person pauses active time but never the dispatch deadline', async () => {
  const f = setup(80)
  let answer: unknown = 'unresolved'
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    answer = await f.exec.waitForPerson({ requestId: 'r', kind: 'ask_user' } as any, { timeoutMs: 60_000 })
  })
  await f.exec.run()
  expect(answer).toBeNull()
  expect(f.exec.stopReason).toBe('timeout')
  expect(f.exec.openRequests()).toEqual([])
  expect(f.released).toEqual(['t'])
  expect(f.events.some(x => x.type === 'turn.request.closed')).toBe(true)
})

test('launcher transport loss is not proof of termination and cannot release its slot', async () => {
  const f = setup(500)
  const core = { turns: { bind() {} }, launcher: { launch: () => ({ kill() {}, events: (async function* () {
    yield { ev: 'started', pgid: 42 }
  })() }) } }
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    await (f.exec as any).launch(core, {}, () => {})
  })
  await f.exec.run()
  expect(f.released).toEqual([])
  expect(f.quarantined).toEqual(['t'])
  expect(f.db.query("SELECT status FROM turns WHERE id='t'").get()).toEqual({ status: 'error' })
})

test('a retry receives only the remaining wall time; its confirmed exit returns one slot', async () => {
  const f = setup(500)
  const limits: number[] = []
  const core = { turns: { bind() {} }, launcher: { launch: (request: any) => {
    limits.push(request.timeoutMs)
    return { kill() {}, events: (async function* () { yield { ev: 'exit', code: 0 } })() }
  } } }
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    await (f.exec as any).launch(core, { timeoutMs: 3 * 60 * 60_000 }, () => {})
    await Bun.sleep(25)
    await (f.exec as any).launch(core, { timeoutMs: 3 * 60 * 60_000 }, () => {})
  })
  await f.exec.run()
  expect(limits).toHaveLength(2)
  expect(limits[0]!).toBeLessThanOrEqual(500)
  expect(limits[1]!).toBeLessThan(limits[0]!)
  expect(f.released).toEqual(['t'])
})

test('a thrown launcher stream requests termination and retains the unconfirmed slot', async () => {
  const f = setup(500); let kills = 0
  const core = { turns: { bind() {} }, launcher: { launch: () => ({ kill() { kills++ }, events: (async function* () {
    yield { ev: 'started', pgid: 42 }
    throw new Error('synthetic broken event stream')
  })() }) } }
  spyOn(f.exec as any, 'execute').mockImplementation(async () => { await (f.exec as any).launch(core, {}, () => {}) })
  await f.exec.run()
  expect(kills).toBe(1); expect(f.exec.abort.signal.aborted).toBe(true)
  expect(f.released).toEqual([]); expect(f.quarantined).toEqual(['t'])
})

test('registering a claimed turn preserves its dispatch time and revocation closes tokens immediately', async () => {
  const f = setup(500)
  const at = '2026-10-27T00:00:00.000Z'
  f.db.query("UPDATE turns SET started_at=?, dispatched_at=? WHERE id='t'").run(at, at)
  const registry = new TurnRegistry(f.db, 501)
  const { token } = registry.create('u', 'c', 'api', null, 't')
  expect(f.db.query("SELECT started_at FROM turns WHERE id='t'").get()).toEqual({ started_at: at })
  registry.invalidate('t')
  expect(await registry.authenticate(token, { pid: 1, uid: 501, gid: 501, pgid: 1, sid: 1 })).toContain('expired')
})

test('a terminal or missing claimed turn cannot regain a live tool token', () => {
  const f = setup(500), registry = new TurnRegistry(f.db, 501)
  f.db.query("UPDATE turns SET status='stopped' WHERE id='t'").run()
  expect(() => registry.create('u', 'c', 'api', null, 't')).toThrow()
  expect(registry.get('t')).toBeUndefined()
  expect(() => registry.create('u', 'c', 'api', null, 'missing')).toThrow()
})

test('real API agent aborts its injected transport at the wall deadline without a second request', async () => {
  const f = setup(60); let calls = 0, aborted = false
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    calls++
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')) }, { once: true })
    })
  }) as unknown as typeof fetch
  spyOn(f.exec as any, 'execute').mockImplementation(async () => runApiAgent({
    conf: { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', label: 'Synthetic', key: null },
    message: 'test', systemPrompt: 'test', rpc: async () => ({ result: { tools: [] } }), emit: () => {},
    signal: f.exec.abort.signal, fetchFn,
  }))
  await f.exec.run()
  expect(calls).toBe(1); expect(aborted).toBe(true)
  expect(f.exec.stopReason).toBe('timeout'); expect(f.released).toEqual(['t'])
})

test('successive human waits share one absolute deadline', async () => {
  const f = setup(90); let first: unknown, second: unknown
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    first = await f.exec.waitForPerson({ requestId: 'first', kind: 'ask_user' } as any, { timeoutMs: 20 })
    second = await f.exec.waitForPerson({ requestId: 'second', kind: 'ask_user' } as any, { timeoutMs: 60_000 })
  })
  await f.exec.run()
  expect(first).toBeNull(); expect(second).toBeNull()
  expect(f.events.filter(e => e.type === 'turn.request')).toHaveLength(2)
  expect(f.exec.stopReason).toBe('timeout'); expect(f.released).toEqual(['t'])
})

test('stop revokes tokens now, quarantines after grace, and releases only after delayed native exit', async () => {
  const f = setup(20_000); const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    realTimeout(fn, ms === TURN_STOP_GRACE_MS ? 5 : ms, ...args)) as typeof setTimeout)
  cleanups.push(() => timer.mockRestore())
  let release!: () => void, kills = 0, invalidations = 0
  const exited = new Promise<void>(resolve => { release = resolve })
  const core = { turns: { bind() {}, invalidate() { invalidations++ } }, launcher: { launch: () => ({
    kill() { kills++ }, events: (async function* () { yield { ev: 'started', pgid: 42 }; await exited; yield { ev: 'exit', code: 0 } })(),
  }) } }
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    ;(f.exec as any).activeCore = core
    await (f.exec as any).launch(core, {}, () => {})
  })
  const run = f.exec.run(); await Bun.sleep(1); f.exec.stop()
  expect(invalidations).toBe(1); expect(kills).toBe(1)
  await Bun.sleep(15)
  expect(f.quarantined).toEqual(['t']); expect(f.released).toEqual([])
  release(); await run
  expect(f.released).toEqual(['t'])
  expect(TURN_STOP_GRACE_MS).toBe(10_000)
})
