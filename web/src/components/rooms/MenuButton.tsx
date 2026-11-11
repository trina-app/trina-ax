// A "…" button with a small menu (a message's reply / copy / edit / delete): arrow keys move, Esc closes and gives the
// keyboard back, a click or a touch outside closes. On a computer the menu stays in the window (`menuSpot`): under the
// button with their right edges in line, above it where it would run off the bottom, moved in 8px from a side it would
// run off (a sidebar row's menu wider than the sidebar slides right), and fixed to the window, so a scroll box (the
// sidebar's list) does not cut it; it moves with the button when something scrolls, and closes once the button is
// scrolled out of sight. On a touch screen
// the button is hidden and a long press on the message opens the same menu (`openSignal`, useLongPress). Below 768px the
// menu is a bottom sheet with 48px rows. `header`: something above the rows where there is no hover row to hold it (a
// message's reactions on a touch screen); hidden where a mouse points. A menu of choices (a room's notifications): items
// with `checked` are radio items (the chosen one ticked), `heading` names the menu above them and `icon` replaces the "…".
// `openRequest`: opened from somewhere else as a click would (a right-click on a row, another menu's item), the keyboard
// in it; `tip`: the tooltip's word when the button's name says more (a row's "⋯": "더 보기" for the eye, the room's name
// for a screen reader); `sheetTitle`: what the menu is about, on a phone's sheet only (a row's long press: the room's
// name, as the row is under the scrim); `focusBack`: where the keyboard goes when a menu without a button of its own
// closes (a row's level menu: the row's "⋯").
import clsx from 'clsx'
import { Check, MoreHorizontal } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { dismissKeyboard } from '../../lib/viewport'
import { useOverlayEntry } from '../../lib/backCloses'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  testId?: string
  /** a choice: true for the chosen one (a radio item with a tick), false for the others */
  checked?: boolean
  /** quieter words after the label (what a default stands for now) */
  hint?: string
}

/** The items in a phone's sheet (below 768px): what cannot be undone (delete) last, whatever order the caller gave,
 * under a hairline (`dangerLine` on the first of them), as iOS sheets have it; a computer's menu keeps the order. */
function sheetOrder(items: MenuItem[]): MenuItem[] {
  if (typeof window === 'undefined' || window.matchMedia?.('(min-width: 48rem)').matches) return items
  return [...items.filter((it) => !it.danger), ...items.filter((it) => it.danger)]
}
const dangerLine = "max-md:relative max-md:mt-2 max-md:before:absolute max-md:before:inset-x-3 max-md:before:-top-1 max-md:before:border-t max-md:before:border-line max-md:before:content-['']"

/** px a computer's menu keeps clear of the window's edges, and between it and its button */
export const MENU_EDGE = 8
const MENU_GAP = 4

/** Where a computer's menu goes, in window px: under its button (`at`) with their right edges in line; above it when it
 * would run off the bottom and fits there; moved in to stay MENU_EDGE clear of each side (a menu wider than the room
 * left of its button slides right rather than off the window's left). Taller than the window either way: its bottom
 * kept in, its top never above the edge (the menu scrolls). */
export function menuSpot(at: { top: number; right: number; bottom: number }, size: { width: number; height: number }, view: { width: number; height: number }): { x: number; y: number } {
  const x = Math.max(MENU_EDGE, Math.min(at.right - size.width, view.width - MENU_EDGE - size.width))
  const below = at.bottom + MENU_GAP, above = at.top - MENU_GAP - size.height
  const y = below + size.height <= view.height - MENU_EDGE ? below : above >= MENU_EDGE ? above : Math.max(MENU_EDGE, view.height - MENU_EDGE - size.height)
  return { x, y }
}

/** A long press with a finger (not a mouse): `onLong` after `ms` without moving; scrolling or lifting cancels it. The
 * phone's own long-press menu (text selection, Android's context menu) stays away while it is used. */
export function useLongPress(onLong: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const touchedAt = useRef(0)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }
  useEffect(() => cancel, [])
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      touchedAt.current = Date.now()
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        timer.current = null
        onLong()
      }, ms)
    },
    onPointerMove: (e: PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => {
      if (Date.now() - touchedAt.current < 1500) e.preventDefault()
    },
  }
}

