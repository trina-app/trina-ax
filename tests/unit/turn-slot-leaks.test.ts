// A turn's slot (and its chat) always comes back (fix/turn-slot-leaks, 2026-11-11):
// 1. a turn quarantined because the launcher connection broke (termination unconfirmed) gives its slot back once its
//    engine's process group is gone, the launcher reports no engine (group unknown), or at a bounded deadline;
// 2. a throw while dispatching one turn never stops the queue (before: every later send 503): a failed claim (rolled
//    back) is tried again, a few times at most, then only that turn fails;
// 3. a throw in the turn's end still records an end state, gives the slot back and resolves `done`.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { CLAIM_TRIES, getChatRuntime, processGroupGone, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { waitFor } from '../lib/wait'

let h: Harness, rt: ChatRuntime
const spies: { mockRestore(): void }[] = []
/** what each turn's engine does, by the chat's id (default: ends at once, normally) */
const engines = new Map<string, (exec: TurnExec) => Promise<void>>()
const execs: TurnExec[] = []

async function setup(name: string) {
  spies.push(spyOn(TurnExec.prototype as any, 'execute').mockImplementation(async function (this: TurnExec) {
    execs.push(this)
    await engines.get(this.spec.chatId)?.(this)
  }))
  h = await harness(`slot-${name}`); await withOwner(h)
  rt = getChatRuntime(h.ctx)
  rt.quarantineProbeMs = 60 * 60_000 // the test probes by hand
  setSetting(h.ctx.db, 'concurrency', 1)
}
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore()
  engines.clear(); execs.length = 0
  if (h) await h.close()
})

function newChat() {
  const id = newId()
  h.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, 'olga')
  return id
}
function send(chatId: string) {
  return rt.createTurn({ chat: rt.store.chatRow(chatId)!, userId: 'olga', locale: 'en', windowId: null, clientKind: 'web', engine: 'api', model: null,
    user: { content: 'synthetic request', parentId: null, attachments: [], clientMessageId: crypto.randomUUID() } })
}
const turnStatus = (id: string) => (h.ctx.db.query('SELECT status FROM turns WHERE id=?').get(id) as { status: string }).status
const messageStatus = (id: string) => (h.ctx.db.query('SELECT status FROM messages WHERE id=?').get(id) as { status: string }).status

