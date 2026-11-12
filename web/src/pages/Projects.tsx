// Projects: a folder of the team folder + instructions, one project per folder. Chats opened inside a project use both
// as their default context. List (projects whose folder the person can read), create (folder they can write; the
// dialog is components/ProjectForm.tsx, also opened from a folder on the Files page), project home: a box that
// starts a chat in the project and the person's chats in it, with the instructions and the folder's files as short
// lines beside them (like Claude's project page). No dev environment line: on the srt runner that setting is the team's,
// in Team settings, and a chat shows its own runs (docs/DECISIONS.md "Dev environment: no line on the project page").
// Shared project chats (docs/DECISIONS.md "Shared project chats"): the setting is in the edit dialog (ProjectForm), the
// list is "채팅" (my chats there and every shared chat of the project I can see, those with the people icon and the
// faces of who wrote in them: ProjectChatRow; it follows chat events, so another person's new chat shows at once), the
// box says who sees a new chat ("나만 봐요" too: docs/DECISIONS.md "Who sees it, always"; while it will be shared, the
// line opens the members dialog for whoever may change them), and deleting the project says its shared chats go to their
// creators' trash. My pinned
// chats there come first, the most recently pinned first, with the sidebar's pin before the title (docs/DECISIONS.md
// "Pinned chats"). A chat row's "···" has the sidebar row's items by the same rules (components/chat/chatMenuItems.tsx).
// Each card on the list has a "…" (the rooms lists' row menu): 이름 바꾸기 and 삭제 for people who may edit the project
// (the same rename prompt as a chat's, the same delete confirm as on the project page), 멤버 for people who may change
// its members (the members dialog, without leaving the list), 링크 복사 for everyone. Under its name a card says who
// sees the project in the words of its page's 멤버 line ("멤버 3명", "나만 봐요": whoSeesProject; no folder path), then
// keeps two lines for the first paragraph of its instructions ("지침이 없어요." when it has none; a lock and "멤버만 내용을
// 볼 수 있어요." on a project whose contents I may not see): the cards of a row are one height, and one without
// instructions does not leave a hole under it.
// Members (docs/DECISIONS.md "Project members in one panel"): a team project's page has a 멤버 line after 파일 with
// who sees it, in the words of the line under the box ("나만 봐요", "나와 관리자만 봐요" or "N명이 봐요"); 관리 opens the members dialog (components/ProjectMembersDialog.tsx) for whoever may change
// them, and for anyone else the line opens to say who does. /projects/:id?members=1 opens the dialog.
// Members only (docs/DECISIONS.md "Project contents only for members"): a team project in projects/ is its members'.
// The list and the page ask with manage=1, so the owner and admins also get the team projects they are not members of
// (Project.member false: no instructions, files or chats of others). Their card's ⋯ has 이름 바꾸기, 멤버 and 삭제
// (Project.canManage); a card with nobody active in it says "남은 멤버 없음". Their page: the name's menu (이름 바꾸기,
// 삭제), one quiet block in place of the box, the files and the instructions ("멤버만 이 프로젝트를 열 수 있어요…" and
// [나를 멤버로 추가]), the 멤버 row, and their own chats there. Adding themselves (or taking themselves out in the
// members dialog) loads the page again. Deleting a team project in projects/ moves it to the trash with its folder; a
// project in the trash says so on its page with 되돌리기 (the owner and admins; gone once the server says its folder
// was deleted for good) and 완전히 삭제, and has no name menu there.
import { ArchiveRestore, FileText, FolderKanban, Folder, Link2, Lock, Pencil, Pin, Plus, ScrollText, Share2, Trash2, UserPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Chat, FileEntry, Project, ProjectParticipant } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { firstParagraph } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'
import { aiName } from '../lib/tabs'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { projectSkillsOn } from '../lib/bulkFiles'
import { useChats } from '../store/chats'
import { chatChanged } from '../store/live'
import { chatTrashDays } from '../lib/chat-trash'
import { useProjects } from '../store/projects'
import { isAdmin, useMe } from '../store/session'
import { Markdown } from '../components/Markdown'
import { DisclosureRow } from '../components/DisclosureRow'
import { TitleMenu } from '../components/TitleMenu'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { ChatFaces, SharedIcon } from '../components/chat/SharedChat'
import { whoSeesText } from '../components/chat/WhoSees'
import { whoSees } from '../lib/sharedChat'
import { useChatMenuItems } from '../components/chat/chatMenuItems'
import { MoveToProjectDialog } from '../components/chat/ChatProject'
import { MenuButton, type MenuItem } from '../components/rooms/MenuButton'
import { ProjectForm } from '../components/ProjectForm'
import { ProjectMembersDialog, chosenOf, confirmAddMe, projectNow } from '../components/ProjectMembersDialog'
import { isProjectsFolder } from '../lib/projectFolders'
import { refusalKey } from '../lib/sharedChat'
import { AccessSummary, MembersField, ParticipantPicker, participantKey, useAccessCount, useParticipantOptions } from '../components/ProjectParticipants'
import { ProjectTrashNote } from '../components/ProjectTrashNote'
import { Button, EmptyState, ErrorNote, Modal, PageHeader, Skeleton, StickyHeader, confirmDialog, menuOpener, pageColumn, promptDialog, useCopy } from '../components/ui'
import { useFocusAfterRemove } from './admin/common'

