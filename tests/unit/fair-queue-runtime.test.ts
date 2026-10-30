import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { CONFIRMED } from '../lib/schedule-card'

let h: Harness, rt: ChatRuntime
let starts: TurnExec[] = []
let fakeRun: ReturnType<typeof spyOn>
async function setup(name: string, people = 3) {
  starts = []
  fakeRun = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) { starts.push(this) })
  h = await harness(`fair-${name}`); const owner = await withOwner(h)
  rt = getChatRuntime(h.ctx)
  for (let i = 1; i < people; i++) h.ctx.db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(`u${i}`, `u${i}`, `U${i}`)
  return owner
}
function send(userId: string, cm = crypto.randomUUID(), chatId?: string) {
  const id = chatId ?? newId()
  if (!chatId) h.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, userId)
  return rt.createTurn({ chat: rt.store.chatRow(id)!, userId, locale: 'en', windowId: null, clientKind: 'web', engine: 'claude-code', model: null,
    user: { content: 'synthetic request', parentId: null, attachments: [], clientMessageId: cm } })
}
function finish(exec: TurnExec) {
  h.ctx.db.query("UPDATE turns SET status='done' WHERE id=?").run(exec.id)
  h.ctx.db.query("UPDATE messages SET status='done' WHERE id=?").run(exec.spec.assistantId)
  rt.turnFinished(exec)
  ;(exec as any).resolveDone()
}
afterEach(async () => {
  if (rt) {
    void rt.drain(0)
    for (const e of starts) finish(e)
  }
  if (h) await h.close()
  fakeRun?.mockRestore()
})

test('60 people can each admit three requests; user cap creates no turn/message rows', async () => {
  await setup('sixty', 60)
  const paused = spyOn(rt, 'schedule').mockImplementation(() => {})
  for (const u of ['olga', ...Array.from({ length: 59 }, (_, i) => `u${i + 1}`)]) for (let n = 0; n < 3; n++) send(u)
  expect(rt.queuedCount()).toBe(180)
  const before = h.ctx.db.query('SELECT COUNT(*) n FROM messages').get()
  expect(() => send('olga')).toThrow()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM messages').get()).toEqual(before)
  paused.mockRestore(); rt.schedule()
  expect(rt.runningCount()).toBe(3)
  expect(new Set(starts.map(e => e.spec.userId)).size).toBe(3)
  const lastSeq = new Map<string, number>()
  for (let i = 0; i < starts.length; i++) {
    const e = starts[i]!, seq = (h.ctx.db.query('SELECT queue_seq FROM turns WHERE id=?').get(e.id) as any).queue_seq
    expect(seq).toBeGreaterThan(lastSeq.get(e.spec.userId) ?? 0); lastSeq.set(e.spec.userId, seq)
    finish(e)
    expect(rt.runningCount()).toBeLessThanOrEqual(3)
  }
  expect(starts.length).toBe(180)
  expect(rt.queuedCount()).toBe(0); expect(rt.runningCount()).toBe(0)
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM turns WHERE status IN ('queued','running')").get()).toEqual({ n: 0 })
})

test('active occupancy, dynamic capacity and late completion preserve slots exactly once', async () => {
  await setup('occupancy')
  send('olga'); send('olga'); send('olga'); send('olga'); send('u1'); send('u2')
  expect(starts.map(e => e.spec.userId)).toEqual(['olga', 'olga', 'olga'])
  setSetting(h.ctx.db, 'concurrency', 1); rt.schedule(); finish(starts[0]!)
  expect(starts.length).toBe(3)
  setSetting(h.ctx.db, 'concurrency', 3); rt.schedule()
  expect(starts[3]!.spec.userId).toBe('u1')
  finish(starts[1]!); expect(starts[4]!.spec.userId).toBe('u2')
  const count = rt.runningCount(); rt.turnFinished(starts[1]!); expect(rt.runningCount()).toBe(count)
  const first = h.ctx.db.query('SELECT dispatched_at,wall_deadline_at FROM turns WHERE id=?').get(starts[0]!.id) as any
  expect(Date.parse(first.wall_deadline_at) - Date.parse(first.dispatched_at)).toBe(45 * 60_000)
})

test('1000 requests by one person cannot exclude the other 59 first requests', async () => {
  await setup('flood', 60)
  for (let i = 0; i < 6; i++) send('olga') // 3 executing + 3 waiting
  const before = h.ctx.db.query('SELECT COUNT(*) n FROM messages').get()
  const overflow = newId(); h.ctx.db.query("INSERT INTO chats(id,user_id) VALUES(?,'olga')").run(overflow)
  for (let i = 6; i < 1000; i++) expect(() => send('olga', crypto.randomUUID(), overflow)).toThrow()
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM messages').get()).toEqual(before)
  for (let i = 1; i < 60; i++) send(`u${i}`)
  expect(rt.queuedCount()).toBe(62)
  expect(rt.queueDiagnostics().rejected.queue_full_user).toBe(994)
  expect(rt.queueDiagnostics().rejected.queue_full).toBe(0)
})

