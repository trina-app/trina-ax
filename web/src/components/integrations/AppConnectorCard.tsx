// Google Drive's own row among the connections (DriveConnector.tsx DriveCard): a ConnectionRow (logo, name, one line,
// one action on the right: a button or a ⋯ menu). Anything it shows while it works (waiting for Google, "connect this
// account?") goes under the row, inside it. CardMenu is the ⋯ every connection's page uses.
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MENU_EDGE } from '../rooms/MenuButton'
import { IconButton } from '../ui'
import { ConnectionRow } from './ConnectionRow'

export function AppConnectorCard({ logo, name, line, lineTone, action, children, testId, state }: {
  logo: ReactNode
  name: string
  /** one short line under the name: what it does, the account, or why it is not available */
  line: ReactNode
  lineTone?: 'muted' | 'warn'
  action?: ReactNode
  children?: ReactNode
  testId: string
  state?: string
}) {
  return (
    <ConnectionRow testId={testId} data={{ 'data-state': state }} logo={logo} name={name} line={line} lineTone={lineTone} end={action}>
      <div className="flex flex-col gap-3 pb-3 empty:hidden">{children}</div>
    </ConnectionRow>
  )
}

export interface CardMenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; testId: string }

/** How far to move a ⋯ menu that opens under its button, right edges in line (`left`, `width` in window px), so it stays
 * MENU_EDGE clear of both sides of the window: on a phone a ⋯ near the left (a person's Gmail page, next to Connected)
 * opened its menu off the screen's left edge (QA TC-935). 0 when it fits. */
export function cardMenuShift(left: number, width: number, viewWidth: number): number {
  return Math.max(MENU_EDGE, Math.min(left, viewWidth - MENU_EDGE - width)) - left
}

/** ⋯ on a card: the few things you rarely do with it (reconnect, disconnect). Arrow keys move, Esc and Tab close. */
export function CardMenu({ label, items, testId }: { label: string; items: CardMenuItem[]; testId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  // measured before it paints: where it would be with no shift, moved in when that is off a side of the window
  useLayoutEffect(() => {
    if (!open || !menu.current) { setShift(0); return }
    const r = menu.current.getBoundingClientRect()
    setShift(cardMenuShift(r.left, r.width, document.documentElement.clientWidth))
  }, [open])
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') { e.stopPropagation(); box.current?.querySelector<HTMLElement>('button')?.focus() }
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems(), at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  return (
    <div ref={box} className="relative" onKeyDown={onKeyDown}>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid={testId}>
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {open && (
        <div ref={menu} role="menu" aria-label={label} style={shift ? { transform: `translateX(${shift}px)` } : undefined} className="absolute right-0 z-30 mt-1 w-max max-w-[min(20rem,calc(100vw-2rem))] min-w-40 rounded-xl border border-line bg-surface p-1 shadow-lg" data-testid={`${testId}-items`}>
          {items.map((it) => (
            <button key={it.testId} type="button" role="menuitem" disabled={it.disabled}
              className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-50 ${it.danger ? 'text-danger' : ''}`}
              onClick={() => {
                // focus back on ⋯ first: the item goes with the menu, and a dialog it opens (Settings, a confirm)
                // returns focus to what had it, which is then ⋯ and not the page's body
                box.current?.querySelector<HTMLElement>('button')?.focus()
                setOpen(false)
                it.onSelect()
              }} data-testid={it.testId}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
