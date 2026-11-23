// How long a send that went without a card can still be taken back (docs/decisions/20261123-do-then-undo.md), for the post
// and share cards. The card appears while its step is still running (the record is set before the step ends), so the
// window starts when the step ends, and a card that saw that happen counts from its own clock (a device clock that runs
// ahead of the server's would otherwise lose the window). A card opened later counts from the saved end.
import { useEffect, useRef, useState } from 'react'

/** a step that ends within this long of the card appearing was seen live */
const LIVE_MS = 120_000

/** Seconds left to undo, rounded up; 0 when the time is over or `eligible` is false. */
export function useUndoWindow(endedAt: string | null | undefined, ms: number, eligible = true): number {
  const mounted = useRef(Date.now())
  const sawRunning = useRef(!endedAt)
  const deadline = useRef<number | null>(null)
  // (a page asleep for a while that only now hears the end gets no fresh window: it counts from the saved end)
  if (endedAt && deadline.current === null) deadline.current = sawRunning.current && Date.now() - mounted.current < LIVE_MS ? Date.now() + ms : Date.parse(endedAt) + ms
  // never more than the window, whatever the device's clock says
  const left = () => (!eligible ? 0 : deadline.current === null ? ms : Math.min(ms, Math.max(0, deadline.current - Date.now())))
  const [, tick] = useState(0)
  const remaining = left()
  useEffect(() => {
    if (!eligible || !endedAt || remaining <= 0) return
    // on the next whole second left (and exactly at the end)
    const id = setTimeout(() => tick((n) => n + 1), remaining % 1000 || 1000)
    return () => clearTimeout(id)
  })
  return Math.ceil(remaining / 1000)
}
