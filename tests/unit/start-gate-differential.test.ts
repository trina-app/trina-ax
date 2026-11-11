// The start gate changes nothing in the queue: the same random sends, ends (Stop on turns still in the gate too) and
// queue-room probes give the same accepts, refusals, running set and round-robin tickets with the gate (startBurst 3)
// as without it (startBurst 0, the queue as before the gate). QA rev2 for #463: holding turns in the queue for a spread
// moved tickets with 2+ people.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { harness, withOwner, type Harness } from './a-lib'
import { getChatRuntime, type ChatRuntime } from '../../server/src/chat/runtime'
import { TurnExec } from '../../server/src/chat/turn'
import { newId } from '../../server/src/db'
import { setSetting } from '../../server/src/admin/settings'
import { setAvailableMemoryForTests } from '../../server/src/system/limits'

let h: Harness | null = null, rt: ChatRuntime
let fakeRun: ReturnType<typeof spyOn> | null = null
const execs = new Map<string, TurnExec>()
afterEach(async () => { await cleanup() })
async function cleanup() {
  if (h) { void rt.drain(0); for (const e of execs.values()) finish(e); await h.close() }
  h = null; execs.clear(); fakeRun?.mockRestore(); fakeRun = null; setAvailableMemoryForTests(undefined)
}
function finish(exec: TurnExec) {
  h!.ctx.db.query("UPDATE turns SET status='done' WHERE id=?").run(exec.id)
  h!.ctx.db.query("UPDATE messages SET status='done' WHERE id=?").run(exec.spec.assistantId)
  rt.turnFinished(exec); (exec as any).resolveDone?.()
}
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

type Op = { k: 'send'; u: number } | { k: 'end'; i: number } | { k: 'settle' } | { k: 'probe'; u: number }
function ops(seed: number, people: number): Op[] {
  const r = rng(seed), out: Op[] = []
  for (let round = 0; round < 6; round++) {
    const n = 3 + Math.floor(r() * 12)
    for (let j = 0; j < n; j++) {
      const x = r()
      if (x < 0.75) out.push({ k: 'send', u: Math.floor(r() * people) })
      else if (x < 0.9) out.push({ k: 'end', i: Math.floor(r() * 1000) }) // end (cancel) one accepted turn, maybe a held one
      else out.push({ k: 'probe', u: Math.floor(r() * people) }) // checkQueueRoom: what a scheduled task's admission sees
    }
    out.push({ k: 'settle' })
    // a few turns end between bursts
    const m = Math.floor(r() * 5)
    for (let j = 0; j < m; j++) out.push({ k: 'end', i: Math.floor(r() * 1000) })
  }
  return out
}

