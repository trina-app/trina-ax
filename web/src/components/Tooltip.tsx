// One tooltip for icon buttons (and anything else that needs a word on hover):
//
//   <Tooltip label="반응 추가"><button aria-label="반응 추가">…</button></Tooltip>
//   <Tooltip label="⌘K" description><IconButton label="검색">…</IconButton></Tooltip>
//
// - Wraps exactly one element that takes a ref and pointer / focus / key handlers (a <button>, IconButton, a link). Its
//   own handlers still run.
// - Shows after 300 ms of a mouse or pen resting on it, at once when it gets keyboard focus; hides on pointer leave, a
//   click, blur, Esc (the Esc still reaches the page, e.g. to close a menu), any scroll, and while the element says it
//   has a menu open (aria-expanded="true").
// - Never on touch: not for a finger, and not at all on a device without a fine pointer (phones, tablets).
// - A small dark label (light in dark mode: the ink and surface tokens swap), above the element; below it when there is
//   no room above, kept inside the window. Rendered into <body> (a portal), so no scroll box clips it and nothing moves.
// - role="tooltip". The element is described by it (aria-describedby) only when the tip says something its own name
//   does not: by default when the element's aria-label does not already hold `label` (a row's "가나 더 보기" with the tip
//   "더 보기" is not read twice), or always with `description`.
// - No animation beyond a short fade, none with reduced motion.
import clsx from 'clsx'
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type Ref } from 'react'
import { createPortal } from 'react-dom'

/** ms a mouse rests on the element before the tip shows */
export const TOOLTIP_DELAY_MS = 300
const GAP = 6
const EDGE = 4

type Child = ReactElement<{
  ref?: Ref<HTMLElement>
  'aria-label'?: string
  'aria-describedby'?: string
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
}>

/** May this device show tooltips at all: it has a mouse or a pen (a fine pointer). */
const finePointer = () => {
  try { return typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: fine)').matches } catch { return false }
}

/** Where the tip goes: above the anchor, centred; below it when there is no room above; inside the window. */
export function placeTip(anchor: { top: number; bottom: number; left: number; width: number }, tip: { width: number; height: number }, view: { width: number; height: number }): { top: number; left: number; below: boolean } {
  const below = anchor.top - GAP - tip.height < EDGE
  const top = below ? Math.min(anchor.bottom + GAP, view.height - tip.height - EDGE) : anchor.top - GAP - tip.height
  const left = Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, view.width - tip.width - EDGE))
  return { top, left, below }
}

export function Tooltip({ label, children, description = false, disabled = false }: { label: string; children: ReactElement; description?: boolean; disabled?: boolean }) {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerAt = useRef(0)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const hide = useCallback(() => {
    clear()
    setOpen(false)
    setPos(null)
  }, [])
  const show = () => {
    if (disabled || !label || !finePointer()) return
    // a menu of its own is open: the menu is what the person looks at
    if (anchor.current?.getAttribute('aria-expanded') === 'true') return
    setOpen(true)
  }
  useEffect(() => () => clear(), [])
  useEffect(() => { if (disabled) hide() }, [disabled, hide])
  // the element's own ref, kept: one stable callback (a new one each render would detach and attach it every commit)
  const childRef = isValidElement(children) ? (children as Child).props.ref : undefined
  const setRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef && typeof childRef === 'object') (childRef as { current: HTMLElement | null }).current = el
  }, [childRef])

  // placed once it is drawn (its size is known), before it is painted
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tipRef.current) return
    const a = anchor.current.getBoundingClientRect()
    const t = tipRef.current.getBoundingClientRect()
    const p = placeTip(a, t, { width: window.innerWidth, height: window.innerHeight })
    setPos({ top: p.top, left: p.left })
  }, [open, label])

  // while it shows: Esc and any scroll take it away (Esc still goes on to the page)
  useEffect(() => {
    if (!open) return
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') hide() }
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', hide, true)
    }
  }, [open, hide])

  if (!isValidElement(children)) return children
  const child = children as Child
  const p = child.props
  const describes = !!label && (description || !p['aria-label']?.includes(label))
  const trigger = cloneElement(child, {
    ref: setRef,
    ...(describes && open ? { 'aria-describedby': [p['aria-describedby'], id].filter(Boolean).join(' ') } : {}),
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      p.onPointerEnter?.(e)
      if (e.pointerType === 'touch') return
      clear()
      timer.current = setTimeout(show, TOOLTIP_DELAY_MS)
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      p.onPointerLeave?.(e)
      hide()
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      p.onPointerDown?.(e)
      pointerAt.current = Date.now()
      hide()
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      p.onFocus?.(e)
      // focus from the keyboard (a click focuses too, right after its pointerdown: no tip for that)
      if (Date.now() - pointerAt.current > 500) { clear(); show() }
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      p.onBlur?.(e)
      hide()
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      p.onKeyDown?.(e)
      if (e.key === 'Escape') hide()
    },
  })
  return (
    <>
      {trigger}
      {open && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={clsx(
              'pointer-events-none fixed z-[200] max-w-64 rounded-md bg-ink px-2 py-1 text-xs leading-snug font-medium break-words text-surface shadow-md transition-opacity duration-100 motion-reduce:transition-none',
              pos ? 'opacity-100' : 'opacity-0',
            )}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
            data-testid="tooltip"
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
