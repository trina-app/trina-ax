// 팀장 넘기기 for the owner (shared/src/api/handover.ts, docs/DECISIONS.md "W6"): one copy of GET /api/admin/handover
// for Home's card, the invite flag (Admin › Members, the welcome steps' invite step) and the confirm dialog. Only the
// owner reads it; for anyone else it holds nothing and asks nothing. The realtime notices reload it
// (store/live.ts: owner_lead_joined, owner_changed).
import { create } from 'zustand'
import type { HandoverState } from '@mycel/shared/api'
import { api, API } from '../lib/api'
import { isOwner, useSession } from './session'

interface State {
  loaded: boolean
  state: HandoverState | null
  /** read it (once; `force`: again). Not the owner: nothing (null) */
  load: (force?: boolean) => Promise<HandoverState | null>
  /** ✕ on Home's card: hidden at once, the server records it (the Inbox notice stays) */
  dismiss: () => Promise<void>
  /** sign-out: nothing one person saw stays for the next */
  reset: () => void
}

/** bumped on sign-out: an answer that arrives after it belongs to the previous person and is dropped */
let generation = 0
let inflight: Promise<HandoverState | null> | null = null

const ownerNow = () => {
  const s = useSession.getState().status
  return s.kind === 'signed-in' && isOwner(s.me)
}

export const useHandover = create<State>((set, get) => ({
  loaded: false,
  state: null,
  async load(force) {
    if (!ownerNow()) {
      set({ loaded: true, state: null })
      return null
    }
    if (get().loaded && !force) return get().state
    if (inflight && !force) return inflight
    const g = generation
    const p = api.call(API.handoverState).then(
      (r) => { if (g === generation) set({ loaded: true, state: r }); return r },
      // a failed read: no flag and no card; the dialog says it could not list the connections
      (e) => { if (g === generation) set({ loaded: true }); throw e },
    ).finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  },
  async dismiss() {
    const card = get().state?.card
    if (!card) return
    const g = generation
    const mark = (dismissed: boolean) => {
      const s = get().state
      if (g === generation && s?.card?.inviteId === card.inviteId) set({ state: { ...s, card: { ...s.card, dismissed } } })
    }
    mark(true)
    try {
      await api.call(API.dismissLeadCard, { body: { inviteId: card.inviteId } })
    } catch (e) {
      mark(false)
      throw e
    }
  },
  reset() { generation++; inflight = null; set({ loaded: false, state: null }) },
}))

/** This window handed the role over a moment ago: the realtime owner_changed that follows is not toasted a second time
 * (the dialog already said it). */
let transferredAt = 0
export const markTransferredHere = () => { transferredAt = Date.now() }
export const transferredHere = (now = Date.now()) => now - transferredAt < 15_000
