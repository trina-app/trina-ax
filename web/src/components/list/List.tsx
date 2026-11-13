// The app's lists, one set of pieces for every place that lists things (docs/DECISIONS.md "Lists: one set of rows and
// headers"): the computer's panels beside the rail (트리나, 대화, 프로젝트, 파일, 활동) and the phone's tabs (대화, 프로젝트,
// 파일, 나 and the 트리나 drawer). Sizes and colours come from the list tokens in index.css (text-row, text-meta,
// min-h-row-min, size-list-icon, text-row-read, font-row-read, text-list-head, …), which have a computer's values and a
// phone's: so a row looks the same in every list of one screen size, and a list never sets its own sizes.
//   ListRow     a row: icon, name, an optional second line (meta), something at its end; unread and selected states
//   ListIcon    a row's icon: a bare 16px icon on a computer, a 32px round tile on a phone (as the 대화 tab's faces)
//   ListSection a section with a header that folds it (▸, its icon, its name, an action at its end)
//   ListHeading a header that does not fold (the phone's 대화 kinds, a settings group)
// A chat's row (nav/ChatItem.tsx) is a ListRow too, with its "···" (`menu`), its pin (`lead`) and its project (`tag`).
// Rows with a drag of their own (a room: nav/RoomsList.tsx, pages/Rooms.tsx) keep their own markup but take their
// name's look from `rowName` here.
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useId, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react'
import { Link } from 'react-router-dom'
import { useFolds } from '../panels/folds'

/** A row's name: unread or selected semibold in ink; otherwise the read look (a computer: muted 400; a phone: ink 500) */
export const rowName = ({ unread = false, selected = false }: { unread?: boolean; selected?: boolean } = {}) =>
  clsx('text-row', unread || selected ? 'font-semibold text-ink' : 'font-row-read text-row-read')

/** A row's icon: a bare icon on a computer, a round tile on a phone (index.css --spacing-list-icon, --color-list-icon-bg).
 * `face`: a list of people (the member picker): a box a picture reads in, 28px on a computer (--spacing-list-face) */
export function ListIcon({ children, className, face }: { children: ReactNode; className?: string; face?: boolean }) {
  return (
    <span aria-hidden className={clsx('flex shrink-0 items-center justify-center rounded-full text-muted', face ? 'size-list-face bg-hover' : 'size-list-icon bg-list-icon-bg', '[&>svg]:size-list-glyph', className)}>
      {children}
    </span>
  )
}

type RowLink = { [data: `data-${string}`]: string | undefined }
/** the row's <li>: a ref, its hover, its menu's right-click and long press, data-* (a chat's row) */
type RowLi = Omit<HTMLAttributes<HTMLLIElement>, 'className' | 'children'> & RowLink & { ref?: Ref<HTMLLIElement> }

/** A row's trailing tag (a chat's project, a task's last run): 13px and faint at the row's right, every row's at the
 * same edge; it keeps its words up to 40% of the row and the name is cut first */
/** A row's height (index.css --spacing-row-min): 30px on a computer, 48px on a phone, never under 44px on a touch
 * screen. Every list row's box takes it (ListRow; a panel's fixed rows, PanelFrame panelRowBox; a room's row) */
export const rowBox = 'min-h-row-min pointer-coarse:min-h-[max(2.75rem,var(--spacing-row-min))]'
/** A section header's row (ListSection; a group of the filtered history, history/HistoryGroups.tsx): the rows' 30px on
 * a computer, 44px to tap on a phone and a touch screen */
export const headBox = 'flex h-row items-center gap-1 pointer-coarse:min-h-11 max-md:min-h-11'

export const rowTag = 'ml-auto max-w-[40%] shrink-0 truncate text-meta font-normal text-faint tabular-nums'

