// QA TC-338: answers running when an update starts end cleanly, and queued messages run after it.
// 1. the engine launcher's orderly stop (mycel-launcher ending.go: prepare-stop "update" from mycel-ctl update, or
//    SIGTERM "shutdown") is a confirmed end: the answer says Trina was updating (or the server restarted), never that
//    the engine stopped unexpectedly, is not retried as a crash, and its turn slot is not quarantined;
// 2. the server's own stop for an update says so too, also for an answer that did not end before the server went
//    (the next start's recovery); queued messages and a scheduled task whose time passed meanwhile run after the
//    restart, in order.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { STOPPED_FOR_UPDATE, getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { getSetting, setSetting } from '../../server/src/admin/settings'
import { CHAT_ERROR_MESSAGES } from '../../shared/src/api/errors'
import { CONFIRMED } from '../lib/schedule-card'
import { waitFor } from '../lib/wait'

let h: Harness, rt: ChatRuntime
const spies: { mockRestore(): void }[] = []
/** what each turn's engine does, by the chat's id (default: ends at once, normally) */
const engines = new Map<string, (exec: TurnExec) => Promise<void>>()
const execs: TurnExec[] = []

async function setup(name: string, o: { reuse?: boolean } = {}) {
  spies.push(spyOn(TurnExec.prototype as any, 'execute').mockImplementation(async function (this: TurnExec) {
    execs.push(this)
    await engines.get(this.spec.chatId)?.(this)
  }))
  h = await harness(`upd-${name}`, {}, o)
  if (!o.reuse) await withOwner(h)
  rt = getChatRuntime(h.ctx)
  rt.quarantineProbeMs = 60 * 60_000
  ;(rt as any).probedAt = Date.now()
  rt.startSpreadMs = 0
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
const message = (id: string) => {
  const r = h.ctx.db.query('SELECT status, error FROM messages WHERE id=?').get(id) as { status: string; error: string | null }
  return { status: r.status, error: r.error ? JSON.parse(r.error) : null }
}

/** an engine launch that the launcher ends in an orderly stop: its exit event says why (signal) */
function launcherStops(signal: 'update' | 'shutdown', launches: { n: number }) {
  return async (exec: TurnExec) => {
    const core = { turns: { bind() {} }, launcher: { launch: () => { launches.n++; return { kill() {}, events: (async function* () {
      yield { ev: 'started', pid: 999_999, pgid: 999_999 }
      yield { ev: 'stdout', b64: Buffer.from('{"type":"system","subtype":"init"}\n').toString('base64') }
      yield { ev: 'exit', code: 0, signal }
    })() } } } }
    await (exec as any).launch(core, {}, () => {})
  }
}
/** an engine that runs until the turn is stopped */
function runsUntilStopped() {
  return async (exec: TurnExec) => {
    const abort = (exec as any).abort as AbortController
    await new Promise<void>((r) => abort.signal.aborted ? r() : abort.signal.addEventListener('abort', () => r(), { once: true }))
  }
}

test('an update that restarts the launcher ends the answer as stopped for the update: no crash, no quarantine, the queue goes on', async () => {
  await setup('launcher-update')
  const a = newChat(), b = newChat()
  const launches = { n: 0 }
  engines.set(a, launcherStops('update', launches))
  const first = send(a)
  const queued = send(b) // waits behind it (one slot)
  expect(await waitFor(() => turnStatus(first.turnId) === 'interrupted')).toBe(true)
  await execs[0]!.done
  const m = message(first.assistantMessage.id)
  expect(m.status).toBe('error')
  expect(m.error).toMatchObject({ code: 'unavailable', message: CHAT_ERROR_MESSAGES.updating.en, params: { reason: 'updating' } })
  expect(m.error.message).toBe('This answer stopped because Trina was updating. Send it again.')
  // one launch: an orderly stop is never retried as a crash
  expect(launches.n).toBe(1)
  // the end is confirmed: no quarantined slot, the queued message runs and a new question is answered
  expect(rt.queueDiagnostics().quarantined).toBe(0)
  expect(await waitFor(() => turnStatus(queued.turnId) === 'done')).toBe(true)
  engines.delete(a)
  const again = send(a)
  expect(await waitFor(() => turnStatus(again.turnId) === 'done')).toBe(true)
  expect(rt.runningCount()).toBe(0)
  expect(rt.runState(a)).toBe('idle')
}, 30_000)

test('a launcher stopped for another reason says the server restarted, or the update when one is under way', async () => {
  await setup('launcher-shutdown')
  const a = newChat(), b = newChat()
  engines.set(a, launcherStops('shutdown', { n: 0 }))
  engines.set(b, launcherStops('shutdown', { n: 0 }))
  rt.shutdownCause = () => 'restart'
  const first = send(a)
  expect(await waitFor(() => turnStatus(first.turnId) === 'interrupted')).toBe(true)
  expect(message(first.assistantMessage.id).error).toMatchObject({ params: { reason: 'interrupted' } })
  expect(rt.queueDiagnostics().quarantined).toBe(0)
  // an installer stopped the launcher while this server switches versions (office mode): the update words
  rt.shutdownCause = () => 'update'
  const second = send(b)
  expect(await waitFor(() => turnStatus(second.turnId) === 'interrupted')).toBe(true)
  expect(message(second.assistantMessage.id).error).toMatchObject({ params: { reason: 'updating' } })
  expect(rt.queueDiagnostics().quarantined).toBe(0)
}, 30_000)

test('the server stopping for an update: the running answer says so; queued messages and a missed scheduled task run after the restart, in order', async () => {
  await setup('server-update')
  const a = newChat(), b = newChat(), c = newChat()
  engines.set(a, runsUntilStopped())
  const running = send(a)
  const q1 = send(b), q2 = send(c)
  expect(await waitFor(() => turnStatus(running.turnId) === 'running')).toBe(true)
  const s = rt.schedules.create('olga', { title: 'Synthetic', prompt: 'synthetic task', repeat: 'once', date: '2099-10-27', time: '09:00' }, new Date('2099-10-26T00:00:00Z'), CONFIRMED)
  rt.shutdownCause = () => 'update'
  await rt.shutdown()
  expect(turnStatus(running.turnId)).toBe('interrupted')
  expect(message(running.assistantMessage.id)).toMatchObject({ status: 'error', error: { params: { reason: 'updating' } } })
  expect(rt.queueDiagnostics().quarantined).toBe(0)
  // the queued ones wait for the new version
  expect(turnStatus(q1.turnId)).toBe('queued')
  expect(turnStatus(q2.turnId)).toBe('queued')
  expect(getSetting(h.ctx.db, STOPPED_FOR_UPDATE)).toBeTruthy()
  // the new version starts: the queued messages run in the order they were sent
  for (const x of spies.splice(0)) x.mockRestore()
  execs.length = 0
  await h.close()
  await setup('server-update', { reuse: true })
  expect(await waitFor(() => turnStatus(q1.turnId) === 'done' && turnStatus(q2.turnId) === 'done')).toBe(true)
  expect(execs.map((e) => e.id)).toEqual([q1.turnId, q2.turnId])
  expect(getSetting(h.ctx.db, STOPPED_FOR_UPDATE)).toBeUndefined()
  // a scheduled task whose time passed while the server was away runs once now
  expect(rt.schedules.runDue(new Date('2099-10-27T09:05:00Z'))).toEqual([s.id])
  expect(await waitFor(() => (h.ctx.db.query("SELECT COUNT(*) n FROM turns WHERE schedule_id=? AND status='done'").get(s.id) as { n: number }).n === 1)).toBe(true)
}, 60_000)

test('an answer that did not end before the server stopped for the update: the next start says it was the update', async () => {
  await setup('recover-update')
  const a = newChat(), b = newChat()
  const pause = spyOn(rt, 'schedule').mockImplementation(() => {})
  const left = send(a), plain = send(b)
  // the server went before these ended (the 6 s limit of shutdown): running rows, and the note shutdown leaves
  h.ctx.db.query("UPDATE turns SET status='running' WHERE id IN (?,?)").run(left.turnId, plain.turnId)
  setSetting(h.ctx.db, STOPPED_FOR_UPDATE, new Date().toISOString())
  pause.mockRestore()
  for (const x of spies.splice(0)) x.mockRestore()
  await h.close()
  await setup('recover-update', { reuse: true })
  expect(turnStatus(left.turnId)).toBe('interrupted')
  expect(message(left.assistantMessage.id).error).toMatchObject({ params: { reason: 'updating' } })
  expect(getSetting(h.ctx.db, STOPPED_FOR_UPDATE)).toBeUndefined()
  // without the note (a crash, a plain restart): the restart words, as before
  const c = newChat()
  const pause2 = spyOn(rt, 'schedule').mockImplementation(() => {})
  const crashed = send(c)
  h.ctx.db.query("UPDATE turns SET status='running' WHERE id=?").run(crashed.turnId)
  pause2.mockRestore()
  for (const x of spies.splice(0)) x.mockRestore()
  await h.close()
  await setup('recover-update', { reuse: true })
  expect(message(crashed.assistantMessage.id).error).toMatchObject({ params: { reason: 'interrupted' } })
}, 60_000)
