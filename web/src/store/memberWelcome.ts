// The welcome card for invited people (GET/PATCH /api/me/welcome; docs/DECISIONS.md "A welcome for invited people").
// One copy for Home, which leaves its other top things out while the card shows. A failed read counts as "no card".
import { create } from 'zustand'
import type { MemberWelcome } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface State {
  loaded: boolean
  welcome: MemberWelcome | null
  /** read again (Home reads it each time it opens: a message written in a room meanwhile is "Say hi" done) */
  load: () => Promise<void>
  /** a row done here: shown at once, the server's answer follows */
  mark: (step: 'hi' | 'photo' | 'asked') => void
  hide: () => Promise<void>
  asked: () => Promise<void>
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0

export const useMemberWelcome = create<State>((set, get) => ({
  loaded: false,
  welcome: null,
  async load() {
    const g = generation
    try {
      const r = await api.call(API.getMemberWelcome)
      if (g === generation) set({ loaded: true, welcome: r.welcome })
    } catch {
      if (g === generation) set({ loaded: true, welcome: get().welcome })
    }
  },
  mark(step) {
    const w = get().welcome
    if (w) set({ welcome: { ...w, steps: { ...w.steps, [step]: true } } })
  },
  async hide() {
    const g = generation
    // gone at once; the server keeps it hidden on every device
    set({ welcome: null })
    try { await api.call(API.updateMemberWelcome, { body: { hide: true } }) } catch { if (g === generation) void get().load() }
  },
  async asked() {
    get().mark('asked')
    const g = generation
    try {
      const r = await api.call(API.updateMemberWelcome, { body: { asked: true } })
      if (g === generation) set({ welcome: r.welcome })
    } catch { /* the next read says */ }
  },
  reset() { generation++; set({ loaded: false, welcome: null }) },
}))
