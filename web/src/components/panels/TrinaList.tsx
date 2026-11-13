// 트리나's list in the rail's panel (docs/DECISIONS.md "The Trina list: pinned, recent"; "Trina history by project";
// "Trina history: the default view is grouped by project"). In this order, each a section whose label folds it
// (PanelFrame.tsx PanelSection):
//   답을 기다려요 N (one quiet row while an AI chat waits on me) ·
//   고정 (my pinned chats) ·
//   트리나 기록 (its "⋯" holds 삭제한 기록; every other chat of mine, newest first, grouped by project as the filter's
//   default "Group by: Project" says, like the Claude Code desktop sidebar: at most five projects with three rows each,
//   "N more" in place, "Show all", the chats outside projects last as "Other chats"; a person with no chat in a project
//   sees no headers, one flat list; "더 보기" reads the next page). Any other choice in the filter shows the filtered
//   history instead (TrinaPanel.tsx, nav/HistoryList.tsx), "Group by: None" its flat list.
// The owner dropped the Trina list's folders (2026-11-13; the server keeps their tables, and a chat once filed in one is
// in 트리나 기록 like any other). The pinned chats come from the server's one read (store/chatGroups.ts); 트리나 기록 is
// the chat list this window keeps (store/chats.ts, as the filtered history reads it), so its rows and marks are live.
import clsx from 'clsx'
import { Pin, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Chat } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { chatGroupsChanged, readChatGroups, useChatGroups } from '../../store/chatGroups'
import { useChats } from '../../store/chats'
import { loadChatList } from '../../lib/chatListLoad'
import { accessChanged, chatChanged, navFoldersChanged, reloadAsked } from '../../store/live'
import { readProjectList, useProjects } from '../../store/projects'
import { cardChats, useWaitingChats } from '../../store/sessionMarkers'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { isUnused } from '../chat/ChatState'
import { LoadError } from '../LoadError'
import { MenuButton } from '../rooms/MenuButton'
import { HistoryGroups, useHistoryGroups } from '../history/HistoryGroups'
import { aiName } from '../../lib/tabs'
import { ChatItem, type ChatPeek } from '../nav/ChatItem'
import { foldRuns, newestRunsOnly } from '../nav/TaskRunsRow'
import { PanelSection, panelRow, panelRowBox } from './PanelFrame'

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
  const recent = useMemo(() => chats.filter((c) => !isUnused(c) && !c.pinnedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [chats])
  // grouped by project (the filter's default): a task's runs are one row (its newest run), so the caps count rows
  const rows = useMemo(() => newestRunsOnly(recent), [recent])
  const caps = useMemo(() => ({ projects: GROUP_PROJECTS, rows: GROUP_ROWS, open: openChat }), [openChat])
  const byProject = useHistoryGroups(rows, caps)

  if (!groups || (loaded && !byProject.ready)) {
    if (error) return <LoadError error={error} onRetry={() => void readChatGroups()} what="chats" minor className="mx-1 mt-2" />
    return <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />
  }

  const row = (c: Chat) => <ChatItem key={c.id} chat={live(c)} onNavigate={noop} peek={peek} onMove={setMoving} />
  const empty = loaded && !groups.pinned.length && !recent.length

  return (
    <div ref={listRef} data-testid="trina-list">
      <WaitingRow />
      {empty && <p className="px-3 py-2 text-sm text-faint">{t('sidebar.noChats')}</p>}

      {groups.pinned.length > 0 && (
        <PanelSection id="trina-pinned" foldKey="trina:pinned" label={t('chat.pinned')} icon={<Pin size={14} className="text-muted" aria-hidden />} count={groups.pinned.length} labelTestId="trina-label" data-testid="trina-pinned">
          <ul>{groups.pinned.map(row)}</ul>
        </PanelSection>
      )}

      {/* always there once read, empty or not: its "⋯" holds 삭제한 기록 and its "더 보기" the next page (the first page may
          be all pinned chats) */}
      {loaded && (
        <PanelSection id="trina-recent" foldKey="trina:recent" label={t('sidebar.aiChats', { name: aiName(t) })} action={<RecentMenu />} labelTestId="trina-label" data-testid="trina-other">
          {byProject.grouped ? (
            // the groups' headers and rows start under the section's words, as the flat list's rows do (sectionBody)
            <div className="pl-[calc(var(--spacing-row-indent)-0.75rem)]">
              <HistoryGroups state={byProject} row={row} pool={recent} onNavigate={noop} menuSpace />
            </div>
          ) : (
            <ul>
              {/* the runs of one scheduled task: one row that opens the task (nav/TaskRunsRow.tsx) */}
              {foldRuns(recent, (c) => <ChatItem chat={c} onNavigate={noop} peek={peek} onMove={setMoving} projectTag />, { projectTag: true, menuSpace: true })}
            </ul>
          )}
          {cursor && (
            <button
              type="button"
              className={clsx(panelRowBox, 'text-meta text-muted')}
              disabled={moreLoading}
              onClick={() => {
                setMoreLoading(true)
                void loadChats(false).catch(() => {}).finally(() => setMoreLoading(false))
              }}
              data-testid="trina-other-more"
            >
              {moreLoading ? t('common.loading') : t('sidebar.more')}
            </button>
          )}
        </PanelSection>
      )}

      {moving && <MoveToProjectDialog chat={moving} onClose={() => {
        const id = moving.id
        setMoving(null)
        // the moved row is a new row in its project's group: the keyboard goes to its "···" where it is now
        requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return
          listRef.current?.querySelector(`a[href="/c/${id}"]`)?.closest('li')?.querySelector<HTMLElement>('[data-testid="chat-row-menu"]')?.focus()
        })
      }} onMoved={(c) => {
        useChats.getState().upsertChat(c)
        chatGroupsChanged()
        // the dialog read the project list a moment ago: the row goes to its project's group at once
        const p = c.projectId ? useProjects.getState().byId[c.projectId] : undefined
        if (p) byProject.projects.add(p)
      }} />}
    </div>
  )
}

const noop = () => {}
/** the default list's caps (docs/DECISIONS.md "Trina history by project"): five projects, three rows each */
const GROUP_PROJECTS = 5
const GROUP_ROWS = 3

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

/** "? 답을 기다려요 N" on top of the list while any AI chat waits on me (the rail's "?"): one quiet row, no card; it opens
 * the first one that is not on screen already (UX review S2). */
function WaitingRow() {
  const t = useT()
  const requests = useChats((s) => s.requests)
  const cards = useMemo(() => cardChats(requests), [requests])
  const navigate = useNavigate()
  // a question or card that waits for my answer (a stopped run keeps its "?" on its row, not here: the words would be wrong)
  const waiting = useWaitingChats().filter((c) => c.waiting || cards.has(c.id))
  const onScreen = /^\/c\/([^/]+)/.exec(useLocation().pathname)?.[1]
  if (!waiting.length) return null
  const first = waiting.find((c) => c.id !== onScreen) ?? waiting[0]!
  return (
    <button type="button" className={clsx(panelRow, 'mb-1 font-medium')} onClick={() => navigate(`/c/${first.id}`)} data-testid="trina-waiting">
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full bg-warn text-nano leading-4 font-bold text-canvas">?</span>
      <span className="min-w-0 flex-1 truncate">{t('marker.card')}</span>
      <span className="shrink-0 text-meta font-normal text-muted tabular-nums" data-testid="trina-waiting-count">{waiting.length}</span>
    </button>
  )
}
