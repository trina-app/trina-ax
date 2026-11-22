// The phone app's add-team check (src/team.ts checkTeam): GET /api/health, the relay's own answers told apart
// (team-link.ts relayAnswer), one relay rename hop, and a sleeping free trial team woken and waited for ("Starting your
// team…", about a minute) instead of "cannot reach" (QA wake gap 1). No native imports: `fetch` is handed in (expo/fetch
// in the app, a fake in tests/unit/mobile-team-check.test.ts).
import { mayBeAsleep, relayAnswer, relayRename, updatingAnswer, wakeTeam, type WakeAnswer } from './team-link'

type Fetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<{
  status: number; ok: boolean; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null
}>
export interface CheckIo {
  fetch: Fetch
  /** told once when the team turns out to be starting: the screen says "Resuming your team…" with a spinner */
  onWaking?: () => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  limitMs?: number
  /** the person's Cancel while the team is starting: the wait stops (reason 'cancelled', nothing to show) */
  signal?: AbortSignal
}
/** How a team address answered: `origin` is the new address after a relay rename. Any other redirect is not a team
 * server. 'wakeTimeout': a sleeping team was starting but did not answer within 3 minutes. 'cancelled': the person
 * cancelled that wait. */
export type TeamCheck = { ok: true; origin: string; renamed: boolean } | { ok: false; reason: 'unreachable' | 'notTeam' | 'unknown' | 'suspended' | 'wakeTimeout' | 'cancelled'; updating?: true }

export async function checkTeamWith(io: CheckIo, origin: string, teamDomain: string | null = null): Promise<TeamCheck> {
  const c = await checkOnce(io, origin, teamDomain)
  // a request that the signal stopped answers "unreachable": the person (or the screen) cancelled it
  return io.signal?.aborted ? { ok: false, reason: 'cancelled' } : c
}

async function checkOnce(io: CheckIo, origin: string, teamDomain: string | null): Promise<TeamCheck> {
  let renamed = false
  let h = await health(io.fetch, origin, io.signal)
  if (h.kind === 'redirect') {
    const to = relayRename(origin, h.location, { teamDomain, loopbackHttp: false })
    if (!to) return { ok: false, reason: 'notTeam' }
    origin = to
    renamed = true
    h = await health(io.fetch, origin, io.signal)
    if (h.kind === 'redirect') return { ok: false, reason: 'notTeam' }
  }
  if (h.kind === 'asleep') {
    const at = origin
    const w = await wakeTeam({
      wake: () => wake(io.fetch, at, io.signal),
      onWaking: () => io.onWaking?.(),
      sleep: io.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
      now: io.now ?? Date.now,
      limitMs: io.limitMs,
      stopped: () => !!io.signal?.aborted,
    })
    if (w === 'cancelled') return { ok: false, reason: 'cancelled' }
    if (w === 'timeout') return { ok: false, reason: 'wakeTimeout' }
    if (w === 'notAsleep') return { ok: false, reason: 'unreachable' }
    h = await health(io.fetch, origin, io.signal)
  }
  if (h.kind === 'ok') return { ok: true, origin, renamed }
  // (unreachable while Trina is updating: the failure screen says so, QA TC-2260)
  return { ok: false, reason: h.kind === 'redirect' ? 'notTeam' : h.kind === 'asleep' ? 'unreachable' : h.kind, ...(h.kind === 'unreachable' && h.updating ? { updating: true as const } : {}) }
}

type Health = { kind: 'ok' | 'unreachable' | 'notTeam' | 'unknown' | 'suspended' | 'asleep'; updating?: boolean } | { kind: 'redirect'; location: string | null }
async function health(fetch: Fetch, origin: string, stop?: AbortSignal): Promise<Health> {
  const abort = linked(stop), timer = setTimeout(() => abort.abort(), 8000)
  try {
    // never followed by the platform: a redirect is looked at here (a relay rename) and otherwise refused
    const response = await fetch(`${origin}/api/health`, { headers: { accept: 'application/json' }, redirect: 'manual', signal: abort.signal })
    if (response.status >= 300 && response.status < 400) return { kind: 'redirect', location: response.headers.get('location') }
    const kind = response.headers.get('x-relay-error')
    const relay = relayAnswer(response.status, kind)
    if (relay === 'unknown' || relay === 'suspended') return { kind: relay }
    // a free trial's server turned off for no use: the check does not wake it, a person's page load does (wake)
    if (mayBeAsleep(response.status, kind)) return { kind: 'asleep' }
    if (relay === 'offline' || response.status >= 500) return { kind: 'unreachable', updating: updatingAnswer(response.status, response.headers.get('x-mycel-updating'), kind) }
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) return { kind: 'notTeam' }
    const reader = response.body?.getReader()
    if (!reader) return { kind: 'notTeam' }
    let size = 0, text = ''
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return { kind: 'notTeam' } }
      text += decoder.decode(value, { stream: true })
    }
    try { return { kind: JSON.parse(text + decoder.decode())?.ok === true ? 'ok' : 'notTeam' } } catch { return { kind: 'notTeam' } }
  } catch { return { kind: 'unreachable' } } finally { clearTimeout(timer) }
}

/** The person's own page load of the team (GET / with Sec-Fetch-Mode: navigate, as a browser opening the link): the
 * request the relay lets wake a sleeping team (relay/src/relay.ts mayWake). Only the status, the relay's x-relay-error
 * and Retry-After are read; the page is not. The relay holds a page load a few seconds; 25 s limit. */
async function wake(fetch: Fetch, origin: string, stop?: AbortSignal): Promise<WakeAnswer> {
  const abort = linked(stop), timer = setTimeout(() => abort.abort(), 25_000)
  try {
    const r = await fetch(`${origin}/`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' }, redirect: 'manual', signal: abort.signal })
    const after = Number(r.headers.get('retry-after'))
    void r.body?.cancel().catch(() => {})
    return { status: r.status, relayError: r.headers.get('x-relay-error'), retryAfter: Number.isFinite(after) && after > 0 ? after : null }
  } catch { return null } finally { clearTimeout(timer) }
}

/** A request's own abort, also aborted by the caller's signal (Cancel, or the failure screen that went away). */
function linked(stop?: AbortSignal): AbortController {
  const abort = new AbortController()
  if (stop?.aborted) abort.abort()
  else stop?.addEventListener('abort', () => abort.abort(), { once: true })
  return abort
}
