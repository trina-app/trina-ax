// The phone's top bar (below 768 px): it says where you are and holds one action at most, each in one place.
//   트리나 (Home):  ☰ the AI's history (검색, 프로젝트, 예약 작업, 팀 스킬, 트리나 기록, 삭제한 기록) · the AI's name
//   대화 (/rooms):   its name · ⊕ a new conversation (the people list)
//   파일:            none (the Files page's own header is the bar)
//   a page under a tab (팀 스킬, 프로젝트, …): ‹ back · the page's name (the page keeps its heading for screen readers
//                    only, so the name is not said twice), in the bar every phone page uses (phone/PhonePageBar.tsx)
//   관리자 (/admin):  none here: Admin draws the same bar itself, with "‹ Admin" over its pages (admin/AdminLayout.tsx)
// Not in a room or an AI chat: their own header (with its ‹) is the bar there. ‹ goes back in the real history, or to
// the tab's list in place of this entry (lib/back.ts), so the phone's own back never loops. Every button is 44 px.
import clsx from 'clsx'
import { ChevronLeft, Menu, MessageCirclePlus } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useGoBack } from '../lib/back'
import { aiName, hidesTabs, pageTitleKey, START_TAB, TAB_ROOT, tabOf } from '../lib/tabs'
import { useAttention } from '../store/sessionMarkers'
import { useUi } from '../store/ui'
import { IconButton } from './ui'
import { PhonePageBar } from './phone/PhonePageBar'

const icon = 'size-11 shrink-0'

export function PhoneTopBar() {
  const t = useT()
  const navigate = useNavigate()
  const { pathname: path, search } = useLocation()
  const setDrawer = useUi((s) => s.setDrawer)
  const attention = useAttention()
  const tab = tabOf(path)
  const back = useGoBack(TAB_ROOT[tab ?? START_TAB])
  if (hidesTabs(path) || tab === 'files' || path === '/admin' || path.startsWith('/admin/')) return null
  // a project's new chat ("/?project=") is reached from the project: a way back there, not the history drawer
  const home = path === '/' && !new URLSearchParams(search).has('project')
  const rooms = path === '/rooms'
  const titleKey = pageTitleKey(path)
  const title = path === '/' ? aiName(t) : rooms ? t('tabs.chats') : titleKey ? t(titleKey) : ''
  if (!home && !rooms)
    return <PhonePageBar onBack={back} title={title} titleHidden={!!titleKey} backTestId="topbar-back" titleTestId="topbar-title" className="md:hidden" />
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1 md:hidden" data-testid="phone-topbar">
      {home ? (
        // a dot when an AI chat in the drawer wants me (session markers: a "?" or a new answer), amber when one is a "?";
        // the rooms' part of the count is the 대화 tab's own
        <IconButton label={attention.chats > 0 ? `${t('sidebar.open')} · ${t('marker.chats', { n: attention.chats })}` : t('sidebar.open')} onClick={() => setDrawer(true)} className={clsx(icon, 'relative')} data-testid="menu-open">
          <Menu size={20} />
          {attention.chats > 0 && <span className={clsx('absolute top-2 right-2 size-2.5 rounded-full ring-2 ring-canvas', attention.chatAsk ? 'bg-warn' : 'bg-accent')} aria-hidden data-testid="menu-dot" data-ask={attention.chatAsk ? '' : undefined} />}
        </IconButton>
      ) : rooms ? (
        <span className={icon} aria-hidden />
      ) : (
        <IconButton label={t('tabs.back')} onClick={back} className={icon} data-testid="topbar-back">
          <ChevronLeft size={22} />
        </IconButton>
      )}
      {/* a page with its own (screen-reader) heading: the name here is for the eye only */}
      <span aria-hidden={titleKey ? true : undefined} className="min-w-0 flex-1 truncate text-center text-sm font-semibold" data-testid="topbar-title">
        {title}
      </span>
      {rooms ? (
        <IconButton label={t('rooms.newChat')} onClick={() => navigate('/rooms?new=1', { replace: true })} className={icon} data-testid="topbar-new-dm">
          <MessageCirclePlus size={20} />
        </IconButton>
      ) : (
        <span className={icon} aria-hidden />
      )}
    </div>
  )
}