/** `muted`: the button in the colour of the icons beside it (a panel's header) rather than the quieter one a message's
 * "…" has */
export function MenuButton({ label, items, className, buttonClassName, testId, openSignal = 0, openRequest = 0, muted, header, heading, icon, tip, sheetTitle, buttonRef, focusBack }: { label: string; items: MenuItem[]; className?: string; buttonClassName?: string; testId?: string; openSignal?: number; openRequest?: number; muted?: boolean; header?: (close: () => void) => ReactNode; heading?: string; icon?: ReactNode; tip?: string; sheetTitle?: string; buttonRef?: RefObject<HTMLButtonElement | null>; focusBack?: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const own = useRef<HTMLButtonElement>(null)
  const button = buttonRef ?? own
  const menu = useRef<HTMLDivElement>(null)
  /** when a long press opened it: the finger lifting right after is no choice of an item */
  const pressedAt = useRef(0)
  // a phone's sheet: Back closes it, not the page under it (lib/backCloses.ts); an item that opens a page or a dialog
  // takes its history entry over
  useOverlayEntry(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    // a phone's sheet over the page: the on-screen keyboard goes down first (a long press while typing), so the sheet
    // is in sight; the draft stays and the keyboard comes back only when the person taps the box again
    if (!window.matchMedia?.('(min-width: 48rem)').matches) dismissKeyboard()
    // the keyboard goes into the menu; a finger that opened it does not need a focus ring on the first item
    if (Date.now() - pressedAt.current > 1000) (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus({ preventScroll: true })
    const h = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])
  /** a computer's menu put in its place (menuSpot), measured as it is drawn: at the window's 0,0 first, which also
   * finds where a parent that holds fixed boxes (a transform) has its corner. Phones: the sheet, nothing to place. */
  const fit = () => {
    const m = menu.current, a = box.current
    if (!m || !a || !window.matchMedia?.('(min-width: 48rem)').matches) return
    m.style.setProperty('--menu-x', '0px')
    m.style.setProperty('--menu-y', '0px')
    const o = m.getBoundingClientRect()
    const { x, y } = menuSpot(a.getBoundingClientRect(), o, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })
    m.style.setProperty('--menu-x', `${x - o.left}px`)
    m.style.setProperty('--menu-y', `${y - o.top}px`)
  }
  // before it is first drawn, and again when its words change while it is open
  useLayoutEffect(() => {
    if (open) fit()
  })
  useEffect(() => {
    if (!open) return
    // the button moves under it (the sidebar's list scrolled) or the window changes size: it follows; once the button
    // is scrolled out of its list's sight the menu goes (the list used to cut it off with the button)
    const scrolled = (e: Event) => {
      const list = e.target as Node & Partial<Pick<Element, 'getBoundingClientRect'>>
      if (menu.current?.contains(list)) return
      // a phone's sheet stands on its own, not by the button (hidden on a touch screen): the list moving under it (the
      // keyboard going down as the sheet opens) does not close it
      if (!window.matchMedia?.('(min-width: 48rem)').matches) return
      const a = box.current?.getBoundingClientRect(), s = list.getBoundingClientRect?.()
      if (a && s && (a.bottom < s.top || a.top > s.bottom)) return setOpen(false)
      fit()
    }
    window.addEventListener('resize', fit)
    document.addEventListener('scroll', scrolled, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', fit)
      document.removeEventListener('scroll', scrolled, { capture: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  // the finger lifting after a long press that opened it (a row whose "…" shows on a touch screen: the AI's history in
  // the phone's drawer) is no second click that closes it
  const toggle = () => {
    if (open && Date.now() - pressedAt.current < 800) return
    setOpen(!open)
  }
  useEffect(() => {
    if (!openSignal) return
    pressedAt.current = Date.now()
    setOpen(true)
    navigator.vibrate?.(10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal])
  useEffect(() => {
    if (!openRequest) return
    pressedAt.current = 0
    setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])
  /** the keyboard back to the button, or where the caller says when there is none on screen */
  const hiddenButton = () => button.current?.offsetParent === null
  const giveBack = () => (hiddenButton() && focusBack ? focusBack() : button.current?.focus())
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      giveBack()
      return
    }
    if (e.key === 'Tab') return setOpen(false)
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
  }
  return (
    <div ref={box} className={clsx(className?.includes('absolute') ? null : 'relative', className)} onKeyDown={onKey}>
      {/* its name as a tooltip (components/Tooltip.tsx), not while its menu is open */}
      <Tooltip label={tip ?? label}>
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          className={clsx('inline-flex items-center justify-center rounded-md p-1.5 transition hover:bg-hover hover:text-ink max-sm:p-2', muted ? 'text-muted' : 'text-faint', buttonClassName)}
          data-testid={testId}
        >
          {icon ?? <MoreHorizontal size={16} aria-hidden />}
        </button>
      </Tooltip>
      {/* phones: a sheet from the bottom with 48px rows over a scrim (a tap on it closes), not a small menu by the finger */}
      {/* (a finger held on it must not reach the message's own long press, which would open the sheet again) */}
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-black/40 md:hidden" onPointerDown={(e) => e.stopPropagation()} onClick={() => Date.now() - pressedAt.current > 400 && setOpen(false)} />}
      {open && (
        <div
          ref={menu}
          role="menu"
          // a finger held on an item is no long press of the row or message under it (it would open the menu again and
          // swallow the item), nor a right-click of it
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          aria-label={heading ?? label}
          className={clsx(
            'fixed z-30 border border-line bg-surface shadow-lg md:rounded-lg md:p-1',
            // where fit() puts it (menuSpot), at once: no transition (with reduced motion every property has a short
            // one, index.css), which would leave it at 0,0 for a frame and spoil fit()'s measure at 0,0
            'md:top-[var(--menu-y,0px)] md:left-[var(--menu-x,0px)] md:transition-none',
            // as wide as its longest item, never narrower than 176px (a longer word does not wrap: "Pindahkan ke proyek…");
            // a window narrower than that: as wide as the window less its edges, the words wrap
            'md:w-max md:max-w-[calc(100vw-1rem)] md:min-w-44 md:max-h-[calc(100dvh-1rem)] md:overflow-y-auto',
            // phones: on the keyboard while it is still up (iOS lets a sheet open under it; lib/viewport.ts
            // --kb-inset), never higher than what is in sight, its rows scrolling
            'max-md:inset-x-0 max-md:bottom-[var(--kb-inset,0px)] max-md:max-h-[calc(var(--app-h,100dvh)-var(--safe-top))] max-md:overflow-y-auto max-md:rounded-t-2xl max-md:px-2 max-md:pt-2 max-md:pb-[max(0.75rem,var(--safe-bottom))]',
          )}
        >
          {header && <div className="mb-1 border-b border-line pb-1 md:pointer-fine:hidden">{header(() => setOpen(false))}</div>}
          {/* the menu's name (aria-label above), shown: not one of its items */}
          {heading && <p aria-hidden className="px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3 max-md:pt-2 max-md:pb-2 max-md:text-sm">{heading}</p>}
          {sheetTitle && <p aria-hidden className="truncate px-3 pt-2 pb-2 text-sm text-muted md:hidden" data-testid="menu-sheet-title">{sheetTitle}</p>}
          {sheetOrder(items).map((it, i, all) => (
            <button
              key={it.label}
              role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={it.checked === undefined ? undefined : it.checked}
              type="button"
              onClick={() => {
                if (Date.now() - pressedAt.current < 400) return
                setOpen(false)
                // a menu without a button on screen: the item is gone with it, the keyboard goes back where it came from
                if (hiddenButton() && focusBack && menu.current?.contains(document.activeElement)) focusBack()
                it.onSelect()
              }}
              className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm max-md:min-h-12 max-md:gap-3 max-md:rounded-lg max-md:px-3', it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-hover', it.danger && i > 0 && !all[i - 1]!.danger && dangerLine)}
              data-testid={it.testId}
            >
              {it.icon}
              <span className="min-w-0 flex-1">
                {it.label}
                {it.hint && <span className="ml-1.5 text-muted">{it.hint}</span>}
              </span>
              {it.checked !== undefined && <Check size={16} aria-hidden className={clsx('shrink-0 text-accent-text', !it.checked && 'invisible')} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
