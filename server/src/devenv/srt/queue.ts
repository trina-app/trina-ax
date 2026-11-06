// One queue for the dev environment on srt (docs/DECISIONS.md "Dev environment: one queue"; owner, 2026-11-06: "when
// the sandbox is full the agent must wait so the server does not get heavy").
//
// Commands (box_shell) and jobs share maxRunning slots of the plan (plan.ts). Dev servers have their own maxRunning and
// no queue (runner.ts startServer). When no slot is free, a command or a job waits in one FIFO queue for the whole team:
// rows of dev_env_runs in state waiting. A job is a row as before. A command gets a ticket: a row with foreground = 1
// and no command file; the box_shell call waits for it and runs the command itself when the ticket is granted.
//
// Fair share: one person holds at most share(maxRunning) = max(1, floor(maxRunning / 2)) slots. The start order has
// two passes (pickNext):
//   1. round robin under the share: of the people under their share, the one who got a slot least recently goes first
//      (never = first), with their oldest entry. With maxRunning 1 this is plain turn-taking.
//   2. fill idle slots: when every person who waits is at their share, the oldest entry starts anyway. A slot is never
//      left idle while someone waits.
//
// A ticket waits at most COMMAND_WAIT_MS (5 minutes), then the call ends with "The dev environment is full. Try again
// later." A job keeps its 24 hours (runner.ts WAIT_MAX_MS). The rows keep the queue when the server restarts; a ticket
// whose call was lost with the old process ends with end_reason 'lost' (endOrphanTickets), and its command never runs.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { newId } from '../../db'

/** the longest a command waits for a slot */
export const COMMAND_WAIT_MS = 5 * 60_000
/** the engines end a tool call after 30 minutes (engine/claude.ts MCP_TOOL_TIMEOUT_MS, engine/codex.ts): the wait and
 * the command's own time limit must end before that */
const TOOL_CALL_MAX_MS = 30 * 60_000
const TOOL_CALL_MARGIN_MS = 60_000

export const FULL_MESSAGE = 'The dev environment is full. Try again later.'

let waitMs = COMMAND_WAIT_MS
/** tests: a shorter wait (null: the default) */
export function setCommandWait(ms: number | null) { waitMs = ms ?? COMMAND_WAIT_MS }

/** How long a command with this time limit may wait: 5 minutes, less when the tool call would end first. */
export const commandWaitFor = (timeoutMs: number) => Math.max(0, Math.min(waitMs, TOOL_CALL_MAX_MS - TOOL_CALL_MARGIN_MS - timeoutMs))

/** the slots one person may hold at the same time */
export const shareOf = (maxRunning: number) => Math.max(1, Math.floor(maxRunning / 2))

// ---------------- the start order (pure) ----------------

export interface Waiter { id: string; userId: string }

/** The next waiting entry to start, or null. `waiting`: oldest first (started_at, id). `running`: the person of every
 * held slot (running jobs and commands). `served`: when each person last got a slot (a larger number = later). */
export function pickNext(waiting: readonly Waiter[], running: readonly string[], maxRunning: number, served: ReadonlyMap<string, number>): string | null {
  if (!waiting.length || running.length >= maxRunning) return null
  const share = shareOf(maxRunning)
  const held = new Map<string, number>()
  for (const u of running) held.set(u, (held.get(u) ?? 0) + 1)
  // pass 1: round robin under the share
  let best: { w: Waiter; at: number } | null = null
  const seen = new Set<string>()
  for (const w of waiting) {
    if (seen.has(w.userId)) continue
    seen.add(w.userId)
    if ((held.get(w.userId) ?? 0) >= share) continue
    const at = served.get(w.userId) ?? -1
    if (!best || at < best.at) best = { w, at }
  }
  if (best) return best.w.id
  // pass 2: everyone who waits is at their share; do not leave the slot idle
  return waiting[0]!.id
}

/** The order of start of every waiting entry if slots came free one by one (for the place in line). */
export function startOrder(waiting: readonly Waiter[], running: readonly string[], maxRunning: number, served: ReadonlyMap<string, number>): string[] {
  const left = [...waiting]
  const held = [...running]
  const s = new Map(served)
  const out: string[] = []
  let tick = Math.max(0, ...s.values()) + 1
  while (left.length) {
    // a slot comes free: the person who holds the most slots gives one back
    if (held.length >= maxRunning) {
      const counts = new Map<string, number>()
      for (const u of held) counts.set(u, (counts.get(u) ?? 0) + 1)
      const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      held.splice(held.indexOf(most), 1)
    }
    const id = pickNext(left, held, maxRunning, s)
    if (!id) break
    const i = left.findIndex((w) => w.id === id)
    const w = left.splice(i, 1)[0]!
    out.push(w.id)
    held.push(w.userId)
    s.set(w.userId, tick++)
  }
  return out
}

/** when each person last got a slot, in this process (lost at a restart: then everyone is new) */
const served = new Map<string, number>()
let serveTick = 0
export function noteServed(userId: string) { served.set(userId, ++serveTick) }
export const servedNow = (): ReadonlyMap<string, number> => served

// ---------------- tickets of commands ----------------

