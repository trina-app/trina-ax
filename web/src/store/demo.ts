// Demo mode (`bun run demo:company`, docs/DECISIONS.md "Demo company: a new hire at 트리나"): GET /api/demo answers only on
// a development server started for the demo; everywhere else it is 404 and nothing of the demo shows. Read once per
// page load (a persona switch reloads the page).
import { create } from 'zustand'
import type { DemoInfo, DemoPersonaKey } from '@mycel/shared/api'
import { api, API, isApiError } from '../lib/api'

/** set when the viewer switched person at least once in this tab: the new hire's screen then offers the same question */
const SWITCHED_KEY = 'mycel.demo.switched'

interface State {
  loaded: boolean
  /** null: not a demo server (or it could not be read) */
  info: DemoInfo | null
  load: () => Promise<DemoInfo | null>
}

let inflight: Promise<DemoInfo | null> | null = null

export const useDemo = create<State>((set, get) => ({
  loaded: false,
  info: null,
  load() {
    if (get().loaded) return Promise.resolve(get().info)
    inflight ??= api.call(API.demoInfo).then(
      (info) => { set({ loaded: true, info }); return info },
      (e) => {
        // 404: no demo here; anything else: show the normal app rather than half a demo
        if (!isApiError(e, 'not_found')) console.warn('demo info', e)
        set({ loaded: true, info: null })
        return null
      },
    ).finally(() => { inflight = null })
    return inflight
  },
}))

/** Sign in as another demo person (a real sign-in of that account on the server), then start the app again as them.
 * `first`: the sign-in page's start, which is not a switch (the new hire's screen keeps its three questions). */
export async function switchPersona(key: DemoPersonaKey, o: { first?: boolean; go?: (to: string) => void } = {}): Promise<void> {
  await api.call(API.demoSwitch, { body: { key } })
  if (!o.first) try { sessionStorage.setItem(SWITCHED_KEY, '1') } catch { /* storage blocked: the same question is still in the menu */ }
  ;(o.go ?? ((to) => window.location.assign(to)))('/')
}

export function hasSwitched(): boolean {
  try { return sessionStorage.getItem(SWITCHED_KEY) === '1' } catch { return false }
}
