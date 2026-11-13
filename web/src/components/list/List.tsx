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
import { useId, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { useFolds } from '../panels/folds'
import { MenuButton, useRowMenu, type MenuItem } from '../rooms/MenuButton'

/** A row's name: unread or selected semibold in ink; otherwise the read look (a panel on a computer: muted 400; a phone
 * and a page's main list, `page`: ink 400) */
export const rowName = ({ unread = false, selected = false, page = false }: { unread?: boolean; selected?: boolean; page?: boolean } = {}) =>
  clsx('text-row', unread || selected ? 'font-semibold text-ink' : page ? 'font-normal text-ink' : 'font-row-read text-row-read')

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
type RowLi = Omit<HTMLAttributes<HTMLLIElement>, 'children'> & RowLink & { ref?: Ref<HTMLLIElement> }

/** A row's "···" (`rowMenu`): the shared menu (rooms/MenuButton.tsx) at the row's right, shown on hover or keyboard focus
 * on a computer and always on a phone; a right-click on the row and a long press on a touch screen open it too */
export interface RowMenu {
  items: MenuItem[]
  /** the button's name ("<title> 메뉴") */
  label: string
  tip?: string
  /** a phone's sheet's title (the row's name) */
  sheetTitle?: string
  testId?: string
  buttonRef?: RefObject<HTMLButtonElement | null>
}

/** A row's trailing tag (a chat's project, a task's last run): 13px and faint at the row's right, every row's at the
 * same edge; it keeps its words up to 40% of the row and the name is cut first */
/** A row's height (index.css --spacing-row-min): 30px on a computer, 48px on a phone, never under 44px on a touch
 * screen. Every list row's box takes it (ListRow; a panel's fixed rows, PanelFrame panelRowBox; a room's row) */
export const rowBox = 'min-h-row-min pointer-coarse:min-h-[max(2.75rem,var(--spacing-row-min))]'
/** A section header's row (ListSection; a group of the filtered history, history/HistoryGroups.tsx): the rows' 30px on
 * a computer, 44px to tap on a phone and a touch screen */
export const headBox = 'flex h-row items-center gap-1 pointer-coarse:min-h-11 max-md:min-h-11'
/** A page's main list's row (ListRow `scale="page"`: a project's 트리나 기록, 팀 스킬's skills; docs/DECISIONS.md "Page
 * lists: page density"): 48px on a computer and a phone (index.css --spacing-row-page), not the panels' 30px, and its
 * words flush with the section's heading, the hover fill reaching out past them (`pageBleed`: the row's own 12px
 * inset as a negative margin), so the list sits in the page's column as its heading and text do. A phone (below
 * 768px) bleeds on the left only: its right keeps the page's gutter, so a row's "···" and `actions` end where the
 * content above them ends (a page's switch, a heading's action), 16px from the screen's edge, not on it (QA TC-1040) */
export const pageRowBox = 'min-h-row-page'
const pageBleed = '-mx-3 w-[calc(100%+1.5rem)] max-md:mr-0 max-md:w-[calc(100%+0.75rem)]'

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
 * member picker): a click anywhere on it ticks it. `rowMenu`: the row's own "···" with right-click and long press
 * (RowMenu). `actions`: buttons beside the row's click area, outside its link (a skill's 실행): the row's words end
 * before them. `rowRef`: the link's or button's element; `rowTitle`: its tooltip. `strong`: the name in ink at medium weight whether read or not
 * (a list of things to pick from, not of things to read: skills). `li`: the <li>'s ref, handlers, className, data-* and
 * aria-*. `scale`: "panel" (the default: the rail's panels, the phone tabs, the drawer, a dialog's list) or "page" for
 * a page's main list (pageRowBox): taller, flush with its heading, read names in ink; its "···" and `actions` move out
 * with the row, so the times and tags still end at one edge.
 */
