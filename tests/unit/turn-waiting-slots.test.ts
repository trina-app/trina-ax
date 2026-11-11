// Answers that wait for a person hold no queue slot (fix/turn-waiting-slots, 2026-11-11):
// 1. a turn that opens a card (ask_user, a confirmation, post_to_room, …) gives its slot back, so a queued answer
//    starts at once; its engine stays up, idle on the tool call;
// 2. when the person answers, the turn needs a slot again: at once when one is free, else first in line before any
//    queued answer, and never more answers working than the concurrency limit;
// 3. a chat whose earlier answer ended but whose engine end is unconfirmed (a quarantined slot) says so (Chat.ending)
//    and a send there is refused with that plain message, not a silent 409.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { chatView } from '../../server/src/chat/shared'
import { HttpError } from '../../server/src/http/errors'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { waitFor } from '../lib/wait'

let h: Harness, rt: ChatRuntime
const spies: { mockRestore(): void }[] = []
const engines = new Map<string, (exec: TurnExec) => Promise<void>>()
const execs: TurnExec[] = []
/** answers doing work now (not waiting on a card or for a slot), and the most seen at once */
let working = 0, mostWorking = 0, mostSlots = 0
const work = async <T>(f: () => Promise<T>): Promise<T> => {
  working++; mostWorking = Math.max(mostWorking, working); mostSlots = Math.max(mostSlots, rt.slotsInUse())
  try { return await f() } finally { working-- }
}

async function setup(name: string, concurrency: number) {
  spies.push(spyOn(TurnExec.prototype as any, 'execute').mockImplementation(async function (this: TurnExec) {
    execs.push(this)
    await engines.get(this.spec.chatId)?.(this)
  }))
  h = await harness(`wait-${name}`); await withOwner(h)
  rt = getChatRuntime(h.ctx)
  rt.quarantineProbeMs = 60 * 60_000
  ;(rt as any).probedAt = Date.now()
  setSetting(h.ctx.db, 'concurrency', concurrency)
  working = 0; mostWorking = 0; mostSlots = 0
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
const execOf = (chatId: string) => execs.find((e) => e.spec.chatId === chatId)
const cardOf = (exec: TurnExec) => exec.openRequests()[0]?.request.requestId
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open } }

/** an engine that works a little, asks the person once, then works until `release` (what it got: `answers`) */
function asking(answers: Map<string, unknown>, release?: Promise<void>) {
  return async (exec: TurnExec) => {
    await work(() => Bun.sleep(5))
    const value = await exec.waitForPerson({ kind: 'ask_user', requestId: crypto.randomUUID(), question: 'Which file?' } as any, { timeoutMs: 60_000 })
    answers.set(exec.spec.chatId, value)
    await work(async () => { await release })
  }
}

test('three answers waiting for a person leave the slots free: a fourth starts at once', async () => {
  await setup('three', 3)
  const answers = new Map<string, unknown>()
  const chats = [newChat(), newChat(), newChat()]
  for (const c of chats) { engines.set(c, asking(answers)); send(c) }
  expect(await waitFor(() => chats.every((c) => execOf(c)?.waitingForPerson))).toBe(true)
  expect(rt.runningCount()).toBe(3)
  await waitFor(() => rt.slotsInUse() === 0)
  expect(rt.slotsInUse()).toBe(0)
  // the fourth does not wait for any of them
  const d = newChat(), done = gate()
  engines.set(d, () => work(() => done.p))
  const fourth = send(d)
  expect(await waitFor(() => turnStatus(fourth.turnId) === 'running')).toBe(true)
  expect(rt.queuedCount()).toBe(0)
  expect(rt.slotsInUse()).toBe(1)
  done.open()
  expect(await waitFor(() => turnStatus(fourth.turnId) === 'done')).toBe(true)
  // each waiting answer goes on once answered (slots are free) and ends
  for (const c of chats) { const e = execOf(c)!; expect(e.answer(cardOf(e)!, 'ask_user', ['report.xlsx'])).toBe('ok') }
  expect(await waitFor(() => rt.runningCount() === 0)).toBe(true)
  for (const c of chats) expect(answers.get(c)).toEqual(['report.xlsx'])
  expect(mostSlots).toBeLessThanOrEqual(3)
}, 30_000)

