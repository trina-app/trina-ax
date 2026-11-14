import { afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { openDb } from '../../server/src/db'
import { setApiEnginePublicOnly } from '../../server/src/system/egress'
import { LAUNCHER_BACKSTOP_MS, QUARANTINE_HOLD_MAX_MS, STALL_TIMEOUT_MS, TURN_STOP_GRACE_MS, TurnExec, type TurnSpec } from '../../server/src/chat/turn'
import { runApiAgent } from '../../server/src/engine/api-agent'
import type { ChatRuntime } from '../../server/src/chat/runtime'
import { TurnRegistry } from '../../server/src/turns'
import { ALIVE_EVERY_MS, aliveSignal } from '../../server/src/proxy/model-proxy'
import { silentLogger } from '../../server/src/log'

// The API-engine test below injects a transport for http://127.0.0.1:1: a self-hosted server, where the API engine may
// use any address. The cloud's public-https-only check is process-wide (system/egress.ts) and is turned on by any
// hosted app an earlier test file started in the same bun process; with it on, the call was refused before the
// transport ran (0 requests). Whether such a file ran first depended on the directory order bun reads (on the Linux
// server g-cloud-deployment.test.ts ran just before this file).
beforeAll(() => setApiEnginePublicOnly(false))
const cleanups: (() => void)[] = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
// One answer has no time limit (docs/DECISIONS.md "No time limit on one answer"): `stallMs` is the stall guard's
// silence (STALL_TIMEOUT_MS in production). The guard looks once a second.
function setup(stallMs: number) {
  const db = openDb(':memory:')
  db.query("INSERT INTO users(id,username,name,role) VALUES('u','u','U','member')").run()
  db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,dispatched_at) VALUES('t','c','u','api','running',?)").run(new Date().toISOString())
  const events: any[] = [], released: string[] = [], quarantined: string[] = []
  const rt = {
    db, stallTimeoutMs: stallMs, quarantineReleaseGraceMs: 300_000, log: silentLogger,
    ctx: { config: { mode: 'dev', engine: {} } },
    hub: { publish: (_: string, event: any) => events.push(event) }, relay: { cancelTurn() {} },
    store: { touchChat() {}, chatRow: () => null, messageRow: () => null, userRef: () => null },
    publishChat() {}, turnFinished: (e: TurnExec) => released.push(e.id),
    turnQuarantined: (e: TurnExec) => quarantined.push(e.id),
    launcherReady: async () => {}, launcherStopped() {}, shutdownCause: () => 'restart',
  } as unknown as ChatRuntime
  const spec: TurnSpec = { turnId: 't', chatId: 'c', userId: 'u', assistantId: 'a', userMessageId: 'm',
    engine: 'api', model: null, locale: 'en', windowId: null, clientKind: 'web' }
  const exec = new TurnExec(rt, spec)
  cleanups.push(() => { exec.stop(); db.close() })
  return { db, rt, exec, events, released, quarantined }
}

test('the stall guard is 15 minutes of silence, far below the launcher backstop', () => {
  expect(STALL_TIMEOUT_MS).toBe(15 * 60_000)
  expect(LAUNCHER_BACKSTOP_MS).toBe(12 * 60 * 60_000)
})

test('an engine that produces nothing for the stall time ends the turn as stalled', async () => {
  const f = setup(500)
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    await new Promise<void>((resolve) => f.exec.abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  await f.exec.run()
  expect(f.exec.stopReason).toBe('timeout')
  expect(f.released).toEqual(['t'])
  expect(f.db.query("SELECT status, error FROM turns WHERE id='t'").get()).toEqual({ status: 'error', error: "The AI didn't respond for 15 minutes, so the answer was stopped. Please try again." })
})

test('waiting for a person pauses the stall guard: a card open longer than the stall time ends by its own time only', async () => {
  const f = setup(500)
  let answer: unknown = 'unresolved'
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    answer = await f.exec.waitForPerson({ requestId: 'r', kind: 'ask_user' } as any, { timeoutMs: 2500 })
  })
  await f.exec.run()
  expect(answer).toBeNull()
  expect(f.exec.stopReason).toBeNull()
  expect(f.exec.openRequests()).toEqual([])
  expect(f.released).toEqual(['t'])
  expect(f.events.some(x => x.type === 'turn.request.closed' && x.data.reason === 'timeout')).toBe(true)
  expect(f.db.query("SELECT status FROM turns WHERE id='t'").get()).toEqual({ status: 'done' })
})

