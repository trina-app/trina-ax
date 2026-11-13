// 트리나's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P1; behind the server's
// `navRail` switch). On top "트리나에게 묻기" (a new AI chat, ⇧⌘O; the one word for every AI action, §2.0) and 검색 (⌘K),
// then the owner's setup row while it shows (onboarding/SetupRow.tsx, on every panel: docs/DECISIONS.md W5). Under them
// today's Trina history as the old sidebar shows it (nav/HistoryList.tsx with its caps: pins, the latest projects, "모두
// 보기"; phase P2 brings the final order and server counts), and at its end the quiet rows that were sidebar rows:
// 프로젝트 (all projects), 예약 작업, 팀 스킬 and 삭제한 기록 (before: the account menu's).
import { BookMarked, CalendarClock, FolderKanban, Search, Trash2 } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useT } from '../../i18n'
import { platform } from '../../lib/pwa'
import { aiName } from '../../lib/tabs'
import { useUi } from '../../store/ui'
import { useChatPeek } from '../nav/ChatItem'
import { HistoryList, SIDEBAR_HISTORY_CAPS } from '../nav/HistoryList'
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
  return (
    <PanelFrame
      title={aiName(t)}
      testId="trina-panel"
      onScroll={peek.hide}
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
      <HistoryList caps={SIDEBAR_HISTORY_CAPS} onNavigate={noop} peek={peek} />
      {peek.card}
      <div className="mt-3 space-y-0.5 border-t border-line pt-2" data-testid="trina-panel-more">
        <NavLink to="/projects" className={panelRowActive} data-testid="nav-projects">
          <FolderKanban size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.projects')}</span>
        </NavLink>
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
    </PanelFrame>
  )
}