test('an answered turn waits for a slot first in line, and never more answers work than the limit', async () => {
  await setup('resume', 1)
  const answers = new Map<string, unknown>()
  const a = newChat(), b = newChat(), c = newChat()
  engines.set(a, asking(answers))
  const first = send(a)
  await waitFor(() => execOf(a)?.waitingForPerson)
  // a's slot went to b, which works until bDone
  const bDone = gate()
  engines.set(b, () => work(() => bDone.p))
  const second = send(b)
  expect(await waitFor(() => turnStatus(second.turnId) === 'running')).toBe(true)
  // the person answers a while b holds the only slot: a waits for it, its time limit paused, its answer held back
  const ea = execOf(a)!
  expect(ea.answer(cardOf(ea)!, 'ask_user', ['yes'])).toBe('ok')
  expect(ea.waitingForSlot).toBe(true)
  expect(answers.has(a)).toBe(false)
  expect(rt.slotsInUse()).toBe(1)
  // c is queued after a's answer: a goes first
  engines.set(c, () => work(() => Bun.sleep(5)))
  const third = send(c)
  await Bun.sleep(50)
  expect(turnStatus(third.turnId)).toBe('queued')
  expect(answers.has(a)).toBe(false)
  bDone.open()
  expect(await waitFor(() => turnStatus(first.turnId) === 'done')).toBe(true)
  expect(answers.get(a)).toEqual(['yes'])
  expect(await waitFor(() => turnStatus(third.turnId) === 'done')).toBe(true)
  // c started only after a was done with the slot
  expect(execs.findIndex((e) => e.spec.chatId === c)).toBeGreaterThan(execs.findIndex((e) => e.spec.chatId === b))
  expect(mostWorking).toBe(1)
  expect(mostSlots).toBe(1)
}, 30_000)

test('a turn stopped while it waits for a slot leaves the line; its held answer reaches no tool', async () => {
  await setup('stop', 1)
  const answers = new Map<string, unknown>()
  const a = newChat(), b = newChat()
  engines.set(a, asking(answers))
  const first = send(a)
  await waitFor(() => execOf(a)?.waitingForPerson)
  const bDone = gate()
  engines.set(b, () => work(() => bDone.p))
  const second = send(b)
  await waitFor(() => turnStatus(second.turnId) === 'running')
  const ea = execOf(a)!
  ea.answer(cardOf(ea)!, 'ask_user', ['delete them'])
  expect(ea.waitingForSlot).toBe(true)
  expect(rt.stopChat(a)).toBe(ea.id)
  expect(await waitFor(() => turnStatus(first.turnId) === 'stopped')).toBe(true)
  expect(answers.get(a)).toBeNull()
  bDone.open()
  expect(await waitFor(() => rt.runningCount() === 0)).toBe(true)
  expect(rt.slotsInUse()).toBe(0)
}, 30_000)

test('a chat whose earlier answer is still ending says so, and a send there gets that plain message', async () => {
  await setup('ending', 2)
  const a = newChat(), b = newChat()
  // the launcher connection breaks mid-answer with the engine still up: the slot is quarantined
  const out = await new Response(Bun.spawn(['ps', '-o', 'pgid=', '-p', String(process.pid)]).stdout).text()
  const pgid = Number(out.trim())
  engines.set(a, async (exec) => {
    const core = { turns: { bind() {} }, launcher: { launch: () => ({ kill() {}, events: (async function* () {
      yield { ev: 'started', pid: pgid, pgid }
      yield { ev: 'error', message: 'launcher: read ECONNRESET' }
    })() }) } }
    await (exec as any).launch(core, {}, () => {})
  })
  const events: any[] = []
  spies.push(spyOn(rt.hub, 'publish').mockImplementation(((_u: string, ev: any) => { events.push(ev) }) as any))
  send(a)
  await waitFor(() => execOf(a)?.status === 'finished')
  await execOf(a)!.done
  expect(rt.endingUnconfirmed(a)).toBe(true)
  expect(chatView(rt, 'olga', rt.store.chatRow(a)!).ending).toBe(true)
  // the chat.updated the end sent already says it
  expect(events.some((e) => e.type === 'chat.updated' && e.data?.chat?.id === a && e.data.chat.ending === true)).toBe(true)
  let refused: unknown = null
  try { send(a) } catch (e) { refused = e }
  expect(refused).toBeInstanceOf(HttpError)
  expect((refused as HttpError).code).toBe('conflict')
  expect((refused as HttpError).extra.params?.reason).toBe('earlier_answer_ending')
  expect((refused as HttpError).body('en').message).toBe('Waiting for the earlier answer to finish. Other chats work as usual.')
  // other chats work as usual
  const other = send(b)
  expect(await waitFor(() => turnStatus(other.turnId) === 'done')).toBe(true)
  expect(chatView(rt, 'olga', rt.store.chatRow(b)!).ending).toBeUndefined()
  // released at its deadline: the line goes, the chat takes a message again
  ;(execOf(a) as any).wallEndsAt = 0
  rt.quarantineReleaseGraceMs = 0
  await rt.probeQuarantined()
  expect(chatView(rt, 'olga', rt.store.chatRow(a)!).ending).toBeUndefined()
  engines.delete(a)
  const again = send(a)
  expect(await waitFor(() => turnStatus(again.turnId) === 'done')).toBe(true)
}, 30_000)
