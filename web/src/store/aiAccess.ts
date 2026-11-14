// Can this person use AI now, and which button fits (GET /api/me/ai-access). One copy for the banner above the composer
// and the button in a failed answer. Nothing shows before the first answer, so it never flashes for people with AI.
import { create } from 'zustand'
import { api, API } from '../lib/api'
import type { AiAction } from '../lib/aiAccess'

interface State {
  loaded: boolean
  usable: boolean
  action: AiAction
  requested: boolean
  /** the trial AI credit is used up or over (GET /api/me/ai-access `trial`) */
  trial: 'used' | 'ended' | null
  /** "Trina isn't ready yet": this member already told an admin within the hour (GET /api/me/ai-access `notReadyTold`,
   * the server's own limit record), so [Tell an admin] reads "Told" after a reload too */
  notReadyTold: boolean
  sending: boolean
  failed: boolean
  load: (force?: boolean) => Promise<void>
  /** as welcome's loadRecent: an answer a few seconds old (or on its way) is shared instead of asked again */
  loadRecent: () => Promise<void>
  ask: () => Promise<void>
  /** a press of [Tell an admin] went through: every not-ready card of this person reads "Told" */
  markNotReadyTold: () => void
  /** sign-out: nothing one person saw stays for the next */
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0
/** the read on its way: the banner and the welcome card mount together and each asked (two at start); one is shared */
let readAt = 0
const RECENT_MS = 3000
let reading: { generation: number; force: boolean; read: Promise<void> } | null = null

/** GET /api/me/ai-access into the store (an answer for the previous person is dropped). */
async function readAccess(get: () => State, set: (s: Partial<State>) => void): Promise<void> {
  const g = generation
  try {
    const r = await api.call(API.getAiAccess)
    if (g !== generation) return
    readAt = Date.now()
    // a press that went through while this answer was on its way stays "Told"
    set({ loaded: true, usable: r.usable, action: r.action, requested: r.requested, trial: r.trial ?? null, notReadyTold: (r.notReadyTold ?? false) || get().notReadyTold })
  } catch {
    if (g !== generation) return
    // a failed check is not "no AI": nothing shows
    set({ loaded: true, usable: true })
  }
}

export const useAiAccess = create<State>((set, get) => ({
  loaded: false, usable: true, action: 'ask_owner', requested: false, trial: null, notReadyTold: false, sending: false, failed: false,
  load(force) {
    if (get().loaded && !force) return Promise.resolve()
    // a forced read wants an answer from after now: it shares only another forced one
    if (reading && reading.generation === generation && (reading.force || !force)) return reading.read
    const entry = { generation, force: !!force, read: readAccess(get, set) }
    reading = entry
    const done = () => { if (reading === entry) reading = null }
    entry.read.then(done, done)
    return entry.read
  },
  loadRecent() {
    if (reading && reading.generation === generation) return reading.read
    if (get().loaded && Date.now() - readAt < RECENT_MS) return Promise.resolve()
    return get().load(true)
  },
  reset() { generation++; reading = null; readAt = 0; set({ loaded: false, usable: true, action: 'ask_owner', requested: false, trial: null, notReadyTold: false, sending: false, failed: false }) },
  markNotReadyTold() { set({ notReadyTold: true }) },
  async ask() {
    if (get().sending || get().requested) return
    set({ sending: true, failed: false })
    const g = generation
    try {
      await api.call(API.requestAiAccess)
      if (g !== generation) return
      set({ requested: true, sending: false })
    } catch {
      if (g !== generation) return
      set({ sending: false, failed: true })
    }
  },
}))