export type TicketEnd = 'granted' | 'expired' | 'cancelled' | 'stopped' | 'aborted'

interface Ticket { rowId: string; userId: string; resolve: (end: TicketEnd) => void; timer: ReturnType<typeof setTimeout> | null }
/** the calls that wait, by row id */
const tickets = new Map<string, Ticket>()
/** granted commands that did not end yet: row id -> person */
const held = new Map<string, string>()

/** the person of every slot that a command of this process holds */
export const heldCommands = (): string[] => [...held.values()]

/** the open tickets (any process) */
export function ticketIds(db: Database): Set<string> {
  return new Set((db.query('SELECT id FROM dev_env_runs WHERE foreground = 1 AND ended_at IS NULL').all() as { id: string }[]).map((r) => r.id))
}

/** rows without the tickets (the caps of waiting jobs count jobs only) */
export function withoutTickets<T extends { id: string }>(db: Database, rows: T[]): T[] {
  const t = ticketIds(db)
  return t.size ? rows.filter((r) => !t.has(r.id)) : rows
}

export interface TicketSpace { userId: string; chatId: string | null; projectId: string | null; root: string }

/** Put a command in the queue: a row with foreground = 1. `shown` is the command with secrets hidden. The AI never
 * gets a result of a ticket as a job (ai_told_at is set). */
export function addTicket(db: Database, o: { space: TicketSpace; turnId: string; shown: string; cwd: string }): string {
  const id = newId()
  const at = new Date().toISOString()
  db.query("INSERT INTO dev_env_runs (id, user_id, chat_id, project_id, turn_id, kind, name, command, root, cwd, state, started_at, ai_told_at, foreground) VALUES (?, ?, ?, ?, ?, 'job', ?, ?, ?, ?, 'waiting', ?, ?, 1)")
    .run(id, o.space.userId, o.space.chatId, o.space.projectId, o.turnId, 'command-' + crypto.randomBytes(3).toString('hex'), o.shown.slice(0, 500), o.space.root, o.cwd, at, at)
  return id
}

/** Wait until the ticket is granted, its time is up, it is cancelled, or the call stops. The row is gone after. */
export function waitTicket(db: Database, rowId: string, userId: string, o: { waitMs: number; signal?: AbortSignal }): Promise<TicketEnd> {
  return new Promise<TicketEnd>((resolve) => {
    const t: Ticket = { rowId, userId, timer: null, resolve: (end) => {
      if (tickets.get(rowId) !== t) return
      tickets.delete(rowId)
      if (t.timer) clearTimeout(t.timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(end)
    } }
    const drop = (end: TicketEnd) => { if (removeRow(db, rowId)) t.resolve(end) }
    const onAbort = () => drop('aborted')
    tickets.set(rowId, t)
    if (o.signal?.aborted) return drop('aborted')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    t.timer = setTimeout(() => drop('expired'), o.waitMs)
  })
}

/** a waiting ticket's row goes; false when it was not waiting any more (granted or ended at the same moment) */
const removeRow = (db: Database, rowId: string) => db.query("DELETE FROM dev_env_runs WHERE id = ? AND foreground = 1 AND state = 'waiting' AND ended_at IS NULL").run(rowId).changes > 0

/** The queue gives the ticket a slot. False when no call waits for it (it ends as lost). */
export function grantTicket(db: Database, rowId: string): boolean {
  const t = tickets.get(rowId)
  if (!t) { endLost(db, rowId); return false }
  if (!removeRow(db, rowId)) return false
  held.set(rowId, t.userId)
  noteServed(t.userId)
  t.resolve('granted')
  return true
}

/** The command of a granted ticket ended: its slot is free. */
export function releaseCommand(rowId: string) { held.delete(rowId) }

/** A person cancels a ticket, or a stop ends it (the setting, the disk). False: the row is not a ticket. */
export function cancelTicket(db: Database, rowId: string, reason: 'stopped' | string): boolean {
  if (!db.query('SELECT 1 FROM dev_env_runs WHERE id = ? AND foreground = 1').get(rowId)) return false
  const t = tickets.get(rowId)
  if (!removeRow(db, rowId)) return true
  if (t) t.resolve(reason === 'stopped' ? 'cancelled' : 'stopped')
  return true
}

const endLost = (db: Database, rowId: string) =>
  db.query("UPDATE dev_env_runs SET state = 'ended', ended_at = ?, end_reason = 'lost', end_note = 'the command waited when the server restarted; it did not run' WHERE id = ? AND foreground = 1 AND ended_at IS NULL")
    .run(new Date().toISOString(), rowId)

/** Tickets with no call that waits for them (the call was lost with an older server process) end, quietly: no notice,
 * no result for the AI. Their command never runs. */
export function endOrphanTickets(db: Database): number {
  let n = 0
  for (const id of ticketIds(db)) if (!tickets.has(id)) { endLost(db, id); n++ }
  return n
}

/** tests */
export function _resetQueue() {
  for (const t of tickets.values()) if (t.timer) clearTimeout(t.timer)
  tickets.clear(); held.clear(); served.clear(); serveTick = 0; waitMs = COMMAND_WAIT_MS
}
