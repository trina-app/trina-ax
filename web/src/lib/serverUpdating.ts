// Trina is updating (QA TC-2260): while an update migrates the database the server answers every call with a 503 that
// says so (server/src/system/migrate-start.ts: x-mycel-updating; on a hosted team the relay's team_maintenance), and
// shared/src/api/client.ts turns it into params.reason "updating" (lib/api.ts isServerUpdating).
// One place in the window knows it: the first such answer (lib/api.ts, every call of the app) starts asking
// GET /api/health every HEALTH_POLL_MS until it answers OK; no answer at all meanwhile (the moment the new version takes
// over) is still "updating". Whatever waits for it (a message on its way, the Share dialog's save, the message box's
// unsent text) awaits whenServerBack() and then goes once, with the id it had (the server's idempotency), so nothing is
// sent twice. No time limit: the update ends, or the person lets the message go.
import { create } from 'zustand'
import { ApiError, isUpdatingAnswer } from '@mycel/shared/api'

export const HEALTH_POLL_MS = 4_000

/** Whether this window knows Trina is updating (an answer said so and /api/health has not answered OK since). */
export const useServerUpdating = create<{ updating: boolean }>(() => ({ updating: false }))

type Deps = { health: () => Promise<boolean>; sleep: (ms: number) => Promise<void> }
const realDeps: Deps = {
  health: async () => {
    const r = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (!r.ok) return false
    const j = (await r.json().catch(() => null)) as { ok?: unknown } | null
    return j?.ok === true
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
let deps = realDeps
let back: Promise<void> | null = null
/** bumped by setServerUpdatingDeps: a wait of before it ends without touching the new state */
let round = 0

/** An answer of the server (any call): one that says Trina is updating starts the wait. */
export function noteAnswer(res: Pick<Response, 'status' | 'headers'>): void {
  if (isUpdatingAnswer(res)) noteServerUpdating()
}

/** Trina is updating: ask /api/health until it answers OK (once per update, however many say it). */
export function noteServerUpdating(): void {
  if (back) return
  const mine = round
  useServerUpdating.setState({ updating: true })
  back = (async () => {
    for (;;) {
      await deps.sleep(HEALTH_POLL_MS)
      if (mine !== round) return
      try { if (await deps.health()) break } catch { /* no answer yet: the new version is taking over */ }
    }
    if (mine !== round) return
    back = null
    useServerUpdating.setState({ updating: false })
  })()
}

/** Settles once the server answers again (at once when no update is known). */
export function whenServerBack(): Promise<void> {
  return back ?? Promise.resolve()
}

/** After an error that waitsForUpdate: settles once the server answers again. */
export function waitForUpdate(): Promise<void> {
  noteServerUpdating()
  return whenServerBack()
}

/** The error says Trina is updating (a 503 of the update), or no answer came while an update is known. */
export function waitsForUpdate(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 503 && e.body.params?.reason === 'updating') return true // (lib/api.ts isServerUpdating)
  return useServerUpdating.getState().updating && (e instanceof TypeError || (e instanceof DOMException && e.name !== 'AbortError'))
}

/** Tests: a fake health check and clock (null: the real ones); also forgets a wait in progress. */
export function setServerUpdatingDeps(d: Partial<Deps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps
  round++
  back = null
  useServerUpdating.setState({ updating: false })
}
