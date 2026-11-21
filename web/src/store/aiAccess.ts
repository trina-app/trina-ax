// Can this person use AI now, and which button fits (GET /api/me/ai-access). One copy for the banner above the composer
// and the button in a failed answer. Nothing shows before the first answer, so it never flashes for people with AI.
import { create } from 'zustand'
import { api, API } from '../lib/api'
import type { AiAction } from '../lib/aiAccess'

interface State {
  loaded: boolean
  usable: boolean
  /** the last read was answered (a failed read leaves `usable` true so nothing shows; this says AI was not confirmed) */
  answered: boolean
  action: AiAction
  requested: boolean
  /** "Trina isn't ready yet": this member already told an admin within the hour (GET /api/me/ai-access `notReadyTold`,
   * the server's own limit record), so [Tell an admin] reads "Told" after a reload too */
  notReadyTold: boolean
  /** connected, but used up until this time (GET /api/me/ai-access `limitedUntil`): `usable` stays true for the
   * screens, so no "connect an AI" banner or card contradicts the answer's own "used up until …" line */
  limitedUntil: string | null
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
    // used up until a known time is not "no AI": an AI is connected, and every failed answer says until when (one
    // message on screen, not that and "No AI is connected yet"; owner review 2026-11-19, QA TC-5192)
    const limitedUntil = !r.usable && r.limitedUntil ? r.limitedUntil : null
    set({ loaded: true, answered: true, usable: r.usable || !!limitedUntil, limitedUntil, action: r.action, requested: r.requested, notReadyTold: (r.notReadyTold ?? false) || get().notReadyTold })
  } catch {
    if (g !== generation) return
    // a failed check is not "no AI": nothing shows
    set({ loaded: true, answered: false, usable: true, limitedUntil: null })
  }
}

export const useAiAccess = create<State>((set, get) => ({
  loaded: false, usable: true, answered: false, action: 'ask_owner', requested: false, notReadyTold: false, limitedUntil: null, sending: false, failed: false,
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
  reset() { generation++; reading = null; readAt = 0; set({ loaded: false, usable: true, answered: false, action: 'ask_owner', requested: false, notReadyTold: false, limitedUntil: null, sending: false, failed: false }) },
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
