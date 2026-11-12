// Who else is writing where (docs/DECISIONS.md "입력 중 표시"), as the socket tells it (lib/realtime.ts onTyping,
// store/live.ts). A place is a room's box (threadRootId null) or a thread's box. A person drops off ROOM_TYPING_EXPIRES_MS
// after their last "typing", at their "stopped", when their message arrives in that place, and everyone at once when this
// window loses the server or signs out. Nothing is kept anywhere else.
import { create } from 'zustand'
import { ROOM_TYPING_EXPIRES_MS, type RoomTypingFrame } from '@mycel/shared/api'

export const typingPlace = (roomId: string, threadRootId: string | null | undefined) => `${roomId}:${threadRootId ?? ''}`

export interface TypingTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}
let timers: TypingTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}
/** Tests: a fake clock. */
export function setTypingTimers(t: TypingTimers) { timers = t }

interface TypingStore {
  /** place → person → when they drop off (clock ms); a person keeps their place in the order while they keep typing */
  byPlace: Record<string, Record<string, number>>
  apply: (f: RoomTypingFrame) => void
  /** their message arrived there: they are no longer writing it */
  sent: (roomId: string, threadRootId: string | null | undefined, userId: string) => void
  /** drop whoever ran out */
  sweep: () => void
  clear: () => void
}

let timer: unknown = null
/** one timer for the next person to run out */
function schedule(byPlace: TypingStore['byPlace']) {
  if (timer !== null) timers.clearTimeout(timer)
  timer = null
  let next = Infinity
  for (const p of Object.values(byPlace)) for (const at of Object.values(p)) next = Math.min(next, at)
  if (next === Infinity) return
  timer = timers.setTimeout(() => {
    timer = null
    useTyping.getState().sweep()
  }, Math.max(0, next - timers.now()))
}

function without(byPlace: TypingStore['byPlace'], key: string, userId: string): TypingStore['byPlace'] | null {
  const p = byPlace[key]
  if (!p || !(userId in p)) return null
  const { [userId]: _gone, ...rest } = p
  const next = { ...byPlace }
  if (Object.keys(rest).length) next[key] = rest
  else delete next[key]
  return next
}

export const useTyping = create<TypingStore>((set, get) => ({
  byPlace: {},
  apply: (f) => {
    const key = typingPlace(f.roomId, f.threadRootId)
    if (!f.typing) return get().sent(f.roomId, f.threadRootId, f.userId)
    const byPlace = { ...get().byPlace, [key]: { ...get().byPlace[key], [f.userId]: timers.now() + ROOM_TYPING_EXPIRES_MS } }
    set({ byPlace })
    schedule(byPlace)
  },
  sent: (roomId, threadRootId, userId) => {
    const next = without(get().byPlace, typingPlace(roomId, threadRootId), userId)
    if (!next) return
    set({ byPlace: next })
    schedule(next)
  },
  sweep: () => {
    const now = timers.now()
    const next: TypingStore['byPlace'] = {}
    for (const [key, p] of Object.entries(get().byPlace)) {
      const live = Object.entries(p).filter(([, at]) => at > now)
      if (live.length) next[key] = Object.fromEntries(live)
    }
    set({ byPlace: next })
    schedule(next)
  },
  clear: () => {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
    set({ byPlace: {} })
  },
}))

const NONE: readonly string[] = []
/** The people writing in this place now, in the order they started, never `meId`. */
export function useTypingIds(roomId: string, threadRootId: string | null, meId: string | null): readonly string[] {
  const ids = useTyping((s) => {
    const p = s.byPlace[typingPlace(roomId, threadRootId)]
    return p ? Object.keys(p).filter((id) => id !== meId).join('\n') : ''
  })
  return ids ? ids.split('\n') : NONE
}
