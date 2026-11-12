// A page's buttons in the phone's Admin bar (below 768 px: AdminLayout.tsx PhonePageBar, on the right), where an iPhone
// app has them: + for the page's main action (Invite, New group, Add folder, Add limit) and ⋯ for the other ways, as a
// bottom sheet (rooms/MenuButton.tsx); a filter's icon may sit there too (Folder permissions). The page renders
// <AdminBarActions> where it likes and it shows in the bar; on a computer, or outside Admin, nothing shows, so the page
// keeps its own buttons there (QA TC-377: no button block at the top of a phone's page). Every button is 44 px with a
// name. The bar's title and its check before ‹ are phoneBar.ts's.
import { MoreHorizontal, Plus } from 'lucide-react'
import { createContext, useContext, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '../../components/Tooltip'
import { MenuButton } from '../../components/rooms/MenuButton'

const Slot = createContext<HTMLElement | null>(null)
/** AdminLayout: the bar's place for a page's buttons (null on a computer) */
export const AdminBarSlot = Slot.Provider

/** `children` in the phone's Admin bar, on the right; nothing where there is no bar (a computer). */
export function AdminBarActions({ children }: { children: ReactNode }) {
  const slot = useContext(Slot)
  return slot ? createPortal(<span className="flex items-center" data-testid="admin-bar-actions">{children}</span>, slot) : null
}

/** Whether the page is under the phone's Admin bar: the page then leaves its own buttons out. */
export const useAdminBarSlot = () => useContext(Slot) !== null

const barButton = 'grid size-11 shrink-0 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-ink disabled:opacity-40'

/** The bar's + : the page's main action, named for screen readers and in its tip. */
export function BarAdd({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <Tooltip label={label}>
      <button type="button" onClick={onClick} aria-label={label} className={barButton} data-testid={testId}>
        <Plus size={22} aria-hidden />
      </button>
    </Tooltip>
  )
}

/** The bar's words button ("Edit"), where a page's one action is not adding something. */
export function BarText({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} className="flex h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium text-accent-text hover:bg-hover" data-testid={testId}>
      {label}
    </button>
  )
}

export interface BarMoreItem { label: string; icon?: ReactNode; onSelect: () => void; testId: string; disabled?: boolean }

/** The bar's ⋯ : the page's other ways (a split button's ⌄ on a computer), as a bottom sheet named `label`. An item that
 * is not possible yet (Usage's CSV before the report is in) is left out; with none left the ⋯ waits, off. A dialog an
 * item opens gives the keyboard back to the ⋯. */
export function BarMore({ label, items, testId }: { label: string; items: BarMoreItem[]; testId: string }) {
  const button = useRef<HTMLButtonElement>(null)
  const ready = items.filter((it) => !it.disabled)
  if (!ready.length)
    return (
      <button type="button" disabled aria-label={label} className={barButton} data-testid={testId}>
        <MoreHorizontal size={22} aria-hidden />
      </button>
    )
  return (
    <MenuButton label={label} heading={label} icon={<MoreHorizontal size={22} aria-hidden />} muted buttonRef={button} className="shrink-0" buttonClassName="size-11" testId={testId}
      items={ready.map((it) => ({ label: it.label, icon: it.icon, onSelect: () => { button.current?.focus(); it.onSelect() }, testId: it.testId }))} />
  )
}
