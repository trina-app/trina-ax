// Folder permissions' page header (Folders.tsx) has two places for what By folder and By person own: the main button
// (Add folder) and the filter row (the "Only folders with rules" switch, or the person search). The views put their own
// controls there with a portal, so their state stays where it is and the header stays one sticky row for all of it.
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const FolderHeaderSlots = createContext<{ actions: HTMLElement | null; filter: HTMLElement | null }>({ actions: null, filter: null })

/** `children` in the header's `slot`; where there is no header (a view shown on its own, a test), in place. */
export function InFolderHeader({ slot, children }: { slot: 'actions' | 'filter'; children: ReactNode }) {
  const el = useContext(FolderHeaderSlots)[slot]
  return el ? createPortal(children, el) : <>{children}</>
}
