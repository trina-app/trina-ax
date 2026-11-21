// One quiet line of a side column (a project's page): icon, name, a short state, and an action on the right. Clicking
// the line shows what is behind it in place, so the column stays a few lines long until someone asks for more. A line
// with nothing behind it (no children) is a plain line: no toggle, only its action.
import { ChevronDown } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'

export function DisclosureRow({ icon, label, badge, meta, action, children, testId }: {
  icon: ReactNode
  label: string
  /** next to the name (an "Experiment" badge) */
  badge?: ReactNode
  /** a few words of state after the name: a count, "On", "Running" */
  meta?: ReactNode
  /** a link or button at the end of the line, outside the toggle */
  action?: ReactNode
  children?: ReactNode
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (children === undefined)
    return (
      <div data-testid={testId} className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2.5 py-3 text-sm">
          <span className="shrink-0 text-muted" aria-hidden>
            {icon}
          </span>
          <span className="min-w-0 truncate font-medium">{label}</span>
          {badge && <span className="shrink-0">{badge}</span>}
          {meta && <span className="shrink-0 text-xs text-faint">{meta}</span>}
        </span>
        {action && <span className="shrink-0 text-sm">{action}</span>}
      </div>
    )
  return (
    <div data-testid={testId}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-3 text-left text-sm -outline-offset-2"
          data-testid={testId && `${testId}-toggle`}
        >
          <span className="shrink-0 text-muted" aria-hidden>
            {icon}
          </span>
          {/* a long name gives way first: the state after it stays readable */}
          <span className="min-w-0 truncate font-medium group-hover:text-ink">{label}</span>
          {badge && <span className="shrink-0">{badge}</span>}
          {meta && <span className="shrink-0 text-xs text-faint">{meta}</span>}
          <ChevronDown size={14} className={clsx('shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {action && <span className="shrink-0 text-sm">{action}</span>}
      </div>
      <div id={id} hidden={!open} className="pb-3 pl-[26px] text-sm">
        {open && children}
      </div>
    </div>
  )
}