/** A project's chats as its page lists them: my pinned ones first (the most recently pinned first, as the server's first
 * page has them), then the newest. */
const chatOrder = (a: Chat, b: Chat) =>
  a.pinnedAt || b.pinnedAt
    ? (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '')
    : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1

/** A chat of the list as it is now, with the faces of who wrote in it it had: those come with the list only, not with a
 * chat event or an action's answer. */
const keepFaces = (old: Chat | undefined, chat: Chat): Chat =>
  old?.shared?.people && chat.shared && !chat.shared.people ? { ...chat, shared: { ...chat.shared, people: old.shared.people, peopleCount: old.shared.peopleCount } } : chat

/** The address of a project's page (the app's own route; someone who cannot see the project gets "not found"). */
const projectLink = (id: string) => `${typeof location === 'undefined' ? '' : location.origin}/projects/${id}`

/** Who may rename and delete it, also without reading it (Project.canManage; older servers: whoever may edit it). */
const mayManage = (p: Project) => p.canManage ?? p.canEdit

/** What deleting did: `gone` (deleted for good, or not found any more), the project in the trash now (a team project in
 * projects/ the caller still manages: the owner and admins), or null (cancelled, refused). */
export type Deleted = 'gone' | Project | null

/**
 * Deleting a project, from its page and from its card on the list: one confirm and one call, by what the project is
 * now on the server (asked again first):
 * - a team project in projects/ whose folder is in place goes to the trash with its folder and its chats (docs/
 *   DECISIONS.md "Project contents only for members"): "휴지통으로 옮길까요? … 팀장이나 관리자가 되살릴 수 있어요." The
 *   owner and admins keep it, In trash; its creator does not see it any more;
 * - one in the trash: deleted for good ("완전히 삭제할까요? 되돌릴 수 없어요.");
 * - any other (a personal project, one made before outside projects/): deleted, its shared chats to their creators'
 *   trash (said when it has any, by the count the server gives now).
 * Also gone when someone else deleted it first.
 */
function useDeleteProject() {
  const t = useT()
  const locale = useLocale()
  const days = chatTrashDays(useMe())
  const deleted = (id: string) => {
    useProjects.getState().drop(id)
    // the server took the project off its private chats (its shared chats go to the trash with their own event): the
    // history must not offer "프로젝트 바꾸기…" for a project that is not there any more
    useChats.setState((s) => ({ chats: s.chats.map((c) => (c.projectId === id && !c.shared ? { ...c, projectId: null } : c)) }))
  }
  // not found: deleted by someone else, or no longer mine to see (then my chats keep it, as the server does)
  const missing = (id: string) => {
    useProjects.getState().drop(id)
    toast({ level: 'info', text: t('projects.missing') })
  }
  return async (p: Project): Promise<Deleted> => {
    // the menu is gone once the count below has arrived: the keyboard goes back to its button
    const opener = menuOpener() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    let now = p
    try {
      now = await projectNow(p.id)
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        missing(p.id)
        return 'gone'
      }
    }
    // the person left the page while it was asked: no confirm on another page
    if (opener && !opener.isConnected) return null
    opener?.focus()
    const toTrash = isProjectsFolder(now.folderPath) && !now.inTrash
    const forGood = !!now.inTrash
    const ask = toTrash
      ? { title: t('projects.trashTitle', { name: now.name }), body: t('projects.trashBody'), confirm: t('files.moveToTrash') }
      : forGood
        ? { title: t('projects.deleteForGoodTitle', { name: now.name }), body: t('projects.deleteForGoodBody'), confirm: t('projects.deleteForGood') }
        : { title: t('projects.deleteTitle', { name: now.name }), body: now.sharedChats ? t('projects.deleteBodyShared', { days, trash: t('sidebar.trash') }) : t('projects.deleteBody'), confirm: t('common.delete') }
    if (!(await confirmDialog({ ...ask, danger: true }))) return null
    try {
      await api.call(API.deleteProject, { params: { id: p.id } })
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        missing(p.id)
        return 'gone'
      }
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return null
    }
    if (toTrash) {
      // in the trash with its folder: the owner and admins still have it (to restore or delete for good); its private
      // chats keep it
      const after = await projectNow(p.id).catch(() => null)
      if (after) {
        useProjects.getState().put(after)
        return after
      }
      useProjects.getState().drop(p.id)
      return 'gone'
    }
    deleted(p.id)
    return 'gone'
  }
}

/** A new name for a project: the chat rename's small prompt (name only, so also for the owner or an admin who is not a
 * member: never the edit dialog, which sends its instructions). The project as saved, or null. */
function useRenameProject() {
  const t = useT()
  const locale = useLocale()
  return async (p: Project): Promise<Project | null> => {
    const name = await promptDialog({ title: t('chat.rename'), label: t('projects.name'), initial: p.name, confirm: t('common.save') })
    if (!name || name === p.name) return null
    try {
      const r = await api.call(API.updateProject, { params: { id: p.id }, body: { name } })
      useProjects.getState().put(r)
      return r
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
      return null
    }
  }
}