test('one of our tool calls running pauses the stall guard; silence after it ends still stalls', async () => {
  const f = setup(500)
  let stoppedWhileCalling: unknown = 'unread'
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    const ended = f.exec.ownCallStarted()
    await Bun.sleep(2500)
    stoppedWhileCalling = f.exec.stopReason
    ended()
    ended() // twice: counted once
    await new Promise<void>((resolve) => f.exec.abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  await f.exec.run()
  expect(stoppedWhileCalling).toBeNull()
  expect(f.exec.stopReason).toBe('timeout')
})

test('launcher transport loss is not proof of termination and cannot release its slot before the launch\'s own end', async () => {
  const f = setup(60_000)
  const launchedAt = performance.now()
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
  // held until the launch's own end, but at most 45 minutes past the stop (the backstop is 12 h), plus the grace
  const releaseAt = f.exec.quarantineState()!.releaseAt
  expect(releaseAt).toBeGreaterThan(launchedAt + 300_000)
  expect(releaseAt).toBeLessThanOrEqual(performance.now() + QUARANTINE_HOLD_MAX_MS + 300_000)
  expect(releaseAt).toBeGreaterThanOrEqual(launchedAt + QUARANTINE_HOLD_MAX_MS + 300_000 - 1000)
})

test('every launch gets the launcher backstop, not a remaining time; its confirmed exit returns one slot', async () => {
  const f = setup(60_000)
  const limits: number[] = []
  const core = { turns: { bind() {} }, launcher: { launch: (request: any) => {
    limits.push(request.timeoutMs)
    return { kill() {}, events: (async function* () { yield { ev: 'exit', code: 0 } })() }
  } } }
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    await (f.exec as any).launch(core, {}, () => {})
    await Bun.sleep(25)
    await (f.exec as any).launch(core, { timeoutMs: LAUNCHER_BACKSTOP_MS }, () => {})
  })
  await f.exec.run()
  expect(limits).toEqual([LAUNCHER_BACKSTOP_MS, LAUNCHER_BACKSTOP_MS])
  expect(f.released).toEqual(['t'])
})

test('a thrown launcher stream requests termination and retains the unconfirmed slot', async () => {
  const f = setup(60_000); let kills = 0
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
  const f = setup(60_000)
  const at = '2026-10-27T00:00:00.000Z'
  f.db.query("UPDATE turns SET started_at=?, dispatched_at=? WHERE id='t'").run(at, at)
  const registry = new TurnRegistry(f.db, 501)
  const { token } = registry.create('u', 'c', 'api', null, 't')
  expect(f.db.query("SELECT started_at FROM turns WHERE id='t'").get()).toEqual({ started_at: at })
  registry.invalidate('t')
  expect(await registry.authenticate(token, { pid: 1, uid: 501, gid: 501, pgid: 1, sid: 1 })).toContain('expired')
})

test('a terminal or missing claimed turn cannot regain a live tool token', () => {
  const f = setup(60_000), registry = new TurnRegistry(f.db, 501)
  f.db.query("UPDATE turns SET status='stopped' WHERE id='t'").run()
  expect(() => registry.create('u', 'c', 'api', null, 't')).toThrow()
  expect(registry.get('t')).toBeUndefined()
  expect(() => registry.create('u', 'c', 'api', null, 'missing')).toThrow()
})

test('real API agent: a model request that never answers is aborted at a stall, without a second request', async () => {
  const f = setup(500); let calls = 0, aborted = false
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    calls++
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic abort')) }, { once: true })
    })
  }) as unknown as typeof fetch
  spyOn(f.exec as any, 'execute').mockImplementation(async () => runApiAgent({
    conf: { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', label: 'Synthetic', key: null },
    message: 'test', systemPrompt: 'test', rpc: async () => ({ result: { tools: [] } }), emit: () => {},
    signal: f.exec.abort.signal, fetchFn, headersTimeoutMs: 60_000,
  }))
  await f.exec.run()
  expect(calls).toBe(1); expect(aborted).toBe(true)
  expect(f.exec.stopReason).toBe('timeout'); expect(f.released).toEqual(['t'])
})

test('the API engine\'s stream chunks are signs of life: a slow but steady answer is not a stall', async () => {
  const f = setup(500)
  const enc = new TextEncoder()
  const chunk = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)
  const fetchFn = (async () => new Response(new ReadableStream({
    async start(c) {
      // about 2.4 s of chunks that give no event of their own (like a tool call's arguments), then the answer
      for (let i = 0; i < 6; i++) { c.enqueue(chunk({ choices: [{ delta: {} }] })); await Bun.sleep(400) }
      c.enqueue(chunk({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }))
      c.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
  const texts: string[] = []
  spyOn(f.exec as any, 'execute').mockImplementation(async () => runApiAgent({
    conf: { baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', label: 'Synthetic', key: null },
    message: 'test', systemPrompt: 'test', rpc: async () => ({ result: { tools: [] } }), emit: (e) => { if (e.type === 'text') texts.push(e.delta) },
    signal: f.exec.abort.signal, fetchFn, activity: () => (f.exec as any).sign(),
  }))
  await f.exec.run()
  expect(f.exec.stopReason).toBeNull()
  expect(texts.join('')).toBe('ok')
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

test('a model answer streaming through the proxy (activity) keeps the turn alive; the signal is throttled per stream', async () => {
  const f = setup(500)
  spyOn(f.exec as any, 'execute').mockImplementation(async () => {
    for (let i = 0; i < 6; i++) { (f.exec as any).onProxyEvent({ type: 'activity' }); await Bun.sleep(400) }
  })
  await f.exec.run()
  expect(f.exec.stopReason).toBeNull()
  const sent: string[] = []
  const alive = aliveSignal('t', (turnId, ev) => sent.push(`${turnId}:${ev.type}`))
  alive(); alive(); alive()
  expect(sent).toEqual(['t:activity'])
  expect(ALIVE_EVERY_MS).toBe(10_000)
})
