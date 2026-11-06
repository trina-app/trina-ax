// The live place in line of the person's waiting dev environment runs (docs/DECISIONS.md "Dev environment: one queue").
// A box_shell step that waits (Step.devEnvRun) watches its run here. While at least one step watches, one poll of
// GET /api/dev-env/runs every few seconds serves them all; it stops when nobody watches. A run that is not in the
// waiting list any more has started or ended: the step then hides its waiting line.
import { useEffect, useSyncExternalStore } from 'react'
import type { DevEnvRuns } from '@mycel/shared/api'
import { api, API } from './api'

export const QUEUE_POLL_MS = 3000

/** a run id -> its place in line (1 = next), or 'gone' (not waiting); absent: not read yet */
type Places = ReadonlyMap<string, number | 'gone'>
let places: Places = new Map()
const watchers = new Map<string, number>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let busy = false

const emit = () => { for (const l of listeners) l() }

function apply(runs: DevEnvRuns) {
  const next = new Map<string, number | 'gone'>()
  const waiting = new Map(runs.waiting.map((r) => [r.id, r.position ?? 1]))
  for (const id of watchers.keys()) next.set(id, waiting.get(id) ?? 'gone')
  places = next
  emit()
}

async function poll() {
  timer = null
  if (!watchers.size || busy) return schedule()
  busy = true
  try { apply(await api.call(API.myDevEnvRuns, {})) } catch { /* a server with no srt runner: the step keeps the place it was written with */ } finally { busy = false }
  schedule()
}
function schedule() {
  if (timer || !watchers.size) return
  timer = setTimeout(() => void poll(), QUEUE_POLL_MS)
}

function watch(id: string): () => void {
  watchers.set(id, (watchers.get(id) ?? 0) + 1)
  if (watchers.get(id) === 1) { if (timer) clearTimeout(timer); timer = null; void poll() }
  return () => {
    const n = (watchers.get(id) ?? 1) - 1
    if (n > 0) watchers.set(id, n)
    else watchers.delete(id)
  }
}

/** Read again now (after a cancel). */
export function refreshQueue() { if (timer) clearTimeout(timer); timer = null; void poll() }

/** The live place of a waiting run: a number, 'gone' (started or ended), or undefined (not read yet). `id` null: none. */
export function useQueuePlace(id: string | null): number | 'gone' | undefined {
  useEffect(() => (id ? watch(id) : undefined), [id])
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => (id ? places.get(id) : undefined),
  )
}

/** tests */
export function _resetQueueStore() { if (timer) clearTimeout(timer); timer = null; places = new Map(); watchers.clear(); busy = false }
