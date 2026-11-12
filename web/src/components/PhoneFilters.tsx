// A list's filters (Role, Group, Person…) beside its search box. On a computer or a tablet they show in the row as
// before. On a phone (below 768 px) one "Filters" button takes their place at the end of the search row, with the
// number of filters away from "All", and opens them in a bottom sheet (ui.tsx Modal), so the search and the filters
// share one row and the part that stays at the top never grows (docs/DECISIONS.md "Admin and Settings on phones"). A
// filter changes the list at once; Done closes the sheet. A view choice (Group by) is not a filter: it is not passed
// here. `icon`: the button is an icon alone, 44 px (QA TC-379), with the count as a small badge on it, for inside a
// search field (common.tsx SearchBox `end`), at the end of a row, or in the Admin bar (pages/admin/barActions.tsx).
import clsx from 'clsx'
import { SlidersHorizontal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { Button, Modal, useMediaQuery } from './ui'

/** `active`: how many of the filters are away from their first choice. `children`: the filters. */
export function PhoneFilters({ active, children, testId = 'phone-filters', icon, framed }: { active: number; children: ReactNode; testId?: string; icon?: boolean; framed?: boolean }) {
  const t = useT()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [open, setOpen] = useState(false)
  if (!phone) return <>{children}</>
  const count = active > 0 && (
    <span className={clsx('rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink tabular-nums', icon && 'absolute top-1 right-0.5 min-w-4 text-center leading-4')} data-testid={`${testId}-count`}>
      <span aria-hidden>{active}</span>
      <span className="sr-only">{t('common.filtersOn', { count: active })}</span>
    </span>
  )
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={icon
          // an icon alone: inside a field (no frame of its own), or `framed` beside other controls
          ? clsx('relative grid size-11 shrink-0 place-items-center rounded-lg transition hover:bg-hover', active ? 'text-ink' : 'text-muted', framed && clsx('border bg-surface', active ? 'border-line-strong' : 'border-line'))
          : clsx('inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-surface px-3 text-sm text-ink transition hover:bg-hover', active ? 'border-line-strong' : 'border-line')}
        data-testid={`${testId}-toggle`}
      >
        {icon ? (
          <>
            <SlidersHorizontal size={18} className="shrink-0" aria-hidden />
            <span className="sr-only">{t('activity.filters')}</span>
          </>
        ) : (
          <>
            <SlidersHorizontal size={15} className="shrink-0 text-muted" aria-hidden />
            {t('activity.filters')}
          </>
        )}
        {count}
      </button>
      {/* the filters themselves, each still its own control, one under the other, 44 px to tap */}
      <Modal open={open} onClose={() => setOpen(false)} title={t('activity.filters')}
        footer={<Button variant="primary" className="min-h-11" onClick={() => setOpen(false)} data-testid={`${testId}-done`}>{t('common.done')}</Button>}>
        <div className="flex flex-col items-stretch gap-3 [&_button]:min-h-11 [&_select]:min-h-11 [&>*]:max-w-full" data-testid={testId}>
          {children}
        </div>
      </Modal>
    </>
  )
}
