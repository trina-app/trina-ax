// 프로젝트's list (docs/DECISIONS.md "Projects: a place of their own"; the owner, 2026-11-13: "프로젝트를 그냥 따로 하나의
// 큰 탭으로"): beside the rail on a computer (ProjectsPanel) and as the phone's 프로젝트 tab (pages/Projects.tsx shows
// ProjectsList at /projects on a phone). "+ 새 프로젝트" on top (the name-only dialog, NewProjectDialog.tsx), then two sections: 팀
// 프로젝트 (others see it too) and 내 프로젝트 (only I do: onlyMine below), and for the owner and admins a third, folded at
// first: 다른 팀 프로젝트, the team projects they manage without being a member (as the Projects page lists them; QA
// TC-1071: the panel said "No projects yet" beside a page that listed one). Each project
// is one plain row: its name and, small and grey under it, who sees it ("멤버 4명", "나만"), when my latest chat there
// was active and how many chats of my list it holds ("2시간 전 · 대화 5개"; "대화 없음" for none); the most
// recently active first, the ones without a chat of mine after them, newest first. Each row has the Projects page cards'
// "···" (ProjectRow below: rename, members, copy link, leave, delete), also on a right-click and a long press. A project's
// row opens its page on the right, which lists its chats, its instructions and its files, as ChatGPT's and Claude's
// projects do; its ▸ on the left opens its newest chats under it in place (docs/decisions/20261120-project-chat-accordion.md,
// folded at first, kept per person as the sections' folds are), and a round count on the project and on a chat says how
// many unread mentions of me wait there, with who mentioned me on hover (store/chatMentions.ts).
// The counts are the server's (GET /api/chats/groups projectActivity), never what this window happens to have loaded.
// A project in the trash is in no section: one quiet Trash row at the bottom has them, for whoever can restore one
// (ProjectsTrash.tsx, docs/decisions/20261121-projects-trash-out-of-list.md).
import { isGuestMe } from '../../lib/guests'
import clsx from 'clsx'
import { ChevronRight, FolderLock, Lock, MessageSquare, Plus, SquareKanban, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import type { Chat, Project } from '@mycel/shared/api'
import { api, API } from '../../lib/api'
import { CountPill } from '../CountPill'
import { Tooltip } from '../Tooltip'
import { useMentions, type ChatMention } from '../../store/chatMentions'
import { chatChanged } from '../../store/live'
import { useFolds } from './folds'
import { useLocale, useT } from '../../i18n'
import { formatRelative } from '../../lib/format'
import { useRailHere } from '../../lib/rail'
import { useChats } from '../../store/chats'
import { SessionMarker, useChatMarker } from '../chat/ChatState'
import { unreadProjects } from '../rail/railBadges'
import { accessChanged, reloadAsked } from '../../store/live'
import { isAdmin, useMe } from '../../store/session'
import { readManagedList, readProjectList, useProjects } from '../../store/projects'
import { NewProjectDialog } from '../NewProjectDialog'
import { ProjectMembersDialog } from '../ProjectMembersDialog'
import { useProjectMenuItems } from '../projectActions'
import { useChatMenuItems } from '../chat/chatMenuItems'
import { MoveToProjectDialog } from '../chat/ChatProject'
import { useGuestAiOff } from '../GuestView'
import { whoSeesProject } from '../projectWho'
import { ListIcon, ListRow } from '../list/List'
import { PanelFrame, PanelSection, panelRow } from './PanelFrame'
import { useGroupsRead } from './TrinaList'
import { ProjectsTrash } from './ProjectsTrash'
import { hasProjectRoom, ProjectRowRoom, useProjectRoom } from '../rooms/ProjectRoomButton'

export function ProjectsPanel() {
  const t = useT()
  return (
    <PanelFrame title={t('projects.title')} testId="projects-panel" top={<NewProjectRow />}>
      <ProjectsList />
    </PanelFrame>
  )
}

/** "+ 새 프로젝트": the name-only dialog (NewProjectDialog.tsx); made, the new project's page opens. A phone's row is
 * the lists' 48px by panelRow itself (`phone` is kept for the phone's page, which still passes it) */
export function NewProjectRow(_: { phone?: boolean } = {}) {
  const t = useT()
  const navigate = useNavigate()
  const me = useMe()
  const [open, setOpen] = useState(false)
  // a guest makes no projects (lib/guests.ts: they are in one place only)
  if (isGuestMe(me)) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={clsx(panelRow, 'font-medium')} data-testid="projects-panel-new">
        <ListIcon><Plus /></ListIcon> <span className="truncate">{t('projects.new')}</span>
      </button>
      {open && <NewProjectDialog people onClose={() => setOpen(false)} onMade={(p) => { setOpen(false); navigate(`/projects/${p.id}`) }} />}
    </>
  )
}

