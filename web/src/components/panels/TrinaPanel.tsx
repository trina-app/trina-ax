// 트리나's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1; docs/DECISIONS.md "The Trina
// list: pinned, recent"). A fixed block on top that never scrolls away, as ChatGPT's and Claude's sidebars have it:
// "트리나에게 묻기" (a new AI chat, ⇧⌘O; the one word for every AI action, §2.0), 검색 (⌘K), 예약 작업 and 팀 스킬
// (as the phone's drawer has them: phone/TrinaDrawer.tsx), then
// the owner's setup row while it shows (onboarding/SetupRow.tsx, on every panel: docs/DECISIONS.md W5). Under them, in
// its own scroll, the Trina list (panels/TrinaList.tsx: 답을 기다려요 · 고정 · 최근 기록; 삭제한 기록 is in 최근 기록's
// "⋯", rarely needed). The header's filter button (status, last activity, group by, sort; Group by defaults to None,
// the flat list: docs/DECISIONS.md "Trina history: Group by defaults to None") shows the whole history filtered instead
// (nav/HistoryList.tsx, the chats this window has loaded and "더 보기"; "Group by: Project" by hand groups it with the
// caps of "Trina history by project"), with one line that says what is filtered and a way back.
import { isGuestMe } from '../../lib/guests'
import { useMe } from '../../store/session'
import { BookMarked, CalendarClock, Search, X } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useT } from '../../i18n'
import { platform } from '../../lib/pwa'
import { aiName } from '../../lib/tabs'
import { useUi } from '../../store/ui'
import { useChatPeek } from '../nav/ChatItem'
import { HistoryList, RecentsMenu, useRecentsView, viewWords, DEFAULT_RECENTS_VIEW } from '../nav/HistoryList'
import { Tooltip } from '../Tooltip'
import { TrinaList } from './TrinaList'
import { SetupRow } from '../onboarding/SetupRow'
import { AiMark } from '../rooms/AiFace'
import { headBox } from '../list/List'
import { PanelFrame, panelRow, panelRowActive } from './PanelFrame'

const onMac = () => platform() === 'mac' || platform() === 'ios'
const kbd = 'ml-auto hidden font-sans text-micro text-faint lg:inline'
const noop = () => {}
/** "Group by: Project" chosen by hand: five projects, three rows each (docs/DECISIONS.md "Trina history by project") */
const GROUP_CAPS = { projects: 5, rows: 3 }

export function TrinaPanel() {
  const t = useT()
  const guest = isGuestMe(useMe())
  const navigate = useNavigate()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const peek = useChatPeek()
  const view = useRecentsView()
  const filtered = view.changed.length > 0
  return (
    <PanelFrame
      title={aiName(t)}
      testId="trina-panel"
      onScroll={peek.hide}
      actions={<RecentsMenu view={view.view} onChange={view.setView} changed={filtered} />}
      top={
        <>
          <button type="button" className={`${panelRow} font-medium`} onClick={() => navigate('/')} data-testid="new-chat">
            <AiMark place="nav" /> <span className="truncate">{t('sidebar.askAi', { name: aiName(t) })}</span>
            <kbd className={kbd}>{onMac() ? '⇧⌘O' : 'Ctrl+Shift+O'}</kbd>
          </button>
          <button type="button" className={panelRow} aria-keyshortcuts={onMac() ? 'Meta+K' : 'Control+K'} onClick={() => setSearchOpen(true)} data-testid="nav-search">
            <Search size={16} aria-hidden /> {t('sidebar.search')}
            <kbd className={kbd}>{onMac() ? '⌘K' : 'Ctrl+K'}</kbd>
          </button>
          {/* scheduled tasks and the team's skills: not a guest's (components/GuestView.tsx) */}
          {!guest && (
            <>
              <NavLink to="/scheduled" className={panelRowActive} data-testid="nav-scheduled">
                <CalendarClock size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.scheduled')}</span>
              </NavLink>
              <NavLink to="/skills" className={panelRowActive} data-testid="nav-skills">
                <BookMarked size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.skills')}</span>
              </NavLink>
            </>
          )}
          <SetupRow />
        </>
      }
    >
      {filtered ? (
        <>
          <div className={`${headBox} pr-1 pl-3 text-meta text-faint`} data-testid="recents-filter-label">
            <span className="min-w-0 flex-1 truncate">{viewWords(view, t)}</span>
            <Tooltip label={t('sidebar.filter.clear')}>
              <button type="button" onClick={() => view.setView(DEFAULT_RECENTS_VIEW)} aria-label={t('sidebar.filter.clear')} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                <X size={12} aria-hidden />
              </button>
            </Tooltip>
          </div>
          <HistoryList onNavigate={noop} peek={peek} viewState={view} caps={GROUP_CAPS} />
        </>
      ) : (
        <TrinaList peek={peek} />
      )}
      {peek.card}
    </PanelFrame>
  )
}
