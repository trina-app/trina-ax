// 트리나's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1). On
// top "트리나에게 묻기" (a new AI chat, ⇧⌘O; the one word for every AI action, §2.0) and 검색 (⌘K),
// then the owner's setup row while it shows (onboarding/SetupRow.tsx, on every panel: docs/DECISIONS.md W5). Under them
// the Trina list in its own order with the server's heads (panels/TrinaList.tsx: 고정 · 폴더 · 프로젝트 · 모든
// 프로젝트 · 기타 기록), and at its end the quiet rows 예약 작업,
// 팀 스킬 and 삭제한 기록, pinned under the list so they never sink under the projects. The header's filter button (status, last activity, group by, sort)
// shows the whole history filtered instead (nav/HistoryList.tsx, the chats this window has loaded and "더 보기"), with
// one line that says what is filtered and a way back.
import { BookMarked, CalendarClock, Search, Trash2, X } from 'lucide-react'
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
import { PanelFrame, panelRow, panelRowActive } from './PanelFrame'

const onMac = () => platform() === 'mac' || platform() === 'ios'
const kbd = 'ml-auto hidden font-sans text-micro text-faint lg:inline'
const noop = () => {}

export function TrinaPanel() {
  const t = useT()
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
      // pinned under the list: 삭제한 기록 never waits at the end of a long list (UX review S2)
      bottom={
        <div className="space-y-0.5" data-testid="trina-panel-more">
          <NavLink to="/scheduled" className={panelRowActive} data-testid="nav-scheduled">
            <CalendarClock size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.scheduled')}</span>
          </NavLink>
          <NavLink to="/skills" className={panelRowActive} data-testid="nav-skills">
            <BookMarked size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.skills')}</span>
          </NavLink>
          <NavLink to="/trash" className={panelRowActive} data-testid="nav-trash">
            <Trash2 size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.trash')}</span>
          </NavLink>
        </div>
      }
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
          <SetupRow />
        </>
      }
    >
      {filtered ? (
        <>
          <div className="flex h-8 items-center gap-1 pr-1 pl-3 text-xs text-faint" data-testid="recents-filter-label">
            <span className="min-w-0 flex-1 truncate">{viewWords(view, t)}</span>
            <Tooltip label={t('sidebar.filter.clear')}>
              <button type="button" onClick={() => view.setView(DEFAULT_RECENTS_VIEW)} aria-label={t('sidebar.filter.clear')} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-hover hover:text-ink" data-testid="recents-filter-clear">
                <X size={12} aria-hidden />
              </button>
            </Tooltip>
          </div>
          <HistoryList onNavigate={noop} peek={peek} viewState={view} />
        </>
      ) : (
        <TrinaList peek={peek} />
      )}
      {peek.card}
    </PanelFrame>
  )
}