/** The projects I see, the most recently active first (see the top of this file). A phone passes `phone` (its rows are panelRow's own 48 px). */
export function ProjectsList(_: { phone?: boolean } = {}) {
  const t = useT()
  const noAiGuest = useGuestAiOff()
  const locale = useLocale()
  const { groups } = useGroupsRead()
  const byId = useProjects((s) => s.byId)
  const listed = useProjects((s) => s.listed)
  useEffect(() => void readProjectList({ minAgeMs: 30_000 }).catch(() => {}), [])
  // GET /api/projects?manage=1 (the Projects page's list, store/projects.ts managed: as last read at once, read again
  // behind it) adds two kinds the plain list has not:
  // - for the owner and admins, the team projects they manage without being members (their name and members only), in
  //   their own folded section, as the Projects page has them;
  // - the team projects in the trash I am a member of (Project.wasMember) or may restore (Project.canRestore): no row of
  //   any group (the owner, 2026-11-21: "지운 게 저렇게 보여야해?"), only the Trash row at the bottom (ProjectsTrash.tsx;
  //   docs/decisions/20261121-projects-trash-out-of-list.md). A link to one still opens its in-the-trash note. Restored
  //   from there, it is mine to read again before the plain list is read: back in its group at once.
  const admin = isAdmin(useMe())
  const managedList = useProjects((s) => s.managed)
  const managed = useMemo(() => (managedList ?? []).filter((p) => !p.inTrash && (p.member !== false || admin)), [admin, managedList])
  useEffect(() => {
    const read = (fresh = false) => void readManagedList({ fresh }).catch(() => {})
    read()
    const again = () => read(true)
    const offs = [accessChanged.on(again), reloadAsked.on(again)]
    return () => offs.forEach((off) => off())
  }, [])
  const activity = useMemo(() => new Map((groups?.projectActivity ?? []).map((a) => [a.projectId, a])), [groups])
  const projects = useMemo(() => {
    // (never one in the trash: the plain list has none, but a project read on its page may be in the store)
    const seen = [...Object.values(byId).filter((p) => listed?.has(p.id) && !p.inTrash), ...managed.filter((p) => !listed?.has(p.id))]
    const at = (p: Project) => activity.get(p.id)?.lastActivityAt ?? ''
    return seen.sort((a, b) => at(b).localeCompare(at(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }, [byId, listed, activity, managed])

  // the project on screen: its page (and its files), or the chat of it opened from here (프로젝트 still lit)
  const { pathname } = useLocation()
  const place = useRailHere()
  // (a thread beside the chat: still that chat)
  const chatId = (matchPath('/c/:chatId', pathname) ?? matchPath('/c/:chatId/t/:messageId', pathname))?.params.chatId
  const chatProject = useChats((s) => (chatId && place === 'projects' ? s.chats.find((c) => c.id === chatId)?.projectId ?? s.others[chatId]?.projectId ?? null : null))
  const lit = matchPath('/projects/:projectId/*', pathname)?.params.projectId ?? chatProject
  const navigate = useNavigate()
  // the members dialog of a row's ⋯ 멤버
  const [members, setMembers] = useState<Project | null>(null)
  // the projects whose chats are open under their row (folded at first), and my unread mentions by project and chat
  const { folds, set: setFold } = useFolds()
  const { byChat, byProject } = useMentions()
  // the projects with something for me, as the rail's Projects mark counts them (rail/railBadges.ts unreadProjects): a
  // thread mention, or a chat of it with messages I have not read and did not mute. Their rows are bold
  const chats = useChats((s) => s.chats)
  const otherChats = useChats((s) => s.others)
  const unreadIn = useMemo(() => unreadProjects(byProject.keys(), [...chats, ...Object.values(otherChats)]), [byProject, chats, otherChats])

  if (!listed) return <div className="mx-auto mt-4 size-4 animate-spin rounded-full border-2 border-line border-t-faint" role="status" aria-label={t('common.loading')} />
  const others = projects.filter((p) => p.member === false)
  const team = projects.filter((p) => p.member !== false && !onlyMine(p))
  const mine = projects.filter(onlyMine)
  const rows = (list: Project[]) => (
    <ul>
      {list.map((p) => {
        const a = activity.get(p.id)
        // "나만" for mine; "멤버 N명" (its page's words) for a team one
        const who = onlyMine(p) ? t('projects.meta.me') : whoSeesProject(t, p, 'projects.whoMembers')
        // a guest with no AI has no chats here (no Chats tab): no count of the team's chats either
        const meta = noAiGuest ? who : [who, ...(a ? [formatRelative(a.lastActivityAt, locale), t('projectsPanel.chats', { n: a.count })] : [t('projectsPanel.noChats')])].filter(Boolean).join(' · ')
        const on = lit === p.id
        // no chats to open for a guest with no AI
        const foldable = !noAiGuest && p.member !== false
        const open = foldable && folds[`project:${p.id}`] === 'open'
        return (
          <ProjectRow
            key={p.id}
            project={p}
            selected={on}
            meta={meta}
            onMembers={() => setMembers(p)}
            onGone={() => on && navigate('/projects')}
            fold={foldable ? { open, toggle: () => setFold(`project:${p.id}`, open ? 'folded' : 'open') } : undefined}
            mention={foldable ? byProject.get(p.id) : undefined}
            unread={foldable && unreadIn.has(p.id)}
            chats={open ? <ProjectChats project={p} byChat={byChat} mentioned={byProject.get(p.id)?.chatIds} /> : null}
          />
        )
      })}
    </ul>
  )
  return (
    <div data-testid="projects-list">
      {members && <ProjectMembersDialog project={members} onClose={() => setMembers(null)} onSaved={(r) => useProjects.getState().put(r)} />}
      {/* none (the Trash row stays at the bottom, also when every project is in the trash, in one place so its dialog
          stays open while a restored project comes back) */}
      {!projects.length && <p className="px-3 py-2 text-sm text-faint" data-testid="projects-panel-empty">{t('projects.empty')}</p>}
      {team.length > 0 && (
        <PanelSection id="projects-team" foldKey="projects:team" label={t('projectsPanel.team')} icon={<Users size={14} className="text-muted" aria-hidden />} count={team.length} labelTestId="projects-panel-label" data-testid="projects-team">
          {rows(team)}
        </PanelSection>
      )}
      {mine.length > 0 && (
        <PanelSection id="projects-mine" foldKey="projects:mine" label={t('projectsPanel.mine')} icon={<Lock size={14} className="text-muted" aria-hidden />} count={mine.length} labelTestId="projects-panel-label" data-testid="projects-mine">
          {rows(mine)}
        </PanelSection>
      )}
      {others.length > 0 && (
        <PanelSection id="projects-other" foldKey="projects:other" folded label={t('projects.otherTeam')} icon={<FolderLock size={14} className="text-muted" aria-hidden />} count={others.length} labelTestId="projects-panel-label" data-testid="projects-other">
          {rows(others)}
        </PanelSection>
      )}
      <ProjectsTrash managed={managedList} />
    </div>
  )
}

/** One project of the list: its name, who sees it and how active it is, and its "···" (right-click, a long press on a
 * touch screen): the Projects page cards' menu (projectActions.tsx useProjectMenuItems: 이름 바꾸기, 멤버, 링크 복사,
 * 나가기, 삭제 by the same rules), so a project is renamed where people look for it. `onGone`: it left the list (deleted,
 * or I left it) */
function ProjectRow({ project: p, selected, meta, onMembers, onGone, fold, mention, unread: news, chats }: { project: Project; selected: boolean; meta?: string; onMembers: () => void; onGone: () => void; fold?: { open: boolean; toggle: () => void }; mention?: ChatMention; unread?: boolean; chats?: ReactNode }) {
  const t = useT()
  const more = useRef<HTMLButtonElement>(null)
  // the keyboard waits on "···" after an item (a dialog it opens gives it back there)
  const select = (fn: () => unknown) => () => {
    more.current?.focus()
    void fn()
  }
  const items = useProjectMenuItems(p, { testId: 'projects-panel', select, onMembers, onDeleted: (d) => d === 'gone' && onGone() })
  const room = hasProjectRoom(p)
  const unread = useProjectRoom(p).unread > 0
  return (
    <>
    <ListRow
      to={`/projects/${p.id}`}
      selected={selected}
      unread={news}
      icon={<SquareKanban />}
      name={p.name}
      nameTitle={p.name}
      meta={meta}
      rowMenu={{ items, label: t('rooms.menu.rowLabel', { name: p.name }), tip: t('rooms.menu.label'), sheetTitle: p.name, buttonRef: more, testId: 'projects-panel-menu' }}
      testId="projects-panel-row"
      nameTestId="projects-panel-name"
      metaTestId="projects-panel-meta"
      // the ▸ sits in the section's indent, left of the icon (a phone: the row makes room for it)
      rowClass={clsx(fold && 'max-md:!pl-12', room && '!pr-16 max-md:!pr-11', room && unread && 'max-md:!pr-20')}
      end={mention ? <MentionPill mention={mention} testId="projects-panel-mentions" /> : undefined}
      menu={
        <>
        {/* the project's chat room: a small chat icon before the "···", a dot while something is unread
            (rooms/ProjectRoomButton.tsx; docs/decisions/20261120-project-is-room.md D5) */}
        {room && <span className="absolute inset-y-0 right-8 flex items-center max-md:right-11"><ProjectRowRoom project={p} /></span>}
        {fold && (
          <Tooltip label={t(fold.open ? 'projectsPanel.fold.close' : 'projectsPanel.fold.open', { name: p.name })}>
          <button
            type="button"
            onClick={fold.toggle}
            aria-expanded={fold.open}
            aria-label={t(fold.open ? 'projectsPanel.fold.close' : 'projectsPanel.fold.open', { name: p.name })}
            className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-md text-faint hover:bg-surface hover:text-ink max-md:top-1/2 max-md:left-1 max-md:size-10 max-md:-translate-y-1/2"
            data-testid="projects-panel-fold"
          >
            <ChevronRight size={14} className={clsx('transition-transform motion-reduce:transition-none', fold.open && 'rotate-90')} aria-hidden />
          </button>
          </Tooltip>
        )}
        </>
      }
    />
    {chats}
    </>
  )
}

/** A round count of unread mentions of me ("1", "2"), who mentioned me on hover and for a screen reader; also on a
 * project page's chat rows (pages/Projects.tsx ProjectChatRow), the same count */
export function MentionPill({ mention: m, testId }: { mention: ChatMention; testId: string }) {
  const t = useT()
  const by = m.names.length ? t('projectsPanel.fold.by', { names: m.names.slice(0, 3).join(', ') }) : ''
  const label = [t('projectsPanel.fold.mentions', { n: m.count }), by].filter(Boolean).join('. ')
  return (
    <span className="flex shrink-0 items-center self-center" title={label}>
      <CountPill text={m.count > 99 ? '99+' : String(m.count)} label={label} className="min-w-5 text-center tabular-nums" testId={testId} />
    </span>
  )
}

/** How many of a project's chats open under its row; the rest are on its page ("대화 전체 보기") */
const CHATS_SHOWN = 8
const NONE: readonly string[] = []
/** how long an open list waits after a change of its chats before it reads again (a running answer sends several) */
const REREAD_MS = 500

/** An open project's chats under its row: the ones I can open there (the page's own GET /api/chats?projectId), newest
 * first, each with its unread mentions of me. A chat with a mention of me is always there and first, also an older one
 * past the newest few (read by itself). Read again when one of its chats changes, the server asks, or access changes. */
function ProjectChats({ project: p, byChat, mentioned = NONE }: { project: Project; byChat: ReadonlyMap<string, ChatMention>; mentioned?: readonly string[] }) {
  const t = useT()
  const locale = useLocale()
  const { pathname } = useLocation()
  const [list, setList] = useState<{ items: Chat[]; more: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  // a chat row's "···" 프로젝트 변경: the move dialog (as the Trina history's, nav/HistoryList.tsx)
  const [moving, setMoving] = useState<Chat | null>(null)
  // a change of one of this project's chats (made, renamed, moved, deleted), a reload or a change of access: read again
  const [again, setAgain] = useState(0)
  // the chats listed now (a chat moved out of this project: its event names the other project)
  const listed = useRef<ReadonlySet<string>>(new Set())
  // a mentioned chat past the first page, as read by itself (read again only on a reload or an access change)
  const olderRead = useRef(new Map<string, Chat | null>())
  useEffect(() => {
    // a running answer sends a few changes a second: one read after they settle
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setAgain((n) => n + 1), REREAD_MS)
    }
    const fresh = () => {
      olderRead.current.clear()
      bump()
    }
    const offs = [chatChanged.on((d) => {
      // a cached older chat that changed (renamed, moved, deleted) is read again, not taken from the cache
      olderRead.current.delete(d.chatId)
      if (d.chat?.projectId === p.id || listed.current.has(d.chatId)) bump()
    }), reloadAsked.on(fresh), accessChanged.on(fresh)]
    return () => {
      if (timer) clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [p.id])
  // only this project's mentions read it again (a new mention may be in a chat the list has not got)
  const mentionKey = [...mentioned].sort().join(',')
  useEffect(() => {
    let live = true
    const ids = mentionKey ? mentionKey.split(',') : []
    void (async () => {
      const r = await api.call(API.listChats, { query: { projectId: p.id, limit: CHATS_SHOWN + 1 } })
      const all = r.items.filter((c) => !c.deletedAt)
      // the newest few, and every mentioned chat the page holds past them (pinned chats lead a page)
      const items = all.filter((c, i) => i < CHATS_SHOWN || ids.includes(c.id))
      const have = new Set(all.map((c) => c.id))
      // a mentioned chat past the newest few: read by itself (one that cannot be read is left out)
      const read = olderRead.current
      const older = await Promise.all(
        ids.filter((id) => !have.has(id)).map(async (id) => {
          if (!read.has(id)) read.set(id, await api.call(API.getChat, { params: { id } }).catch(() => null))
          return read.get(id) ?? null
        }),
      )
      const extra = older.filter((c): c is Chat => !!c && !c.deletedAt && c.projectId === p.id)
      return { items: [...items, ...extra], more: all.length > items.length || !!r.nextCursor }
    })().then(
      (v) => {
        if (!live) return
        listed.current = new Set(v.items.map((c) => c.id))
        setList(v)
        setFailed(false)
      },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [p.id, mentionKey, again])
  const items = useMemo(() => {
    if (!list) return []
    // a chat with a mention of me first, then the newest
    return [...list.items].sort((a, b) => (byChat.get(b.id)?.count ?? 0) - (byChat.get(a.id)?.count ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
  }, [list, byChat])
  const sub = 'pl-[3.25rem] max-md:pl-16'
  return (
    <li data-testid="projects-panel-chats">
      <ul>
        {!list && !failed && <li className={clsx(sub, 'py-1 text-meta text-faint')}>{t('projectsPanel.fold.loading')}</li>}
        {failed && !list && <li className={clsx(sub, 'py-1 text-meta text-faint')} data-testid="projects-panel-chats-failed">{t('projectsPanel.fold.failed')}</li>}
        {list && !items.length && <li className={clsx(sub, 'py-1 text-meta text-faint')} data-testid="projects-panel-chats-empty">{t('projectsPanel.fold.none')}</li>}
        {items.map((c) => <ProjectChatItem key={c.id} chat={c} mention={byChat.get(c.id)} selected={pathname.startsWith(`/c/${c.id}`)} rowClass={sub} tag={formatRelative(c.updatedAt, locale)} onMove={setMoving} onGone={() => setAgain((n) => n + 1)} />)}
        {list?.more && (
          <ListRow to={`/projects/${p.id}`} name={<span className="text-meta text-muted">{t('projectsPanel.fold.more')}</span>} rowClass={sub} testId="projects-panel-chats-more" />
        )}
      </ul>
      {moving && (
        <MoveToProjectDialog
          chat={moving}
          onClose={() => setMoving(null)}
          onMoved={(c) => {
            useChats.getState().upsertChat(c)
            setAgain((n) => n + 1)
          }}
        />
      )}
    </li>
  )
}

/** The live copy of a project chat (the chats store's, else the list's): its unread messages follow chat.updated */
export function useLiveChat(c: Chat): Chat {
  return useChats((s) => s.chats.find((x) => x.id === c.id) ?? s.others[c.id]) ?? c
}
/** A project chat's unread messages (a project's shared chat is a conversation: chat/message-notices.ts): the Trina
 * list's number (ChatState.tsx SessionMarker), or nothing */
export function UnreadMessages({ chat }: { chat: Chat }) {
  const { marker, reason } = useChatMarker(chat)
  return marker?.reason === 'message' && !chat.muted ? <SessionMarker marker={marker} label={reason} className="self-center" /> : null
}

/** One chat under an open project's row: bold with my unread mentions (their count) or messages (their number). Its
 * "···" (also a right-click and a long press) holds the Trina history row's items by the same rules
 * (chat/chatMenuItems.tsx), as the project page's chat rows do (pages/Projects.tsx ProjectChatRow). `onGone`: it left
 * the list (hidden, left, deleted): the list is read again */
function ProjectChatItem({ chat, mention: m, selected, rowClass, tag, onMove, onGone }: { chat: Chat; mention?: ChatMention; selected: boolean; rowClass: string; tag: string; onMove: (c: Chat) => void; onGone: () => void }) {
  const t = useT()
  const c = useLiveChat(chat)
  const news = !!c.unreadCount && !c.muted
  const more = useRef<HTMLButtonElement>(null)
  // the keyboard waits on "···" after an item (a dialog it opens gives it back there)
  const items = useChatMenuItems(c, { testId: 'projects-panel-chat', more, select: (fn) => () => (more.current?.focus(), void fn()), onMove, onRemoved: onGone })
  const name = c.title || t('chat.untitled')
  return (
    <ListRow
      to={`/c/${c.id}`}
      selected={selected}
      icon={<MessageSquare />}
      name={name}
      nameTitle={c.title}
      unread={!!m || news}
      tag={m || news ? undefined : tag}
      end={m ? <MentionPill mention={m} testId="projects-panel-chat-mentions" /> : news ? <UnreadMessages chat={c} /> : undefined}
      rowClass={rowClass}
      rowMenu={{ items, label: t('rooms.menu.rowLabel', { name }), tip: t('rooms.menu.label'), sheetTitle: name, buttonRef: more, testId: 'projects-panel-chat-menu' }}
      testId="projects-panel-chat"
      link={{ 'data-chat-id': c.id }}
    />
  )
}

/** 내 프로젝트: a project only I see: a personal one (in my own folder), or a team project nobody else sees by its rules
 * (just me, or me and the admins by their role: Project.alone); never one I only manage. Everything else is 팀
 * 프로젝트. A server without the count: by its folder. */
export const onlyMine = (p: Project) =>
  p.folderPath.startsWith('users/') || (p.member !== false && p.audience !== undefined && (p.audience <= 1 || !!p.alone))
