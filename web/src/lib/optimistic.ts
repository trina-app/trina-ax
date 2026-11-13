// A change the person makes shows at once (docs/DECISIONS.md "Optimistic changes: the screen first, the server after").
// The new value goes on screen before the request; the request goes out; a failure puts back what the server last
// agreed to and says so in a short toast in the person's language. Changes of one item (`key`, e.g. `chat:<id>:pin`)
// go to the server one after another, in the order they were made, so the server ends where the last tap left it.
// A reply that is no longer the newest (a newer change of the same item was made meanwhile) writes nothing: the newer
// one's reply decides (the same rule as #698's "an answer from before a change made here writes nothing").
// A list read that was asked before such a change may be older than it too: `optimisticEdits()` counts the changes made
// here, so a read compares it before and after and reads again instead of writing older values back.
// Not for what cannot be taken back or what concerns access or money (deleting forever, removing someone, a role,
// payments): those keep their confirm, then wait for the server.
import { errorText } from './api'
import { currentLocale, t } from '../i18n'
import { toast } from '../store/ui'

export interface OptimisticChange<V, R> {
  /** the item and what of it changes: changes with the same key are one queue (`chat:<id>:pin`, `room:<id>:muted`) */
  key: string
  /** the value now, before this change (what a failure puts back when nothing newer was confirmed meanwhile) */
  from: V
  /** the new value, on screen at once */
  to: V
  /** put a value on screen (the store, a list's own copy) */
  show: (value: V) => void
  /** the request; it may run a moment later than the tap when an earlier change of the same key is still on its way */
  send: () => Promise<R>
  /** the server's answer, written only while this is still the newest change of its key */
  settle?: (reply: R) => void
  /** the toast on failure: by default the error in the person's language; false: no toast (the caller says it) */
  failText?: string | false
}

export type OptimisticResult<R> = { ok: true; reply: R; newest: boolean } | { ok: false; error: unknown }

interface Lane {
  /** the newest change's number (one count for all keys) */
  newest: number
  /** what the server last agreed to: from the first change's `from`, then each success's `to` */
  confirmed: unknown
  /** the end of the queue: the next change's request waits for it */
  tail: Promise<unknown>
  /** changes still on their way */
  open: number
}

const lanes = new Map<string, Lane>()
let edits = 0

/** How many changes were made here so far: a list read compares it from its start to its answer; a different count means
 * the answer may be from before a change on screen (read again, do not write it). */
export const optimisticEdits = (): number => edits

/** a change of `key` is still on its way to the server (a read of that item would bring an older value) */
export const optimisticPending = (key: string): boolean => (lanes.get(key)?.open ?? 0) > 0

/** Show a change at once and send it; see the file's comment. Never rejects: the result says how it ended. */
export function optimistic<V, R>(c: OptimisticChange<V, R>): Promise<OptimisticResult<R>> {
  const n = ++edits
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
    try {
      const reply = await c.send()
      l.confirmed = c.to
      const newest = l.newest === n
      if (newest) c.settle?.(reply)
      return { ok: true, reply, newest }
    } catch (error) {
      // a newer change is on screen: it decides (and, failing too, puts back what was confirmed by then)
      if (l.newest === n) {
        c.show(l.confirmed as V)
        if (c.failText !== false) toast({ level: 'error', text: c.failText ?? errorText(error, currentLocale(), t('error.network')) })
      }
      return { ok: false, error }
    } finally {
      if (--l.open === 0 && lanes.get(c.key) === l) lanes.delete(c.key)
    }
  })
  l.tail = run
  return run
}

/** forget every queue (another person signed in; tests) */
export function resetOptimistic(): void {
  lanes.clear()
}
