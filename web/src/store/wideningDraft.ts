// The way back to a sharing dialog on a phone (docs/DECISIONS.md "People who see a shared chat later: nothing new is
// hidden", the widening list): an answer of the list opens on the same screen there, so before it leaves, the dialog's
// draft (which project, the picks, the list's scroll, where it was opened) is kept here and in sessionStorage (this tab
// only; storage may be blocked: then the app's memory alone). The chat page then shows "‹ Back to sharing"; that bar and
// the system Back return to the screen that opened the dialog, and WideningDraftHost opens it again on the list with the
// picks. A draft older than 30 minutes, or one whose project's members were saved meanwhile (its rules hash changed),
// is dropped and the dialog opens fresh.
import { create } from 'zustand'
import type { ProjectParticipant } from '@mycel/shared/api'
import type { RuleRef } from '../components/ProjectParticipants'

export const DRAFT_MAX_AGE_MS = 30 * 60_000
const KEY = 'trina.wideningDraft'

export interface WideningDraft {
  projectId: string
  participants: ProjectParticipant[]
  removeRules: RuleRef[]
  /** the members' rules hash the picks were made on: a save meanwhile drops the draft */
  rulesHash: string
  /** the list's scroll (px) */
  scroll: number
  /** the screen that opened the dialog (pathname + search) */
  from: string
  at: number
  /** left for an answer: the dialog opens again when that screen is back */
  left: boolean
}

const read = (): WideningDraft | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as WideningDraft | null
    return v && typeof v.projectId === 'string' && Array.isArray(v.participants) && typeof v.from === 'string' ? v : null
  } catch { return null }
}
const write = (d: WideningDraft | null) => {
  try { if (d) sessionStorage.setItem(KEY, JSON.stringify(d)); else sessionStorage.removeItem(KEY) } catch { /* storage blocked: memory only */ }
}

/** A draft still good to restore at `now` (not older than 30 minutes). */
export const freshDraft = (d: WideningDraft | null, now = Date.now()): d is WideningDraft => !!d && now - d.at <= DRAFT_MAX_AGE_MS

interface DraftState {
  draft: WideningDraft | null
  keep: (d: WideningDraft) => void
  /** back on the screen that opened it: the host takes the draft (left → false) */
  reopened: () => void
  drop: () => void
  reset: () => void
}

export const useWideningDraft = create<DraftState>((set, get) => ({
  draft: typeof window === 'undefined' ? null : read(),
  keep: (d) => { write(d); set({ draft: d }) },
  reopened: () => { const d = get().draft; if (!d) return; const next = { ...d, left: false }; write(next); set({ draft: next }) },
  drop: () => { write(null); set({ draft: null }) },
  reset: () => set({ draft: null }),
}))