async function run(seq: Op[], people: number, conc: number, burst: number) {
  setAvailableMemoryForTests(null)
  fakeRun = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) { if ((this as any).stopReason) finish(this); else execs.set(this.id, this) })
  h = await harness(`gate-diff-${burst}-${Math.random().toString(36).slice(2)}`); await withOwner(h)
  rt = getChatRuntime(h.ctx); rt.startBurst = burst
  const owner = (h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
  const users = [owner]
  for (let i = 1; i < people; i++) { h.ctx.db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(`u${i}`, `u${i}`, `U${i}`); users.push(`u${i}`) }
  setSetting(h.ctx.db, 'concurrency', conc); rt.schedule()
  const accepted: { turnId: string; chatId: string; gone: boolean }[] = []
  const trace: string[] = []
  const state = () => {
    const run = accepted.map((a, i) => (!a.gone && execs.has(a.turnId) && (rt as any).running.has(a.turnId) ? i : -1)).filter((i) => i >= 0)
    const q = accepted.map((a, i) => (!a.gone && (rt as any).queued.some((s: any) => s.turnId === a.turnId) ? i : -1)).filter((i) => i >= 0)
    const tk = [...(rt as any).queueStore.tickets().entries()].sort((a: any, b: any) => a[1] - b[1]).map((e: any) => users.indexOf(e[0])).join('<')
    return `run=${run.join(',')} q=${q.join(',')} tickets=${tk}`
  }
  for (const op of seq) {
    if (op.k === 'send') {
      const id = newId(); h.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(id, users[op.u])
      try {
        const t = rt.createTurn({ chat: rt.store.chatRow(id)!, userId: users[op.u]!, locale: 'en', windowId: null, clientKind: 'web', engine: 'claude-code', model: null,
          user: { content: 'synthetic', parentId: null, attachments: [], clientMessageId: crypto.randomUUID() } })
        accepted.push({ turnId: t.turnId, chatId: id, gone: false }); trace.push(`send${op.u}:ok`)
      } catch (e: any) { trace.push(`send${op.u}:${e.code}/${e.params?.reason ?? e.message}`) }
    } else if (op.k === 'probe') {
      try { rt.checkQueueRoom(users[op.u]!, 'en'); trace.push(`probe${op.u}:ok`) } catch (e: any) { trace.push(`probe${op.u}:${e.params?.reason}`) }
    } else if (op.k === 'end') {
      const live = accepted.filter((a) => !a.gone)
      if (!live.length) { trace.push('end:none'); continue }
      const a = live[op.i % live.length]!
      a.gone = true
      const exec = execs.get(a.turnId)
      if (exec && (rt as any).running.get(a.turnId) === exec) { execs.delete(a.turnId); finish(exec) } else rt.stopChat(a.chatId)
      for (let k = 0; k < 3; k++) await Promise.resolve() // a turn stopped in the start gate ends a microtask later
      trace.push(`end:${accepted.indexOf(a)}` + (process.env.GATE_DIFF_ONLY ? ` [${state()} hold=${(rt as any).startGate.map((e: any) => e.id).map((id: string) => accepted.findIndex((x) => x.turnId === id)).join(',')}]` : ''))
    } else {
      if (burst) { const end = Date.now() + 5000; while (((rt as any).launchTimer || (rt as any).startGate.length) && Date.now() < end) await Bun.sleep(20) }
      trace.push(`settle ${state()}`)
    }
  }
  await cleanup()
  return trace
}

/** more seeds: GATE_DIFF_SEEDS=12 */
const SEEDS = Number(process.env.GATE_DIFF_SEEDS ?? 3)
const only = process.env.GATE_DIFF_ONLY?.split(',').map(Number)
if (only) test('one case', async () => {
  const [people, conc, seed] = only as [number, number, number]
  const seq = ops(seed * 7919 + people * 31 + conc, people)
  const dev = await run(seq, people, conc, 0), pr = await run(seq, people, conc, 3)
  for (let i = 0; i < Math.max(dev.length, pr.length); i++) console.log(`${i} ${JSON.stringify(seq[i])} dev=${dev[i]} pr=${pr[i]}${dev[i] !== pr[i] ? '   <<<' : ''}`)
}, 120000)
const configs: [number, number][] = only ? [] : [[1, 10], [2, 3], [3, 10], [4, 4]]
for (const [people, conc] of configs) {
  test(`limits as on dev: ${people} people, concurrency ${conc}`, async () => {
    let diffs = 0, refusals = 0, stranded = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const seq = ops(seed * 7919 + people * 31 + conc, people)
      const dev = await run(seq, people, conc, 0)
      const pr = await run(seq, people, conc, 3)
      refusals += dev.filter((t) => t.includes('rate_limited')).length
      for (const t of pr) { const m = /^settle run=([^ ]*) q=([^ ]*)/.exec(t); if (m && m[2] && (m[1] ? m[1].split(',').length : 0) < conc) { stranded++; console.log(`STRANDED ${people}/${conc} seed ${seed}: ${t}`) } }
      if (JSON.stringify(dev) !== JSON.stringify(pr)) {
        diffs++
        const i = dev.findIndex((t, j) => t !== pr[j])
        console.log(`DIFF people=${people} conc=${conc} seed=${seed} at op ${i}: dev=${dev[i]} pr=${pr[i]}\n dev: ${dev.slice(Math.max(0, i - 6), i + 2).join(' | ')}\n pr:  ${pr.slice(Math.max(0, i - 6), i + 2).join(' | ')}`)
      }
    }
    console.log(`people=${people} conc=${conc}: ${SEEDS} seeds, diffs=${diffs}, dev refusals=${refusals}, pr stranded=${stranded}`)
    expect(diffs).toBe(0)
    expect(stranded).toBe(0)
  }, 120000)
}
