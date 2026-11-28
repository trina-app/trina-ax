// The "My setup" card on Home (GET/PATCH /api/me/welcome; docs/DECISIONS.md "A welcome for invited people",
// docs/decisions/20261120-my-setup-card.md). One copy for Home, which leaves its other top things out while the card
// shows, Settings › Profile (show a hidden card again) and Admin › Home (an admin's "팀 파일 정리하기"). A failed read
// counts as "no card".
import { create } from 'zustand'
import type { MemberWelcome, MemberWelcomeResponse } from '@mycel/shared/api'
import { api, API } from '../lib/api'

interface State {
  loaded: boolean
  welcome: MemberWelcome | null
  /** the card was hidden while its days last: Settings › Profile can show it again */
  hidden: boolean
  /** an admin's "팀 파일 정리하기" on Admin › Home */
  organizeFiles: boolean
  /** read again (Home reads it each time it opens: a message written in a room meanwhile is "Say hi" done) */
  load: () => Promise<void>
  /** a row done here: shown at once, the server's answer follows */
  mark: (step: 'hi' | 'photo' | 'asked' | 'files' | 'tools') => void
  /** false: the server did not take it (the card comes back from a fresh read) */
  hide: () => Promise<boolean>
  /** Settings › Profile: the hidden card back on Home */
  show: () => Promise<boolean>
  /** "You're all set" has had its moment: gone from this page (the server lets it go by itself a little later) */
  drop: () => void
  asked: () => Promise<void>
  /** every tool the tools row offers is the team's for everyone: nothing left to connect, the row is done */
  toolsCovered: () => Promise<void>
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0
/** cards whose "all set" was dropped on this page, so a read meanwhile does not bring it back */
let dropped = false

const from = (r: MemberWelcomeResponse) => ({ welcome: dropped && r.welcome?.allSet ? null : r.welcome, hidden: !!r.hidden, organizeFiles: !!r.organizeFiles })

export const useMemberWelcome = create<State>((set, get) => ({
  loaded: false,
  welcome: null,
  hidden: false,
  organizeFiles: false,
  async load() {
    const g = generation
    try {
      const r = await api.call(API.getMemberWelcome)
      if (g === generation) set({ loaded: true, ...from(r) })
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
    set({ welcome: null, hidden: !get().welcome?.allSet })
    try {
      await api.call(API.updateMemberWelcome, { body: { hide: true } })
      return true
    } catch {
      if (g === generation) void get().load()
      return false
    }
  },
  async show() {
    const g = generation
    try {
      const r = await api.call(API.updateMemberWelcome, { body: { show: true } })
      if (g === generation) set({ loaded: true, ...from(r) })
      return true
    } catch { return false }
  },
  drop() { dropped = true; set({ welcome: null }) },
  async asked() {
    get().mark('asked')
    const g = generation
    try {
      const r = await api.call(API.updateMemberWelcome, { body: { asked: true } })
      if (g === generation) set(from(r))
    } catch { /* the next read says */ }
  },
  async toolsCovered() {
    get().mark('tools')
    const g = generation
    try {
      const r = await api.call(API.updateMemberWelcome, { body: { tools: true } })
      if (g === generation) set(from(r))
    } catch { /* the next read says */ }
  },
  reset() { generation++; dropped = false; set({ loaded: false, welcome: null, hidden: false, organizeFiles: false }) },
}))
