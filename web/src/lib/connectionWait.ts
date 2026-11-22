// A message sent while the device is offline (QA TC-r2d-06): it stays "sending" and goes by itself once the connection
// is back, however long that takes, never turning into "not sent" only because the person was offline for a while.
// Offline: the browser says so (navigator.onLine false), or the live connection to the server is down (store/ui conn,
// set by store/live.ts). Back: the browser's "online", or the live connection open again; and in any case a try again
// every CONNECTION_RECHECK_MS, so a state that never changes (no live connection in this window) cannot hold a message
// forever.
import { useUi } from '../store/ui'

export const CONNECTION_RECHECK_MS = 20_000

export function connectionDown(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const conn = useUi.getState().conn
  return conn === 'offline' || conn === 'reconnecting'
}

/** Settles once the connection looks back (at once when it is not down), or after CONNECTION_RECHECK_MS. */
export function whenConnected(recheckMs = CONNECTION_RECHECK_MS): Promise<void> {
  if (!connectionDown()) return Promise.resolve()
  return new Promise((resolve) => {
    const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null
    const done = () => {
      clearTimeout(timer)
      unsub()
      win?.removeEventListener('online', done)
      resolve()
    }
    const check = () => { if (!connectionDown()) done() }
    const timer = setTimeout(done, recheckMs)
    const unsub = useUi.subscribe((s, prev) => { if (s.conn !== prev.conn) check() })
    // the browser is online again: try (the live connection may take a moment longer to say so)
    win?.addEventListener('online', done)
  })
}
