// Folder permissions' page header (Folders.tsx) has two places for what By folder and By person own: the main button
// (Add folder) and the filter row (the "Only folders with rules" switch, or the person search). The views put their own
// controls there with a portal, so their state stays where it is and the header stays one sticky row for all of it.
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** `off`: the header is not shown (a phone's folder, editor or person page): what goes in it is not shown either. */
export const FolderHeaderSlots = createContext<{ actions: HTMLElement | null; filter: HTMLElement | null; off?: boolean }>({ actions: null, filter: null })

/** `children` in the header's `slot`; where there is no header (a view shown on its own, a test), in place. */
export function InFolderHeader({ slot, children }: { slot: 'actions' | 'filter'; children: ReactNode }) {
  const slots = useContext(FolderHeaderSlots)
  const el = slots[slot]
  if (slots.off) return null
  return el ? createPortal(children, el) : <>{children}</>
}

/** A phone's way back from the rule editor to By person is Back (the editor took the place of the entry that opened it),
 * which carries no state: the folder whose row takes the focus there waits here until By person shows. */
let peopleRefocus: string | null = null
export const setPeopleRefocus = (path: string | null) => { peopleRefocus = path }
export function takePeopleRefocus(): string | null {
  const p = peopleRefocus
  peopleRefocus = null
  return p
}
