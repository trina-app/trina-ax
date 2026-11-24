// A Google check instead of the password, for an account without one (server/src/auth/reauth.ts;
// docs/decisions/20261122-google-reauth.md). The new window opens on the press itself (Safari blocks one opened after a
// request) and goes to Google once the server answers; this tab asks every 1.5 seconds how it went, and the request
// that needed the check then carries `reauthFlow`. Only in a browser: in the desktop and phone apps Google opens in the
// system browser, which does not have the app's session (canGoogleCheck).
import type { Me } from '@mycel/shared/api'
import { api, API, isApiError } from './api'
import { clientKind } from './desktop'

/** blocked: the browser stopped the new window; failed: over without a confirmation (the Google window said why);
 * cancelled: the person closed the dialog */
export class GoogleCheckError extends Error {
  constructor(readonly reason: 'blocked' | 'failed' | 'cancelled') { super(`google_check_${reason}`) }
}

const POLL_MS = 1500
/** a check waits at Google at most this long (the server's flow lives 10 minutes) */
const MAX_MS = 10 * 60_000

/** This person re-checks with Google, not a password: the account has none (Me.user.hasPassword false). */
export const needsGoogleCheck = (me: Me | null | undefined): boolean => me?.user.hasPassword === false

/** The Google check can run here: a plain browser. */
export const canGoogleCheck = (): boolean => clientKind() === 'web'

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new GoogleCheckError('cancelled'))
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
  const stop = () => { clearTimeout(t); reject(new GoogleCheckError('cancelled')) }
  signal?.addEventListener('abort', stop, { once: true })
})

/**
 * Run a Google check. Call it in the press (or submit) handler before anything is awaited: the window must open in the
 * press. Resolves with the check's id, to send as `reauthFlow`; rejects with GoogleCheckError, or the start's ApiError
 * (no Google account connected, a locked re-check, Google not available at this address).
 */
export async function googleCheck(signal?: AbortSignal): Promise<string> {
  const w = window.open('about:blank', '_blank')
  if (!w) throw new GoogleCheckError('blocked')
  const close = () => { try { w.close() } catch { /* gone already */ } }
  let start: { url: string; flow: string }
  try { start = await api.call(API.startGoogleReauth) } catch (e) { close(); throw e }
  // Google's page gets no handle on this tab
  try { w.opener = null } catch { /* some browsers refuse it; Google's own policy severs it anyway */ }
  w.location.replace(start.url)
  const until = Date.now() + MAX_MS
  try {
    while (Date.now() < until) {
      await wait(POLL_MS, signal)
      let state: string
      try { state = (await api.call(API.googleReauthState, { params: { id: start.flow } })).state } catch (e) {
        if (isApiError(e, 'not_found')) throw new GoogleCheckError('failed')
        continue // a network blip: ask again
      }
      if (state === 'confirmed') return start.flow
      if (state === 'failed') throw new GoogleCheckError('failed')
    }
    throw new GoogleCheckError('failed')
  } catch (e) {
    // cancelled here: the Google window goes too (a failed one stays, so the person reads why)
    if (e instanceof GoogleCheckError && e.reason === 'cancelled') close()
    throw e
  }
}
