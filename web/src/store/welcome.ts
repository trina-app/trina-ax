// The welcome steps' progress on the server (GET/PATCH /api/onboarding/welcome), one copy for the steps page, the
// Home entry and the invite bar on the first-result chat. Only owners and admins can read it; callers check the role.
import { create } from 'zustand'
import type { WelcomeProgress, WelcomeTeamResult, WelcomeUpdate } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface State {
  loaded: boolean
  progress: WelcomeProgress | null
  load: (force?: boolean) => Promise<WelcomeProgress | null>
  /** a read that is at most a few seconds old (or on its way) is as good as a new one: the steps page opening right
   * after Home's own read shares it instead of asking again; older: a new read */
  loadRecent: () => Promise<WelcomeProgress | null>
  /** one change; the server's answer replaces the copy */
  update: (u: WelcomeUpdate) => Promise<WelcomeProgress>
  /** every team's start: the general pack and the team's own group and folders, once (the server keeps that too);
   * two calls at once share one request */
  setupTeam: () => Promise<WelcomeTeamResult>
  /** sign-out: nothing one person saw stays for the next */
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0
let inflight: Promise<WelcomeProgress | null> | null = null
/** when the last read came back */
let readAt = 0
const RECENT_MS = 3000
let settingUp: Promise<WelcomeTeamResult> | null = null

export const useWelcome = create<State>((set, get) => ({
  loaded: false,
  progress: null,
  async load(force) {
    if (get().loaded && !force) return get().progress
    if (inflight && !force) return inflight
    const g = generation
    const p = api.call(API.getWelcome).then(
      (r) => { if (g === generation) { set({ loaded: true, progress: r.progress }); readAt = Date.now() } return r.progress },
      // a failed read shows no entry and no bar; the steps page says so itself
      (e) => { if (g === generation) set({ loaded: true }); throw e },
    ).finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  },
  async loadRecent() {
    if (inflight) return inflight
    if (get().loaded && Date.now() - readAt < RECENT_MS) return get().progress
    return get().load(true)
  },
  async update(u) {
    const g = generation
    const r = await api.call(API.updateWelcome, { body: u })
    if (g === generation) set({ loaded: true, progress: r.progress })
    return r.progress!
  },
  setupTeam() {
    if (settingUp) return settingUp
    const g = generation
    const p = api.call(API.setupWelcomeTeam).then((r) => {
      if (g === generation) set({ loaded: true, progress: r.progress })
      return r
    }).finally(() => { if (settingUp === p) settingUp = null })
    settingUp = p
    return p
  },
  reset() { generation++; inflight = null; readAt = 0; settingUp = null; set({ loaded: false, progress: null }) },
}))
