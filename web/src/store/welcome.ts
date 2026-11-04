// The welcome steps' progress on the server (GET/PATCH /api/onboarding/welcome), one copy for the steps page, the
// Home entry and the invite bar on the first-result chat. Only owners and admins can read it; callers check the role.
import { create } from 'zustand'
import type { SkillPackInstallResult, WelcomeProgress, WelcomeUpdate } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface State {
  loaded: boolean
  progress: WelcomeProgress | null
  load: (force?: boolean) => Promise<WelcomeProgress | null>
  /** one change; the server's answer replaces the copy */
  update: (u: WelcomeUpdate) => Promise<WelcomeProgress>
  /** the marketing pack, once (the server records it; null when it ran before) */
  installPack: () => Promise<SkillPackInstallResult | null>
  /** sign-out: nothing one person saw stays for the next */
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0
let inflight: Promise<WelcomeProgress | null> | null = null

export const useWelcome = create<State>((set, get) => ({
  loaded: false,
  progress: null,
  async load(force) {
    if (get().loaded && !force) return get().progress
    if (inflight && !force) return inflight
    const g = generation
    const p = api.call(API.getWelcome).then(
      (r) => { if (g === generation) set({ loaded: true, progress: r.progress }); return r.progress },
      // a failed read shows no entry and no bar; the steps page says so itself
      (e) => { if (g === generation) set({ loaded: true }); throw e },
    ).finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  },
  async update(u) {
    const g = generation
    const r = await api.call(API.updateWelcome, { body: u })
    if (g === generation) set({ loaded: true, progress: r.progress })
    return r.progress!
  },
  async installPack() {
    const g = generation
    const r = await api.call(API.installWelcomePack)
    if (g === generation) set({ loaded: true, progress: r.progress })
    return r.install
  },
  reset() { generation++; inflight = null; set({ loaded: false, progress: null }) },
}))
