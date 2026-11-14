// A sign-in that takes this page to another site and back by its address (Add to Slack, Sign in with Slack: the
// answer comes back as ?slack=…). In a browser the page goes there; in the desktop app the window stays and the system
// browser opens instead (desktop/src/main/security.ts sends a foreign address there), and in the phone app its browser
// does: the page then waits, and must never wait for ever (QA TC-1417: the browser window was closed before it
// finished). So while it waits: Try again and Cancel always (BrowserWait), the state read again whenever the window is
// used again (it may have finished in the other browser), and a wait that ends by itself (lib/signInWait.ts). A page
// the browser brings back from its history (Back from Slack) stops waiting too.
import { useEffect, useRef, useState } from 'react'
import { useWaitLimit } from './signInWait'

export function useBrowserHandoff(onBack?: () => void) {
  // when the wait began (a new wait: a new clock), or null
  const [since, setSince] = useState<number | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const back = useRef(onBack)
  back.current = onBack
  const waiting = since !== null
  useEffect(() => {
    if (!waiting) return
    const shown = (e: PageTransitionEvent) => { if (e.persisted) setSince(null) }
    const again = () => { if (document.visibilityState !== 'hidden') back.current?.() }
    window.addEventListener('pageshow', shown)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('pageshow', shown)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [waiting])
  useWaitLimit(waiting, since, () => { setSince(null); setTimedOut(true) })
  return {
    waiting,
    timedOut,
    /** go to `url` (this page, or the other browser) and wait for the way back */
    go: (url: string) => { setTimedOut(false); setSince(Date.now()); window.location.assign(url) },
    /** stop waiting (Cancel, or it finished) */
    stop: () => { setSince(null); setTimedOut(false) },
  }
}
