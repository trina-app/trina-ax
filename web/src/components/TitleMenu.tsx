// A page's name in its top line, opening the few things you rarely do with it (rename, edit, share, delete): a menu,
// like the name at the top of a Claude chat or project. Used by the project page and the chat screen.
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface TitleMenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  testId: string
}

/** heading: the name is the page's heading (the chat screen), with this test id; the menu itself stays outside it */
export function TitleMenu({ name, items, testId, heading }: { name: string; items: TitleMenuItem[]; testId: string; heading?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation() // only the menu: not an open file or browser panel too (Layout)
      setOpen(false)
      box.current?.querySelector('button')?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems()
      const at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  const button = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-current="page"
      onClick={() => setOpen((v) => !v)}
      className="flex max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover"
      data-testid={testId}
    >
      <span className="truncate">{name}</span>
      <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden />
    </button>
  )
  return (
    <div ref={box} className="relative min-w-0" onKeyDown={onKeyDown}>
      {heading ? (
        <h1 className="min-w-0" data-testid={heading}>
          {button}
        </h1>
      ) : (
        button
      )}
      {open && (
        <div role="menu" aria-label={name} className="absolute top-full left-0 z-30 mt-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              type="button"
              className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover', it.danger && 'text-danger')}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
              data-testid={it.testId}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
