// One row of a list on a phone (people, groups, connections; docs/DECISIONS.md "Admin and Settings on phones"): the name
// and, at the right, its chip (a role, a count, a state) and its ⋯ on the first line; a second line only when it says
// something (a username that is not the name, the email a search matched, a status). It replaces the three-line cards
// (name, then username, then the role on a line of its own). The chip may be a control (the owner's member ↔ admin
// choice): then it is 44 px tall to tap. `onOpen`: the name and its line open the row's own page (a person's, a
// group's), as a button the height of the row.
import clsx from 'clsx'
import type { ReactNode } from 'react'

export function CompactRow({ title, chip, second, menu, className, testId, rowRef, onOpen, openLabel }: {
  title: ReactNode
  chip?: ReactNode
  /** the second line; null, empty or false: none */
  second?: ReactNode
  menu?: ReactNode
  className?: string
  testId?: string
  rowRef?: React.Ref<HTMLLIElement>
  /** opens the row's own page */
  onOpen?: () => void
  /** the open button's name, when the title alone does not say it */
  openLabel?: string
}) {
  const text = (
    <>
      <span className="block truncate font-medium">{title}</span>
      {second ? <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint">{second}</span> : null}
    </>
  )
  return (
    <li ref={rowRef} className={clsx('flex min-h-12 items-center gap-2 py-1.5 text-sm', className)} data-testid={testId}>
      {onOpen ? (
        <button type="button" onClick={onOpen} aria-label={openLabel} className="-my-1.5 flex min-h-12 min-w-0 flex-1 flex-col justify-center py-1.5 text-left -outline-offset-2" data-testid="row-open">
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
