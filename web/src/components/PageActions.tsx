// A page's buttons, one main and the rest beside it (docs/DECISIONS.md "Admin and Settings on phones"; Apple's HIG:
// one primary action, the others in a menu only when needed). On a computer or a tablet every button shows, as before;
// on a phone (below 768 px) the main one stays a button and the others go under its ⌄ (SplitAction), so a header holds
// one row instead of three buttons on two rows. SplitAction and its menu were Connectors' own (Add ⌄, a connector's
// Connect ⌄); every page uses them from here.
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, useMediaQuery } from './ui'
import { Tooltip } from './Tooltip'
import { MenuButton } from './rooms/MenuButton'

export interface AddMenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  testId: string
  /** not yet possible (Usage's Download CSV before the report is in): shown, skipped by the arrow keys */
  disabled?: boolean
}

/** A primary button with a ⌄ menu of other ways to do it. `menuLabel`: the ⌄'s name ("More ways to invite").
 * `menuTestId`: the ⌄'s test id. */
export function SplitAction({ label, icon, onPrimary, items, testId, menuLabel, menuTestId = 'integration-add-more' }: {
  label: string
  icon?: ReactNode
  onPrimary: () => void
  items: AddMenuItem[]
  testId: string
  menuLabel: string
  /** Connectors' tests know the ⌄ as integration-add-more (Add ⌄ and a connector's Connect ⌄) */
  menuTestId?: string
}) {
  return (
    <div className="flex shrink-0 items-stretch" data-testid={`${testId}-group`}>
      {/* a phone: 44 px, for a finger (the Button's own phone size) */}
      <Button variant="primary" className="rounded-r-none" onClick={onPrimary} data-testid={testId}>{icon}{icon ? ' ' : ''}{label}</Button>
      <ActionMenu items={items} label={menuLabel} testId={menuTestId} />
    </div>
  )
}

/** The ⌄ half of a split button: a small menu of the other ways. A dialog opened from it gets the focus back on this
 * button when it closes (the item is gone with the menu). A phone (below 768 px): the app's bottom sheet
 * (rooms/MenuButton.tsx), 48 px rows; a way that is not possible yet is left out there. */
export function ActionMenu({ items, label, testId }: { items: AddMenuItem[]; label: string; testId: string }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  const sheetButton = useRef<HTMLButtonElement>(null)
  const half = 'h-11 rounded-l-none rounded-r-lg border-l border-accent-ink/20 bg-accent px-2.5 text-accent-ink'
  const ready = items.filter((it) => !it.disabled)
  // nothing possible yet (Usage's CSV before the report is in): the ⌄ waits, as its one item would
  if (phone && !ready.length)
    // no-tooltip: a phone (no hover), and the button is off until its item is possible
    return <button type="button" disabled aria-label={label} className={`flex items-center opacity-50 ${half}`} data-testid={testId}><ChevronDown size={15} aria-hidden /></button>
  if (phone)
    return (
      <MenuButton label={label} heading={label} icon={<ChevronDown size={15} aria-hidden />} className="flex" testId={testId} buttonRef={sheetButton}
        buttonClassName="!h-11 !rounded-l-none !rounded-r-lg border-l border-accent-ink/20 !bg-accent !px-2.5 !text-accent-ink hover:!bg-accent-hover"
        // the keyboard on the ⌄ first: the item goes with the sheet, and a dialog it opens gives the focus back there
        items={ready.map((it) => ({ label: it.label, icon: it.icon, onSelect: () => { sheetButton.current?.focus(); it.onSelect() }, testId: it.testId }))} />
    )
  return <ActionDropdown items={items} label={label} testId={testId} />
}

function ActionDropdown({ items, label, testId }: { items: AddMenuItem[]; label: string; testId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const menuItems = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
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
      if (e.key === 'Escape') e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const all = menuItems()
      const at = all.indexOf(document.activeElement as HTMLElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }
  return (
    <div ref={box} className="relative flex" onKeyDown={onKeyDown}>
      <Tooltip label={label}>
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 items-center rounded-r-lg border-l border-accent-ink/20 bg-accent px-2 text-accent-ink transition hover:bg-accent-hover max-md:min-h-11 max-md:px-2.5"
          data-testid={testId}
        >
          <ChevronDown size={15} aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <div role="menu" aria-label={label} className="absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm -outline-offset-2 hover:bg-hover focus:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent max-md:min-h-11"
              onClick={() => {
                setOpen(false)
                // the dialog this opens returns the focus to the button it was opened from
                button.current?.focus()
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

export interface PageAction extends AddMenuItem {
  /** the button's test id on a computer, when it is not the menu item's */
  buttonTestId?: string
}

/**
 * A page's buttons: `primary` and the `more` ways. Computers and tablets: every button, the main one last (as the
 * pages had them). Phones: the main button with the others under its ⌄ (`menuLabel` names the ⌄). One button and no
 * others: just that button. The test ids stay those of the buttons (`buttonTestId` ?? `testId`) on a computer and
 * become the menu items' on a phone.
 */
export function PageActions({ primary, more = [], menuLabel }: { primary: PageAction; more?: PageAction[]; menuLabel: string }) {
  const phone = useMediaQuery('(max-width: 767.98px)')
  if (phone && more.length)
    return <SplitAction label={primary.label} icon={primary.icon} onPrimary={primary.onSelect} items={more} testId={primary.buttonTestId ?? primary.testId} menuLabel={menuLabel} menuTestId={`${primary.buttonTestId ?? primary.testId}-more`} />
  return (
    <>
      {more.map((a) => (
        <Button key={a.testId} size="sm" onClick={a.onSelect} disabled={a.disabled} data-testid={a.buttonTestId ?? a.testId}>
          {a.icon} {a.label}
        </Button>
      ))}
      <Button size="sm" variant="primary" onClick={primary.onSelect} data-testid={primary.buttonTestId ?? primary.testId}>
        {primary.icon} {primary.label}
      </Button>
    </>
  )
}
