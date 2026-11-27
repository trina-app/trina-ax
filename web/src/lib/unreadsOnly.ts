// 활동's "안 읽음 / Unreads" switch (docs/decisions/20261127-activity-lean.md): off by default, remembered in this browser,
// and one switch for the computer's list (components/panels/ActivityPanel.tsx) and the phone's page (pages/Activity.tsx),
// so the two never disagree in one browser.
import { create } from 'zustand'

export const UNREADS_ONLY_KEY = 'mycel.activity.unreadsOnly'

const read = () => {
  try {
    return localStorage.getItem(UNREADS_ONLY_KEY) === 'yes'
  } catch {
    return false
  }
}

export const useUnreadsOnly = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: typeof window === 'undefined' ? false : read(),
  set: (on) => {
    try {
      if (on) localStorage.setItem(UNREADS_ONLY_KEY, 'yes')
      else localStorage.removeItem(UNREADS_ONLY_KEY)
    } catch {
      /* not kept: a private window may refuse */
    }
    set({ on })
  },
}))