/** an engine launch whose launcher connection breaks mid-turn (SocketLauncher's synthesized transport error) */
function brokenLauncher(pgid: number | null) {
  return async (exec: TurnExec) => {
    const core = { turns: { bind() {} }, launcher: { launch: () => ({ kill() {}, events: (async function* () {
      if (pgid !== null) yield { ev: 'started', pid: pgid, pgid }
      yield { ev: 'error', message: 'launcher: read ECONNRESET' }
    })() }) } }
    await (exec as any).launch(core, {}, () => {})
  }
}
async function goneGroup(): Promise<number> {
  const p = Bun.spawn(['true'])
  await p.exited
  expect(processGroupGone(p.pid)).toBe(true)
  return p.pid
}
async function liveGroup(): Promise<number> {
  const out = await new Response(Bun.spawn(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout).text()
  const pgid = Number(out.trim())
  expect(processGroupGone(pgid)).toBe(false)
  return pgid
}

test('a turn quarantined by a broken launcher connection gives its slot back once its engine is gone', async () => {
  await setup('gone')
  const a = newChat(), b = newChat()
  engines.set(a, brokenLauncher(await goneGroup()))
  const first = send(a)
  await waitFor(() => execs.length === 1 && execs[0]!.status === 'finished')
  await execs[0]!.done
  // termination unconfirmed: the answer failed, the slot and the chat stay held
  expect(messageStatus(first.assistantMessage.id)).toBe('error')
  expect(rt.queueDiagnostics().quarantined).toBe(1)
  expect(rt.runState(a)).not.toBe('idle')
  const second = send(b)
  expect(rt.runningCount()).toBe(1)
  expect(rt.queuedCount()).toBe(1)
  // the probe finds the process group gone: the slot is back, the waiting answer runs and ends
  await rt.probeQuarantined()
  expect(rt.queueDiagnostics().quarantined).toBe(0)
  expect(await waitFor(() => turnStatus(second.turnId) === 'done')).toBe(true)
  expect(rt.runningCount()).toBe(0)
  // and the chat takes a new question again (its engine works this time)
  engines.delete(a)
  const again = send(a)
  expect(await waitFor(() => turnStatus(again.turnId) === 'done')).toBe(true)
}, 30_000)

test('an engine still running keeps the slot until the bounded deadline; Stop only looks again', async () => {
  await setup('alive')
  const a = newChat()
  engines.set(a, brokenLauncher(await liveGroup()))
  send(a)
  await waitFor(() => execs[0]?.status === 'finished')
  await execs[0]!.done
  await rt.probeQuarantined()
  expect(rt.queueDiagnostics().quarantined).toBe(1)
  // Stop on the ended answer never releases an unconfirmed engine by itself
  expect(rt.stopChat(a)).toBe(execs[0]!.id)
  await rt.probeQuarantined()
  expect(rt.runningCount()).toBe(1)
  // past the wall deadline plus the grace: released, the answer stays failed
  ;(execs[0] as any).wallEndsAt = 0
  rt.quarantineReleaseGraceMs = 0
  await rt.probeQuarantined()
  expect(rt.queueDiagnostics().quarantined).toBe(0)
  expect(rt.runningCount()).toBe(0)
  expect(turnStatus(execs[0]!.id)).toBe('error')
}, 30_000)

test('with no process group known, only a launcher with no live engine releases the slot', async () => {
  await setup('nopgid')
  const a = newChat()
  engines.set(a, brokenLauncher(null))
  send(a)
  await waitFor(() => execs[0]?.status === 'finished')
  await execs[0]!.done
  let live: number | null = null
  spies.push(spyOn(rt, 'launcherLiveTurns').mockImplementation(async () => live))
  await rt.probeQuarantined()
  expect(rt.runningCount()).toBe(1)
  live = 2
  await rt.probeQuarantined()
  expect(rt.runningCount()).toBe(1)
  live = 0
  await rt.probeQuarantined()
  expect(rt.runningCount()).toBe(0)
}, 30_000)

test('a throw while claiming a turn is tried again; one that keeps failing ends only that turn', async () => {
  await setup('dispatch')
  const a = newChat(), b = newChat(), c = newChat()
  // once: the claim's transaction rolled back, the turn stays queued and runs on the next try (capacity watcher)
  const once = spyOn(rt.queueStore, 'claim').mockImplementationOnce(() => { throw new Error('injected claim failure') })
  const first = send(a)
  expect(turnStatus(first.turnId)).toBe('queued')
  expect(rt.acceptingTurns).toBe(true)
  expect(await waitFor(() => turnStatus(first.turnId) === 'done', { timeoutMs: 10_000 })).toBe(true)
  once.mockRestore()
  // every time: after CLAIM_TRIES tries only that turn fails, and the queue goes on
  const always = spyOn(rt.queueStore, 'claim').mockImplementation(() => { throw new Error('injected claim failure') })
  spies.push(always)
  const second = send(b)
  // tried again only after a pause, CLAIM_TRIES times in all
  rt.schedule()
  expect(always).toHaveBeenCalledTimes(1)
  expect(await waitFor(() => turnStatus(second.turnId) === 'error', { timeoutMs: 15_000 })).toBe(true)
  expect(always).toHaveBeenCalledTimes(CLAIM_TRIES)
  expect(messageStatus(second.assistantMessage.id)).toBe('error')
  expect(rt.runningCount() + rt.queuedCount()).toBe(0)
  always.mockRestore()
  const third = send(c)
  expect(await waitFor(() => turnStatus(third.turnId) === 'done')).toBe(true)
  // the failed chat takes a new question too
  const again = send(b)
  expect(await waitFor(() => turnStatus(again.turnId) === 'done')).toBe(true)
}, 30_000)

test('a quarantined turn whose launcher never confirms the end is made to end at the release time', async () => {
  await setup('stuck')
  const a = newChat()
  const pgid = await liveGroup()
  engines.set(a, async (exec) => {
    const core = { turns: { bind() {} }, launcher: { launch: () => ({ kill() {}, events: (async function* () {
      yield { ev: 'started', pid: pgid, pgid }
      await new Promise(() => {}) // connected, never an exit
    })() }) } }
    await (exec as any).launch(core, {}, () => {})
  })
  send(a)
  await waitFor(() => execs.length === 1)
  rt.stopChat(a)
  ;(execs[0] as any).quarantine() // what the stop grace does when no exit comes
  await rt.probeQuarantined()
  expect(execs[0]!.status).not.toBe('finished')
  ;(execs[0] as any).wallEndsAt = 0
  rt.quarantineReleaseGraceMs = 0
  await rt.probeQuarantined()
  await execs[0]!.done
  expect(turnStatus(execs[0]!.id)).toBe('error')
  await rt.probeQuarantined()
  expect(rt.runningCount()).toBe(0)
  expect(rt.queueDiagnostics().quarantined).toBe(0)
}, 30_000)

test('a throw in the end of a turn still ends it, gives the slot back and resolves done', async () => {
  await setup('finish')
  const a = newChat(), b = newChat()
  // a step of the end failing on its own (the browser relay): the answer still ends normally
  const relay = spyOn(rt.relay, 'cancelTurn').mockImplementationOnce(() => { throw new Error('injected relay failure') })
  spies.push(relay)
  const first = send(a)
  expect(await waitFor(() => turnStatus(first.turnId) === 'done')).toBe(true)
  expect(messageStatus(first.assistantMessage.id)).toBe('done')
  expect(rt.runningCount()).toBe(0)
  // the end state itself failing (the final redaction): the turn fails, but ends
  const redact = spyOn(TurnExec.prototype, 'redact').mockImplementation(() => { throw new Error('injected finish failure') })
  spies.push(redact)
  const second = send(b)
  await waitFor(() => execs.length === 2)
  await execs[1]!.done
  redact.mockRestore()
  expect(turnStatus(second.turnId)).toBe('error')
  expect(messageStatus(second.assistantMessage.id)).toBe('error')
  expect(rt.runningCount()).toBe(0)
  const again = send(b)
  expect(await waitFor(() => turnStatus(again.turnId) === 'done')).toBe(true)
}, 30_000)
