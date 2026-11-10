// A list's filters (Role, Group, Person…) beside its search box. On a computer or a tablet they show in the row as
// before. On a phone (below 768 px) one "Filters" button takes their place at the end of the search row, with the
// number of filters away from "All", and opens them under the row (the way Activity log did it on phones), so the
// search and the filters share one row instead of a filter alone on a row of its own (docs/DECISIONS.md "Admin and
// Settings on phones"). A view choice (Group by) is not a filter: it is not passed here.
import clsx from 'clsx'
import { SlidersHorizontal } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { useMediaQuery } from './ui'

/** `active`: how many of the filters are away from their first choice. `children`: the filters. */
export function PhoneFilters({ active, children, testId = 'phone-filters' }: { active: number; children: ReactNode; testId?: string }) {
  const t = useT()
  const phone = useMediaQuery('(max-width: 767.98px)')
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!phone) return <>{children}</>
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={clsx('inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border bg-surface px-3 text-sm text-ink transition hover:bg-hover', active ? 'border-line-strong' : 'border-line')}
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
      {/* under the row (the row wraps): the filters themselves, each still its own control */}
      <div id={id} hidden={!open} className="flex basis-full flex-wrap items-center gap-2" data-testid={testId}>
        {children}
      </div>
    </>
  )
}
