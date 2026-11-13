// A change the person makes shows at once (docs/DECISIONS.md "Optimistic changes: the screen first, the server after").
// The new value goes on screen before the request; the request goes out; a failure puts back what the server last
// agreed to and says so in a short toast in the person's language. Changes of one item (`key`, e.g. `chat:<id>:pin`)
// go to the server one after another, in the order they were made, so the server ends where the last tap left it.
// A reply that is no longer the newest (a newer change of the same item was made meanwhile) writes nothing: the newer
// one's reply decides (the same rule as #698's "an answer from before a change made here writes nothing").
// For setting a value (pin, mute, a name, on/off, a folder): an older change that fails under a newer one says nothing,
// only the newest is reported. Not for what adds up (a reaction, a message) or cannot be taken back or concerns access
// or money (deleting forever, removing someone, a role, payments): those keep their confirm, then wait for the server.
// A list read or a live event may carry the value from before a change: `optimisticPending` says a change of the item
// is still unanswered (keep the value on screen), `optimisticEdits` counts the changes made (compared from a read's start
// to its answer: different, the answer may be from before one; read again instead of writing it).
import { errorText } from './api'
import { currentLocale, t } from '../i18n'
import { toast } from '../store/ui'

export interface OptimisticChange<V, R> {
  /** the item and what of it changes, `<kind>:<id>:<field>`: changes with the same key are one queue */
  key: string
  /** the value now, before this change; only the first change of a queue uses it (later ones go back to what the server
   * confirmed by then) */
  from: V
  /** the new value, on screen at once */
  to: V
  /** put a value on screen (the store, a list's own copy) */
  show: (value: V) => void
  /** the request; it may run a moment later than the tap when an earlier change of the same key is still on its way */
  send: () => Promise<R>
  /** the server's answer, written only while this is still the newest change of its key */
  settle?: (reply: R) => void
  /** the value the server now has, from its answer (a trimmed name, its own time); by default `to` */
  confirmed?: (reply: R) => V
  /** the toast on failure: by default the error in the person's language; false: no toast (the caller says it) */
  failText?: string | false
}

/** `newest` false: a newer change of the item was made meanwhile, and `reply` is not what is on screen */
export type OptimisticResult<R> = { ok: true; reply: R; newest: boolean } | { ok: false; error: unknown; newest: boolean }

interface Lane {
  /** the newest change's number */
  newest: number
  /** what the server last agreed to: from the first change's `from`, then each success's answer */
  confirmed: unknown
  /** the end of the queue: the next change's request waits for it */
  tail: Promise<unknown>
  /** changes not answered yet */
  open: number
}

const lanes = new Map<string, Lane>()
/** changes made so far, by key (kept after they end, for `optimisticEdits`; cleared by `resetOptimistic`) */
const made = new Map<string, number>()
let count = 0
/** a reset (another person signed in) makes every change still on its way write nothing */
let generation = 0

type KeyMatch = string | ((key: string) => boolean)
const matches = (m: KeyMatch, key: string) => (typeof m === 'string' ? key === m : m(key))

/** How many changes of the matching keys were made here so far (a key, or a test such as every chat pin). */
export function optimisticEdits(match: KeyMatch): number {
  let n = 0
  for (const [k, c] of made) if (matches(match, k)) n += c
  return n
}

/** The keys of the matching changes still unanswered (a read or an event about them may be older than the screen). */
export function optimisticPendingKeys(match: KeyMatch): string[] {
  return [...lanes].filter(([k, l]) => l.open > 0 && matches(match, k)).map(([k]) => k)
}

/** a change of `key` is still unanswered */
export const optimisticPending = (key: string): boolean => (lanes.get(key)?.open ?? 0) > 0

/** Show a change at once and send it; see the file's comment. Never rejects: the result says how it ended. */
export function optimistic<V, R>(c: OptimisticChange<V, R>): Promise<OptimisticResult<R>> {
  const n = ++count
  const mine = generation
  made.set(c.key, (made.get(c.key) ?? 0) + 1)
  let lane = lanes.get(c.key)
  if (!lane) {
    lane = { newest: n, confirmed: c.from, tail: Promise.resolve(), open: 0 }
    lanes.set(c.key, lane)
  }
  const l = lane
  l.newest = n
  l.open++
  c.show(c.to)
  const run = l.tail.then(async (): Promise<OptimisticResult<R>> => {
    let outcome: { reply: R } | { error: unknown }
    try {
      outcome = { reply: await c.send() }
    } catch (error) {
      outcome = { error }
    }
    // answered: no longer pending, so the settle below (and the events after it) may write the server's copy
    l.open--
    if (l.open === 0 && lanes.get(c.key) === l) lanes.delete(c.key)
    const newest = l.newest === n
    if (mine !== generation) return 'reply' in outcome ? { ok: true, reply: outcome.reply, newest: false } : { ok: false, error: outcome.error, newest: false }
    if ('reply' in outcome) {
      l.confirmed = c.confirmed ? c.confirmed(outcome.reply) : c.to
      if (newest) c.settle?.(outcome.reply)
      return { ok: true, reply: outcome.reply, newest }
    }
    // a newer change is on screen: it decides (and, failing too, puts back what was confirmed by then)
    if (newest) {
      c.show(l.confirmed as V)
      if (c.failText !== false) toast({ level: 'error', text: c.failText ?? errorText(outcome.error, currentLocale(), t('error.network')) })
    }
    return { ok: false, error: outcome.error, newest }
  })
  l.tail = run
  return run
}

/** Forget every queue and count (another person signed in): what is still on its way writes nothing. */
export function resetOptimistic(): void {
  generation++
  lanes.clear()
  made.clear()
}
