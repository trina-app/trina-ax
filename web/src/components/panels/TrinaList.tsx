// 트리나's list in the rail's panel and on the phone's 트리나 tab (docs/DECISIONS.md "The Trina list: pinned, recent";
// "Projects: a place of their own"). In this order, each a section whose label folds it (PanelFrame.tsx PanelSection):
//   고정 (my pinned chats) ·
//   my sections (nav/HistorySections.tsx; docs/decisions/20261122-trina-history-sections.md), each a section of its own ·
//   트리나 기록 (sidebar.aiChats, the history's one name on every screen: QA TC-1085; its "⋯" holds 삭제한 기록; every other chat of mine, newest first, by date (Today, Yesterday …, each folding: the menu's default "Group by: Date", the owner 2026-11-22): a project's chat with its project's name small
//   and grey at the row's end, so yesterday's project chat is still one click away; "더 보기" reads the next page).
// Projects are not here: they are their own place (the rail's 프로젝트, panels/ProjectsPanel.tsx). A section is my own
// way to sort my list (only I see it, it changes nobody's access); a project is a shared place with its own files,
// instructions and people.
// The pinned chats come from the server's one read (store/chatGroups.ts); 최근 기록 is the chat list this window keeps
// (store/chats.ts, as the filtered history reads it), so its rows and marks are live. A chat that waits on me has no row
// or group of its own on top (QA TC-ask1-18): it stays where it is with its "?", the rail's icon carries the same mark.
import clsx from 'clsx'
import { Pin, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { chatGroupsChanged, readChatGroups, useChatGroups } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { accessChanged, chatChanged, navFoldersChanged, reloadAsked } from '../../store/live'
import { readProjectList } from '../../store/projects'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { isUnused } from '../chat/ChatState'
import { LoadError } from '../LoadError'
import { MenuButton } from '../rooms/MenuButton'
import { ChatItem, type ChatPeek } from '../nav/ChatItem'
import { aiName } from '../../lib/tabs'
import { PanelSection, panelRowBox } from './PanelFrame'
import { HistorySections, useSectionRows } from '../nav/HistorySections'
import { DateGroups } from '../nav/HistoryList'
import { DROP_OVER } from '../nav/NavFolders'
import { leftSectionToast, useSectionDrop } from '../nav/SidebarSections'
import { loadChatList, loadMoreShown } from '../../lib/chatListLoad'

export { useFolds } from './folds'

/** how long a window coming back to the front waits before the groups are read again */
const REFOCUS_READ_MS = 60_000

/** how old a read of the groups may be when the list shows again (the rail's 트리나 after another place, the phone's
 * tab): a change of my chats or folders meanwhile marks it stale (store/chatGroups.ts), so the list reads at once then */
export const SHOW_AGAIN_READ_MS = 60_000
/** the server asked for a reload, or access changed, while no list was on screen: the next one reads at once */
let missed = false
reloadAsked.on(() => { missed = true })
accessChanged.on(() => { missed = true })

/** Keep the groups read: on first show, after a change of my chats or folders, a reload the server asked for, a change
 * of access, and the window back in front after a minute. Also 프로젝트's list (each project's count and last activity). */
export function useGroupsRead() {
  const groups = useChatGroups((s) => s.groups)
  const error = useChatGroups((s) => s.error)
  useEffect(() => {
    void readChatGroups(missed ? {} : { minAgeMs: SHOW_AGAIN_READ_MS })
    missed = false
    // a change of a chat in my list (someone else's shared chat I never wrote in is not: its project's page has it)
    const offs = [chatChanged.on((d) => { if (!d.chat?.shared || d.chat.shared.mine || d.change !== 'updated') chatGroupsChanged() }), navFoldersChanged.on((k) => k === 'chats' && chatGroupsChanged()), reloadAsked.on(() => void readChatGroups()), accessChanged.on(chatGroupsChanged)]
    const again = () => document.visibilityState !== 'hidden' && void readChatGroups({ minAgeMs: REFOCUS_READ_MS })
    window.addEventListener('focus', again)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('focus', again)
    }
  }, [])
  return { groups, error }
}

