// 트리나's tab on a phone with the new navigation (the server's `navRail` switch; docs/DECISIONS.md "Phone tabs: 트리나 ·
// 대화 · 파일 · 나", the plan's option B): the Trina list first, the same list and order as the computer's 트리나 panel
// (panels/TrinaList.tsx: 고정 · 폴더 · 프로젝트 · 모든 프로젝트 · 기타 기록, then 예약 작업 · 팀 스킬 · 삭제한 기록 as quiet
// rows at the end), so going back to yesterday's chat is one tap. On top the owner's setup row while it shows. The bar:
// "트리나", 🔍 (search: chats, files and the rest, as ⌘K) and the filter (status, last activity, group by, sort: the
// filtered history in place of the list, with one line that says what is filtered and a way back). No status chips
// ("답이 필요해요" is in the filter). A new chat is the floating "트리나에게 묻기" at the bottom right, which opens the
// new-chat box on its own page (/new, lib/newChat.ts); the list keeps room under its last row so the button never covers
// one. The ☰ drawer is gone: everything it held is in this list or under 나.
// Above the list, the one card Home has at its top while it waits (the same order as pages/Home.tsx): the owner's lead
// link card, else an invited person's welcome card, else the "no AI answers you" card.
import { BookMarked, CalendarClock, Search, Trash2, X } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useT } from '../../i18n'
import { newChatPath } from '../../lib/newChat'
import { aiName } from '../../lib/tabs'
import { useUi } from '../../store/ui'
import { useAiAccess } from '../../store/aiAccess'
import { isOwner, useMe } from '../../store/session'
import { useMemberWelcome } from '../../store/memberWelcome'
import { HandoverCard, useLeadCard } from '../handover/HandoverCard'
import { NoAiCard } from '../onboarding/ConnectAi'
import { MemberWelcomeCard } from '../onboarding/MemberWelcome'
import { useChatPeek } from '../nav/ChatItem'
import { DEFAULT_RECENTS_VIEW, HistoryList, RecentsMenu, useRecentsView, viewWords } from '../nav/HistoryList'
import { SetupRow } from '../onboarding/SetupRow'
import { PhonePageBar } from '../phone/PhonePageBar'
import { AiMark } from '../rooms/AiFace'
import { IconButton } from '../ui'
import { panelRow } from './PanelFrame'
import { TrinaList } from './TrinaList'

const noop = () => {}

export function PhoneTrinaHome() {
  const t = useT()
  const navigate = useNavigate()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const peek = useChatPeek()
  const view = useRecentsView()
  const filtered = view.changed.length > 0
  const quiet = `${panelRow} h-11 text-muted`
  return (
    <div className="relative flex h-full flex-col" data-testid="phone-trina-home">
      <PhonePageBar
        title={aiName(t)}
        heading
        backTestId="phone-trina-back"
        titleTestId="topbar-title"
        action={
          <span className="flex items-center">
            <IconButton label={t('sidebar.search')} onClick={() => setSearchOpen(true)} className="size-11 shrink-0" data-testid="topbar-search">
              <Search size={20} />
            </IconButton>
            <RecentsMenu view={view.view} onChange={view.setView} changed={filtered} always />
          </span>
        }
      />
      {/* the list in its own scroll; room under the last row for the floating button (56 px and its 16 px margin) */}
      <nav aria-label={aiName(t)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-24" data-testid="phone-trina-list">
        <SetupRow />
        <ListTopCard />
        {filtered ? (
          <>
            <div className="flex h-10 items-center gap-1 pr-1 pl-3 text-xs text-faint" data-testid="recents-filter-label">
              <span className="min-w-0 flex-1 truncate">{viewWords(view, t)}</span>
              <IconButton label={t('sidebar.filter.clear')} onClick={() => view.setView(DEFAULT_RECENTS_VIEW)} className="size-11 shrink-0" data-testid="recents-filter-clear">
                <X size={14} aria-hidden />
              </IconButton>
            </div>
            <HistoryList caps={null} onNavigate={noop} peek={peek} viewState={view} bare />
          </>
        ) : (
          <TrinaList peek={peek} />
        )}
        <div className="mt-3 space-y-0.5 border-t border-line pt-2" data-testid="trina-panel-more">
          <Link to="/scheduled" className={quiet} data-testid="nav-scheduled">
            <CalendarClock size={16} aria-hidden /> <span className="truncate">{t('sidebar.scheduled')}</span>
          </Link>
          <Link to="/skills" className={quiet} data-testid="nav-skills">
            <BookMarked size={16} aria-hidden /> <span className="truncate">{t('sidebar.skills')}</span>
          </Link>
          <Link to="/trash" className={quiet} data-testid="nav-trash">
            <Trash2 size={16} aria-hidden /> <span className="truncate">{t('sidebar.trash')}</span>
          </Link>
        </div>
      </nav>
      <button
        type="button"
        onClick={() => navigate(newChatPath())}
        className="absolute right-4 bottom-4 z-10 flex h-14 max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-ink pr-5 pl-4 text-[0.9375rem] font-medium text-canvas shadow-lg active:opacity-90"
        data-testid="new-chat"
      >
        <AiMark place="nav" />
        <span className="truncate">{t('sidebar.askAi', { name: aiName(t) })}</span>
      </button>
    </div>
  )
}

/** The one card above the list (see the top of this file), or nothing. */
function ListTopCard() {
  const lead = useLeadCard(true)
  const welcome = useMemberWelcome((s) => s.welcome)
  const ai = useAiAccess()
  // the owner's setup row says "AI 연결하기" already (onboarding/SetupRow.tsx): no second card for it
  const owner = isOwner(useMe())
  useEffect(() => {
    void useMemberWelcome.getState().load()
    void useAiAccess.getState().load()
  }, [])
  const card = lead ? <HandoverCard card={lead} /> : welcome ? <MemberWelcomeCard welcome={welcome} /> : ai.loaded && !ai.usable && !owner ? <NoAiCard /> : null
  return card ? <div className="mb-3 px-1" data-testid="phone-trina-card">{card}</div> : null
}
