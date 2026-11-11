// A row's actions behind "…" (Admin › Members and Groups): a small menu at the button, arrow keys move, Escape or Tab
// closes and goes back to the button, a click outside closes. A phone (below 768 px): the app's bottom sheet
// (rooms/MenuButton.tsx) with 48 px rows, what cannot be undone last, and the row's name above them.
import clsx from 'clsx'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { IconButton, useMediaQuery } from '../../components/ui'
import { MenuButton } from '../../components/rooms/MenuButton'

export interface MemberMenuItem { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; testId: string }

/** A row's actions behind "…" (members, groups; like a skill's menu): arrow keys move, Escape or Tab closes and goes
 * back to the button, a click outside closes. rowFocus: the "…" takes the focus when the row before it was deleted
 * (useFocusAfterRemove). */
export function MemberMenu({ name, items, rowFocus }: { name: string; items: MemberMenuItem[]; rowFocus?: boolean }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  return phone ? <SheetMenu name={name} items={items} rowFocus={rowFocus} /> : <RowDropdown name={name} items={items} rowFocus={rowFocus} />
}

/** A phone's "…": the bottom sheet, 44 px to tap, delete and the like last (a sheet the caller ordered either way). */
function SheetMenu({ name, items, rowFocus }: { name: string; items: MemberMenuItem[]; rowFocus?: boolean }) {
  const t = useT()
  const button = useRef<HTMLButtonElement>(null)
  // the "…" a deleted row's neighbour gives the keyboard to (useFocusAfterRemove)
  useLayoutEffect(() => { button.current?.toggleAttribute('data-row-focus', !!rowFocus) }, [rowFocus])
  return (
    <MenuButton label={t('members.actionsFor', { name })} tip={t('members.actionsFor', { name })} sheetTitle={name} buttonRef={button} className="shrink-0" buttonClassName="size-11 !text-muted" testId="member-more"
      items={[...items.filter((it) => !it.danger), ...items.filter((it) => it.danger)]} />
  )
}

function RowDropdown({ name, items, rowFocus }: { name: string; items: MemberMenuItem[]; rowFocus?: boolean }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // The menu has a fixed position at the "…" button: in a table row it must not be cut off by the table's sideways
  // scroll box (the last row's menu went below its edge). It opens upwards when there is no room below.
  const [pos, setPos] = useState<CSSProperties | null>(null)
  const place = () => {
    const r = box.current?.querySelector('button')?.getBoundingClientRect()
    if (!r) return
    const right = window.innerWidth - r.right
    const up = window.innerHeight - r.bottom < items.length * 34 + 24 && r.top > window.innerHeight - r.bottom
    setPos(up ? { position: 'fixed', bottom: window.innerHeight - r.top + 4, right } : { position: 'fixed', top: r.bottom + 4, right })
  }
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  useLayoutEffect(() => {
    if (!open) return setPos(null)
    place()
    // the page (or the table) scrolls, or the window changes size: the menu stays at its button
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus({ preventScroll: true })
    // not on losing focus: Safari moves focus off a button when it is pressed, and the click would find the menu gone
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation()
      setOpen(false)
      box.current?.querySelector('button')?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems()
      const at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  const label = t('members.actionsFor', { name })
  return (
    <div ref={box} className="relative shrink-0" onKeyDown={onKeyDown}>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="max-md:size-11" data-testid="member-more" data-row-focus={rowFocus || undefined}>
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" aria-label={label} style={pos ?? undefined} className="fixed z-30 w-52 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              type="button"
              className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover', it.danger && 'text-danger')}
              onClick={() => {
                setOpen(false)
                // focus on "…" first: the item goes away, and a dialog it opens gives focus back to "…" when it closes
                box.current?.querySelector('button')?.focus()
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