export function TrinaList({ peek }: { peek: ChatPeek }) {
  const t = useT()
  const { groups, error } = useGroupsRead()
  // the chats store: 최근 기록's rows and every row's live copy (marks); the session marker count elsewhere reads it too
  const chats = useChats((s) => s.chats)
  const others = useChats((s) => s.others)
  const loaded = useChats((s) => s.chatsLoaded)
  const cursor = useChats((s) => s.chatsCursor)
  const loadChats = useChats((s) => s.loadChats)
  const [moreLoading, setMoreLoading] = useState(false)
  useEffect(() => {
    // the first read is shared with the rail's marks (lib/chatListLoad.ts)
    if (!loaded) void loadChatList().catch(() => {})
  }, [loaded])
  // a chat that joined my list on another screen (a shared project chat I just wrote in, its event telling only its
  // maker's view) is in the server's heads: put it in the list, so 최근 기록 has it without a reload
  useEffect(() => {
    if (!groups) return
    const st = useChats.getState()
    const have = new Set(st.chats.map((c) => c.id))
    for (const c of [...groups.other.items, ...groups.projects.flatMap((p) => p.top)]) if (!have.has(c.id) && !c.deletedAt) st.upsertChat(c)
  }, [groups])
  // the projects' names for 최근 기록's tags
  useEffect(() => void readProjectList({ minAgeMs: 30_000 }).catch(() => {}), [])
  const byId = useMemo(() => new Map([...Object.values(others), ...chats].map((c) => [c.id, c])), [chats, others])
  const live = useCallback((c: Chat) => byId.get(c.id) ?? c, [byId])
  const [moving, setMoving] = useState<Chat | null>(null)
  const openChat = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? null
  // the chat on screen in sight in the list (the rail's "?" or the waiting row opened one far down): the least scroll
  // once per chat opened (a new read of the groups while I browse never pulls the list back)
  const listRef = useRef<HTMLDivElement>(null)
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (!openChat || scrolledTo.current === openChat) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(openChat)}"]`)
    if (!row) return
    scrolledTo.current = openChat
    row.scrollIntoView?.({ block: 'nearest' })
  }, [openChat, groups, chats])

  // 최근 기록: every chat of my list that is not pinned, newest first (a chat made only to hold attachments is not a
  // conversation yet)
  const sections = useSectionRows()
  const recent = useMemo(() => chats.filter((c) => !isUnused(c) && !c.pinnedAt && !sections.sectioned.has(c.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [chats, sections.sectioned])
  // a chat dragged onto 트리나 기록 leaves its section
  const dropOut = useSectionDrop(null, 'chats')

  if (!groups) {
    if (error) return <LoadError error={error} onRetry={() => void readChatGroups()} what="chats" minor className="mx-1 mt-2" />
    return <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />
  }

  const row = (c: Chat) => <ChatItem key={c.id} chat={live(c)} onNavigate={noop} peek={peek} onMove={setMoving} />
  const empty = loaded && !groups.pinned.length && !recent.length && !sections.sectioned.size

  return (
    <div ref={listRef} data-testid="trina-list">
      {groups.pinned.length > 0 && (
        <PanelSection id="trina-pinned" foldKey="trina:pinned" label={t('chat.pinned')} icon={<Pin size={14} className="text-muted" aria-hidden />} count={groups.pinned.length} labelTestId="trina-label" data-testid="trina-pinned">
          <ul>{groups.pinned.map(row)}</ul>
        </PanelSection>
      )}

      <HistorySections state={sections} row={(c) => <ChatItem key={c.id} chat={live(c)} onNavigate={noop} peek={peek} onMove={setMoving} projectTag />} className="mb-0 [&>section]:mt-4 [&>section:first-child]:mt-4" />

      {/* always there once read, empty or not: its "⋯" holds 삭제한 기록 and its "더 보기" the next page (the first page may
          be all pinned chats) */}
      {loaded && (
        <PanelSection id="trina-recent" foldKey="trina:recent" label={t('sidebar.aiChats', { name: aiName(t) })} action={<RecentMenu />} labelTestId="trina-label" data-testid="trina-other" className={clsx(dropOut.over && DROP_OVER)} {...dropOut.props} data-drop={dropOut.over ? '' : undefined}>
          {/* nothing yet: said under the section's heading, not above it */}
          {empty && <p className="px-3 py-2 text-sm text-faint" data-testid="trina-empty">{t('sidebar.noChats')}</p>}
          {/* by date, each date folding, as the menu's default "Group by: Date" (the owner, 2026-11-22); the runs of one
              scheduled task are one row that opens the task (nav/TaskRunsRow.tsx) */}
          <DateGroups chats={recent} row={(c) => <ChatItem key={c.id} chat={live(c)} onNavigate={noop} peek={peek} onMove={setMoving} projectTag />} by="date" created={false} projectTag />
          {cursor && (
            <button
              type="button"
              className={clsx(panelRowBox, 'text-meta text-muted')}
              disabled={moreLoading}
              onClick={() => {
                setMoreLoading(true)
                void loadMoreShown(loadChats, () => useChats.getState().chats.filter((c) => !isUnused(c) && !c.pinnedAt && !sections.sectioned.has(c.id)).length).finally(() => setMoreLoading(false))
              }}
              data-testid="trina-other-more"
            >
              {moreLoading ? t('common.loading') : t('sidebar.more')}
            </button>
          )}
        </PanelSection>
      )}

      {moving && <MoveToProjectDialog chat={moving} onClose={() => setMoving(null)} onMoved={(c) => { leftSectionToast(moving, c); useChats.getState().upsertChat(c); chatGroupsChanged() }} />}
    </div>
  )
}

const noop = () => {}

/** 최근 기록's "⋯": 삭제한 기록 (the deleted AI chats, /trash), rarely needed, so not a row of its own */
function RecentMenu() {
  const t = useT()
  const navigate = useNavigate()
  return (
    <MenuButton
      label={t('trinaList.recentMenu', { name: aiName(t) })}
      tip={t('trinaList.recentMenu', { name: aiName(t) })}
      compact
      muted
      items={[{ label: t('sidebar.trash'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => navigate('/trash'), testId: 'nav-trash' }]}
      testId="trina-recent-menu"
      // a touch screen wider than a phone (touch-hit is phones' only): 44 px to tap, as the panel's other controls
      buttonClassName="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    />
  )
}

