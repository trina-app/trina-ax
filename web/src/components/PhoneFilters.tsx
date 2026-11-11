// A list's filters (Role, Group, Person…) beside its search box. On a computer or a tablet they show in the row as
// before. On a phone (below 768 px) one "Filters" button takes their place at the end of the search row, with the
// number of filters away from "All", and opens them in a bottom sheet (ui.tsx Modal), so the search and the filters
// share one row and the part that stays at the top never grows (docs/DECISIONS.md "Admin and Settings on phones"). A
// filter changes the list at once; Done closes the sheet. A view choice (Group by) is not a filter: it is not passed
// here.
import clsx from 'clsx'
import { SlidersHorizontal } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { Button, Modal, useMediaQuery } from './ui'

/** `active`: how many of the filters are away from their first choice. `children`: the filters. */
export function PhoneFilters({ active, children, testId = 'phone-filters' }: { active: number; children: ReactNode; testId?: string }) {
  const t = useT()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [open, setOpen] = useState(false)
  if (!phone) return <>{children}</>
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={clsx('inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-surface px-3 text-sm text-ink transition hover:bg-hover', active ? 'border-line-strong' : 'border-line')}
        data-testid={`${testId}-toggle`}
      >
        <SlidersHorizontal size={15} className="shrink-0 text-muted" aria-hidden />
        {t('activity.filters')}
        {active > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink tabular-nums" data-testid={`${testId}-count`}>
            <span aria-hidden>{active}</span>
            <span className="sr-only">{t('common.filtersOn', { count: active })}</span>
          </span>
        )}
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
