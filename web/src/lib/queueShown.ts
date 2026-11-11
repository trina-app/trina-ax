// "Queued" shows only once an answer has waited a moment (QUEUE_SHOWN_AFTER_MS). The server starts at most 3 answers
// per 200 ms (chat/runtime.ts startSpread), so in a burst an answer may sit at place ≥ 1 for up to 200 ms although a
// slot is free; the place line (chat Messages, the room's RoomAiStatus) would flash for that moment.
import { useEffect, useState } from 'react'

export const QUEUE_SHOWN_AFTER_MS = 400

/** true once `queued` has held for QUEUE_SHOWN_AFTER_MS (false again the moment it stops) */
export function useQueueShown(queued: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!queued) { setShown(false); return }
    const t = setTimeout(() => setShown(true), QUEUE_SHOWN_AFTER_MS)
    return () => clearTimeout(t)
  }, [queued])
  return queued && shown
}
