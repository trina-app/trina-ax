// Status messages (docs/DECISIONS.md "상태 메시지"): whose status shows now. The team's come with the people directory
// (store/people.ts, read again on the quiet profile notices); mine with my account (GET /api/me), which also has one
// that starts later. An ended status is hidden here at once by this window's own clock: one timer, for the soonest end
// of what is on screen, so nothing waits for the server's notice (or for a socket that is down).
import { useCallback } from 'react'
import { create } from 'zustand'
import type { MyStatus, StatusMessage } from '@mycel/shared/api'
import { usePeople } from './people'
import { useSession } from './session'

/** the time the statuses on screen were last looked at (a re-render when one ends) */
export const useStatusClock = create<{ now: number }>(() => ({ now: Date.now() }))

/** A status that shows now: not ended, and (mine) not one whose first day is still to come. */
export function liveStatus(s: StatusMessage | MyStatus | undefined | null, now: number): StatusMessage | null {
  if (!s) return null
  if ('fromDay' in s && s.fromDay) return null
  if (s.until && Date.parse(s.until) <= now) return null
  return s
}

let timer: ReturnType<typeof setTimeout> | null = null
/** Wait for the soonest end among the statuses this window knows. */
function arm() {
  if (timer) clearTimeout(timer)
  timer = null
  const now = Date.now()
  let next = Infinity
  const see = (s: StatusMessage | undefined) => {
    const t = s?.until ? Date.parse(s.until) : NaN
    if (t > now && t < next) next = t
  }
  for (const p of Object.values(usePeople.getState().byId)) see(p.statusMessage)
  const st = useSession.getState().status
  if (st.kind === 'signed-in') see(st.me.user.statusMessage)
  if (next === Infinity) return
  // a timer cannot wait longer than about 24 days: it then looks again
  timer = setTimeout(() => {
    timer = null
    useStatusClock.setState({ now: Date.now() })
    arm()
  }, Math.min(next - now + 50, 2 ** 31 - 1))
}
if (typeof window !== 'undefined') {
  usePeople.subscribe((s, prev) => { if (s.byId !== prev.byId) arm() })
  useSession.subscribe((s, prev) => { if (s.status !== prev.status) arm() })
}

/** Someone's status now (mine from my account: it follows a save at once), or null. */
export function useStatusOf(userId: string | null | undefined): StatusMessage | null {
  const now = useStatusClock((s) => s.now)
  const mine = useSession((s) => (s.status.kind === 'signed-in' && userId && s.status.me.user.id === userId ? (s.status.me.user.statusMessage ?? null) : undefined))
  const theirs = usePeople((s) => (userId ? s.byId[userId]?.statusMessage : undefined))
  // the clock's time, or the real time if it has moved on since (a render for another reason)
  return liveStatus(mine === undefined ? theirs : mine, Math.max(now, Date.now()))
}

/** For a list (an unnamed group chat's names): a status by id, as useStatusOf gives it. */
export function useStatusesOf(): (userId: string) => StatusMessage | null {
  const now = useStatusClock((s) => s.now)
  const byId = usePeople((s) => s.byId)
  const me = useSession((s) => (s.status.kind === 'signed-in' ? s.status.me.user : null))
  return useCallback((id: string) => liveStatus(me && me.id === id ? me.statusMessage : byId[id]?.statusMessage, Math.max(now, Date.now())), [now, byId, me])
}

/** My own status after a save or a clear: my account at once (the notice makes my other windows read it again), and my
 * line in the directory, so every place shows it before the list is read again. */
export function applyMyStatus(status: MyStatus | null) {
  const st = useSession.getState().status
  if (st.kind !== 'signed-in') return
  const user = { ...st.me.user }
  if (status) user.statusMessage = status
  else delete user.statusMessage
  useSession.setState({ status: { kind: 'signed-in', me: { ...st.me, user } } })
  const p = usePeople.getState()
  const mine = p.byId[user.id]
  if (!mine) return
  const live = liveStatus(status, Date.now())
  const next = { ...mine }
  if (live) next.statusMessage = { emoji: live.emoji, text: live.text, ...(live.until ? { until: live.until } : {}), ...(live.untilDay ? { untilDay: live.untilDay } : {}) }
  else delete next.statusMessage
  usePeople.setState({ byId: { ...p.byId, [user.id]: next }, people: p.people?.map((x) => (x.id === user.id ? next : x)) ?? null })
}
