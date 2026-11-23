// 트리나's list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1; docs/DECISIONS.md "The Trina
// list: pinned, recent"). A fixed block on top that never scrolls away, as ChatGPT's and Claude's sidebars have it:
// "트리나에게 묻기" (a new AI chat, ⇧⌘O; the one word for every AI action, §2.0), 검색 (⌘K), 예약 작업 and 팀 스킬
// (as the phone's drawer has them: phone/TrinaDrawer.tsx; 팀 스킬 with how many wait for my review, as a room's unread
// count: store/skillsWaiting.ts), then
// the owner's setup row while it shows (onboarding/SetupRow.tsx, on every panel: docs/DECISIONS.md W5). Under them, in
// its own scroll, the Trina list (panels/TrinaList.tsx: 답을 기다려요 · 고정 · 최근 기록; 삭제한 기록 is in 최근 기록's
// "⋯", rarely needed). The filter (status, last activity, group by, sort) is on the 트리나 기록 header, above the list it
// controls (docs/decisions/20261123-history-filter-place.md); TrinaList shows the filtered history there.
import { isGuestMe } from '../../lib/guests'
import { useMe } from '../../store/session'
import { useFreeRoam } from '../../store/demo'
import { BookMarked, CalendarClock, Search } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useT } from '../../i18n'
import { platform } from '../../lib/pwa'
import { badgeText } from '../../lib/rooms'
import { aiName } from '../../lib/tabs'
import { useSkillsWaiting } from '../../store/skillsWaiting'
import { useUi } from '../../store/ui'
import { useChatPeek } from '../nav/ChatItem'
import { useRecentsView } from '../nav/HistoryList'
import { CountPill } from '../CountPill'
import { TrinaList } from './TrinaList'
import { SetupRow } from '../onboarding/SetupRow'
import { AiMark } from '../rooms/AiFace'
import { PanelFrame, panelRow, panelRowActive } from './PanelFrame'

const onMac = () => platform() === 'mac' || platform() === 'ios'
const kbd = 'ml-auto hidden font-sans text-micro text-faint lg:inline'

export function TrinaPanel() {
  const t = useT()
  const guest = isGuestMe(useMe())
  // a free-roam demo: no scheduled tasks (server/src/demo/guard.ts refuses them as background work)
  const freeRoam = useFreeRoam()
  const waiting = useSkillsWaiting(!guest)
  const navigate = useNavigate()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const peek = useChatPeek()
  const view = useRecentsView()
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
          {/* scheduled tasks and the team's skills: not a guest's (components/GuestView.tsx) */}
          {!guest && (
            <>
              {!freeRoam && (
                <NavLink to="/scheduled" className={panelRowActive} data-testid="nav-scheduled">
                  <CalendarClock size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.scheduled')}</span>
                </NavLink>
              )}
              <NavLink to="/skills" className={panelRowActive} data-testid="nav-skills">
                <BookMarked size={16} className="text-muted" aria-hidden /> <span className="truncate">{t('sidebar.skills')}</span>
                {waiting > 0 && <CountPill text={badgeText(waiting)} label={t('skills.waitingReview', { n: waiting })} className="ml-auto" testId="nav-skills-count" />}
              </NavLink>
            </>
          )}
          <SetupRow />
        </>
      }
    >
      <TrinaList peek={peek} viewState={view} />
      {peek.card}
    </PanelFrame>
  )
}
