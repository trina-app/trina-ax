// A "…" button with a small menu (a message's reply / copy / edit / delete): arrow keys move, Esc closes and gives the
// keyboard back, a click or a touch outside closes. Opens upward when it would run off the bottom. On a touch screen
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
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'

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
  const [open, setOpen] = useState<null | 'down' | 'up'>(null)
  const box = useRef<HTMLDivElement>(null)
  const own = useRef<HTMLButtonElement>(null)
  const button = buttonRef ?? own
  const menu = useRef<HTMLDivElement>(null)
  /** when a long press opened it: the finger lifting right after is no choice of an item */
  const pressedAt = useRef(0)
  useEffect(() => {
    if (!open) return
    // the keyboard goes into the menu; a finger that opened it does not need a focus ring on the first item
    if (Date.now() - pressedAt.current > 1000) (menu.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus({ preventScroll: true })
    const h = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(null)
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])
  const place = () => {
    const r = (button.current?.offsetParent ? button.current : box.current)?.getBoundingClientRect()
    return r && typeof window !== 'undefined' && r.bottom + 40 * items.length + 16 > window.innerHeight ? 'up' : 'down'
  }
  const toggle = () => setOpen(open ? null : place())
  useEffect(() => {
    if (!openSignal) return
    pressedAt.current = Date.now()
    setOpen(place())
    navigator.vibrate?.(10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal])
  useEffect(() => {
    if (!openRequest) return
    pressedAt.current = 0
    setOpen(place())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])
  /** the keyboard back to the button, or where the caller says when there is none on screen */
  const giveBack = () => (button.current?.offsetParent ? button.current.focus() : focusBack?.())
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
      giveBack()
      return
    }
    if (e.key === 'Tab') return setOpen(null)
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
          aria-expanded={!!open}
          onClick={toggle}
          className={clsx('inline-flex items-center justify-center rounded-md p-1.5 transition hover:bg-hover hover:text-ink max-sm:p-2', muted ? 'text-muted' : 'text-faint', buttonClassName)}
          data-testid={testId}
        >
          {icon ?? <MoreHorizontal size={16} aria-hidden />}
        </button>
      </Tooltip>
      {/* phones: a sheet from the bottom with 48px rows over a scrim (a tap on it closes), not a small menu by the finger */}
      {/* (a finger held on it must not reach the message's own long press, which would open the sheet again) */}
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-black/40 md:hidden" onPointerDown={(e) => e.stopPropagation()} onClick={() => Date.now() - pressedAt.current > 400 && setOpen(null)} />}
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
            'z-30 border border-line bg-surface shadow-lg md:absolute md:right-0 md:rounded-lg md:p-1',
            header || heading ? 'md:w-max md:min-w-44' : 'md:w-44',
            'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:rounded-t-2xl max-md:px-2 max-md:pt-2 max-md:pb-[max(0.75rem,var(--safe-bottom))]',
            open === 'up' ? 'md:bottom-full md:mb-1' : 'md:top-full md:mt-1',
          )}
        >
          {header && <div className="mb-1 border-b border-line pb-1 md:pointer-fine:hidden">{header(() => setOpen(null))}</div>}
          {/* the menu's name (aria-label above), shown: not one of its items */}
          {heading && <p aria-hidden className="px-2 pt-1 pb-1.5 text-xs text-muted max-md:px-3 max-md:pt-2 max-md:pb-2 max-md:text-sm">{heading}</p>}
          {sheetTitle && <p aria-hidden className="truncate px-3 pt-2 pb-2 text-sm text-muted md:hidden" data-testid="menu-sheet-title">{sheetTitle}</p>}
          {items.map((it) => (
            <button
              key={it.label}
              role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={it.checked === undefined ? undefined : it.checked}
              type="button"
              onClick={() => {
                if (Date.now() - pressedAt.current < 400) return
                setOpen(null)
                // a menu without a button on screen: the item is gone with it, the keyboard goes back where it came from
                if (!button.current?.offsetParent && focusBack && menu.current?.contains(document.activeElement)) focusBack()
                it.onSelect()
              }}
              className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm max-md:min-h-12 max-md:gap-3 max-md:rounded-lg max-md:px-3', it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-hover')}
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
