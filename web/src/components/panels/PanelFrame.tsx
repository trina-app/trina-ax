// The list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): one list at a time, the place's
// name on top with its own buttons, then the list in its own scroll. 288 px at 1440, 256 px at 1280, 240 px at 1200 and
// below, never more than 300 px at a large text size (wider than before for the 15 px rows: docs/DECISIONS.md "Panels:
// Slack-sized type"). Below 1052 px its header has "목록 숨기기" (rail/railPanel.ts); the rail then
// shows the button that brings it back. A <nav> named by its title; the skip link "목록으로" lands on it (Layout.tsx).
import clsx from 'clsx'
import { PanelLeftClose } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { IconButton, useMediaQuery } from '../ui'
import { PANEL_ALWAYS_PX, useRailPanel } from '../rail/railPanel'
import { rowBox } from '../list/List'

export const PANEL_ID = 'rail-panel'

/** `bottom`: rows that stay under the list, never scrolled away (트리나's 예약 작업 · 팀 스킬 · 삭제한 기록) */
export function PanelFrame({ title, actions, top, children, bottom, onScroll, testId }: { title: ReactNode; actions?: ReactNode; top?: ReactNode; children: ReactNode; bottom?: ReactNode; onScroll?: () => void; testId: string }) {
  const t = useT()
  const id = useId()
  const wide = useMediaQuery(`(min-width: ${PANEL_ALWAYS_PX}px)`)
  // the list is scrolled away from its top: a hairline under the rows above it
  const [scrolled, setScrolled] = useState(false)
  return (
    <nav id={PANEL_ID} tabIndex={-1} aria-labelledby={id} className="flex h-full w-[clamp(240px,min(18rem,20vw),300px)] shrink-0 flex-col border-r border-line bg-subtle outline-none" data-testid={testId}>
      {/* a touch screen (a tablet across, a touch laptop): the header's buttons are 44 px to tap, as the rail's */}
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4 pointer-coarse:[&_:is(a,button)]:min-h-11 pointer-coarse:[&_:is(a,button)]:min-w-11">
        <h2 id={id} className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-ink" data-testid="panel-title">
          {title}
        </h2>
        {actions}
        {!wide && (
          <IconButton label={t('rail.hideList')} onClick={() => useRailPanel.getState().setHidden(true)} data-testid="panel-hide">
            <PanelLeftClose size={16} aria-hidden />
          </IconButton>
        )}
      </div>
      {top && <div className="shrink-0 space-y-0.5 px-2 pb-2 empty:hidden">{top}</div>}
      {/* a touch screen: the list's rows (chats, rooms, folders: nav/ChatItem.tsx, nav/RoomsList.tsx) are 44 px to tap */}
      <div
        className={clsx('scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-2 pt-2 pb-2 pointer-coarse:[&_li>a]:min-h-11', scrolled ? 'border-line' : 'border-transparent')}
        onScroll={(e) => {
          onScroll?.()
          setScrolled(e.currentTarget.scrollTop > 0)
        }}
        data-testid="panel-scroll"
      >
        {children}
      </div>
      {bottom && <div className="shrink-0 space-y-0.5 border-t border-line px-2 py-2">{bottom}</div>}
    </nav>
  )
}

/** a panel row's box with no size or colour (index.css "list panels"): a ListRow's height (rowBox: 30 px, 48 px on a
 * phone, 44 px or more on a touch screen), a 16 px icon, the words; for a row that sets its own (a quiet row in
 * `text-meta text-muted`, a place row read or open) */
export const panelRowBox = `flex ${rowBox} w-full items-center gap-2.5 rounded-lg px-3 text-left hover:bg-hover focus-visible:-outline-offset-2`
/** a row at the top of a panel (트리나에게 묻기, 검색, 예약 작업, 팀 스킬; 새 프로젝트): 15 px in ink, as the list's rows */
export const panelRow = `${panelRowBox} text-row text-ink`
export const panelRowActive = ({ isActive }: { isActive: boolean }) => clsx(panelRow, isActive && 'bg-hover font-semibold')
/* The panels' three levels (docs/DECISIONS.md "Panels: three levels you can tell apart", "Panels: Slack-sized type"; the
 * owner, 2026-11-13: "위계가 안 보여", then "글자가 너무 작아"): a section's header (PanelSection: the rows' 15 px,
 * semibold in ink, space above it, a ▸ on its left that folds it, its rows indented under its words), a group's header
 * inside a section (a folder: groupHead, a ▸ on its left, the name in ink and medium weight, a hover), and the rows,
 * indented under their group with a faint line down its left (groupRows), as a file tree draws it, so the eye sees
 * where a group ends. */

/** A group's header row (a folder): the ▸ fold button, its icon and name; `relative` for the "⋯" at its right */
export const groupHead = 'group/head relative flex h-row items-center gap-1 rounded-md pr-2 pl-0.5 text-row font-medium text-ink hover:bg-hover pointer-coarse:min-h-11 max-md:min-h-11'
/** A group's rows: indented under the header's ▸ with a faint guide line, a small gap after the group */
export const groupRows = 'mb-1.5 ml-[15px] border-l border-line pl-1.5'
/** The section, its header and the group's ▸ are the lists' own (components/list/List.tsx), under the names the panels
 * have always used */
export { GroupChevron, ListSection as PanelSection } from '../list/List'
