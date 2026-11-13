// The phone's top bar (below 768 px): it says where you are and holds one action at most, each in one place.
//   트리나 (/), 파일 (/files…): none here: 트리나's list and 파일's places draw their own bar
//                    (components/panels/PhoneTrinaHome.tsx, FilesPanel.tsx; pages/Files.tsx), as Admin does
//   a new chat (/new): ‹ back to the list (or to its project) · the AI's name
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
import { MessageCirclePlus, Search } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useGoBack } from '../lib/back'
import { useBackLabel } from '../lib/backStack'
import { activityInChats, parentOf, rootTab } from '../lib/screens'
import { stackNow } from '../lib/screenHistory'
import { aiName, hidesTabs, pageTitleKey, START_TAB, TAB_ROOT, tabOf } from '../lib/tabs'
import { useUi } from '../store/ui'
import { IconButton } from './ui'
import { PhonePageBar } from './phone/PhonePageBar'
import { PhoneBarSlot, usePhoneBarTitle } from './phone/PhoneBarAction'

const icon = 'size-11 shrink-0'

export function PhoneTopBar() {
  const t = useT()
  const navigate = useNavigate()
  const { pathname: path, search } = useLocation()
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const tab = tabOf(path)
  const up = parentOf(`${path}${search}`) ?? TAB_ROOT[tab ?? START_TAB]
  const back = useGoBack(up)
  const backLabel = useBackLabel(up, () => null)
  // a page's own name for the bar (one project's page: phone/PhoneBarAction.tsx PhoneBarTitle)
  const pageTitle = usePhoneBarTitle()
  // 트리나's list and 파일 draw their own bar, as Admin does (/new hides the tab bar, not this bar: its message box is at
  // the bottom, ‹ goes back to the list)
  if ((hidesTabs(path) && path !== '/new') || path === '/' || path === '/files' || path.startsWith('/files/') || path === '/admin' || path.startsWith('/admin/')) return null
  const rooms = path === '/rooms'
  // Activity opened from 대화's 멘션·스레드 row is that row's page (lib/screens.ts CHATS_ACTIVITY)
  const titleKey = path === '/activity' && activityInChats(search) ? 'feed.chats' : pageTitleKey(path)
  const title = path === '/new' ? aiName(t) : rooms ? t('tabs.chats') : titleKey ? t(titleKey) : ''
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
