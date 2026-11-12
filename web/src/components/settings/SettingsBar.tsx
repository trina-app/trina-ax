// The right side of a Settings section's phone bar (SettingsDialog.tsx, phone/PhonePageBar.tsx): a section puts its one
// action there (Memory's "+"), like the iPhone's Settings. On a computer, or before the bar is there, nothing shows: the
// section keeps its own button for that.
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const SettingsBarSlot = createContext<HTMLElement | null>(null)

/** `children` in the open section's phone bar, when there is one. */
export function SettingsBarAction({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsBarSlot)
  return slot ? createPortal(children, slot) : null
}

/** Whether the section has the phone bar's action place (a phone): the section then leaves out its own button. */
export const useSettingsBar = () => useContext(SettingsBarSlot) !== null