test('60 schedules and 60 manual requests share each user FIFO and capacity', async () => {
  await setup('mixed', 60)
  const pause = spyOn(rt, 'schedule').mockImplementation(() => {})
  const people = ['olga', ...Array.from({ length: 59 }, (_, i) => `u${i + 1}`)]
  for (const u of people) rt.schedules.create(u, { title: 'Once', prompt: 'synthetic scheduled task', repeat: 'once', date: '2026-10-27', time: '09:00' }, new Date('2026-10-26T00:00:00Z'), CONFIRMED)
  expect(rt.schedules.runDue(new Date('2026-10-27T09:00:00Z'))).toHaveLength(60)
  for (const u of people) send(u)
  expect(rt.queuedCount()).toBe(120)
  pause.mockRestore(); rt.schedule()
  const seen = new Set<string>()
  for (let i = 0; i < starts.length; i++) {
    const e = starts[i]!
    expect(e.spec.clientKind).toBe(seen.has(e.spec.userId) ? 'web' : 'schedule')
    seen.add(e.spec.userId); finish(e)
  }
  expect(starts).toHaveLength(120)
})

test('drain rejects new admission, duplicate resend survives caps, snapshots become idle on cancel', async () => {
  const owner = await setup('snapshot')
  setSetting(h.ctx.db, 'concurrency', 1)
  const clientMessageId = crypto.randomUUID()
  send('olga'); const queued = send('olga', clientMessageId); const id = queued.assistantMessage.chatId
  const snap = await owner.call('GET', `/api/chats/${id}/queue`)
  expect(snap).toMatchObject({ state: 'queued', turnId: queued.turnId, position: 1 })
  expect(typeof snap.epoch).toBe('string'); expect(snap.revision).toBeGreaterThan(0)
  rt.stopChat(id)
  const idle = await owner.call('GET', `/api/chats/${id}/queue`)
  expect(idle).toMatchObject({ state: 'idle', turnId: null, messageId: null, position: null, epoch: snap.epoch })
  expect(idle.revision).toBeGreaterThan(snap.revision)
  expect(rt.queuePosition(queued.turnId)).toBeNull()
  const foreign = send('u1')
  expect((await owner.raw('GET', `/api/chats/${foreign.assistantMessage.chatId}/queue`)).status).toBe(404)
  void rt.drain(0)
  expect(() => send('u1')).toThrow('unavailable')
  const duplicate = rt.createTurn({ chat: rt.store.chatRow(id)!, userId: 'olga', locale: 'en', windowId: null, clientKind: 'web', engine: 'claude-code', model: null,
    user: { content: 'same', parentId: null, attachments: [], clientMessageId } })
  expect(duplicate.turnId).toBe(queued.turnId)
  const before = h.ctx.db.query('SELECT COUNT(*) n FROM turns').get(), tickets = [...rt.queueStore.tickets()]
  for (let i = 0; i < 100; i++) expect(send('olga', clientMessageId, id).turnId).toBe(queued.turnId)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns').get()).toEqual(before)
  expect([...rt.queueStore.tickets()]).toEqual(tickets)
  finish(starts[0]!); expect(starts).toHaveLength(1)
  rt.resume(); expect(starts[1]!.id).toBe(foreign.turnId)
})

test('a postcommit notification failure cannot strand accepted work outside the runtime', async () => {
  await setup('event-failure')
  const publish = spyOn(rt.hub, 'publish').mockImplementationOnce(() => { throw new Error('synthetic notification failure') })
  try { send('olga') } catch {}
  publish.mockRestore()
  expect(starts).toHaveLength(1)
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM turns WHERE status='queued'").get()).toEqual({ n: 0 })
})

test('schedule full/restart preserves original occurrence and admission transaction has no orphan', async () => {
  await setup('scheduled')
  const pause = spyOn(rt, 'schedule').mockImplementation(() => {})
  for (let i = 0; i < 3; i++) send('olga')
  const now = new Date('2026-10-27T09:01:00.000Z')
  const s = rt.schedules.create('olga', { title: 'Synthetic', prompt: 'synthetic task', repeat: 'once', date: '2026-10-27', time: '09:00' }, new Date('2026-10-26T00:00:00Z'), CONFIRMED)
  const original = s.next_run_at
  const before = h.ctx.db.query('SELECT COUNT(*) n FROM chats').get()
  expect(rt.schedules.runDue(now)).toEqual([])
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM chats').get()).toEqual(before)
  expect(rt.schedules.get('olga', s.id)).toMatchObject({ pending_due_at: original, retry_at: '2026-10-27T09:02:00.000Z' })
  const queued = h.ctx.db.query("SELECT chat_id FROM turns WHERE status='queued' LIMIT 1").get() as any
  rt.stopChat(queued.chat_id)
  const retry = new Date('2026-10-27T09:02:00.000Z')
  expect(rt.schedules.runDue(retry)).toEqual([s.id])
  expect(rt.schedules.runDue(retry)).toEqual([])
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns WHERE schedule_id=? AND scheduled_for=?').get(s.id, original)).toEqual({ n: 1 })
  expect(rt.schedules.get('olga', s.id)).toMatchObject({ pending_due_at: null, retry_at: null, enabled: 0 })
  pause.mockRestore()
})