export function ListRow({ expanded, to, state, onClick, icon, lead, name, nameTitle, meta, end, tag, tagTitle, tagTestId, menu, menuSpace, choice, rowMenu, actions, rowRef, rowTitle, strong, scale = 'panel', unread, selected, wrap, disabled, face, testId, nameTestId, metaTestId, link, li, rowClass, onFocus, onBlur, onKeyDown }: {
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
  rowMenu?: RowMenu
  actions?: ReactNode
  rowRef?: Ref<HTMLElement>
  /** the whole row's tooltip (a skill's description) */
  rowTitle?: string
  strong?: boolean
  scale?: 'panel' | 'page'
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
  /** a button row that opens and closes what follows it (the trash's copies of one file): its aria-expanded */
  expanded?: boolean
}) {
  const page = scale === 'page'
  const cls = clsx(
    // a touch screen: at least 44px to tap, or the list's own least height where that is more (a phone: 48px)
    'flex gap-2.5 rounded-lg px-3 text-left focus-visible:-outline-offset-2',
    // a page's list: the row's inset outside the column (with `actions`, only on the left: they take the right's)
    page ? [pageRowBox, actions ? '-ml-3' : pageBleed] : [rowBox, 'w-full'],
    (to || onClick || choice) && !disabled && 'hover:bg-hover',
    choice && 'cursor-pointer has-[:disabled]:opacity-60',
    meta ? 'items-start py-1.5 max-md:items-center max-md:py-2' : face ? 'items-center py-1' : 'items-center',
    selected && 'bg-hover',
    // the "···" (28px on a computer, 44px on a phone) at the row's right: the words end before it
    (menu || menuSpace || rowMenu) && 'pr-9 max-md:pr-11',
    actions && 'min-w-0 flex-1',
    rowClass,
  )
  const body = (
    <>
      {icon && <ListIcon face={face} className={meta ? (face ? 'self-center' : 'mt-0.5 max-md:mt-0') : undefined}>{icon}</ListIcon>}
      {lead && <span className="-mr-1 flex shrink-0 items-center gap-1 self-center">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className={clsx(wrap ? 'line-clamp-2 break-words' : 'block truncate', strong ? 'text-row font-medium text-ink' : rowName({ unread, selected, page }))} title={nameTitle} data-testid={nameTestId}>
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
  const { ref: liRef, className: liClass, ...liRest } = li ?? {}
  // the row's menu: a right-click and a long press open it (its handlers on the <li>), and the finger lifting after a
  // long press opens nothing (guard)
  const rm = useRowMenu()
  const click = rowMenu
    ? (e: MouseEvent<HTMLElement>) => {
        rm.guard(e)
        if (!e.defaultPrevented) onClick?.(e)
      }
    : onClick
  const events = { onFocus, onBlur, onKeyDown }
  const box = choice ? (
    <label ref={rowRef as Ref<HTMLLabelElement>} title={rowTitle} className={cls} data-testid={testId} {...link}>
      {body}
    </label>
  ) : to ? (
    <Link ref={rowRef as Ref<HTMLAnchorElement>} title={rowTitle} to={to} state={state} onClick={click} aria-current={selected ? 'page' : undefined} className={cls} data-testid={testId} {...events} {...link}>
      {body}
    </Link>
  ) : onClick || rowMenu ? (
    <button ref={rowRef as Ref<HTMLButtonElement>} title={rowTitle} type="button" onClick={click} disabled={disabled} aria-expanded={expanded} className={cls} data-testid={testId} {...events} {...link}>
      {body}
    </button>
  ) : (
    // neither: a row that opens nothing (a scheduled run that did not start has no chat), no hover
    <div ref={rowRef as Ref<HTMLDivElement>} title={rowTitle} className={cls} data-testid={testId} {...link}>
      {body}
    </div>
  )
  return (
    <li
      ref={liRef}
      className={clsx((menu || end || rowMenu || actions) && 'group', (menu || menuSpace || rowMenu) && 'relative', actions && 'flex items-center gap-1', liClass) || undefined}
      // a caller's own pointer or context-menu handlers on the <li> take the place of the row menu's: give one or the other
      {...(rowMenu ? rm.row : {})}
      {...liRest}
    >
      {box}
      {/* a page's list: out to the fill's edge on a computer; a phone keeps the page's gutter (pageBleed) */}
      {actions && <span className={clsx('flex shrink-0 items-center gap-1', page && '-mr-3 max-md:mr-0')}>{actions}</span>}
      {menu}
      {rowMenu && (
        // 28 px on a computer (WCAG 2.2 target size: it sits on the row), 44 px on a phone
        <MenuButton
          label={rowMenu.label}
          tip={rowMenu.tip}
          items={rowMenu.items}
          sheetTitle={rowMenu.sheetTitle}
          buttonRef={rowMenu.buttonRef}
          // a page's list: as far out as the row's fill reaches (pageBleed), the same 4px in from its edge; a phone: at
          // the content's right edge, the page's gutter kept
          className={clsx('absolute inset-y-0 flex items-center', page ? '-right-2 max-md:right-0' : 'right-1 max-md:right-0')}
          buttonClassName="touch-hit hover:bg-surface max-md:size-11 pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
          openSignal={rm.openSignal}
          openRequest={rm.openRequest}
          testId={rowMenu.testId}
        />
      )}
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
