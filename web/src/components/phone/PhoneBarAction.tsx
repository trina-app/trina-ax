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

/** The page's name for the bar, and what a tap on it does (`press`: null, it does nothing) */
interface BarTitle { title: string | null; press: { label: string } | null }
const useTitle = create<BarTitle & { set: (v: BarTitle) => void }>((set) => ({ title: null, press: null, set: (v) => set(v) }))
/** the page's latest tap handler (kept out of the store: a new function each render would draw the bar again) */
let pressNow: (() => void) | null = null

/** The page's own name as the phone's top bar's title while it is on screen (the page's h1 then for screen readers
 * only, so the name shows once). `onPress`: a tap on the name does something (a project's page: rename it, for whoever
 * may), `pressLabel` its accessible name ("Rename Launch"). */
export function PhoneBarTitle({ children, onPress, pressLabel }: { children: string; onPress?: () => void; pressLabel?: string }) {
  const set = useTitle((s) => s.set)
  pressNow = onPress ?? null
  const label = onPress ? (pressLabel ?? children) : null
  useEffect(() => {
    set({ title: children, press: label === null ? null : { label } })
  }, [children, label, set])
  useEffect(() => () => {
    pressNow = null
    set({ title: null, press: null })
  }, [set])
  return null
}

/** The title a page gave the bar, or null. */
export const usePhoneBarTitle = () => useTitle((s) => s.title)
/** What a tap on the bar's title does (its accessible name and the call), or null. */
export const usePhoneBarPress = () => {
  const press = useTitle((s) => s.press)
  return press ? { label: press.label, onPress: () => pressNow?.() } : null
}
