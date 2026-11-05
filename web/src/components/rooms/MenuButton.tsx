// A "…" button with a small menu (the room header's settings, a message's reply / edit / delete): arrow keys move,
// Esc closes and gives the keyboard back, a click outside closes. Opens upward when it would run off the bottom.
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  testId?: string
}

export function MenuButton({ label, items, className, buttonClassName, testId }: { label: string; items: MenuItem[]; className?: string; buttonClassName?: string; testId?: string }) {
  const [open, setOpen] = useState<null | 'down' | 'up'>(null)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(null)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const toggle = () => {
    if (open) return setOpen(null)
    const r = button.current?.getBoundingClientRect()
    setOpen(r && typeof window !== 'undefined' && r.bottom + 40 * items.length + 16 > window.innerHeight ? 'up' : 'down')
  }
  const onKey = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
      button.current?.focus()
      return
    }
    if (e.key === 'Tab') return setOpen(null)
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
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
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={toggle}
        className={clsx('inline-flex items-center justify-center rounded-md p-1.5 text-faint transition hover:bg-hover hover:text-ink max-sm:p-2', buttonClassName)}
        data-testid={testId}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={label} className={clsx('absolute right-0 z-30 w-44 rounded-lg border border-line bg-surface p-1 shadow-lg', open === 'up' ? 'bottom-full mb-1' : 'top-full mt-1')}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(null)
                it.onSelect()
              }}
              className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm max-sm:py-2', it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-hover')}
              data-testid={it.testId}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
