// How long a screen waits for a sign-in that happens in a browser window (Connect → Google, a service's sign-in page,
// Add to Slack, Sign in with Slack) before it stops waiting and offers Connect again (QA TC-1417: the window was
// closed before it finished, and the page waited for ever with no way out). The server keeps such a flow 10 minutes
// and a new Connect replaces it; a screen that gives up first cancels it there where it can, so nothing is left half
// done (docs/DECISIONS.md "Connect: a wait that can always be left").
import { useEffect, useRef } from 'react'

/** five minutes: enough to sign in and approve; shorter than the server's 10-minute flows */
export const SIGN_IN_WAIT_MS = 5 * 60_000

/** Call `onTimeout` once `active` has lasted `ms`. `key` names one wait: a new key (a new flow) starts the clock again. */
export function useWaitLimit(active: boolean, key: unknown, onTimeout: () => void, ms = SIGN_IN_WAIT_MS) {
  const done = useRef(onTimeout)
  done.current = onTimeout
  useEffect(() => {
    if (!active) return
    const id = setTimeout(() => done.current(), ms)
    return () => clearTimeout(id)
  }, [active, key, ms])
}
