// The phone's top bar (below 768 px): it says where you are and holds one action at most, each in one place.
//   트리나 (Home):  ☰ the AI's history (phone/TrinaDrawer.tsx: 검색, 예약 작업, 팀 스킬, 트리나 기록, 삭제한 기록), a
//                    dot on it when an AI chat wants me · the AI's name (as before the navigation redesign)
//   파일 (/files…):  none here: its places draw their own bar (FilesPanel.tsx; pages/Files.tsx), as Admin does
//   대화 (/rooms):   its name · 🔍 search on its rooms, people and messages (SearchDialog's 대화 type) · ⊕ a new
//                    conversation (the people list)
//   a page under a tab (팀 스킬, a project, …): ‹ back · the page's name (the page keeps its heading for screen readers
//                    only, so the name is not said twice), in the bar every phone page uses (phone/PhonePageBar.tsx);
//                    the page's one action on the right ("+", "Edit": phone/PhoneBarAction.tsx); a detail page that
//                    is named by its own name (one project) puts that name in the title (PhoneBarTitle)
//   관리자 (/admin):  none here: Admin draws the same bar itself, with "‹ Admin" over its pages (admin/AdminLayout.tsx)
// Not in a room or an AI chat: their own header (with its ‹) is the bar there. ‹ goes back in the real history, or to
// the page's parent (lib/screens.ts) in place of this entry (lib/back.ts), so the phone's own back never loops; it is
// named after where it goes ("‹ 트리나", "‹ 설정": lib/backStack.ts useBackLabel). Every button is 44 px.
import clsx from 'clsx'
import { Menu, MessageCirclePlus, Search } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useGoBack } from '../lib/back'
import { useBackLabel } from '../lib/backStack'
import { activityInChats, parentOf, rootTab } from '../lib/screens'
import { stackNow } from '../lib/screenHistory'
import { aiName, hidesTabs, pageTitleKey, START_TAB, TAB_ROOT, tabOf } from '../lib/tabs'
import { useAttention } from '../store/sessionMarkers'
import { useUi } from '../store/ui'
import { useTrinaDrawer } from './phone/TrinaDrawer'
import { IconButton } from './ui'
import { PhonePageBar } from './phone/PhonePageBar'
import { PhoneBarSlot, usePhoneBarTitle } from './phone/PhoneBarAction'

const icon = 'size-11 shrink-0'

export function PhoneTopBar() {
  const t = useT()
  const navigate = useNavigate()
  const { pathname: path, search } = useLocation()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const setDrawer = useTrinaDrawer((s) => s.setOpen)
  const attention = useAttention()
  const tab = tabOf(path)
  const up = parentOf(`${path}${search}`) ?? TAB_ROOT[tab ?? START_TAB]
  const back = useGoBack(up)
  const backLabel = useBackLabel(up, () => null)
  // a page's own name for the bar (one project's page: phone/PhoneBarAction.tsx PhoneBarTitle)
  const pageTitle = usePhoneBarTitle()
  // 파일 draws its own bar, as Admin does
  if (hidesTabs(path) || path === '/files' || path.startsWith('/files/') || path === '/admin' || path.startsWith('/admin/')) return null
  // a project's new chat ("/?project=") is reached from the project: a way back there, not the history drawer
  const home = path === '/' && !new URLSearchParams(search).has('project')
  if (home)
    return (
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1 md:hidden" data-testid="phone-topbar">
        {/* a dot when an AI chat in the drawer wants me (session markers: a "?" or a new answer), amber when one is a "?" */}
        <IconButton label={attention.chats > 0 ? `${t('sidebar.open')} · ${t('marker.chats', { n: attention.chats })}` : t('sidebar.open')} onClick={() => setDrawer(true)} className={clsx(icon, 'relative')} data-testid="menu-open">
          <Menu size={20} />
          {attention.chats > 0 && <span className={clsx('absolute top-2 right-2 size-2.5 rounded-full ring-2 ring-canvas', attention.chatAsk ? 'bg-warn' : 'bg-accent')} aria-hidden data-testid="menu-dot" data-ask={attention.chatAsk ? '' : undefined} />}
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold" data-testid="topbar-title">
          {aiName(t)}
        </span>
        {/* as wide as ☰, so the name stays in the middle */}
        <span className="w-11 shrink-0" aria-hidden />
      </div>
    )
  const rooms = path === '/rooms'
  // Activity opened from 대화's 멘션·스레드 row is that row's page (lib/screens.ts CHATS_ACTIVITY)
  const titleKey = path === '/activity' && activityInChats(search) ? 'feed.chats' : pageTitleKey(path)
  const title = path === '/' ? aiName(t) : rooms ? t('tabs.chats') : titleKey ? t(titleKey) : ''
  // a tab's own list at the bottom of its stack: no ‹, it is where the tab starts (the list opened on top of another
  // tab's screens, from search, keeps its ‹ back there)
  const root = !!rootTab(`${path}${search}`) && !stackNow()?.below
  if (!rooms)
    return <PhonePageBar onBack={root ? undefined : back} backLabel={backLabel} title={pageTitle ?? title} titleHidden={!!titleKey} action={<PhoneBarSlot />} backTestId="topbar-back" titleTestId="topbar-title" className="md:hidden" />
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1 md:hidden" data-testid="phone-topbar">
      {/* as wide as the two buttons on the right and the gap between them, so the name stays in the middle */}
      <span className="w-23 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold" data-testid="topbar-title">
        {title}
      </span>
      <IconButton label={t('rooms.search')} onClick={() => setSearchOpen(true, 'rooms')} className={icon} data-testid="topbar-search">
        <Search size={20} />
      </IconButton>
      <IconButton label={t('rooms.newChat')} onClick={() => navigate('/rooms?new=1', { replace: true })} className={icon} data-testid="topbar-new-dm">
        <MessageCirclePlus size={20} />
      </IconButton>
    </div>
  )
}