test('restart preserves rotated tickets/FIFO; a committed running claim is interrupted, never replayed', async () => {
  await setup('restart')
  const pause = spyOn(rt, 'schedule').mockImplementation(() => {})
  const a1 = send('olga'), a2 = send('olga'), b1 = send('u1')
  rt.queueStore.claim(a1.turnId, 'olga', 2700000)
  const before = rt.queueStore.tickets(), epoch = rt.queueEpoch
  await h.close(); pause.mockRestore()
  h = await harness('fair-restart', {}, { reuse: true }); rt = getChatRuntime(h.ctx)
  expect(rt.queueEpoch).not.toBe(epoch)
  expect(starts.map(e => e.id)).toEqual([b1.turnId, a2.turnId])
  expect(before.get('u1')!).toBeLessThan(before.get('olga')!)
  expect(h.ctx.db.query('SELECT status FROM turns WHERE id=?').get(a1.turnId)).toEqual({ status: 'interrupted' })
})

test('unconfirmed shutdown keeps a quarantined slot, inactive user cancels queued work and pending schedules', async () => {
  await setup('quarantine')
  setSetting(h.ctx.db, 'concurrency', 1)
  const a = send('olga'); send('u1')
  rt.turnQuarantined(starts[0]!); rt.turnQuarantined(starts[0]!)
  expect(rt.queueDiagnostics().quarantined).toBe(1)
  expect(starts.length).toBe(1)
  rt.stopChat(a.assistantMessage.chatId)
  expect(rt.runningCount()).toBe(1)
  const s = rt.schedules.create('u1', { title: 'Pending', prompt: 'synthetic task', repeat: 'daily', time: '09:00' }, undefined, CONFIRMED)
  h.ctx.db.query('UPDATE schedules SET pending_due_at=next_run_at WHERE id=?').run(s.id)
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id='u1'").run()
  rt.stopUserTurns('u1')
  expect(rt.schedules.get('u1', s.id)).toMatchObject({ enabled: 0, pending_due_at: null })
  expect(rt.queuedCount()).toBe(0)
  // The event consumer can finish after transport loss while the OS process is still unconfirmed.
  ;(starts[0] as any).resolveDone()
  expect(await rt.drain(1)).toBe(false)
  finish(starts[0]!)
  expect(rt.queueDiagnostics().quarantined).toBe(0)
})

test('schedule admission crash rolls back chat/messages/ticket and retries original due after restart', async () => {
  await setup('schedule-crash')
  const s = rt.schedules.create('olga', { title: 'Once', prompt: 'synthetic task', repeat: 'once', date: '2026-10-27', time: '09:00' }, new Date('2026-10-26T00:00:00Z'), CONFIRMED)
  const insert = spyOn(rt.store, 'insertMessage').mockImplementation(() => { throw new Error('injected commit failure') })
  expect(rt.schedules.runDue(new Date('2026-10-27T09:01:00Z'))).toEqual([])
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM chats').get()).toEqual({ n: 0 })
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 })
  expect(rt.queueStore.tickets().size).toBe(0)
  expect(rt.schedules.get('olga', s.id)?.pending_due_at).toBe(s.next_run_at)
  insert.mockRestore(); await h.close()
  h = await harness('fair-schedule-crash', {}, { reuse: true }); rt = getChatRuntime(h.ctx)
  expect(rt.schedules.runDue(new Date('2026-10-27T09:02:00Z'))).toEqual([s.id])
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM turns WHERE schedule_id=?').get(s.id)).toEqual({ n: 1 })
})

test('cancel transaction failure retains its accepted queue entry and ticket until retry', async () => {
  await setup('cancel-crash')
  const pause = spyOn(rt, 'schedule').mockImplementation(() => {})
  const a = send('olga'), before = [...rt.queueStore.tickets()]
  h.ctx.db.exec("CREATE TRIGGER fail_cancel BEFORE UPDATE ON turns WHEN NEW.status='stopped' BEGIN SELECT RAISE(ABORT,'synthetic cancel crash'); END")
  expect(() => rt.stopChat(a.assistantMessage.chatId)).toThrow('synthetic cancel crash')
  expect(rt.queuedCount()).toBe(1); expect([...rt.queueStore.tickets()]).toEqual(before)
  expect(h.ctx.db.query('SELECT status FROM turns WHERE id=?').get(a.turnId)).toEqual({ status: 'queued' })
  h.ctx.db.exec('DROP TRIGGER fail_cancel')
  rt.stopChat(a.assistantMessage.chatId)
  expect(rt.queuedCount()).toBe(0); expect(rt.queueStore.tickets().size).toBe(0)
  pause.mockRestore()
})
