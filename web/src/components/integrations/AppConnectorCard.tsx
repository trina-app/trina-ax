// One card in the App connectors grid (Settings › App connectors and Admin › App connectors), in the style of the MCP
// Discover grid: logo, name, one line, and one action on the right (a button or a ⋯ menu). Anything a card shows while
// it works (waiting for Google, "connect this account?") goes under that line, inside the card.
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconButton } from '../ui'

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
    <li className="flex flex-col gap-3 rounded-xl bg-subtle p-3" data-testid={testId} data-state={state}>
      <div className="flex items-start gap-3">
        {logo}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className={`mt-0.5 block truncate text-xs ${lineTone === 'warn' ? 'text-warn' : 'text-muted'}`} data-testid={`${testId}-line`}>{line}</span>
        </span>
        {action && <span className="flex shrink-0 items-center gap-1">{action}</span>}
      </div>
      {children}
    </li>
  )
}

export interface CardMenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; testId: string }

/** ⋯ on a card: the few things you rarely do with it (reconnect, disconnect). Arrow keys move, Esc and Tab close. */
export function CardMenu({ label, items, testId }: { label: string; items: CardMenuItem[]; testId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
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
        <div role="menu" aria-label={label} className="absolute right-0 z-30 mt-1 min-w-40 rounded-xl border border-line bg-surface p-1 shadow-lg" data-testid={`${testId}-items`}>
          {items.map((it) => (
            <button key={it.testId} type="button" role="menuitem" disabled={it.disabled}
              className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-hover focus:bg-hover focus:outline-none disabled:opacity-50 ${it.danger ? 'text-danger' : ''}`}
              onClick={() => { setOpen(false); it.onSelect() }} data-testid={it.testId}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
