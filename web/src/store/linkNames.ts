// Names of app links shown as chips (docs/decisions/20261118-named-app-links.md; components/AppLinkChip.tsx): what the
// server said each link is called for the signed-in person (POST /api/link-names). The chips of a screen ask at once:
// one request per short burst, each link once (deduplicated), at most LINK_NAMES_MAX per request. An answer is kept for
// a few minutes (a rename shows on the next look after that), and dropped with the person's other stores on a switch
// of account (App.tsx dropPersonStores), so nobody sees a name looked up for someone else.
import { create } from 'zustand'
import { LINK_NAMES_MAX, type LinkName, type LinkNameRef } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { appLinkKey } from '../lib/appLinks'

/** How long an answer is used before the next chip that shows it asks again. */
export const LINK_NAME_TTL_MS = 3 * 60_000
/** How long the first chip waits for the others of the same screen before asking. */
const BURST_MS = 25

export type LinkNameAnswer = Pick<LinkName, 'name' | 'folder' | 'room'> & { at: number }

interface LinkNamesState {
  byKey: Record<string, LinkNameAnswer>
  reset: () => void
}

let generation = 0
const queued = new Map<string, LinkNameRef>()
const asking = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

export const useLinkNames = create<LinkNamesState>((set) => ({
  byKey: {},
  reset: () => {
    generation++
    queued.clear()
    asking.clear()
    if (timer) clearTimeout(timer)
    timer = null
    set({ byKey: {} })
  },
}))

/** Ask for this link's name unless it is known (and fresh), queued or being asked already. */
export function wantLinkName(ref: LinkNameRef, now = Date.now()): void {
  const key = appLinkKey(ref)
  const have = useLinkNames.getState().byKey[key]
  if ((have && now - have.at < LINK_NAME_TTL_MS) || queued.has(key) || asking.has(key)) return
  queued.set(key, { kind: ref.kind, id: ref.id })
  timer ??= setTimeout(flush, BURST_MS)
}

function flush() {
  timer = null
  const all = [...queued.entries()]
  queued.clear()
  const mine = generation
  for (let i = 0; i < all.length; i += LINK_NAMES_MAX) {
    const part = all.slice(i, i + LINK_NAMES_MAX)
    for (const [k] of part) asking.add(k)
    void api.call(API.linkNames, { body: { links: part.map(([, r]) => r) } }).then(
      (r) => {
        if (mine !== generation) return
        const at = Date.now()
        const next: Record<string, LinkNameAnswer> = {}
        for (const it of r.items) next[appLinkKey(it)] = { name: it.name, ...(it.folder ? { folder: it.folder } : {}), ...(it.room ? { room: it.room } : {}), at }
        // a link the answer left out is named like one without access (never guessed)
        for (const [k] of part) next[k] ??= { name: null, at }
        useLinkNames.setState((s) => ({ byKey: { ...s.byKey, ...next } }))
      },
      () => {
        if (mine !== generation) return
        // offline or refused: the generic words for now (an answer still fresh stays; an old one is not shown on: the
        // viewer may have lost access since), asked again after a short while
        const now = Date.now()
        const at = now - LINK_NAME_TTL_MS + 30_000
        const kept = (a: LinkNameAnswer | undefined) => (a && now - a.at < LINK_NAME_TTL_MS ? a : { name: null, at })
        useLinkNames.setState((s) => ({ byKey: { ...s.byKey, ...Object.fromEntries(part.map(([k]) => [k, kept(s.byKey[k])])) } }))
      },
    ).finally(() => {
      if (mine !== generation) return
      for (const [k] of part) asking.delete(k)
    })
  }
}

/** For tests: the batch now, without waiting for the burst. */
export const flushLinkNamesForTest = () => { if (timer) { clearTimeout(timer); flush() } }