/** A card's "…" on the list (components/rooms/MenuButton.tsx: arrow keys, Esc, a bottom sheet on phones). On a computer
 * it shows on hover and keyboard focus, on a touch screen always. */
function ProjectCardMenu({ project: p, onRenamed, onDeleted, onMembers }: { project: Project; onRenamed: (p: Project) => void; onDeleted: (d: Exclude<Deleted, null>) => void; onMembers: () => void }) {
  const t = useT()
  const { copy } = useCopy()
  const remove = useDeleteProject()
  const renameProject = useRenameProject()
  // the item goes with the menu: the keyboard waits on "…", and a dialog an item opens gives it back there
  const more = useRef<HTMLButtonElement>(null)
  const select = (fn: () => unknown) => () => {
    more.current?.focus()
    void fn()
  }
  const rename = async () => {
    const r = await renameProject(p)
    if (r) onRenamed(r)
  }
  const copyLink = async () => {
    await copy(projectLink(p.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const items: MenuItem[] = [
    ...(mayManage(p) ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: select(rename), testId: 'project-card-rename' }] : []),
    ...(p.membersEditable ? [{ label: t('projects.participants'), icon: <Users size={14} aria-hidden />, onSelect: select(onMembers), testId: 'project-card-members' }] : []),
    { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: select(copyLink), testId: 'project-card-copy-link' },
    ...(mayManage(p) ? [{ label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: select(() => remove(p).then((d) => d && onDeleted(d))), testId: 'project-card-delete' }] : []),
  ]
  return (
    <MenuButton
      label={t('rooms.menu.rowLabel', { name: p.name })}
      tip={t('rooms.menu.label')}
      items={items}
      sheetTitle={p.name}
      // in line with the name's first line, its right edge at the card's padding
      className="absolute top-3.5 right-2.5"
      // phones: its size, in line with the name; taps from a 44 px box around it
      compact
      buttonClassName="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100"
      buttonRef={more}
      testId="project-card-menu"
    />
  )
}

/** A card's lines under the name: who sees the project, in its 멤버 line's words (and "in the trash" while it is), and
 * its instructions' first paragraph as plain text in two lines' room, also when it is shorter or there is none
 * ("지침이 없어요.", faint). A project whose contents I may not see (Project.member false: the owner or an admin who is
 * not a member) comes without its instructions, so in their place a lock and "멤버만 내용을 볼 수 있어요." (faint); one
 * in the trash says nothing there (nobody sees its contents then, and its line above says it is in the trash). */
function ProjectCardLines({ project: p }: { project: Project }) {
  const t = useT()
  const who = whoSeesProject(t, p, 'projects.whoMembers')
  const hidden = p.member === false
  const about = !hidden && p.instructions ? firstParagraph(p.instructions) : ''
  const none = hidden ? (
    p.inTrash ? null : (
      <>
        <Lock size={12} className="mr-1 inline-block align-[-1px]" aria-hidden />
        {t('projects.cardMembersOnly')}
      </>
    )
  ) : (
    t('projects.noInstructions')
  )
  return (
    <>
      {(who || p.inTrash) && (
        <span className="mt-1 block truncate text-xs text-faint" data-testid="project-card-who">
          {who}
          {p.inTrash && <span data-testid="project-card-state">{who ? ' · ' : ''}{t('chat.project.inTrash')}</span>}
        </span>
      )}
      {/* 'block' would cancel line-clamp's display */}
      <span className={`mt-2 line-clamp-2 min-h-[2lh] text-sm ${about ? 'text-muted' : 'text-faint'}`} data-testid="project-card-about">{about || none}</span>
    </>
  )
}

export function ProjectList() {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // ?new=1 (from Search's "New project") opens the form at once; closing it drops the parameter
  const [params, setParams] = useSearchParams()
  const [creating, setCreatingState] = useState(params.get('new') === '1')
  const setCreating = (v: boolean) => {
    setCreatingState(v)
    if (!v && params.has('new')) setParams((p) => { p.delete('new'); return p }, { replace: true })
  }
  const navigate = useNavigate()
  // the members dialog of a card's ⋯ 멤버
  const [members, setMembers] = useState<Project | null>(null)
  // a card deleted from its menu: the keyboard goes on to the next card (or "New project" after the last one)
  const { box, removed } = useFocusAfterRemove(items, () => document.querySelector<HTMLElement>('[data-testid="project-new"]'))
  const load = async () => {
    try {
      // manage=1: the owner and admins also get the team projects they manage without being members (pickers elsewhere
      // never ask for those)
      const items = (await api.call(API.listProjects, { query: { manage: '1' } })).items
      useProjects.getState().put(...items)
      setItems(items)
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title={t('projects.title')}
        desc={t('projects.desc')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="project-new">
            <Plus size={15} aria-hidden /> {t('projects.new')}
          </Button>
        }
      />
      <div ref={box} className={`${pageColumn} p-4 sm:p-6`}>
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {items && !items.length && <EmptyState icon={<FolderKanban size={28} />} title={t('projects.empty')} />}
        {/* the cells of a row stretch to its tallest card, and each card fills its cell */}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((p, i) => (
            <li key={p.id} className="group relative" data-testid="project-card">
              {/* the card stays marked while its "…" menu is open */}
              <Link to={`/projects/${p.id}`} className="block h-full rounded-2xl border border-line bg-surface p-4 transition group-has-[[aria-expanded=true]]:bg-hover hover:bg-hover" data-row-focus>
                {/* clear of the "…" in the card's corner; the icon stays on the first line of a long name */}
                <span className="flex items-start gap-2 pr-8 font-medium">
                  <FolderKanban size={16} className="mt-1 shrink-0 text-accent-text" aria-hidden /> <span className="min-w-0 break-words">{p.name}</span>
                </span>
                <ProjectCardLines project={p} />
              </Link>
              <ProjectCardMenu
                project={p}
                onRenamed={(r) => setItems((xs) => xs && xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)))}
                onDeleted={(d) => {
                  // in the trash: the card stays, saying so
                  if (d !== 'gone') return setItems((xs) => xs && xs.map((x) => (x.id === d.id ? d : x)))
                  removed(i)
                  setItems((xs) => xs && xs.filter((x) => x.id !== p.id))
                }}
                onMembers={() => setMembers(p)}
              />
            </li>
          ))}
        </ul>
      </div>
      {creating && <ProjectForm onClose={() => setCreating(false)} onSaved={(p) => navigate(`/projects/${p.id}`)} />}
      {/* the card as the server sees it now (an owner or admin who added or took out themselves: its instructions come or go) */}
      {members && <ProjectMembersDialog project={members} onClose={() => setMembers(null)} onSaved={(r) => setItems((xs) => xs && xs.map((x) => (x.id === r.id ? r : x)))} />}
    </div>
  )
}

