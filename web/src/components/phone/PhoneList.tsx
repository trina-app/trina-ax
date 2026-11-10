// A settings list on a phone (below 768 px), like the iPhone's Settings but in this app's own look (no grey boxes):
// groups under a small heading, rows of at least 48 px with an icon, the name, a short value or a badge on the right
// and a chevron when the row opens a page, hairlines that start where the name does, and a quiet footer line. Admin's
// root and the 나 list (Settings) both use it (docs/DECISIONS.md "Admin and Settings on phones: a list you tap into").
// A row that opens a page pushes it (Back returns to the list).
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export function PhoneListGroup({ title, footer, children, testId, labelId }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; testId?: string; labelId?: string }) {
  return (
    <section className="mt-6 first:mt-4" data-testid={testId} aria-labelledby={title && labelId ? labelId : undefined}>
      {title && (
        <h2 id={labelId} className="px-4 pb-1.5 text-xs font-medium text-faint">
          {title}
        </h2>
      )}
      <ul className="border-y border-line">{children}</ul>
      {footer && <div className="px-4 pt-2 text-xs text-faint">{footer}</div>}
    </section>
  )
}

const chevronIcon = <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />

/** One row. `to`: opens a page (a push) with a chevron; `onClick`: an action in place (no chevron unless `chevron`);
 * neither: a plain row. `value`: a short word on the right (a count, an engine's name); `badge`: in its place when
 * something needs a look ("2 to fix"). `wrap`: the name may take two lines (a "needs attention" sentence). `below`:
 * buttons under the name (an attention row that can be acted on here). `end`: a control in place of the chevron. */
export function PhoneListRow({ icon, title, value, badge, to, state, onClick, chevron, wrap, below, end, testId, disabled, ariaLabel, expanded }: {
  icon?: ReactNode
  title: ReactNode
  value?: ReactNode
  badge?: ReactNode
  to?: string
  state?: unknown
  onClick?: () => void
  chevron?: boolean
  wrap?: boolean
  below?: ReactNode
  end?: ReactNode
  testId?: string
  disabled?: boolean
  ariaLabel?: string
  expanded?: boolean
}) {
  const shown = badge ?? (value != null && value !== '' ? <span className="max-w-[45%] shrink-0 truncate text-sm text-muted tabular-nums">{value}</span> : null)
  const mark = end ?? ((chevron ?? !!to) ? chevronIcon : null)
  // the hairline sits on the part after the icon, so it starts where the name does; none above the first row
  const content = (
    <span className="flex min-h-12 min-w-0 flex-1 items-center gap-3 border-t border-line py-2.5 pr-4 group-first/row:border-t-0">
      <span className={clsx('min-w-0 flex-1', wrap ? 'line-clamp-2' : 'truncate')}>{title}</span>
      {shown}
      {mark}
    </span>
  )
  const iconCell = icon ? <span className="grid size-5 shrink-0 place-items-center self-center text-muted" aria-hidden>{icon}</span> : null
  const rowCls = 'flex w-full items-stretch gap-3 pl-4 text-left text-sm transition hover:bg-hover focus-visible:-outline-offset-2'
  if (below) {
    return (
      <li className="group/row" data-testid={testId}>
        <div className="flex items-stretch gap-3 pl-4 text-sm">
          {icon && <span className="grid size-5 shrink-0 place-items-center pt-3 text-muted" aria-hidden>{icon}</span>}
          <div className="min-w-0 flex-1 border-t border-line py-2.5 pr-4 group-first/row:border-t-0">
            {to ? <Link to={to} state={state} className="block rounded hover:underline">{title}</Link> : <span className="block">{title}</span>}
            <div className="mt-2 flex flex-wrap items-center gap-2">{below}</div>
          </div>
        </div>
      </li>
    )
  }
  return (
    <li className="group/row">
      {to ? (
        <Link to={to} state={state} className={rowCls} aria-label={ariaLabel} data-testid={testId}>{iconCell}{content}</Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} disabled={disabled} aria-expanded={expanded} className={clsx(rowCls, 'disabled:opacity-60')} aria-label={ariaLabel} data-testid={testId}>{iconCell}{content}</button>
      ) : (
        <div className={rowCls} data-testid={testId}>{iconCell}{content}</div>
      )}
    </li>
  )
}