/**
 * One row of a list. `to` makes it a link (with `state`), else `onClick` a button, else a row that opens nothing. `icon`: a lucide icon (drawn in a
 * ListIcon). `meta`: a second line, small and faint ("나만 · 3시간 전", a notice's time). `end`: what sits at the row's
 * right (a count, a dot, a ›). `selected`: the place on screen (aria-current, a fill); `unread`: semibold in ink.
 * `wrap`: the name may take two lines. `nameTitle`: the whole name on hover when it is cut. `disabled`: a button row
 * that does nothing now (a picker's row already added): no hover fill. `face`: the icon box of a list of people (ListIcon).
 * `lead`: small marks right before the name (a chat's pin, its shared icon). `tag`: the row's trailing tag (rowTag).
 * `menu`: the row's "···", beside the link in the <li> (it places itself at the row's right); the row's words keep
 * clear of it. `menuSpace`: the same clearance for a row with no menu in a list whose rows have one (a task's runs among
 * chats), so every tag ends at the same edge. `li`: the <li>'s ref, handlers and data-*; `rowClass`: more classes
 * for the link (a chat's long press, its open menu's fill). `choice`: the row is the <label> of a checkbox in `end` (the
 * member picker): a click anywhere on it ticks it.
 */
export function ListRow({ to, state, onClick, icon, lead, name, nameTitle, meta, end, tag, tagTitle, tagTestId, menu, menuSpace, choice, unread, selected, wrap, disabled, face, testId, nameTestId, metaTestId, link, li, rowClass, onFocus, onBlur, onKeyDown }: {
  to?: string
  state?: unknown
  onClick?: (e: MouseEvent<HTMLElement>) => void
  icon?: ReactNode
  lead?: ReactNode
  name: ReactNode
  nameTitle?: string
  meta?: ReactNode
  end?: ReactNode
  tag?: ReactNode
  tagTitle?: string
  tagTestId?: string
  menu?: ReactNode
  menuSpace?: boolean
  choice?: boolean
  unread?: boolean
  selected?: boolean
  wrap?: boolean
  disabled?: boolean
  face?: boolean
  testId?: string
  nameTestId?: string
  metaTestId?: string
  /** more attributes for the row's link or button (data-*) */
  link?: RowLink
  li?: RowLi
  rowClass?: string
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
}) {
  const cls = clsx(
    // a touch screen: at least 44px to tap, or the list's own least height where that is more (a phone: 48px)
    'flex w-full gap-2.5 rounded-lg px-3 text-left focus-visible:-outline-offset-2',
    rowBox,
    (to || onClick || choice) && !disabled && 'hover:bg-hover',
    choice && 'cursor-pointer has-[:disabled]:opacity-60',
    meta ? 'items-start py-1.5 max-md:items-center max-md:py-2' : face ? 'items-center py-1' : 'items-center',
    selected && 'bg-hover',
    // the "···" (28px on a computer, 44px on a phone) at the row's right: the words end before it
    (menu || menuSpace) && 'pr-9 max-md:pr-11',
    rowClass,
  )
  const body = (
    <>
      {icon && <ListIcon face={face} className={meta ? (face ? 'self-center' : 'mt-0.5 max-md:mt-0') : undefined}>{icon}</ListIcon>}
      {lead && <span className="-mr-1 flex shrink-0 items-center gap-1 self-center">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className={clsx(wrap ? 'line-clamp-2 break-words' : 'block truncate', rowName({ unread, selected }))} title={nameTitle} data-testid={nameTestId}>
          {name}
        </span>
        {meta && (
          <span className="block truncate text-meta text-faint tabular-nums" data-testid={metaTestId}>
            {meta}
          </span>
        )}
      </span>
      {tag && <span className={clsx(rowTag, 'self-center')} title={tagTitle} data-testid={tagTestId}>{tag}</span>}
      {end}
    </>
  )
  const { ref: liRef, ...liRest } = li ?? {}
  const events = { onFocus, onBlur, onKeyDown }
  return (
    <li ref={liRef} className={clsx((menu || end) && 'group', (menu || menuSpace) && 'relative') || undefined} {...liRest}>
      {choice ? (
        <label className={cls} data-testid={testId} {...link}>
          {body}
        </label>
      ) : to ? (
        <Link to={to} state={state} onClick={onClick} aria-current={selected ? 'page' : undefined} className={cls} data-testid={testId} {...events} {...link}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} disabled={disabled} className={cls} data-testid={testId} {...events} {...link}>
          {body}
        </button>
      ) : (
        // neither: a row that opens nothing (a scheduled run that did not start has no chat), no hover
        <div className={cls} data-testid={testId} {...link}>
          {body}
        </div>
      )}
      {menu}
    </li>
  )
}