/** A chat on a project's page: its title and when it last changed. A shared chat has the people icon before the title
 * and the faces of the people who wrote in it before the time (ChatFaces: one person with the name); a chat of mine
 * has neither. The title gives way first: the faces and the time keep their room. Its "···" holds the sidebar row's
 * items by the same rules (components/chat/chatMenuItems.tsx): pin, 링크 복사, rename, move, delete; a bottom sheet on
 * a phone. */
export function ProjectChatRow({ chat: c, onMove, onChanged, onRemoved }: { chat: Chat; onMove?: (c: Chat) => void; onChanged?: (c: Chat) => void; onRemoved?: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  // the row's keyboard focus shows the names on the faces (they take no focus of their own inside the link)
  const row = useRef<HTMLAnchorElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  // the keyboard waits on "…" after an item (a dialog it opens gives it back there)
  const items = useChatMenuItems(c, { testId: 'project-chat', more, select: (fn) => () => (more.current?.focus(), void fn()), onMove, onChanged, onRemoved })
  return (
    <div className="group relative">
    <Link ref={row} to={`/c/${c.id}`} className="group -mx-2 flex items-center gap-4 rounded-md py-3 pr-10 pl-2 text-sm hover:bg-hover max-md:pr-12" data-shared={c.shared ? 'true' : undefined} data-testid="project-chat">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {c.pinnedAt && <Pin size={12} role="img" aria-label={t('chat.pinned')} className="shrink-0 text-faint" data-testid="chat-pin-icon" />}
        {c.shared && <SharedIcon className="text-faint" />}
        <span className="truncate">{c.title || t('chat.untitled')}</span>
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-xs text-faint">
        {c.shared && (
          <>
            <ChatFaces shared={c.shared} focusFrom={row} />
            <span aria-hidden>·</span>
          </>
        )}
        <span className="shrink-0">{formatRelative(c.updatedAt, locale)}</span>
      </span>
    </Link>
    <MenuButton
      label={t('rooms.menu.rowLabel', { name: c.title || t('chat.untitled') })}
      tip={t('rooms.menu.label')}
      items={items}
      sheetTitle={c.title || t('chat.untitled')}
      // centred by flex, not a transform: a transform here would hold the phone's fixed bottom sheet inside this box
      className="absolute inset-y-0 right-0 flex items-center"
      buttonClassName="touch-hit pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-has-[:focus-visible]:opacity-100 aria-expanded:opacity-100 focus-visible:opacity-100"
      buttonRef={more}
      testId="project-chat-menu"
    />
    </div>
  )
}

export function ProjectHome() {
  const t = useT()
  const locale = useLocale()
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [p, setP] = useState<Project | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chats, setChats] = useState<Chat[] | null>(null)
  // failed: the folder could not be read (a network error); the line then says no count rather than a wrong one
  const [files, setFiles] = useState<{ entries: FileEntry[]; more: boolean; failed?: boolean } | null>(null)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  // a chat row's ⋯ 프로젝트 변경
  const [moving, setMoving] = useState<Chat | null>(null)
  // 나를 멤버로 추가 or 되돌리기 under way
  const [busy, setBusy] = useState<'join' | 'restore' | null>(null)
  // 되돌리기 refused because its folder was deleted for good from the trash meanwhile: no 되돌리기 any more (it would
  // only be refused again), 완전히 삭제 stays
  const [purged, setPurged] = useState(false)
  // the members dialog: 관리 on the 멤버 line, or ?members=1 (the AI's link to it)
  const [params, setParams] = useSearchParams()
  const [members, setMembersState] = useState(false)
  const setMembers = (v: boolean) => {
    setMembersState(v)
    if (!v && params.has('members')) setParams((x) => { x.delete('members'); return x }, { replace: true })
  }
  const me = useMe()
  // a personal project (users/<me>/...) becomes a team project: a new projects/<name> with the people chosen, its files
  // copied there (docs/DECISIONS.md "Projects live only in projects/"); not when the team lets only admins make them
  const personal = !!p && !!me && p.folderPath.startsWith(`users/${me.user.id}/`) && (isAdmin(me) || me.team.projectCreators === 'members')

  /** the latest load only may fill the page (another project's page, or a load after a change, started later) */
  const loads = useRef(0)
  /**
   * The project, its chats (mine, and the shared ones I see) and its files. manage=1 (the default): the owner and
   * admins also get a team project they are not members of (Project.member false: no files then, and the server lists
   * only my own chats in it); `manage` false once I am a member (after 나를 멤버로 추가).
   */
  const load = (o: { manage?: boolean } = {}) => {
    const mine = ++loads.current
    const live = () => mine === loads.current
    api.call(API.getProject, { params: { id: projectId! }, ...(o.manage === false ? {} : { query: { manage: '1' } }) }).then(
      (x) => {
        if (!live()) return
        setP(x)
        setMissing(false)
        setError(null)
        useProjects.getState().put(x)
        api.call(API.listChats, { query: { projectId: x.id, limit: 50 } }).then((r) => live() && setChats(r.items), () => live() && setChats([]))
        if (x.member === false) setFiles(null)
        else api.call(API.tree, { query: { path: x.folderPath, limit: 100 } }).then((r) => live() && setFiles({ entries: r.entries, more: !!r.nextCursor }), () => live() && setFiles({ entries: [], more: false, failed: true }))
      },
      (e) => {
        if (!live()) return
        if (isApiError(e, 'not_found')) setMissing(true)
        else setError(errorText(e, locale, t('error.network')))
      },
    )
  }

  useEffect(() => {
    setP(null)
    setChats(null)
    setFiles(null)
    setMissing(false)
    setError(null)
    setPurged(false)
    // another project's page (back and forward): no dialog of the one before
    setMembersState(false)
    setEditing(false)
    load()
    return () => {
      loads.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // the list follows chat events (store/live.ts chatChanged; the server sends each person only the chats they see): a
  // chat of this project made, renamed or restored shows, one deleted, moved away or no longer visible to me goes. The
  // faces of who wrote in a shared chat come with the list only, so a row keeps the ones it had
  useEffect(() => chatChanged.on(({ chatId, change, chat }) => {
    setChats((cur) => {
      if (!cur) return cur
      const old = cur.find((c) => c.id === chatId)
      const rest = cur.filter((c) => c.id !== chatId)
      if (change === 'deleted' || change === 'purged' || !chat || chat.deletedAt || chat.projectId !== projectId) return old ? rest : cur
      const next = keepFaces(old, chat)
      return [next, ...rest].sort(chatOrder)
    })
  }), [projectId])

  // a row's rename, pin or move, without waiting for its chat event: the row as it is now, in its place (a pin moves it
  // up); moved to another project, it goes
  const chatHere = (chat: Chat) => setChats((cur) => {
    if (!cur) return cur
    const old = cur.find((c) => c.id === chat.id)
    const rest = cur.filter((c) => c.id !== chat.id)
    if (!old || chat.projectId !== projectId) return rest
    const next = keepFaces(old, chat)
    return [next, ...rest].sort(chatOrder)
  })

  // ?members=1 opens the members dialog once the project is here, for whoever may change them; otherwise it goes
  useEffect(() => {
    if (!p || params.get('members') !== '1') return
    if (p.membersEditable) setMembersState(true)
    else setParams((x) => { x.delete('members'); return x }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.id, p?.membersEditable, params])

  // in the trash with its folder, the owner and admins stay on its page (it says so); deleted for good, or no longer
  // mine to see (its creator after the trash): back to the list
  const remove = useDeleteProject()
  const del = async () => {
    if (!p) return
    const d = await remove(p)
    if (d === 'gone') navigate('/projects')
    else if (d) load()
  }
  const renameProject = useRenameProject()
  const rename = async () => {
    const r = p && (await renameProject(p))
    if (r) setP(r)
  }

  // 나를 멤버로 추가 (docs/DECISIONS.md "Project contents only for members"): the members as they are now and me, saved
  // as the members dialog saves them (the rules hash read now; 409 when someone changed them meanwhile: the page as it
  // is now, and why). Its members are told; the page loads again as a member's.
  const addMe = async () => {
    if (!p || !me || busy) return
    if (!(await confirmAddMe(t, p.name))) return
    setBusy('join')
    try {
      const a = await api.call(API.getProjectAccess, { params: { id: p.id } })
      const participants = [...chosenOf(a).filter((x) => !(x.subjectType === 'user' && x.subjectId === me.user.id)), { subjectType: 'user' as const, subjectId: me.user.id }]
      await api.call(API.putProjectParticipants, { params: { id: p.id }, body: { participants, expectedHash: a.rulesHash } })
      load({ manage: false })
    } catch (e) {
      if (isApiError(e, 'conflict') && e.body.params?.reason === 'rules_changed') load()
      const refused = refusalKey(e, 'project')
      toast({ level: 'error', text: refused ? t(refused) : errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }

  // 되돌리기: the project and its folder back from the trash (the owner and admins; its folder purged meanwhile: the
  // server's words, 409 project_folder_purged, and 되돌리기 goes)
  const restore = async () => {
    if (!p || busy) return
    setBusy('restore')
    try {
      const r = await api.call(API.restoreProject, { params: { id: p.id } })
      useProjects.getState().put(r)
      setP(r)
      load()
    } catch (e) {
      if (isApiError(e, 'conflict') && e.body.params?.reason === 'project_folder_purged') setPurged(true)
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }

  // the members dialog saved: an owner or admin who added or took out themselves loads the page again (its files,
  // instructions and the others' chats come or go)
  const membersSaved = (next: Project) => {
    if ((next.member === false) !== (p?.member === false)) load({ manage: next.member === false })
    else setP(next)
  }

  if (missing) return <EmptyState title={t('projects.missing')}><Link to="/projects" className="text-accent-text underline">{t('projects.title')}</Link></EmptyState>
  if (error) return <div className="p-6"><ErrorNote>{error}</ErrorNote></div>
  if (!p) return <Skeleton lines={6} className="p-6" />
  // the owner or an admin on a team project they are not a member of (or one in the trash, which nobody reads): its
  // name, its members, their own chats in it; nothing of its contents
  const outside = p.member === false
  const summary = firstParagraph(p.instructions)
  const folderLink = `/files?path=${encodeURIComponent(p.folderPath)}`
  const sideAction = 'rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-ink'
  // a team project in place has members (a personal one is mine alone; one in the trash is nobody's until restored)
  const hasMembers = !p.folderPath.startsWith('users/') && !p.inTrash
  // in the trash: no name menu (its note has 되돌리기 and 완전히 삭제; renaming it is not needed there)
  const menu = p.inTrash
    ? null
    : outside
      ? mayManage(p)
        ? [
            { label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void rename(), testId: 'project-rename' },
            { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'project-delete' },
          ]
        : null
      : p.canEdit
        ? [
            { label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true), testId: 'project-edit' },
            ...(personal ? [{ label: t('projects.share'), icon: <Share2 size={14} aria-hidden />, onSelect: () => setSharing(true), testId: 'project-share' }] : []),
            { label: t('common.delete'), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'project-delete' },
          ]
        : null
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* like Claude's project page: where you are, with the few things you rarely do behind the name; it stays at the
          top while the page scrolls */}
      <StickyHeader bar className="flex h-12 shrink-0 items-center border-b border-line px-4 sm:px-6" testId="project-topline">
        <nav aria-label={t('files.breadcrumb')} className="flex min-w-0 items-center gap-1.5 text-sm">
          {/* phones: the top bar above says 프로젝트, with its ‹ (components/PhoneTopBar.tsx) */}
          <Link to="/projects" className="shrink-0 text-muted hover:text-ink max-md:hidden">
            {t('projects.title')}
          </Link>
          <span className="text-faint max-md:hidden" aria-hidden>
            /
          </span>
          {menu ? (
            <TitleMenu name={p.name} testId="project-menu" items={menu} />
          ) : (
            <span aria-current="page" className="truncate">
              {p.name}
            </span>
          )}
        </nav>
      </StickyHeader>
      <div className="mx-auto w-full max-w-[1080px] px-4 pt-8 pb-12 sm:px-6 sm:pt-10">
        <h1 className="text-[1.625rem] font-semibold tracking-tight break-words sm:text-[1.875rem]">{p.name}</h1>
        {summary && (
          <p className="mt-1.5 line-clamp-2 max-w-3xl text-sm text-muted" data-testid="project-summary">
            {summary}
          </p>
        )}
        {/* phone: the box, then the side lines, then the chats; wide: the chats under the box, the lines beside them */}
        <div className="mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]">
          <div className="min-w-0 lg:col-start-1">
            {/* a project whose folder is in the trash takes no chat: the note says so, with what the owner and admins
                can do; a project I manage without being a member: one quiet block in place of the box */}
            {p.inTrash ? (
              <ProjectTrashNote project={p}>
                {isAdmin(me) && !purged && (
                  <Button size="sm" busy={busy === 'restore'} onClick={() => void restore()} data-testid="project-restore">
                    <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
                  </Button>
                )}
                {mayManage(p) && (
                  <Button size="sm" variant="ghost-danger" onClick={() => void del()} data-testid="project-delete-for-good">
                    {t('projects.deleteForGood')}
                  </Button>
                )}
              </ProjectTrashNote>
            ) : outside ? (
              <div className="rounded-2xl border border-line px-4 py-4 text-sm sm:px-5" data-testid="project-members-only">
                <p className="break-keep text-muted">{t('projects.membersOnly')}</p>
                {p.membersEditable && (
                  <Button size="sm" className="mt-3" busy={busy === 'join'} onClick={() => void addMe()} data-testid="project-add-me">
                    <UserPlus size={14} aria-hidden /> {t('projects.addMe')}
                  </Button>
                )}
              </div>
            ) : (
              <NewChatComposer projectId={p.id} project={p} onMembers={() => setMembers(true)} placeholder={t('projects.newChat')} />
            )}
          </div>
          {(!outside || hasMembers) && (
            <aside aria-label={t('projects.about')} className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
              <div className="divide-y divide-line">
                {!outside && (
                  <DisclosureRow
                    testId="project-instructions"
                    icon={<ScrollText size={16} />}
                    label={t('projects.instructions')}
                    // phones: the same 수정 as in the name's menu above, so not a second button here
                    action={p.canEdit ? <button type="button" className={`${sideAction} max-md:hidden`} onClick={() => setEditing(true)}>{t('common.edit')}</button> : undefined}
                  >
                    {p.instructions ? <Markdown text={p.instructions} className="text-sm! leading-6! prose-headings:text-sm!" /> : <p className="text-faint">{t('projects.noInstructions')}</p>}
                  </DisclosureRow>
                )}
                {!outside && (
                  <DisclosureRow
                    testId="project-files"
                    icon={<Folder size={16} />}
                    label={t('files.title')}
                    meta={files && !files.failed && (files.more ? t('projects.itemsMore', { n: files.entries.length }) : t('projects.items', { n: files.entries.length }))}
                    action={<Link to={folderLink} className={sideAction}>{t('projects.open')}</Link>}
                  >
                    {/* phones: the folder's path here, not as a line of its own under the rows */}
                    <p className="mb-2 truncate text-xs text-faint md:hidden" title={p.folderPath || t('files.root')}>{p.folderPath || t('files.root')}</p>
                    {!files && <Skeleton lines={3} />}
                    {files && !files.failed && !files.entries.length && <p className="text-faint">{t('files.emptyReadOnly')}</p>}
                    <ul className="-ml-2 space-y-0.5">
                      {files?.entries.slice(0, 30).map((f) => (
                        <li key={f.path}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-hover"
                            onClick={() => (f.type === 'folder' ? navigate(`/files?path=${encodeURIComponent(f.path)}`) : openTeamFile(f.path))}
                          >
                            {f.type === 'folder' ? <Folder size={14} className="shrink-0 text-accent-text" aria-hidden /> : <FileText size={14} className="shrink-0 text-faint" aria-hidden />}
                            <span className="truncate">{f.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {files && (files.more || files.entries.length > 30) && (
                      <Link to={folderLink} className="mt-1 inline-block text-xs text-accent-text hover:underline">
                        {t('projects.openFolder')}
                      </Link>
                    )}
                  </DisclosureRow>
                )}
                {hasMembers && <MembersRow project={p} sideAction={sideAction} onManage={() => setMembers(true)} />}
              </div>
              {!outside && (
                <p className="mt-3 truncate text-xs text-faint max-md:hidden" title={p.folderPath || t('files.root')}>
                  {p.folderPath || t('files.root')}
                </p>
              )}
            </aside>
          )}
          <section aria-labelledby="pj-chats" className="min-w-0 lg:col-start-1" data-testid="project-chats">
            {/* the sidebar's name for the AI's history ("트리나 기록"): one name for it on every screen */}
            <h2 id="pj-chats" className="mb-1 text-sm text-muted">
              {t('sidebar.aiChats', { name: aiName(t) })}
            </h2>
            {!chats && <Skeleton lines={3} />}
            {chats && !chats.length && <p className="py-2 text-sm text-faint">{t('projects.noChats')}</p>}
            <ul className="divide-y divide-line">
              {chats?.map((c) => (
                <li key={c.id}>
                  <ProjectChatRow chat={c} onMove={setMoving} onChanged={chatHere} onRemoved={(x) => setChats((cur) => cur && cur.filter((y) => y.id !== x.id))} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onSaved={setP} />}
      {members && <ProjectMembersDialog project={p} onClose={() => setMembers(false)} onSaved={membersSaved} />}
      {moving && <MoveToProjectDialog chat={moving} onClose={() => setMoving(null)} onMoved={(c) => { useChats.getState().upsertChat(c); chatHere(c) }} />}
      {sharing && <ShareProjectDialog project={p} onClose={() => setSharing(false)} onShared={(r) => { setP(r); useProjects.getState().put(r); toast({ level: 'success', text: t('files.shared', { path: r.folderPath }) }) }} />}
    </div>
  )
}

/** Who sees a project, by the rule of its page's 멤버 line (MembersRow below), for that line and for its card on the list,
 * so the two never differ. `own` words the count of its own people (the owner and admins): beside the 멤버 label just the
 * number ("3명"), on a card with the word ("멤버 3명"). Nothing from a server without the count. */
function whoSeesProject(t: ReturnType<typeof useT>, p: Project, own: 'projects.membersN' | 'projects.whoMembers'): string | undefined {
  if (p.audience === undefined) return undefined
  // a team project in projects/ is its members' (docs/DECISIONS.md "Project contents only for members"): its own count,
  // also for the owner or an admin who is not a member ("남은 멤버 없음" when nobody active is one, "나만 봐요" when I am)
  if (isProjectsFolder(p.folderPath)) return p.audience === 0 ? t('projects.noMembers') : p.member !== false && p.audience === 1 ? t('chat.whoMe') : t(own, { n: p.audience })
  const shared = { audience: p.audience, alone: p.alone }
  return whoSees(shared).kind === 'people' && p.audienceSplit ? t(own, { n: p.audienceSplit.direct }) : whoSeesText(t, shared, 'project')
}

/** The 멤버 line of a team project's page: who sees it (whoSeesProject). A team project in projects/ is its members'
 * (docs/DECISIONS.md "Project contents only for members"): "나만 봐요" when I am its only member, else how many ("3명";
 * "남은 멤버 없음" when nobody active is one), also for the owner or an admin who is not a member. A project made before
 * outside projects/ says it in the words and by the rule of the line under the box (components/chat/WhoSees.tsx
 * whoSeesText, docs/DECISIONS.md "Who sees it, always"): "나만 봐요", "나와 관리자만 봐요" (Project.alone), else its people
 * by its rules for the owner and admins ("3명", Project.audienceSplit) or the total. Whoever may change its members gets
 * 관리 (the members dialog) and nothing to open; anyone else opens the line to read who changes them: the creator by
 * name only while they can (Project.creatorChangesMembers: their account active, the folder theirs), else 관리자 (never
 * an admin's name). An admin on a project made before on another folder reads where to change it instead. */
export function MembersRow({ project: p, sideAction, onManage }: { project: Project; sideAction: string; onManage: () => void }) {
  const t = useT()
  const me = useMe()
  const inProjects = isProjectsFolder(p.folderPath)
  const meta = whoSeesProject(t, p, 'projects.membersN')
  if (p.membersEditable)
    return (
      <DisclosureRow
        testId="project-members"
        icon={<Users size={16} />}
        label={t('projects.participants')}
        meta={meta}
        action={<button type="button" className={sideAction} onClick={onManage} data-testid="project-members-manage">{t('projects.manage')}</button>}
      />
    )
  // an admin: where its members are changed instead (a project made before outside projects/, with the link; or one
  // whose folder is not there)
  const admin = isAdmin(me)
  return (
    <DisclosureRow testId="project-members" icon={<Users size={16} />} label={t('projects.participants')} meta={meta}>
      {admin ? (
        <p className="text-sm leading-6 break-keep text-muted" data-testid="project-members-hint">
          {inProjects ? t('projects.membersFolderMissing') : (
            <>
              {t('projects.legacyNote')}{' '}
              <Link to={`/admin/folders?folder=${encodeURIComponent(p.folderPath)}`} className="text-accent-text underline">{t('projects.otherRulesLink')}</Link>
            </>
          )}
        </p>
      ) : (
        <p className="text-sm leading-6 break-keep text-muted" data-testid="project-members-hint">
          {p.creatorChangesMembers && p.createdBy ? t('projects.membersByCreator', { name: p.createdBy.name }) : t('projects.membersByAdmins')}
        </p>
      )}
    </DisclosureRow>
  )
}

/** "팀 프로젝트로 공유": a personal project becomes a team project in a new projects/<name>, seen by the people chosen
 * here (and me, the owner and admins); its files are copied there and my personal folder stays. */
function ShareProjectDialog({ project, onClose, onShared }: { project: Project; onClose: () => void; onShared: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const options = useParticipantOptions()
  const fixed = useMemo(() => new Map(me ? [[participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.whoMe')]] : []), [me, t])
  const count = useAccessCount(participants, { enabled: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const share = async (skillsOk = false) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.call(API.shareProject, { params: { id: project.id }, body: { participants, ...(skillsOk ? { skillsOk } : {}) } })
      if ('id' in r) onShared(r)
      onClose()
    } catch (e) {
      // its skills/ holds skills: copied into projects/<name> they switch on in this project's chats once the person says yes
      const skills = projectSkillsOn(e)
      if (skills && !skillsOk) {
        setBusy(false)
        if (await confirmDialog({ title: t('files.skillsOnTitle'), body: t('projects.skillsOnBody', { n: skills.length, names: skills.join(', ') }), confirm: t('projects.shareConfirm') })) await share(true)
        return
      }
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={t('projects.shareTitle')} width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void share()} data-testid="project-share-confirm">{t('projects.shareConfirm')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm break-keep text-muted">{t('projects.shareBody')}</p>
        <MembersField label={t('projects.participants')}>
          <div className="space-y-2">
            <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} />
            <AccessSummary count={count} />
          </div>
        </MembersField>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
