// "Now try it yourself" at the end of the story (docs/decisions/20261119-demo-free-roam-web.md): the visitor's own real
// server behind demo-gate (demo.trina.app). The scripted demo never depends on it: before the button is offered, the
// gate's public status (`/__demo/status`, `{ available }`, with CORS for the site) is read once with a short timeout; a
// failure, a slow answer or `available: false` keeps only the plans link, with one line that the live demo is busy.
import { useEffect, useState } from 'react'

/** how long the status may take before the live demo counts as busy */
export const LIVE_STATUS_TIMEOUT_MS = 2500

export type LiveState = 'checking' | 'available' | 'busy'

/** the gate's status address for a live demo address (its origin, the story's language when it has one) */
export function statusUrl(liveUrl: string): string | null {
  try {
    const u = new URL(liveUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const s = new URL('/__demo/status', u.origin)
    const lang = u.searchParams.get('lang')
    if (lang) s.searchParams.set('lang', lang)
    return s.toString()
  } catch {
    return null
  }
}

/** Can the gate take a visitor now? Anything but a quick `{ available: true }` is no. */
export async function liveAvailable(liveUrl: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  const url = statusUrl(liveUrl)
  if (!url) return false
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? LIVE_STATUS_TIMEOUT_MS)
  try {
    const res = await (o.fetch ?? fetch)(url, { signal: ctl.signal, credentials: 'omit', cache: 'no-store', mode: 'cors' })
    if (!res.ok) return false
    const body = (await res.json()) as { available?: unknown }
    return body?.available === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The live demo's state once the story's end shows (`on`); read once. No live demo in the story: busy, never asked. */
export function useLiveDemo(liveUrl: string | null, on: boolean, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): LiveState {
  const [state, setState] = useState<LiveState>(liveUrl ? 'checking' : 'busy')
  useEffect(() => {
    if (!on || !liveUrl) return
    let live = true
    void liveAvailable(liveUrl, o).then((ok) => { if (live) setState(ok ? 'available' : 'busy') })
    return () => { live = false }
    // read once per address (the options are fixed for a page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, liveUrl])
  return state
}
