// One row of a list of connections and apps (docs/DECISIONS.md "Connection rows: one look"): a logo, the name, one line
// under it, and one status or action at the right. Every such list uses it: Connectors' and Admin › Connectors'
// connections and Discover (ConnectorsView.tsx), a member's asks (MemberAsks.tsx), the AI apps and their connections
// (AiAppConnect.tsx, pages/AiApps.tsx, pages/admin/AiApps.tsx) and Google Drive's own row (AppConnectorCard.tsx). So
// they are one height on a computer (56px) and one on a phone (64px, room for a 44px button), with the same logo size,
// name and line, wherever they show. Sizes come from the list tokens (text-row) like ListRow's (components/list/List.tsx).
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { pageBleed, rowOpenHover } from '../list/List'

/** A row's logo box (LogoTile, InitialTile, AiAppLogo, DriveLogo take it as their className) */
export const connectionLogo = 'size-10 rounded-xl p-2'

/** the row's own box: the same least height on every list of one screen size */
const rowBox = 'flex min-h-14 items-center gap-3 py-2 max-md:min-h-16'
/** a row that opens its page (QA TC-1416: it did not look clickable): the list rows' hover fill reaching past the words
 * as a page list's does (List.tsx pageBleed, rowOpenHover), a pointer, and the keyboard's ring around the whole row */
const openBox = clsx(pageBleed, rowOpenHover, 'relative cursor-pointer px-3')
/** the open button's area covers the whole row (its ::after), so a click anywhere but on `end`'s own controls opens it;
 * its keyboard ring is drawn on that area */
const openArea = "after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
/** the row's › (a row that opens a page, as the other admin lists) */
const chevron = <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden data-testid="connection-row-chevron" />

export function ConnectionRow({ logo, name, badge, line, lineTone, wrap, more, end, onOpen, openLabel, openTestId, whole, testId, data, className, children }: {
  logo: ReactNode
  name: ReactNode
  /** beside the name: a small label (Team) */
  badge?: ReactNode
  /** one line under the name: what it does, the account, who asked; cut to one line */
  line?: ReactNode
  lineTone?: 'muted' | 'warn'
  /** the name and the line wrap instead of being cut (what a connection may do: every word counts) */
  wrap?: boolean
  /** more lines under that one, only when they say something (a connection's expiry, what it lacks) */
  more?: ReactNode
  /** the right side: one status or one action (or the few buttons of one choice) */
  end?: ReactNode
  /** the logo, name and line open the row's page (a button); `end` stays its own control */
  onOpen?: () => void
  openLabel?: string
  openTestId?: string
  /** the whole row is the open button, `end` too (a phone's row with a ›: `end` must hold no control then) */
  whole?: boolean
  testId?: string
  data?: Record<`data-${string}`, string | undefined>
  /** the li's own class: its separator */
  className?: string
  /** under the row, inside it (what a row shows while it works: waiting for Google, the steps) */
  children?: ReactNode
}) {
  const body = (
    <>
      {logo}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={clsx(wrap ? 'break-words' : 'truncate', 'min-w-0 text-row font-medium')}>{name}</span>
          {badge}
        </span>
        {line && <span className={clsx('mt-0.5 block text-xs', wrap ? 'break-words' : 'truncate', lineTone === 'warn' ? 'text-warn' : 'text-muted')} data-testid={testId ? `${testId}-line` : undefined}>{line}</span>}
        {more}
      </span>
    </>
  )
  // over the open button's area (openArea): its own controls take their clicks
  const endBox = end ? <span className={clsx('flex shrink-0 items-center gap-2', onOpen && !whole && 'relative z-[1]')}>{end}</span> : null
  return (
    // min-w-0: a list that is a grid (Discover) must not widen to the full line it cuts
    <li className={clsx('min-w-0', className)} data-testid={testId} {...data}>
      {onOpen && whole ? (
        <button type="button" className={clsx(rowBox, 'w-full rounded-lg text-left -outline-offset-2 hover:bg-hover')} onClick={onOpen} aria-label={openLabel} data-testid={openTestId}>
          {body}
          {endBox}
        </button>
      ) : (
        <div className={clsx(rowBox, onOpen && openBox)}>
          {onOpen ? (
            <button type="button" className={clsx('flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch text-left', openArea)} onClick={onOpen} aria-label={openLabel} data-testid={openTestId}>
              {body}
            </button>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
          )}
          {endBox}
          {onOpen && chevron}
        </div>
      )}
      {children}
    </li>
  )
}
