// Demo mode (`bun run demo:company`, docs/DECISIONS.md "Demo company: a new hire at 트리나"): GET /api/demo answers only on
// a development server started for the demo; everywhere else it is 404 and nothing of the demo shows. Read once per
// page load (a persona switch reloads the page).
//
// A free-roam demo (docs/decisions/20261119-demo-free-roam-web.md) also says how much of the demo limit is used: read
// again after every answer (store/live.ts message.done), and the limit is marked used up at once when a send or an
// answer is refused for it (lib/api.ts onDemoLimit, an answer's error), so the limit dialog opens once and every AI
// message box stops sending.
import { create } from 'zustand'
import { DEMO_LIMIT_REASON, type ApiErrorBody, type DemoInfo, type DemoPersonaKey } from '@mycel/shared/api'
import { api, API, isApiError, onDemoLimit } from '../lib/api'
import { demoMeter, demoReason, isFreeRoam, takeFreshStart } from '../lib/freeRoam'
import { clearLocalData } from '../lib/localData'
import { forgetStepsSeen } from '../lib/welcome'
import { forgetPersonInTab } from './session'

/** set when the viewer switched person at least once in this tab: the new hire's screen then offers the same question */
const SWITCHED_KEY = 'mycel.demo.switched'
/** set once the limit dialog was shown in this tab: a reload keeps the line under the box, not the dialog again */
const LIMIT_SEEN_KEY = 'mycel.demo.limitSeen'

interface State {
  loaded: boolean
  /** null: not a demo server (or it could not be read) */
  info: DemoInfo | null
  load: () => Promise<DemoInfo | null>
  /** free roam: the demo limit is used up (the server said so, or GET /api/demo counts it used) */
  out: boolean
  /** free roam: the limit dialog is open */
  limitOpen: boolean
  /** free roam: read the demo's use again (after an answer) */
  refresh: () => Promise<void>
  /** free roam: the demo limit is used up. `live` (the default): it was reached while this page was open (an answer
   * ended at or over it, a send was refused at it), and the limit sheet opens once; not live (the page loaded at the
   * limit): it opens only when this tab has not shown it yet */
  hitLimit: (live?: boolean) => void
  closeLimit: () => void
}

let inflight: Promise<DemoInfo | null> | null = null

const seenLimit = () => { try { return sessionStorage.getItem(LIMIT_SEEN_KEY) === '1' } catch { return false } }
const markSeen = () => { try { sessionStorage.setItem(LIMIT_SEEN_KEY, '1') } catch { /* storage blocked: the dialog may show again after a reload */ } }

export const useDemo = create<State>((set, get) => ({
  loaded: false,
  info: null,
  out: false,
  limitOpen: false,
  load() {
    if (get().loaded) return Promise.resolve(get().info)
    inflight ??= api.call(API.demoInfo).then(
      (info) => {
        // a new visitor (the gate's start opened `/?fresh=1`): nothing of the previous visitor of this browser, before
        // any screen of the app mounts (App.tsx shows its splash until this is loaded)
        if (isFreeRoam(info)) freshStart()
        set({ loaded: true, info })
        noteUse(info, false)
        return info
      },
      (e) => {
        // 404: no demo here; anything else: show the normal app rather than half a demo
        if (!isApiError(e, 'not_found')) console.warn('demo info', e)
        set({ loaded: true, info: null })
        return null
      },
    ).finally(() => { inflight = null })
    return inflight
  },
  async refresh() {
    if (!isFreeRoam(get().info)) return
    try {
      const info = await api.call(API.demoInfo)
      set({ info })
      noteUse(info, true)
    } catch { /* the next answer reads it again */ }
  },
  hitLimit(live = true) {
    if (!isFreeRoam(get().info) || get().out) return
    // QA TC-5575: a turn that ended just over the limit showed only the line under the box, because this tab had shown
    // the sheet before (an earlier instance on the same demo address keeps the tab's flag). Reaching 100 % on this
    // page always opens it, once (`out` stays set); only a reload at the limit leaves it to the line
    const show = live || !seenLimit()
    markSeen()
    set({ out: true, limitOpen: show })
  },
  closeLimit() { set({ limitOpen: false }) },
}))

/** The tab's own keys of this app (sessionStorage `mycel.*`: the box's chips, draft chats, the limit dialog seen, the
 * rail's places); none of them belongs to a new visitor. */
function forgetTabKeys() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k?.startsWith('mycel.')) sessionStorage.removeItem(k)
    }
  } catch { /* storage blocked: nothing kept to forget */ }
}

/**
 * Free roam, opened with `?fresh=1` (lib/freeRoam.ts takeFreshStart): the sign-out cleanup, as the account menu's
 * sign-out runs it (lib/logout.ts): unsent drafts, queued sends and uploads (localStorage), the box's chips and draft
 * chats (store/session.ts forgetPersonInTab), and the tab's own keys. Every demo copy has the same user id, so without
 * this a draft or a queued message of the previous visitor in this browser would show up (or be sent) on this copy.
 * Harmless when the parameter never comes. True when it ran.
 */
export function freshStart(o: { loc?: Pick<Location, 'href'>; history?: Pick<History, 'replaceState' | 'state'> } = {}): boolean {
  if (!takeFreshStart(o.loc, o.history)) return false
  clearLocalData()
  forgetPersonInTab()
  forgetStepsSeen()
  forgetTabKeys()
  return true
}

/** what GET /api/demo says about the limit: used up opens the dialog once; `live`: read again after an answer, so the
 * limit was reached on this page (a reload at the limit keeps only the line) */
function noteUse(info: DemoInfo | null, live: boolean) {
  if (!isFreeRoam(info)) return
  if (demoMeter(info.used, info.cap).out) useDemo.getState().hitLimit(live)
}

// a send (or any request) refused at the demo limit, wherever it came from
onDemoLimit(() => useDemo.getState().hitLimit(true))

/** store/live.ts: an AI answer ended. Free roam only: one refused at the limit marks it; any other reads the use again
 * (a little later, so the server has counted the answer) */
let refreshTimer: ReturnType<typeof setTimeout> | null = null
export function demoAnswerEnded(error: Pick<ApiErrorBody, 'params'> | null | undefined): void {
  const s = useDemo.getState()
  if (!isFreeRoam(s.info)) return
  if (demoReason(error) === DEMO_LIMIT_REASON) return s.hitLimit()
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshTimer = null; void useDemo.getState().refresh() }, 800)
}

/** Is this a free-roam demo (known once GET /api/demo was read; App.tsx waits for it before the app's screens). */
export const freeRoamNow = (): boolean => isFreeRoam(useDemo.getState().info)
export const useFreeRoam = (): boolean => useDemo((s) => isFreeRoam(s.info))
/** free roam and the demo limit used up: every AI message box stops sending */
export const useDemoOut = (): boolean => useDemo((s) => isFreeRoam(s.info) && s.out)

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
