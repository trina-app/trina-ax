// Left sidebar, sized like Claude's (280 px, 14 px rows of 36 px, 16 px icons; all but the icons grow with the text size), people first (docs/DECISIONS.md "Desktop
// sidebar: rooms first"): the team on top and me at the bottom (docs/DECISIONS.md "The team menu"). On top the team's
// logo and name (TeamMenu.tsx: for owners and admins a button with ▾ that opens the team menu: the team's address,
// "Invite people" and Admin), then one labeled row each (the owner, 2026-11-07: no icon row): "트리나에게 묻기" (a new
// AI chat, ⇧⌘O; it is also the way Home), 검색 (⌘K), 프로젝트, 예약 작업, 알림함 (its count on the row), 파일 and 팀 스킬;
// then one scroll with two strictly capped sections: "대화" (rooms/SidebarRooms.tsx: the
// five latest rooms and the room on screen, "더 보기 (N)" for the rest with what is unread there) and "트리나 기록" (the
// AI's history by project, history/HistoryGroups.tsx and docs/DECISIONS.md "Trina history by project": the five
// projects with the latest activity and the chats in no project last, three rows each with "N more", a group folding
// under its ▾; without a chat in a project the five latest and the chat on screen, as before; "모두 보기" for the whole
// of it with its filters, with "답 필요 K" when hidden chats show a "?" or a dot; one session marker per row from the chat
// list itself, chat/ChatState.tsx: "?", a spinner or a dot), so the AI never sinks under many rooms. Onboarding's setup row (onboarding/SetupRow.tsx) has its
// own row between the two. People and the AI never share a word: no bare "채팅" here. Each folds, and each one's whole
// list stays open or closed, remembered in this browser. Then the account menu (the person's email or ID, Settings,
// Usage (their own, in Settings), Deleted history, Sign out), which opens above the profile line. Below
// 768 px it is the 트리나 tab's drawer, the AI's history only (☰ in the phone's top bar on Home): the AI's name on top
// (not the team menu: the drawer belongs to the AI's tab), 검색, 예약 작업, 팀 스킬, 트리나 기록, and 삭제한 기록 at the
// bottom. Connectors is not here: a person connects a service once and rarely comes back, so it is a section of Settings
// (설정 › 커넥터, the account menu's Settings; on a phone the 나 tab), like Claude's (docs/DECISIONS.md "Connectors in
// Settings"). A new AI chat is the 트리나 tab itself, the Inbox and Admin are in the 나 tab, the projects and the team
// folder are the 프로젝트 tab (QA TC-255: each thing in one place) and the rooms are the 대화 tab; rows are 44 px there.
// A shared project chat I made or wrote in (docs/DECISIONS.md "Shared project chats") is a row like any other, with the
// people icon before its title (no section of its own); its "···" offers only what I may do there. A chat of my own has
// "프로젝트로 옮기기…" ("프로젝트 바꾸기…" in a project) there too, the dialog of the chat's title menu; a shared chat stays
// in its project. Every row's "···" has "상단에 고정" / "고정 해제" (docs/DECISIONS.md "Pinned chats"): my pinned chats
// come first, the most recently pinned first, with a pin before the title and no header of their own; on a computer at
// most ten of them above the five latest (or the projects), all of them in "모두 보기" and in the phone's drawer.
// The pieces are reusable lists in components/nav/ (navigation redesign, docs/AGENTS/plan/20261112-1839-nav-rail.md,
// phase P0b): MenuRows / PhoneMenuRows, HistoryList (caps as a prop: SIDEBAR_HISTORY_CAPS here), ChatItem, AccountMenu;
// the rooms are rooms/SidebarRooms.tsx around nav/RoomsList.tsx. This file places them and keeps what is the column's
// own: the hover peek (one per column), the scroll's hairline and the phone drawer's status and Deleted history rows.
import clsx from 'clsx'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { aiName } from '../lib/tabs'
import { useT } from '../i18n'
import { useInboxUnread } from '../store/inbox'
import { useUi } from '../store/ui'
import { MyStatusRow } from './StatusMessage'
import { SidebarRooms } from './rooms/SidebarRooms'
import { SetupRow } from './onboarding/SetupRow'
import { TeamMenu } from './TeamMenu'
import { useMediaQuery } from './ui'
import { AccountMenu } from './nav/AccountMenu'
import { useChatPeek } from './nav/ChatItem'
import { HistoryList, SIDEBAR_HISTORY_CAPS } from './nav/HistoryList'
import { MenuRows, PhoneMenuRows } from './nav/MenuRows'

export default function Sidebar() {
  const t = useT()
  // the column beside the page (a computer) or the phone's drawer: the drawer keeps the phone's own layout
  const wide = useMediaQuery('(min-width: 768px)')
  const setDrawer = useUi((s) => s.setDrawer)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const navigate = useNavigate()
  const peek = useChatPeek()
  const close = () => setDrawer(false)
  // the list below the rows is scrolled away from its top (its hairline shows)
  const [scrolled, setScrolled] = useState(false)
  // unread inbox notifications: a count next to "Inbox" (the list itself is in Settings > Notifications)
  const unread = useInboxUnread()
  const nav = 'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink hover:bg-hover max-md:h-11'
  const active = ({ isActive }: { isActive: boolean }) => clsx(nav, isActive && 'bg-hover font-medium')

  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-full flex-col bg-subtle">
      {wide ? (
        // the team on top (TeamMenu.tsx): its logo and name, and for owners and admins the team menu
        <TeamMenu />
      ) : (
        // the phone's drawer is the AI's history: the AI's one name there, as on its tab, with the product's mark
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
          <Link to="/" onClick={close} className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" aria-hidden className="size-5 shrink-0 rounded-md" data-testid="sidebar-logo-phone" />
            <span>{aiName(t)}</span>
          </Link>
        </div>
      )}
      {wide ? <MenuRows unread={unread} onNewChat={() => navigate('/')} onSearch={() => setSearchOpen(true)} /> : <PhoneMenuRows onNavigate={close} onSearch={() => setSearchOpen(true)} />}

      {/* one scroll, like Slack's: 대화 (a computer) and 트리나 기록, each capped at five with the rest behind its button. A
          hairline at its top edge while it is scrolled, like the one above the account row, says the content runs under
          the rows above (the owner, 2026-11-07); the 1 px is always there (transparent at the top), so nothing moves */}
      <div
        className={clsx('scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-2 pb-2', scrolled ? 'border-line' : 'border-transparent')}
        onScroll={(e) => {
          peek.hide()
          setScrolled(e.currentTarget.scrollTop > 0)
        }}
        data-scrolled={scrolled ? '' : undefined}
        data-testid="sidebar-scroll"
      >
        {wide && <SidebarRooms onNavigate={close} />}
        {/* the owner's way back to the welcome steps (onboarding/SetupRow.tsx): its own row between the sections */}
        <SetupRow onNavigate={close} />
        <HistoryList caps={wide ? SIDEBAR_HISTORY_CAPS : null} onNavigate={close} peek={peek} />
      </div>
      {peek.card}
      {wide ? (
        <AccountMenu />
      ) : (
        // phones: my status (the computer's account menu has it) and the account menu's Deleted chats, at the end of the
        // history
        <div className="border-t border-line p-2">
          <MyStatusRow className="h-11" onOpen={close} />
          <NavLink to="/trash" className={active} onClick={close} data-testid="nav-trash">
            <Trash2 size={16} aria-hidden /> {t('sidebar.trash')}
          </NavLink>
        </div>
      )}
    </nav>
  )
}
