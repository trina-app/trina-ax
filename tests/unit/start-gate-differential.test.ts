// The start gate changes nothing in the queue: the same random sends, ends (Stop on turns still in the gate too),
// queue-room probes, #442 parks and resumes (turnWaiting / turnResuming on launched turns) and stopUserTurns give the
// same accepts, refusals, running, queued and parked sets, slots in use and round-robin tickets with the gate
// (startBurst 3) as without it (startBurst 0, the queue as before the gate). QA rev2 for #463: holding turns in the
// queue for a spread moved tickets with 2+ people. QA rev11 added the parks, resumes, stopUserTurns and 2p/c10, 6p/c3.
// GATE_DIFF_SEEDS=12: more seeds; GATE_DIFF_REAL=1: a stopped turn runs the real TurnExec.run (no engine, it only ends).
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
const origRun = TurnExec.prototype.run
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
type Op = { k: 'send'; u: number } | { k: 'end'; i: number } | { k: 'settle' } | { k: 'probe'; u: number } | { k: 'park'; i: number } | { k: 'resume'; i: number } | { k: 'stopUser'; u: number }
function ops(seed: number, people: number): Op[] {
  const r = rng(seed), out: Op[] = []
  for (let round = 0; round < 8; round++) {
    const n = 3 + Math.floor(r() * 12)
    for (let j = 0; j < n; j++) {
      const x = r()
      if (x < 0.62) out.push({ k: 'send', u: Math.floor(r() * people) })
      else if (x < 0.77) out.push({ k: 'end', i: Math.floor(r() * 1000) }) // end (cancel) one accepted turn, maybe a held one
      else if (x < 0.85) out.push({ k: 'probe', u: Math.floor(r() * people) }) // checkQueueRoom: what a scheduled task's admission sees
      else if (x < 0.92) out.push({ k: 'park', i: Math.floor(r() * 1000) })
      else if (x < 0.98) out.push({ k: 'resume', i: Math.floor(r() * 1000) })
      else out.push({ k: 'stopUser', u: Math.floor(r() * people) })
    }
    out.push({ k: 'settle' })
    // a few turns end between bursts
    const m = Math.floor(r() * 5)
    for (let j = 0; j < m; j++) out.push({ k: 'end', i: Math.floor(r() * 1000) })
  }
  return out
}
const realStopped = process.env.GATE_DIFF_REAL === '1'
async function run(seq: Op[], people: number, conc: number, burst: number) {
  setAvailableMemoryForTests(null)
  fakeRun = spyOn(TurnExec.prototype, 'run').mockImplementation(async function(this: TurnExec) {
    if ((this as any).stopReason) { if (realStopped) return origRun.call(this); finish(this) } else execs.set(this.id, this)
  })
  h = await harness(`gate-diff-${burst}-${Math.random().toString(36).slice(2)}`); await withOwner(h)
  rt = getChatRuntime(h.ctx); rt.startBurst = burst
  const owner = (h.ctx.db.query("SELECT id FROM users WHERE username='olga'").get() as { id: string }).id
  const users = [owner]
  for (let i = 1; i < people; i++) { h.ctx.db.query("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").run(`u${i}`, `u${i}`, `U${i}`); users.push(`u${i}`) }
  setSetting(h.ctx.db, 'concurrency', conc); rt.schedule()
  const accepted: { turnId: string; chatId: string; gone: boolean }[] = []
  const trace: string[] = []
  const R = () => (rt as any)
  // gives up after 5 s; a gate left non-empty then shows as gate=N, a difference from dev
  const waitGate = async () => { if (burst) { const end = Date.now() + 5000; while ((R().launchTimer || R().startGate.length) && Date.now() < end) await Bun.sleep(20) } }
  const state = () => {
    const run = accepted.map((a, i) => (R().running.has(a.turnId) ? i : -1)).filter((i) => i >= 0)
    const q = accepted.map((a, i) => (R().queued.some((s: any) => s.turnId === a.turnId) ? i : -1)).filter((i) => i >= 0)
    const parked = accepted.map((a, i) => (R().parked.has(a.turnId) ? i : -1)).filter((i) => i >= 0)
    const res = R().resuming.map((id: string) => accepted.findIndex((a) => a.turnId === id))
    const tk = [...R().queueStore.tickets().entries()].sort((a: any, b: any) => a[1] - b[1]).map((e: any) => users.indexOf(e[0])).join('<')
    return `run=${run.join(',')} q=${q.join(',')} gate=${R().startGate.length} parked=${parked.join(',')} res=${res.join(',')} slots=${rt.slotsInUse()} tickets=${tk}`
  }
  const micro = async () => { for (let k = 0; k < 4; k++) await Promise.resolve() }
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
      if (exec && R().running.get(a.turnId) === exec) { execs.delete(a.turnId); finish(exec) } else rt.stopChat(a.chatId)
      await micro(); if (realStopped) await Bun.sleep(5)
      trace.push(`end:${accepted.indexOf(a)}`)
    } else if (op.k === 'park' || op.k === 'resume') {
      // #442: a launched turn waits for a person (its slot is free for the queue) and later goes on
      await waitGate(); await micro()
      const cand = accepted.filter((a) => !a.gone && execs.has(a.turnId) && R().running.get(a.turnId) === execs.get(a.turnId) && (op.k === 'park' ? !R().parked.has(a.turnId) : R().parked.has(a.turnId) && !R().resuming.includes(a.turnId)))
      if (!cand.length) { trace.push(`${op.k}:none`); continue }
      const a = cand[op.i % cand.length]!, exec = execs.get(a.turnId)!
      if (op.k === 'park') rt.turnWaiting(exec); else rt.turnResuming(exec)
      await micro()
      trace.push(`${op.k}:${accepted.indexOf(a)}`)
    } else if (op.k === 'stopUser') {
      const n = rt.stopUserTurns(users[op.u]!)
      for (const a of accepted) if (!a.gone && !R().running.has(a.turnId) && !R().queued.some((s: any) => s.turnId === a.turnId)) a.gone = true
      await micro(); if (realStopped) await Bun.sleep(5)
      // in both modes running turns that were stopped must end: fake engine ends them now (dev: launched ones are only stopped)
      for (const a of accepted) { const e = execs.get(a.turnId); if (e && (e as any).stopReason && R().running.get(a.turnId) === e) { execs.delete(a.turnId); finish(e); a.gone = true } }
      await micro()
      for (const a of accepted) if (!a.gone && !R().running.has(a.turnId) && !R().queued.some((s: any) => s.turnId === a.turnId)) a.gone = true
      trace.push(`stopUser${op.u}:${n}`)
    } else {
      await waitGate()
      trace.push(`settle ${state()}`)
    }
  }
  await cleanup()
  return trace
}
const SEEDS = Number(process.env.GATE_DIFF_SEEDS ?? 3)
const only = process.env.GATE_DIFF_ONLY?.split(',').map(Number)
if (only) test('one case', async () => {
  const [people, conc, seed] = only as [number, number, number]
  const seq = ops(seed * 104729 + people * 37 + conc, people)
  const dev = await run(seq, people, conc, 0), pr = await run(seq, people, conc, 3)
  for (let i = 0; i < Math.max(dev.length, pr.length); i++) console.log(`${i} ${JSON.stringify(seq[i])} dev=${dev[i]} pr=${pr[i]}${dev[i] !== pr[i] ? '   <<<' : ''}`)
}, 120000)
const configs: [number, number][] = only ? [] : [[1, 10], [2, 3], [2, 10], [3, 10], [4, 4], [6, 3]]
for (const [people, conc] of configs) {
  test(`limits as on dev (parks, resumes, stopUserTurns too): ${people} people, concurrency ${conc}`, async () => {
    // no stranding: each settle's running, queued, gate (empty), parked and resuming sets and slots in use equal dev's
    // (on dev #442's live-engine cap, LIVE_ENGINES_PER_SLOT x the limit, can hold the queue with a slot free too)
    let diffs = 0, refusals = 0, parks = 0, resumes = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const seq = ops(seed * 104729 + people * 37 + conc, people)
      const dev = await run(seq, people, conc, 0)
      const pr = await run(seq, people, conc, 3)
      refusals += dev.filter((t) => t.includes('rate_limited')).length
      parks += dev.filter((t) => /^park:\d/.test(t)).length; resumes += dev.filter((t) => /^resume:\d/.test(t)).length
      if (JSON.stringify(dev) !== JSON.stringify(pr)) {
        diffs++
        const i = dev.findIndex((t, j) => t !== pr[j])
        console.log(`DIFF ${people}p c${conc} seed=${seed} op ${i} ${JSON.stringify(seq[i])}\n dev: ${dev.slice(Math.max(0, i - 4), i + 2).join(' | ')}\n pr:  ${pr.slice(Math.max(0, i - 4), i + 2).join(' | ')}`)
      }
    }
    console.log(`${people}p c${conc}: ${SEEDS} seeds, diffs=${diffs}, dev refusals=${refusals}, parks=${parks}, resumes=${resumes}`)
    expect(diffs).toBe(0)
    // the #442 ops really ran (the seeds are fixed, so these counts are too)
    expect(parks).toBeGreaterThan(0); expect(resumes).toBeGreaterThan(0)
  }, 300000)
}