/** a section's body: its rows (a list's `li > a`, a quiet button) indented so their icon starts under the header's words
 * (a computer; a phone keeps the rows' own inset); a group in it (a 대화 folder) indented the same */
const sectionBody = '[&>button]:pl-row-indent [&>ul>li>a]:pl-row-indent [&>section]:pl-row-indent'

/**
 * A section of a list (트리나's 고정, 최근 기록; 대화's kinds; 프로젝트's 팀/내; 파일's places; 활동's 읽음): its header (the
 * rows' size, semibold in ink on a computer; small and grey on a phone: index.css --text-list-head), space above it,
 * folds the section with the ▸ on its left (remembered per person in this browser, `foldKey`); `count`, when given,
 * shows beside the label while it is folded. `link`: the label's words open a page (파일's 팀 폴더), so the ▸ is a
 * button of its own.
 */
export function ListSection({ id, label, icon, count, action, link, foldKey, labelTestId, children, className, ...rest }: {
  id: string
  label: ReactNode
  icon?: ReactNode
  count?: number
  action?: ReactNode
  link?: ReactNode
  foldKey: string
  labelTestId: string
  children: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLElement>, 'id'> & { [data: `data-${string}`]: string | undefined }) {
  const { folds, set } = useFolds()
  const key = `section:${foldKey}`
  const folded = folds[key] === 'folded'
  const bodyId = useId()
  const toggle = () => set(key, folded ? 'open' : 'folded')
  const words = (
    <>
      {icon}
      <span className="truncate">{label}</span>
      {folded && count !== undefined && count > 0 && <span className="shrink-0 text-meta font-normal text-faint tabular-nums" data-testid="panel-section-count">{count}</span>}
    </>
  )
  return (
    <section aria-labelledby={id} className={clsx('mt-4 first:mt-0', className)} data-folded={folded ? '' : undefined} {...rest}>
      <div className={clsx(headBox, 'pr-1')} data-testid={labelTestId}>
        <h3 id={id} className="flex min-w-0 flex-1 items-center gap-1.5 text-list-head font-semibold text-list-head-ink">
          {link ? (
            <>
              <GroupChevron folded={folded} controls={bodyId} label={typeof label === 'string' ? label : undefined} onClick={toggle} testId="panel-section-fold" />
              <span className="flex min-w-0 items-center gap-1.5">{link}</span>
            </>
          ) : (
            <button type="button" aria-expanded={!folded} aria-controls={bodyId} onClick={toggle} className="flex h-row min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 text-left hover:text-muted pointer-coarse:min-h-11 max-md:min-h-11" data-testid="panel-section-fold">
              <span className="flex size-6 shrink-0 items-center justify-center text-muted">
                <ChevronRight size={14} className={clsx('transition-transform motion-reduce:transition-none', !folded && 'rotate-90')} aria-hidden />
              </span>
              {words}
            </button>
          )}
        </h3>
        {action}
      </div>
      <div id={bodyId} hidden={folded} className={sectionBody}>
        {!folded && children}
      </div>
    </section>
  )
}

/** A header that does not fold (the phone's 대화 kinds, a settings group): the same look as ListSection's. `as`: its
 * heading level (h2 on a page's own list, h3 inside a panel). */
export function ListHeading({ id, children, className, as: Tag = 'h3', testId }: { id?: string; children: ReactNode; className?: string; as?: 'h2' | 'h3'; testId?: string }) {
  return (
    <Tag id={id} className={clsx('truncate text-list-head font-semibold text-list-head-ink', className)} data-testid={testId}>
      {children}
    </Tag>
  )
}

/** A group's ▸ (left of its name): folds and opens it */
export function GroupChevron({ folded, controls, label, onClick, testId }: { folded: boolean; controls: string; label?: string; onClick: () => void; testId: string }) {
  return (
    // no-tooltip: a disclosure's ▸ (aria-expanded)
    <button type="button" aria-expanded={!folded} aria-controls={controls} aria-label={label} onClick={onClick} className="touch-hit flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-ink pointer-coarse:size-11" data-testid={testId}>
      <ChevronRight size={14} className={clsx('transition-transform motion-reduce:transition-none', !folded && 'rotate-90')} aria-hidden />
    </button>
  )
}
