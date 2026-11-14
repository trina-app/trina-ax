// One row of a list on a phone (people, groups, connections; docs/DECISIONS.md "Admin and Settings on phones"): the name
// and, at the right, its chip (a role, a count, a state) and its ⋯ on the first line; a second line only when it says
// something (a username that is not the name, the email a search matched, a status). It replaces the three-line cards
// (name, then username, then the role on a line of its own). The chip may be a control (the owner's member ↔ admin
// choice): then it is 44 px tall to tap. `onOpen`: the name and its line open the row's own page (a person's, a
// group's, an engine's), as a button the height of the row; `lead`: a small mark before the name.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

const openCls = '-my-1.5 flex min-h-12 min-w-0 flex-1 flex-col justify-center py-1.5 text-left -outline-offset-2'

export function CompactRow({ lead, title, chip, second, menu, className, testId, data, rowRef, onOpen, to, openLabel }: {
  /** before the name: a small mark (an engine's logo) */
  lead?: ReactNode
  title: ReactNode
  chip?: ReactNode
  /** the second line; null, empty or false: none */
  second?: ReactNode
  menu?: ReactNode
  className?: string
  testId?: string
  /** more attributes for the row (data-*) */
  data?: Record<`data-${string}`, string | undefined>
  rowRef?: React.Ref<HTMLLIElement>
  /** opens the row's own page */
  onOpen?: () => void
  /** opens the row's own page as a link (a new tab works too) */
  to?: string
  /** the open button's name, when the title alone does not say it */
  openLabel?: string
}) {
  const text = (
    <>
      <span className="block truncate text-row font-medium">{title}</span>
      {second ? <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">{second}</span> : null}
    </>
  )
  return (
    <li ref={rowRef} className={clsx('flex min-h-12 items-center gap-2 py-1.5 text-sm', className)} data-testid={testId} {...data}>
      {lead}
      {to ? (
        <Link to={to} aria-label={openLabel} className={openCls} data-testid="row-open">
          {text}
        </Link>
      ) : onOpen ? (
        <button type="button" onClick={onOpen} aria-label={openLabel} className={openCls} data-testid="row-open">
          {text}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{text}</div>
      )}
      {chip && <div className="flex shrink-0 items-center">{chip}</div>}
      {menu && <div className="flex shrink-0 items-center">{menu}</div>}
    </li>
  )
}
