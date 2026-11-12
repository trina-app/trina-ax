// A page's one action in the phone's top bar (below 768 px: components/PhoneTopBar.tsx), on the right, where iOS apps
// put "+" or "Edit": the page renders <PhoneBarAction> where it likes and it shows in the bar. PhoneTopBar holds the
// one place (<PhoneBarSlot>); a page that renders nothing leaves the bar as it was. Phones only: a computer's page keeps
// its own buttons, so the caller renders this only on a phone. A detail page whose name is the screen's (one project:
// "‹ 프로젝트 · Launch · ···") puts its name in the bar's title the same way (<PhoneBarTitle>), in place of its list's.
import { useEffect, type ReactNode } from 'react'
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

const useTitle = create<{ title: string | null; set: (title: string | null) => void }>((set) => ({ title: null, set: (title) => set({ title }) }))

/** The page's own name as the phone's top bar's title while it is on screen (the page's h1 then for screen readers
 * only, so the name shows once). */
export function PhoneBarTitle({ children }: { children: string }) {
  const set = useTitle((s) => s.set)
  useEffect(() => {
    set(children)
    return () => set(null)
  }, [children, set])
  return null
}

/** The title a page gave the bar, or null. */
export const usePhoneBarTitle = () => useTitle((s) => s.title)
