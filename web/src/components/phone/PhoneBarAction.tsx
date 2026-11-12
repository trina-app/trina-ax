// A page's one action in the phone's top bar (below 768 px: components/PhoneTopBar.tsx), on the right, where iOS apps
// put "+" or "Edit": the page renders <PhoneBarAction> where it likes and it shows in the bar. PhoneTopBar holds the
// one place (<PhoneBarSlot>); a page that renders nothing leaves the bar as it was. Phones only: a computer's page keeps
// its own buttons, so the caller renders this only on a phone.
import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'

const useSlot = create<{ el: HTMLElement | null; set: (el: HTMLElement | null) => void }>((set) => ({ el: null, set: (el) => set({ el }) }))

/** The bar's place for a page's action (PhoneTopBar's right side). */
export function PhoneBarSlot() {
  const set = useSlot((s) => s.set)
  return <span ref={set} className="contents" data-testid="phone-bar-slot" />
}

/** `children` in the phone's top bar, on the right; nothing while no bar is on screen. */
export function PhoneBarAction({ children }: { children: ReactNode }) {
  const el = useSlot((s) => s.el)
  return el ? createPortal(children, el) : null
}
