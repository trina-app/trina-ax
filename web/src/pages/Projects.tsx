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
// chats there come first, the most recently pinned first, with the pin before the title, as in the history (docs/DECISIONS.md
// "Pinned chats"). A chat row's "···" has the history row's items by the same rules (components/chat/chatMenuItems.tsx).
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
// Phones (below 768 px): /projects is the 프로젝트 tab's own list, the same as the computer's panel
// (panels/ProjectsPanel.tsx; docs/DECISIONS.md "Projects: a place of their own"): "+ 새 프로젝트" on top, then each project
// with when it was last active and how many chats of mine it holds. A project's page has one bar, "‹ 프로젝트 · name ·
// ···" (the name in the bar's title, the name's menu as the bar's "···" sheet; the big name for screen readers only); its
// files line is one row that opens the project's files on a screen of the 프로젝트 tab (ProjectFiles below,
// /projects/:id/files, with no folder path line), so Back returns to the project.
import { ArchiveRestore, ChevronRight, FileText, FolderKanban, Folder, FolderOpen, Import, Link2, Lock, Pencil, Pin, Plus, ScrollText, Trash2, UserPlus, Users, X } from 'lucide-react'
import { foldRuns, runsUnread, TaskRunsIcon, TaskRunsMark, taskRunsAttrs, taskRunsPath, type Run } from '../components/nav/TaskRunsRow'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { scheduleName } from '../lib/scheduleText'
import { useSessionMarkers } from '../store/sessionMarkers'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Chat, FileEntry, Project, ProjectParticipant, TreeResponse } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { formatRelative } from '../lib/format'
import { RAIL_STATE_KEY } from '../lib/rail'
import { firstParagraph } from '../lib/markdown'
import { openTeamFile } from '../lib/sidePanel'
import { aiName } from '../lib/tabs'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { projectSkillsOn } from '../lib/bulkFiles'
import { useChats } from '../store/chats'
import { isUnused } from '../components/chat/ChatState'
import { accessChanged, chatChanged, reloadAsked } from '../store/live'
import { chatTrashDays } from '../lib/chat-trash'
import { hideProject, keepPendingProject, readManagedList, showProject, unhideProject, useProjects } from '../store/projects'
import { optimistic, optimisticPending } from '../lib/optimistic'
import { chatOrder, folderMoved, keepFaces, useProjectPage, withChatEvent } from '../store/projectPage'
import { FOLDER_PAGE, keptFolder, readFolder } from '../store/teamFiles'
import { isAdmin, useMe } from '../store/session'
import { Markdown } from '../components/Markdown'
import { DisclosureRow } from '../components/DisclosureRow'
import { ListRow } from '../components/list/List'
import { TitleMenu } from '../components/TitleMenu'
import { NewChatComposer } from '../components/chat/NewChatComposer'
import { forgetPrivateAsk, usePrivateAsk } from '../components/chat/privateAsk'
import { mayShareChat, openShareChat } from '../components/chat/ShareChat'
import { ChatFaces, PrivateIcon, SharedIcon, otherWriters } from '../components/chat/SharedChat'
import { whoSeesProject } from '../components/projectWho'
import { useChatMenuItems } from '../components/chat/chatMenuItems'
import { MoveToProjectDialog } from '../components/chat/ChatProject'
import { MenuButton, type MenuItem } from '../components/rooms/MenuButton'
import { ProjectForm } from '../components/ProjectForm'
import { NewProjectDialog } from '../components/NewProjectDialog'
import { onlyMine } from '../components/panels/ProjectsPanel'
import { NewProjectRow, ProjectsList } from '../components/panels/ProjectsPanel'
import { ProjectMembersDialog, chosenOf, confirmAddMe, projectNow } from '../components/ProjectMembersDialog'
import { PeopleStack, useProjectPeople } from '../components/ProjectPeople'
import { IncludesGuests } from '../components/GuestTag'
import { usePeopleList } from '../store/people'
import { guestProject, isGuestMe } from '../lib/guests'
import { GuestProjectNote, useGuestAiOff } from '../components/GuestView'
import { isProjectsFolder } from '../lib/projectFolders'
import { isTeamProject, noLongerMemberOf, privateInTeamProject, refusalKey } from '../lib/sharedChat'
import { AccessSummary, MembersField, ParticipantPicker, participantKey, useAccessCount, useParticipantOptions } from '../components/ProjectParticipants'
import { ProjectTrashNote } from '../components/ProjectTrashNote'
import { leaveItems, useLeaveProject } from '../components/LeaveProject'
import { Button, EmptyState, ErrorNote, Modal, PageHeader, Skeleton, StickyHeader, confirmDialog, menuOpener, pageColumn, promptDialog, useCopy, useMediaQuery } from '../components/ui'
import { PhoneBarAction, PhoneBarTitle } from '../components/phone/PhoneBarAction'
import { Tooltip } from '../components/Tooltip'
import { FileDropZone } from '../components/FileDropZone'
import { useFocusAfterRemove } from './admin/common'

const PHONE = '(max-width: 767.98px)'

/** The address of a project's page (the app's own route; someone who cannot see the project gets "not found"). */
const projectLink = (id: string) => `${typeof location === 'undefined' ? '' : location.origin}/projects/${id}`

/** Who may rename and delete it, also without reading it (Project.canManage; older servers: whoever may edit it). */
const mayManage = (p: Project) => p.canManage ?? p.canEdit
/** Delete is offered only where the server takes it (Project.canDelete: a member's older project on an admin's folder
 * is an admin's to delete, QA TC-1016) */
const mayDelete = (p: Project) => p.canDelete ?? mayManage(p)

/** The menu item that deletes it says what it does (QA TC-1064): a team project in projects/ goes to the trash ("Move to
 * trash", as its confirm asks); in the trash, or any other project, "Delete". */
const deleteLabel = (t: ReturnType<typeof useT>, p: Project) => t(isProjectsFolder(p.folderPath) && !p.inTrash ? 'projects.moveToTrash' : 'common.delete')

/** What deleting did: `gone` (deleted for good, or not found any more), the project in the trash now (a team project in
 * projects/ the caller still manages: the owner and admins), or null (cancelled, refused). */
export type Deleted = 'gone' | Project | null

/**
 * A team project into the trash, or back out of it, at once (lib/optimistic.ts, key `project:<id>:trash`): the owner
 * and admins keep its card and its page, saying it is in the trash; anyone else's card goes. `onShown` gets what is on
 * screen each time it changes ('gone': not on the list any more). A refusal puts it back with the server's words.
 * The answer: the project as the server has it now (null: not the caller's to see any more).
 */
function trashProject(p: Project, trashed: boolean, keeps: boolean, onShown?: (now: Project | 'gone') => void, failText?: false) {
  let at = -1
  // a member keeps its card in the trash (Project.wasMember; QA TC-1060), and so does whoever restores it
  const shown = (inTrash: boolean): Project | 'gone' => (inTrash && !keeps ? 'gone' : { ...p, inTrash, ...(inTrash && p.member !== false ? { wasMember: true as const } : {}) })
  return optimistic<boolean, Project | null>({
    key: `project:${p.id}:trash`,
    from: !!p.inTrash,
    to: trashed,
    show: (inTrash) => {
      const now = shown(inTrash)
      if (now === 'gone') at = hideProject(p.id)
      else if (at >= 0 || !useProjects.getState().managed?.some((x) => x.id === p.id)) unhideProject(now, at)
      else showProject(now)
      onShown?.(now)
    },
    send: async () => {
      if (trashed) await api.call(API.deleteProject, { params: { id: p.id } })
      else return api.call(API.restoreProject, { params: { id: p.id } })
      // in the trash with its folder: the owner and admins still have it (to restore or delete for good); its private
      // chats keep it
      return projectNow(p.id).catch(() => null)
    },
    confirmed: (r) => (r ? !!r.inTrash : trashed),
    settle: (r) => {
      if (r) {
        useProjects.getState().put(r)
        // a card taken off the list for someone the server still shows it to: back in its place
        if (at >= 0) unhideProject(r, at)
        onShown?.(r)
      } else {
        useProjects.getState().drop(p.id, true)
        onShown?.('gone')
      }
    },
    failText,
  })
}

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
export function useDeleteProject() {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const days = chatTrashDays(me)
  const deleted = (id: string) => {
    useProjects.getState().drop(id, true)
    // the server took the project off its private chats (its shared chats go to the trash with their own event): the
    // history must not offer "프로젝트 바꾸기…" for a project that is not there any more
    useChats.setState((s) => ({ chats: s.chats.map((c) => (c.projectId === id && !c.shared ? { ...c, projectId: null } : c)) }))
  }
  // not found: deleted by someone else, or no longer mine to see (then my chats keep it, as the server does)
  const missing = (id: string) => {
    useProjects.getState().drop(id, true)
    toast({ level: 'info', text: t('projects.missing') })
  }
  /** `onShown`: the trash shows at once (a team project in projects/): what is on screen each time it changes */
  return async (p: Project, onShown?: (now: Project | 'gone') => void): Promise<Deleted> => {
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
        ? {
            title: t('projects.deleteForGoodTitle', { name: now.name }),
            // its shared chats go to their creators' trash (routes/chats.ts deleteProject; QA TC-1063)
            body: now.sharedChats ? (
              <>
                {t('projects.deleteForGoodBody')}
                <span className="mt-2 block" data-testid="project-delete-shared">{t('projects.deleteForGoodShared', { days, trash: t('sidebar.trash') })}</span>
              </>
            ) : t('projects.deleteForGoodBody'),
            confirm: t('projects.deleteForGood'),
          }
        : { title: t('projects.deleteTitle', { name: now.name }), body: now.sharedChats ? t('projects.deleteBodyShared', { days, trash: t('sidebar.trash') }) : now.folderPath.startsWith('users/') ? t('projects.deletePersonal') : t('projects.deleteBody'), confirm: t('common.delete') }
    if (!(await confirmDialog({ ...ask, danger: true }))) return null
    if (toTrash) {
      // at once (deleting for good and any other delete wait: they cannot be taken back)
      // its members and whoever manages it keep it, In trash (the Projects list shows it to its members only)
      const r = await trashProject(now, true, true, onShown, false)
      if (!r.ok) {
        if (!r.newest) return null
        // someone else deleted it first
        if (isApiError(r.error, 'not_found')) {
          missing(p.id)
          onShown?.('gone')
          return 'gone'
        }
        toast({ level: 'error', text: errorText(r.error, locale, t('error.network')) })
        return null
      }
      return r.reply ?? 'gone'
    }
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
    deleted(p.id)
    return 'gone'
  }
}

/** A new name for a project: the chat rename's small prompt (name only, so also for the owner or an admin who is not a
 * member: never the edit dialog, which sends its instructions). On screen at once wherever the project is named
 * (lib/optimistic.ts, key `project:<id>:name`; `onName`: a page's own copy), back with the server's words when it
 * refuses. The project as saved (null: cancelled, refused, or renamed again meanwhile). */
function useRenameProject() {
  const t = useT()
  return async (p: Project, onName?: (name: string) => void): Promise<Project | null> => {
    const name = await promptDialog({ title: t('chat.rename'), label: t('projects.name'), initial: p.name, confirm: t('common.save') })
    if (!name || name === p.name) return null
    const r = await optimistic<string, Project>({
      key: `project:${p.id}:name`,
      from: p.name,
      to: name.trim(),
      show: (v) => {
        showProject({ ...(useProjects.getState().byId[p.id] ?? p), name: v })
        onName?.(v)
      },
      send: () => api.call(API.updateProject, { params: { id: p.id }, body: { name } }),
      confirmed: (r) => r.name,
      settle: (r) => {
        useProjects.getState().put(r)
        onName?.(r.name)
      },
    })
    return r.ok && r.newest ? r.reply : null
  }
}

/** A card's "…" on the list (components/rooms/MenuButton.tsx: arrow keys, Esc, a bottom sheet on phones). On a computer
 * it shows on hover and keyboard focus, on a touch screen always. A phone's row (`row`: useRowMenu's signals) has it
 * always, 44 px, before the chevron (as the AI chat rows in the 트리나 tab have theirs), and a long press opens it too. */
function ProjectCardMenu({ project: p, onRenamed, onDeleted, onMembers, row }: { project: Project; onRenamed: (p: Project) => void; onDeleted: (d: Exclude<Deleted, null>) => void; onMembers: () => void; row?: { openSignal: number; openRequest: number } }) {
  const t = useT()
  const phone = useMediaQuery(PHONE)
  const { copy } = useCopy()
  const remove = useDeleteProject()
  const renameProject = useRenameProject()
  const leaveProject = useLeaveProject()
  // the item goes with the menu: the keyboard waits on "…", and a dialog an item opens gives it back there; a "…" not on
  // screen (none should be) gives the keyboard to its row's link instead of losing it
  const more = useRef<HTMLButtonElement>(null)
  const focusBack = () => {
    const b = more.current
    if (b && b.offsetParent !== null) b.focus()
    else b?.closest('li')?.querySelector<HTMLElement>('[data-row-focus]')?.focus()
  }
  const select = (fn: () => unknown) => () => {
    focusBack()
    void fn()
  }
  const rename = async () => {
    const r = await renameProject(p)
    if (r) onRenamed(r)
  }
  const del = async () => {
    // (gone at once, then again with the answer: the keyboard moves on once)
    let gone = false
    const d = await remove(p, (now) => {
      if (now !== 'gone' || gone) return
      gone = true
      onDeleted('gone')
    })
    if (d && !(d === 'gone' && gone)) onDeleted(d)
  }
  const copyLink = async () => {
    await copy(projectLink(p.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const items: MenuItem[] = [
    ...(mayManage(p) ? [{ label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: select(rename), testId: 'project-card-rename' }] : []),
    ...(p.membersEditable ? [{ label: t('projects.participants'), icon: <Users size={14} aria-hidden />, onSelect: select(onMembers), testId: 'project-card-members' }] : []),
    { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: select(copyLink), testId: 'project-card-copy-link' },
    ...leaveItems(t, p, select(async () => { if (await leaveProject(p)) onDeleted('gone') }), 'project-card-leave'),
    // the trash shows at once: the card says so, or (not kept there for me) goes
    ...(mayDelete(p) ? [{ label: deleteLabel(t, p), icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: select(del), testId: 'project-card-delete' }] : []),
  ]
  if (row)
    return (
      <MenuButton
        label={t('rooms.menu.rowLabel', { name: p.name })}
        tip={t('rooms.menu.label')}
        items={items}
        sheetTitle={p.name}
        // in the room the row keeps for it before its chevron (phone/PhoneList.tsx): 44 px from the screen's edge
        className="absolute inset-y-0 right-11 flex items-center"
        buttonClassName="size-11 hover:bg-surface"
        buttonRef={more}
        focusBack={focusBack}
        openSignal={row.openSignal}
        openRequest={row.openRequest}
        testId="project-card-menu"
      />
    )
  return (
    <MenuButton
      label={t('rooms.menu.rowLabel', { name: p.name })}
      tip={t('rooms.menu.label')}
      items={items}
      sheetTitle={p.name}
      // in line with the name's first line, its right edge at the card's padding; phones: a 44 px button in the card's
      // corner (QA TC-254)
      className={phone ? 'absolute top-1 right-1' : 'absolute top-3.5 right-2.5'}
      compact={!phone}
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
  const me = useMe()
  // the list as last read (store/projects.ts managed): a visit after the first shows it at once and reads it again behind
  // it; only the very first read shows the skeleton (docs/DECISIONS.md "Projects and Files lists open at once")
  const items = useProjects((s) => s.managed)
  const setItems = useProjects((s) => s.setManaged)
  const [error, setError] = useState<string | null>(null)
  // ?new=1 (Search's "New project", the 트리나 list's + and "새 프로젝트") opens the form, also when the list is already
  // on screen, and leaves the address at once (as /rooms?new=1 does): dropping it only on close replaced the new
  // project's page that saving had just opened with the list again
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.get('new') === '1')
  const asked = params.get('new') === '1'
  useEffect(() => {
    if (!asked) return
    setCreating(true)
    setParams((p) => {
      p.delete('new')
      return p
    }, { replace: true })
  }, [asked, setParams])
  const navigate = useNavigate()
  // the members dialog of a card's ⋯ 멤버
  const [members, setMembers] = useState<Project | null>(null)
  // a card deleted from its menu: the keyboard goes on to the next card (or "New project" after the last one)
  const { box, removed } = useFocusAfterRemove(items, () => document.querySelector<HTMLElement>('[data-testid="project-new"]'))
  const load = async (fresh = false) => {
    try {
      // manage=1: the owner and admins also get the team projects they manage without being members (pickers elsewhere
      // never ask for those)
      await readManagedList({ fresh })
      setError(null)
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    }
  }
  const phone = useMediaQuery(PHONE)
  // a phone's /projects is the 프로젝트 tab's list (panels/ProjectsPanel.tsx), which reads the same list for an admin.
  // Read again when access changed or the live connection could not resume (no project events: a visit reads it too)
  useEffect(() => {
    if (phone) return
    void load()
    const offA = accessChanged.on(() => void load(true))
    const offB = reloadAsked.on(() => void load(true))
    return () => {
      offA()
      offB()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone])
  // a team project in the trash: its card stays for its members, "In trash" (Project.wasMember, QA TC-1060); the owner
  // and admins who are not members restore it from Files › Trash, so no card of it for them here (QA TC-1061)
  const shown = useMemo(() => items?.filter((p) => !p.inTrash || !!p.wasMember) ?? null, [items])
  const renamed = (r: Project) => setItems((xs) => xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)))
  const onDeleted = (p: Project, i: number) => (d: Exclude<Deleted, null>) => {
    // in the trash: the card stays, saying so
    if (d !== 'gone') return setItems((xs) => xs.map((x) => (x.id === d.id ? d : x)))
    removed(i)
    setItems((xs) => xs.filter((x) => x.id !== p.id))
  }
  if (phone)
    return (
      // a phone: the 프로젝트 tab's own list, the same as the computer's panel (its top bar says 프로젝트)
      <div className="flex h-full flex-col">
        <h1 className="sr-only">{t('projects.title')}</h1>
        <nav aria-label={t('projects.title')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-6" data-testid="phone-projects-list">
          <NewProjectRow phone />
          <div className="mt-2">
            <ProjectsList phone />
          </div>
        </nav>
        {creating && <NewProjectDialog onClose={() => setCreating(false)} onMade={(p) => navigate(`/projects/${p.id}`)} />}
      </div>
    )
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title={t('projects.title')}
        desc={t('projects.desc')}
        actions={
          // a guest makes no projects (lib/guests.ts: they are in one place only)
          !isGuestMe(me) && (
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="project-new">
              <Plus size={15} aria-hidden /> {t('projects.new')}
            </Button>
          )
        }
      />
      <div ref={box} className={`${pageColumn} p-4 sm:p-6`}>
        {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}
        {!items && !error && <Skeleton lines={4} />}
        {shown && !shown.length && <EmptyState screen icon={<FolderKanban size={28} />} title={t('projects.empty')} />}
        {/* the cells of a row stretch to its tallest card, and each card fills its cell */}
        {/* the same sections as 프로젝트's list (panels/ProjectsPanel.tsx): 팀 프로젝트, 내 프로젝트, then, quieter, the team
            projects the owner or an admin only manages (not a member: their name and members only) */}
        {(() => {
          const groups: { key: string; label: string; list: Project[]; quiet?: boolean }[] = [
            { key: 'team', label: t('projectsPanel.team'), list: (shown ?? []).filter((p) => (p.member !== false || p.inTrash) && !onlyMine(p)) },
            { key: 'mine', label: t('projectsPanel.mine'), list: (shown ?? []).filter((p) => p.member !== false && onlyMine(p)) },
            { key: 'other', label: t('projects.otherTeam'), list: (shown ?? []).filter((p) => p.member === false && !p.inTrash), quiet: true },
          ]
          return groups.filter((g) => g.list.length).map((g) => (
            <section key={g.key} aria-labelledby={`projects-${g.key}`} className="mt-6 first:mt-0" data-testid={`projects-section-${g.key}`}>
              <h2 id={`projects-${g.key}`} className={`mb-2 text-xs font-medium tracking-wide ${g.quiet ? 'text-faint' : 'text-muted'}`}>{g.label}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.list.map((p) => {
                  const i = items!.indexOf(p)
                  return (
                    <li key={p.id} className="group relative" data-testid="project-card">
                      {/* the card stays marked while its "…" menu is open */}
                      <Link to={`/projects/${p.id}`} className={`block h-full rounded-2xl border border-line p-4 transition group-has-[[aria-expanded=true]]:bg-hover hover:bg-hover ${g.quiet ? 'bg-subtle' : 'bg-surface'}`} data-row-focus>
                        {/* clear of the "…" in the card's corner; the icon stays on the first line of a long name */}
                        <span className="flex items-start gap-2 pr-8 font-medium max-md:pr-10">
                          <FolderKanban size={16} className="mt-1 shrink-0 text-accent-text" aria-hidden /> <span className="min-w-0 break-words">{p.name}</span>
                        </span>
                        <ProjectCardLines project={p} />
                      </Link>
                      <ProjectCardMenu project={p} onRenamed={renamed} onDeleted={onDeleted(p, i)} onMembers={() => setMembers(p)} />
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        })()}
      </div>
      {/* made here: on the list at once when the person comes back (the read behind it puts it in the server's place) */}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onMade={(p) => { setItems((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p])); navigate(`/projects/${p.id}`) }} />}
      {/* the card as the server sees it now (an owner or admin who added or took out themselves: its instructions come or go) */}
      {members && <ProjectMembersDialog project={members} onClose={() => setMembers(null)} onSaved={(r) => setItems((xs) => xs.map((x) => (x.id === r.id ? r : x)))} />}
    </div>
  )
}

/** A project page's chat list rows (a chat, a scheduled task's runs folded into one) are the lists' rows
 * (components/list/List.tsx ListRow) built the same way, at a page's density (`scale="page"`: 48px, the titles flush
 * with the heading above them, docs/DECISIONS.md "Page lists: page density"), so every title starts at one x in one size, weight and colour,
 * every row has one height, and every time ends at one x (QA TC-990): each keeps the "···" slot at its end whether it
 * has a menu or not (`rowMenu`, `menuSpace`), so the menu showing on hover moves nothing. What a row is (pinned, shared,
 * a scheduled task's clock) is a small mark after the title, never before it, so no mark moves a title off the list's
 * edge; how a chat stands (who wrote in it, how a task's runs went) is before its time. */
function projectRowName(title: string, marks?: ReactNode) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate" data-testid="project-row-title">{title}</span>
      {marks}
    </span>
  )
}
function ProjectRowEnd({ at, children }: { at: string; children?: ReactNode }) {
  const locale = useLocale()
  return (
    <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 self-center text-meta text-faint">
      {children}
      <time dateTime={at} className="shrink-0 tabular-nums">{formatRelative(at, locale)}</time>
    </span>
  )
}

/** A chat on a project's page: its title and when it last changed. A shared chat has the faces of the others who wrote
 * in it before the time (ChatFaces: one person with the name; docs/DECISIONS.md "Faces in every chat list"), or, while
 * nobody else wrote, the people icon after the title; a chat of mine has neither. The title gives way first: the faces
 * and the time keep their room. Its "···" holds the history row's items by the same rules
 * (components/chat/chatMenuItems.tsx): pin, 링크 복사, rename, move, delete; a bottom sheet on a phone. */
export function ProjectChatRow({ chat: c, project, onMove, onChanged, onRemoved }: { chat: Chat; project?: Project | null; onMove?: (c: Chat) => void; onChanged?: (c: Chat) => void; onRemoved?: (c: Chat) => void }) {
  const t = useT()
  // the row's keyboard focus shows the names on the faces (they take no focus of their own inside the link)
  const row = useRef<HTMLAnchorElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  // the keyboard waits on "…" after an item (a dialog it opens gives it back there)
  const items = useChatMenuItems(c, { testId: 'project-chat', more, select: (fn) => () => (more.current?.focus(), void fn()), onMove, onChanged, onRemoved })
  const name = c.title || t('chat.untitled')
  const faces = !!c.shared && !!otherWriters(c.shared)
  return (
    <ListRow
      scale="page"
      to={`/c/${c.id}`}
      state={{ [RAIL_STATE_KEY]: 'projects', chat: c }}
      rowRef={row}
      name={projectRowName(
        name,
        <>
          {c.pinnedAt && <Pin size={12} role="img" aria-label={t('chat.pinned')} className="shrink-0 text-faint" data-testid="chat-pin-icon" />}
          {c.shared && !faces && <SharedIcon className="text-faint" />}
          {/* my chat that only I see in a team project ("Only me", or from before): only its creator lists it */}
          {privateInTeamProject(c, project) && <PrivateIcon />}
        </>,
      )}
      end={
        <ProjectRowEnd at={c.updatedAt}>
          {faces && (
            <>
              <ChatFaces shared={c.shared!} focusFrom={row} page />
              <span aria-hidden>·</span>
            </>
          )}
        </ProjectRowEnd>
      }
      rowMenu={{ items, label: t('rooms.menu.rowLabel', { name }), tip: t('rooms.menu.label'), sheetTitle: name, buttonRef: more, testId: 'project-chat-menu' }}
      testId="project-chat"
      link={{ 'data-shared': c.shared ? 'true' : undefined }}
    />
  )
}

/** A scheduled task's runs started in this project as one row of its chat list (components/nav/TaskRunsRow.tsx): the
 * task's name with its clock after it, how its newest run went and that run's time; it opens the task's page. */
function ProjectTaskRow({ runs }: { runs: Run[] }) {
  const t = useT()
  const here = useSessionMarkers((s) => (s.visible ? s.onScreen : null))
  const unread = runsUnread(runs, here)
  return (
    <ListRow
      scale="page"
      to={taskRunsPath(runs)}
      unread={unread}
      menuSpace
      name={projectRowName(scheduleName(runs[0]!.schedule, t), <TaskRunsIcon />)}
      end={
        <ProjectRowEnd at={runs[0]!.updatedAt}>
          <TaskRunsMark runs={runs} />
        </ProjectRowEnd>
      }
      testId="task-runs-row"
      link={taskRunsAttrs(runs, unread)}
    />
  )
}

/** A project page's chats as read, with the rows a move out or a delete still on its way changed on screen (lib/
 * optimistic.ts keys `chat:<id>:project|trash`): as on screen, there or not. */
function keepPendingRows(items: Chat[], shown: Chat[] | null): Chat[] {
  const pending = (id: string) => optimisticPending(`chat:${id}:project`) || optimisticPending(`chat:${id}:trash`)
  if (!shown) return items
  const kept = items.flatMap((c) => (!pending(c.id) ? [c] : (shown.find((x) => x.id === c.id) ?? [])))
  const back = shown.filter((c) => pending(c.id) && !items.some((x) => x.id === c.id))
  return back.length ? [...kept, ...back].sort(chatOrder) : kept
}

/** The files line of a project's page: its folder's first page (`failed`: it could not be read, so no count is said). */
type PageFiles = { entries: FileEntry[]; more: boolean; failed?: boolean }
const pageFiles = (r: TreeResponse): PageFiles => ({ entries: r.entries, more: !!r.nextCursor })

/** What a project's page shows first: as it was left (store/projectPage.ts) with its folder as last listed. */
function keptPage(id: string | undefined): { project: Project | null; chats: Chat[] | null; files: PageFiles | null } {
  const kept = id ? useProjectPage.getState().pages[id] : undefined
  if (!kept) return { project: null, chats: null, files: null }
  const folder = kept.project.member === false ? null : keptFolder(kept.project.folderPath)
  return { project: kept.project, chats: kept.chats, files: folder && pageFiles(folder) }
}

// Files from this computer dropped anywhere on a project's page go into its new-chat box, as on Home and a chat's page
// (QA TC-071); a project that takes no chat here (in the trash, managed from outside) says nothing can be attached.
export function ProjectHome() {
  return (
    <FileDropZone className="h-full" data-testid="project-drop">
      <ProjectPage />
    </FileDropZone>
  )
}

function ProjectPage() {
  const t = useT()
  const locale = useLocale()
  const { projectId } = useParams()
  const navigate = useNavigate()
  // a project seen a moment ago shows as it was at once (store/projectPage.ts, its files store/teamFiles.ts) and is read
  // again behind it
  const [rawP, setP] = useState<Project | null>(() => keptPage(projectId).project)
  // a guest: the project with nothing to change on it (lib/guests.ts guestProject)
  const guestHere = isGuestMe(useMe())
  const p = useMemo(() => (guestHere && rawP ? guestProject(rawP) : rawP), [guestHere, rawP])
  // a guest whose invite gives them no AI: no box and no Trina history; the project's files and members are the page,
  // under one quiet line (components/GuestView.tsx useGuestAiOff; Team AI that cannot answer yet keeps the page, and its
  // box says why)
  const aiOff = useGuestAiOff()
  const [missing, setMissing] = useState(false)
  // not found because I was taken out of it (or left): its name (QA TC-1067)
  const [goneFrom, setGoneFrom] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chats, setChats] = useState<Chat[] | null>(() => keptPage(projectId).chats)
  const shownChats = useRef(chats)
  shownChats.current = chats
  // failed: the folder could not be read (a network error); the line then says no count rather than a wrong one
  const [files, setFiles] = useState<PageFiles | null>(() => keptPage(projectId).files)
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  // a chat row's ⋯ 프로젝트 변경
  const [moving, setMoving] = useState<Chat | null>(null)
  // 기존 대화 가져오기
  const [importing, setImporting] = useState(false)
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
  const phone = useMediaQuery(PHONE)
  // who is in it (a team project in projects/): the faces under its name; asked again after a save
  // in the members dialog
  const [peopleVersion, setPeopleVersion] = useState(0)
  const people = useProjectPeople(p, peopleVersion)
  // the team directory knows who is a guest: "Includes 1 guest" under the faces needs it before the members dialog is opened
  usePeopleList()
  // opened from + on the project's header in Trina history (components/history/HistoryGroups.tsx): the box is ready to
  // type in (with a mouse; a phone's keyboard does not jump up)
  const location = useLocation()
  const newChat = !!(location.state as { newChat?: boolean } | null)?.newChat
  // "Continue in a chat only you see" from a shared chat (components/chat/privateAsk.ts): the box starts "Only me" with
  // the question in it (each ask starts the box again)
  const privateAsk = usePrivateAsk(projectId)
  useEffect(() => () => forgetPrivateAsk(projectId), [projectId])
  // a personal project (users/<me>/...) becomes a team project: a new projects/<name> with the people chosen, its files
  // copied there (docs/DECISIONS.md "Projects live only in projects/"); not when the team lets only admins make them
  const mine = !!p && !!me && p.folderPath.startsWith(`users/${me.user.id}/`)
  const personal = mine && !!me && (isAdmin(me) || me.team.projectCreators === 'members')

  /** the latest load only may fill the page (another project's page, or a load after a change, started later) */
  const loads = useRef(0)
  /** the project as on screen now, for a load that starts (its folder is read along with it) */
  const shownP = useRef(p)
  shownP.current = p
  /** the project changed here (renamed, edited, shared, its members saved): a read started before does not show */
  const projectEdits = useRef(0)
  const changeP = (next: Project) => {
    projectEdits.current++
    setP(next)
  }
  /** the chats' changes made since a read started (a row's rename, an event): made again on its answer, numbered */
  const chatEdits = useRef<{ n: number; f: (cur: Chat[]) => Chat[] }[]>([])
  const chatEditCount = useRef(0)
  /** chat reads on their way (no change is kept for later when none is) */
  const chatReads = useRef(0)
  const changeChats = (f: (cur: Chat[]) => Chat[]) => {
    chatEditCount.current++
    if (chatReads.current) chatEdits.current.push({ n: chatEditCount.current, f })
    setChats((cur) => cur && f(cur))
  }
  /**
   * The project, its chats (mine, and the shared ones I see) and its files, all three at once: its id is in the address,
   * and its folder is known from the page shown or the projects store (read again after the project when it was not,
   * or was another). manage=1 (the default): the owner and admins also get a team project they are not members of
   * (Project.member false: no files then, and the server lists only my own chats in it); `manage` false once I am a
   * member (after 나를 멤버로 추가). `fresh`: after a change here, so a folder read on its way is not joined.
   */
  const load = (o: { manage?: boolean; fresh?: boolean } = {}) => {
    const id = projectId!
    const mine = ++loads.current
    const live = () => mine === loads.current
    const pFrom = projectEdits.current
    const chatsFrom = chatEditCount.current
    const known = (shownP.current?.id === id ? shownP.current : null) ?? useProjectPage.getState().pages[id]?.project ?? useProjects.getState().byId[id] ?? null
    const guess = known && (known.member !== false || o.manage === false) ? known.folderPath : null
    const folderRead = guess ? readFolder(guess, { fresh: o.fresh }) : null
    folderRead?.catch(() => {})
    chatReads.current++
    api.call(API.listChats, { query: { projectId: id, limit: 50 } }).then(
      (r) => {
        if (!live()) return
        let items = r.items
        // the changes made while it was read, on top of its answer (an older list never undoes them)
        for (const c of chatEdits.current) if (c.n > chatsFrom) items = c.f(items)
        // a chat moved out, or into the trash, and not answered yet: as on screen (this answer may be from before it)
        items = keepPendingRows(items, shownChats.current)
        setChats(items)
      },
      // what was shown stays (nothing shown: no chats)
      () => live() && setChats((cur) => cur ?? []),
    ).finally(() => {
      if (--chatReads.current === 0) chatEdits.current = []
    })
    api.call(API.getProject, { params: { id }, ...(o.manage === false ? {} : { query: { manage: '1' } }) }).then(
      (x) => {
        if (!live()) return
        // changed here while it was read: what is on screen is newer than this answer; a rename or the trash still on
        // its way stays as on screen
        const fresh = keepPendingProject(x, shownP.current)
        const now = projectEdits.current === pFrom ? fresh : (shownP.current ?? fresh)
        if (now === fresh) setP(fresh)
        keepable.current = true
        useProjectPage.getState().keep(id, { project: now, chats: shownChats.current })
        setMissing(false)
        setError(null)
        useProjects.getState().put(now)
        if (now.member === false) setFiles(null)
        else {
          const read = guess === now.folderPath && folderRead ? folderRead : readFolder(now.folderPath, { fresh: o.fresh })
          read.then(
            (r) => live() && setFiles(pageFiles(r)),
            () => live() && setFiles((cur) => (cur && !cur.failed ? cur : { entries: [], more: false, failed: true })),
          )
        }
      },
      (e) => {
        if (!live()) return
        if (isApiError(e, 'not_found')) {
          setMissing(true)
          setGoneFrom(noLongerMemberOf(e))
          useProjectPage.getState().drop(id)
        } else if (shownP.current?.id !== id) setError(errorText(e, locale, t('error.network')))
        // (a page shown from a moment ago stays as it was; the next visit reads it again)
      },
    )
  }

  // the page as it is on screen is what a return to it shows first; not while an access change (or a connection that
  // could not resume) is unanswered: what is on screen may not be mine to see any more until the project is read again
  const keepable = useRef(true)
  useEffect(() => {
    if (keepable.current && p && p.id === projectId && !missing) useProjectPage.getState().keep(p.id, { project: p, chats })
  }, [p, chats, projectId, missing])
  useEffect(() => {
    const again = () => {
      keepable.current = false
      load({ fresh: true })
    }
    const offA = accessChanged.on(again)
    const offB = reloadAsked.on(again)
    return () => {
      offA()
      offB()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    const kept = keptPage(projectId)
    setP(kept.project)
    setChats(kept.chats)
    setFiles(kept.files)
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
  useEffect(() => chatChanged.on((e) => changeChats((cur) => withChatEvent(cur, projectId!, e))), [projectId])

  // a row's rename, pin or move, without waiting for its chat event: the row as it is now, in its place (a pin moves it
  // up); moved to another project, it goes; a move out of it or a delete the server refused brings it back
  const chatHere = (chat: Chat) => changeChats((cur) => {
    const old = cur.find((c) => c.id === chat.id)
    const rest = cur.filter((c) => c.id !== chat.id)
    if (chat.projectId !== projectId || chat.deletedAt) return rest
    // gone from here while its move out or its trash is on its way: a late answer of a rename or a pin does not bring it
    // back (a refusal of those comes after they are answered)
    if (!old && (optimisticPending(`chat:${chat.id}:trash`) || optimisticPending(`chat:${chat.id}:project`))) return cur
    return [keepFaces(old, chat), ...rest].sort(chatOrder)
  })

  // + in Trina history said "a new chat here": once the box has it (it mounts with the project, its own effect runs
  // first), the word goes from this history entry, so Back or a reload do not focus the box again and a second + does
  useEffect(() => {
    if (newChat && p) navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newChat, p?.id])

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
  const leaveProject = useLeaveProject()
  const leaveIt = async () => {
    if (!p || !(await leaveProject(p))) return
    useProjectPage.getState().drop(p.id)
    navigate('/projects')
  }
  const del = async () => {
    if (!p) return
    let left = false
    const leave = () => {
      if (left) return
      left = true
      useProjectPage.getState().drop(p.id)
      navigate('/projects')
    }
    // the trash at once: its note here (the owner and admins), or back to the list (anyone else)
    const d = await remove(p, (now) => (now === 'gone' ? leave() : live.current === p.id && changeP(now)))
    if (d === 'gone') leave()
    else if (d && live.current === p.id) load({ fresh: true })
  }
  /** the project on screen now (an answer after the person went to another project's page writes nothing here) */
  const live = useRef<string | undefined>(projectId)
  live.current = projectId
  useEffect(() => () => void (live.current = undefined), [])
  const renameProject = useRenameProject()
  const rename = async () => {
    if (!p) return
    const id = p.id
    const r = await renameProject(p, (name) => live.current === id && shownP.current && changeP({ ...shownP.current, name }))
    if (r && live.current === id) changeP(r)
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
      load({ manage: false, fresh: true })
    } catch (e) {
      if (isApiError(e, 'conflict') && e.body.params?.reason === 'rules_changed') load({ fresh: true })
      const refused = refusalKey(e, 'project')
      toast({ level: 'error', text: refused ? t(refused) : errorText(e, locale, t('error.network')) })
    } finally {
      setBusy(null)
    }
  }

  // 되돌리기: the project and its folder back from the trash (the owner and admins; its folder purged meanwhile: the
  // server's words, 409 project_folder_purged, and 되돌리기 goes)
  // At once (the note goes, the page is the project's again), back with the server's words when it refuses
  const restore = async () => {
    if (!p || busy) return
    const id = p.id
    const r = await trashProject(p, false, true, (now) => live.current === id && now !== 'gone' && changeP(now))
    if (live.current !== id) return
    if (r.ok) load({ fresh: true })
    else if (r.newest && isApiError(r.error, 'conflict') && r.error.body.params?.reason === 'project_folder_purged') setPurged(true)
  }

  // the members dialog saved: an owner or admin who added or took out themselves loads the page again (its files,
  // instructions and the others' chats come or go)
  const membersSaved = (next: Project) => {
    setPeopleVersion((v) => v + 1)
    if ((next.member === false) !== (p?.member === false)) load({ manage: next.member === false, fresh: true })
    else changeP(next)
  }

  if (missing) return <div data-testid="project-missing" data-gone={goneFrom ? '' : undefined}><EmptyState screen title={goneFrom ? t('projects.noLongerMember', { name: goneFrom }) : t('projects.missing')}><Link to="/projects" className="text-accent-text underline">{t('projects.title')}</Link></EmptyState></div>
  if (error) return <div className="p-6"><ErrorNote>{error}</ErrorNote></div>
  if (!p) return <Skeleton lines={6} className="p-6" />
  // the owner or an admin on a team project they are not a member of (or one in the trash, which nobody reads): its
  // name, its members, their own chats in it; nothing of its contents
  const outside = p.member === false
  const folderLink = `/files?path=${encodeURIComponent(p.folderPath)}`
  const sideAction = 'rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-ink'
  // the folder read, with nothing in it yet, and someone here who may add files: the files box in place of its line
  // the project has no files (as far as this person reads it)
  const filesNone = !!files && !files.failed && !files.entries.length && !files.more
  const filesEmpty = filesNone && p.canEdit
  // still reading it for someone who may add files: a box of the same height, so the column does not jump when an
  // empty folder comes back (a folder with files becomes its one line). A phone: always its one row (QA TC-1072)
  const filesBox = !phone && (filesEmpty || (!files && p.canEdit))
  // a team project in place has members (a personal one is mine alone; one in the trash is nobody's until restored)
  const hasMembers = !p.folderPath.startsWith('users/') && !p.inTrash
  // in the trash: may bring it back (its folder not deleted for good meanwhile)
  const restorable = !purged && (p.canRestore ?? (p.trashed === undefined && isAdmin(me)))
  // where nobody can ask here (the owner or an admin who is not a member, a project in the trash) there is no Trina
  // history with "Ask here" under it either (QA TC-1066)
  const canAsk = !outside && !p.inTrash
  // in the trash: no name menu (its note has 되돌리기 and 완전히 삭제; renaming it is not needed there)
  const menu = p.inTrash
    ? null
    : outside
      ? mayManage(p)
        ? [
            { label: t('chat.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void rename(), testId: 'project-rename' },
            ...(mayDelete(p) ? [{ label: deleteLabel(t, p), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'project-delete' }] : []),
          ]
        : null
      : p.canEdit || p.leave
        ? [
            ...(p.canEdit ? [{ label: t('common.edit'), icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true), testId: 'project-edit' }] : []),
            // a member leaves it (components/LeaveProject.tsx); delete stays last
            ...leaveItems(t, p, () => void leaveIt(), 'project-leave'),
            ...(p.canEdit && mayDelete(p) ? [{ label: deleteLabel(t, p), icon: <Trash2 size={14} aria-hidden />, onSelect: () => void del(), danger: true, testId: 'project-delete' }] : []),
          ]
        : null
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {phone ? (
        // a phone: one bar, "‹ 프로젝트 · name · ···" (components/PhoneTopBar.tsx); the name's menu is the bar's "···"
        <>
          <PhoneBarTitle>{p.name}</PhoneBarTitle>
          {menu && (
            <PhoneBarAction>
              <MenuButton label={t('rooms.menu.rowLabel', { name: p.name })} tip={t('rooms.menu.label')} sheetTitle={p.name} items={menu} muted buttonClassName="size-11" testId="project-menu" />
            </PhoneBarAction>
          )}
        </>
      ) : (
      /* like Claude's project page: where you are, with the few things you rarely do behind the name; it stays at the
          top while the page scrolls */
      <StickyHeader bar className="flex h-12 shrink-0 items-center border-b border-line px-4 sm:px-6" testId="project-topline">
        <nav aria-label={t('files.breadcrumb')} className="flex min-w-0 items-center gap-1.5 text-sm">
          <Link to="/projects" className="shrink-0 text-muted hover:text-ink">
            {t('projects.title')}
          </Link>
          <span className="text-faint" aria-hidden>
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
      )}
      <div className="mx-auto w-full max-w-[1080px] px-4 pt-8 pb-12 max-md:pt-4 sm:px-6 sm:pt-10">
        {/* phones: the name is the bar's; here for screen readers only */}
        <h1 className="text-display font-semibold tracking-tight break-words max-md:sr-only">{p.name}</h1>
        {/* who is in it, by face (a shared project only): clicking them opens the members dialog; a phone shows them
            here too, under the bar's name */}
        {hasMembers && people && people.people.length > 0 && (
          <div className="mt-2 flex max-md:mt-0" data-testid="project-people-header">
            <PeopleStack people={people.people} onOpen={() => setMembers(true)} testId="project-header" />
            {/* "Includes 1 guest" (components/GuestTag.tsx): people from outside the team are in it */}
            <IncludesGuests ids={people.people.map((x) => x.id)} className="ml-2 self-center text-xs text-faint" />
          </div>
        )}
        {/* no copy of the instructions here: they show once, in 지침 beside the box (QA TC-980) */}
        {/* phone: the box, then the chats right under it, then the side lines (QA TC-1072); wide: the chats under the
            box, the lines beside them */}
        <div className={aiOff ? 'mt-6 grid max-w-[720px] gap-y-6' : 'mt-6 grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]'}>
          <div className="min-w-0 lg:col-start-1">
            {/* a project whose folder is in the trash takes no chat: the note says so, with what the owner and admins
                can do; a project I manage without being a member: one quiet block in place of the box */}
            {p.inTrash ? (
              // who moved it there and when; Restore for the owner, admins and its creator (Project.canRestore, QA
              // TC-1062; an older server: the owner and admins), Delete for good for the owner and admins; anyone else
              // (its other members, QA TC-1060) reads who can restore it
              <ProjectTrashNote project={p}>
                {(restorable || mayManage(p)) && (
                  <>
                    {restorable && (
                      <Button size="sm" busy={busy === 'restore'} onClick={() => void restore()} data-testid="project-restore">
                        <ArchiveRestore size={14} aria-hidden /> {t('common.restore')}
                      </Button>
                    )}
                    {mayManage(p) && (
                      <Button size="sm" variant="ghost-danger" onClick={() => void del()} data-testid="project-delete-for-good">
                        {t('projects.deleteForGood')}
                      </Button>
                    )}
                  </>
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
              aiOff ? (
                <p className="text-sm text-muted" data-testid="guest-no-ai">{t('guest.noAi')}</p>
              ) : (
              <>
              {/* a guest, once: their chats here are seen by the project's members (components/GuestView.tsx) */}
              <GuestProjectNote projectId={p.id} />
              <NewChatComposer
                projectId={p.id}
                project={p}
                onMembers={() => setMembers(true)}
                placeholder={t(phone ? 'projects.askHereShort' : 'projects.askHere', { name: aiName(t) })}
                autoFocus={newChat || !!privateAsk}
                {...(privateAsk ? { initialText: privateAsk.text, startPrivate: true, resetKey: privateAsk.n } : {})}
              />
              </>
              )
            )}
          </div>
          {(!outside || hasMembers) && (
            <aside aria-label={t('projects.about')} className={aiOff ? 'min-w-0' : 'min-w-0 max-md:order-last lg:col-start-2 lg:row-span-2 lg:row-start-1'}>
              <div className="divide-y divide-line">
                {!outside && !p.instructions?.trim() && p.canEdit && phone ? (
                  // a phone: one line, its name and 지침 쓰기 (QA TC-1072: two empty boxes pushed the chats down)
                  <DisclosureRow
                    testId="project-instructions"
                    icon={<ScrollText size={16} />}
                    label={t('projects.instructions')}
                    action={<button type="button" className={`${sideAction} touch-hit`} onClick={() => setEditing(true)} data-testid="project-instructions-write">{t('projects.page.writeInstructions')}</button>}
                  />
                ) : !outside && !p.instructions?.trim() && p.canEdit ? (
                  // none yet, for whoever may edit: a box that says what they are for, with one clear button (filled,
                  // it is the one quiet line below again)
                  <EmptySideBox
                    testId="project-instructions"
                    icon={<ScrollText size={16} />}
                    label={t('projects.instructions')}
                    line={t('projects.page.instructionsEmpty', { ai: aiName(t) })}
                    lineTestId="project-instructions-empty"
                  >
                    <Button size="sm" onClick={() => setEditing(true)} data-testid="project-instructions-write">
                      <Plus size={14} aria-hidden /> {t('projects.page.writeInstructions')}
                    </Button>
                  </EmptySideBox>
                ) : !outside && !aiOff && (
                  // (a guest with no AI: the instructions are for the AI only, so none here; components/GuestView.tsx)
                  <DisclosureRow
                    testId="project-instructions"
                    icon={<ScrollText size={16} />}
                    label={t('projects.instructions')}
                    // phones: the same 수정 as in the name's menu above, so not a second button here
                    action={p.canEdit ? <button type="button" className={`${sideAction} max-md:hidden`} onClick={() => setEditing(true)}>{t('common.edit')}</button> : undefined}
                  >
                    {p.instructions?.trim() ? (
                      <Markdown text={p.instructions} className="text-sm! leading-6! prose-headings:text-sm!" />
                    ) : (
                      // none yet, for someone who cannot edit them (who may, has the box above): what they are for
                      <p className="text-faint" data-testid="project-instructions-empty">
                        {t('projects.page.instructionsEmpty', { ai: aiName(t) })}
                      </p>
                    )}
                  </DisclosureRow>
                )}
                {!outside && filesBox && (
                  // no files yet, for whoever may add them: a box that says what they are for, with one clear button
                  // to the project's folder in 파일, where files are uploaded (a phone: the project's files screen, as
                  // its header row, so Back comes here the same way)
                  <EmptySideBox
                    loading={!files}
                    testId="project-files"
                    icon={<Folder size={16} />}
                    label={t('files.title')}
                    head={
                      phone ? (
                        <Link to={`/projects/${p.id}/files`} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-sm" data-testid="project-files-open">
                          <Folder size={16} className="shrink-0 text-muted" aria-hidden />
                          <span className="min-w-0 truncate font-medium">{t('files.title')}</span>
                          <ChevronRight size={16} className="ml-auto shrink-0 text-faint" aria-hidden />
                        </Link>
                      ) : undefined
                    }
                    line={t('projects.page.filesEmptyHint', { ai: aiName(t) })}
                    lineTestId="project-files-empty"
                  >
                    <Button size="sm" onClick={() => navigate(phone ? `/projects/${p.id}/files` : folderLink)} data-testid="project-files-upload">
                      <Plus size={14} aria-hidden /> {t('projects.page.uploadFiles')}
                    </Button>
                  </EmptySideBox>
                )}
                {!outside && phone && !filesBox && (
                  // a phone: one row to the project's files, a screen of this tab (Back comes here)
                  <div data-testid="project-files">
                    <Link to={`/projects/${p.id}/files`} className="flex min-h-12 items-center gap-2.5 py-3 text-sm" data-testid="project-files-open">
                      <Folder size={16} className="shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 truncate font-medium">{t('files.title')}</span>
                      {files && !files.failed && <span className="shrink-0 text-xs text-faint" data-testid={files.entries.length ? undefined : 'project-files-empty'}>{!files.entries.length ? t('projects.page.filesEmpty') : files.more ? t('projects.itemsMore', { n: files.entries.length }) : t('projects.items', { n: files.entries.length })}</span>}
                      <ChevronRight size={16} className="ml-auto shrink-0 text-faint" aria-hidden />
                    </Link>
                  </div>
                )}
                {!outside && !phone && !filesBox && (
                  <DisclosureRow
                    testId="project-files"
                    icon={<Folder size={16} />}
                    label={t('files.title')}
                    // none yet, for someone who cannot add them (who may, has the box above): the phone's words ("No
                    // files yet", not "0 items", QA N4) and nothing to open
                    meta={files && !files.failed && (filesNone ? <span data-testid="project-files-empty">{t('projects.page.filesEmpty')}</span> : files.more ? t('projects.itemsMore', { n: files.entries.length }) : t('projects.items', { n: files.entries.length }))}
                    action={<Link to={folderLink} className={sideAction}>{t('projects.open')}</Link>}
                  >
                    {filesNone ? undefined : (
                      <>
                        {!files && <Skeleton lines={3} />}
                        {/* the app's list rows (components/list/List.tsx), their icon under the box's own inset */}
                        <ul className="-mx-3">
                          {files?.entries.slice(0, 30).map((f) => (
                            <ListRow
                              key={f.path}
                              onClick={() => (f.type === 'folder' ? navigate(`/files?path=${encodeURIComponent(f.path)}`) : openTeamFile(f.path))}
                              icon={f.type === 'folder' ? <Folder className="text-accent-text" /> : <FileText />}
                              name={f.name}
                              nameTitle={f.name}
                            />
                          ))}
                        </ul>
                        {files && (files.more || files.entries.length > 30) && (
                          <Link to={folderLink} className="mt-1 inline-block text-xs text-accent-text hover:underline">
                            {t('projects.openFolder')}
                          </Link>
                        )}
                      </>
                    )}
                  </DisclosureRow>
                )}
                {hasMembers && <MembersRow project={p} sideAction={sideAction} onManage={() => setMembers(true)} />}
                {/* a personal project: "나만 봐요 · 멤버 추가" (sharing makes it a team project, its files move along) */}
                {mine && !p.inTrash && (
                  <DisclosureRow
                    testId="project-members"
                    icon={<Users size={16} />}
                    label={t('projects.participants')}
                    meta={t('projects.members.onlyMe')}
                    action={personal ? <button type="button" className={sideAction} onClick={() => setSharing(true)} data-testid="project-share">{t('projects.members.add')}</button> : undefined}
                  >
                    {!personal && <p className="text-sm leading-6 break-keep text-muted" data-testid="project-share-admins-only">{t('projects.shareAdminsOnly')}</p>}
                  </DisclosureRow>
                )}
              </div>
              {/* no folder path line: people read 파일 (its 열기 opens the folder) and 멤버, not paths */}
            </aside>
          )}
          {canAsk && !aiOff && (
          <section aria-labelledby="pj-chats" className="min-w-0 lg:col-start-1" data-testid="project-chats">
            {/* the AI's history by its one name ("트리나 기록"), the same on every screen */}
            {/* the heading's line: the name, and at its end, on its baseline, 기존 대화 가져오기 for a member, however many
                chats it has (QA TC-1001: a task's runs counted too, so it came and went; docs/DECISIONS.md "Making a project") */}
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 id="pj-chats" className="min-w-0 truncate text-title-sm font-semibold">
                {t('sidebar.aiChats', { name: aiName(t) })}
              </h2>
              {!outside && !p.inTrash && !guestHere && (
                <Button size="sm" className="shrink-0" onClick={() => setImporting(true)} data-testid="project-import">
                  <Import size={14} aria-hidden /> {t('projects.page.import')}
                </Button>
              )}
            </div>
            {!chats && <Skeleton lines={3} />}
            {chats && !chats.length && <p className="py-2 text-sm text-faint" data-testid="project-chats-empty">{t(isTeamProject(p) && !outside && !me?.server?.allChatsConfidential ? 'projects.page.chatsEmptyTeam' : 'projects.page.chatsEmpty')}</p>}
            {/* a team project where I have chats only I see (from before, brought in, "Only me"): once, a quiet line between
                the heading and the list that says how many and opens the list to share them one at a time */}
            {chats && !outside && !p.inTrash && <PrivateChatsNotice project={p} chats={chats} />}
            <ul className="divide-y divide-line">
              {/* the runs of one scheduled task started here: one row of this list that opens the task (nav/TaskRunsRow.tsx) */}
              {chats && foldRuns(chats, (c) => (
                <ProjectChatRow chat={c} project={p} onMove={setMoving} onChanged={chatHere} onRemoved={(x) => changeChats((cur) => cur.filter((y) => y.id !== x.id))} />
              ), { task: (runs) => <ProjectTaskRow runs={runs} /> })}
            </ul>
          </section>
          )}
        </div>
      </div>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onSaved={changeP} />}
      {members && <ProjectMembersDialog project={p} onClose={() => setMembers(false)} onSaved={membersSaved} />}
      {importing && <ImportChatsDialog project={p} onClose={() => setImporting(false)} onMoved={(c) => { useChats.getState().upsertChat(c); changeChats((cur) => (!cur.some((x) => x.id === c.id) ? [c, ...cur].sort(chatOrder) : cur)) }} />}
      {moving && <MoveToProjectDialog chat={moving} onClose={() => setMoving(null)} onMoved={(c) => { useChats.getState().upsertChat(c); chatHere(c) }} />}
      {sharing && <ShareProjectDialog project={p} chats={chats?.length ?? 0} onClose={() => setSharing(false)} onShared={(r) => { changeP(r); useProjects.getState().put(r); toast({ level: 'success', text: t('projects.sharedNow', { name: r.name }) }) }} />}
    </div>
  )
}

/** An empty Instructions or Files of a project's page, for whoever may fill it: a light box with the line's name, one
 * short line on what it is for, and one clear button (owner 2026-11-13: empty, the quiet lines were easy to miss). The
 * filled ones stay the one-line DisclosureRows. `head`: a header of its own in place of the icon and name (a phone's
 * files row, which is a link). `loading`: what is in it is not known yet: the same box with grey bars in place of the
 * line and the button. */
function EmptySideBox({ icon, label, head, line, lineTestId, testId, loading, children }: { icon: ReactNode; label: string; head?: ReactNode; line: string; lineTestId: string; testId: string; loading?: boolean; children: ReactNode }) {
  return (
    // no hairlines of the column around a box: its own edge is the line
    <div className="border-b-0! py-2" data-testid={testId}>
      <div className="rounded-xl border border-line px-3.5 pt-2 pb-3.5" data-empty={loading ? undefined : 'true'} data-loading={loading ? 'true' : undefined}>
        {head ? (
          <div className="flex">{head}</div>
        ) : (
          <div className="flex min-h-9 items-center gap-2.5 text-sm">
            <span className="shrink-0 text-muted" aria-hidden>
              {icon}
            </span>
            <span className="min-w-0 truncate font-medium">{label}</span>
          </div>
        )}
        {loading ? (
          <div aria-hidden>
            <div className="mt-0.5 flex h-5 items-center">
              <div className="h-3.5 w-4/5 animate-pulse rounded bg-subtle" />
            </div>
            <div className="mt-3 h-8 w-28 animate-pulse rounded-lg bg-subtle max-md:h-11" />
          </div>
        ) : (
          <>
            <p className="mt-0.5 text-sm leading-5 break-keep text-muted" data-testid={lineTestId}>
              {line}
            </p>
            <div className="mt-3">{children}</div>
          </>
        )}
      </div>
    </div>
  )
}

/** 기존 대화 가져오기: my own recent chats that may move into this project (not shared, not a room's side chat, in no
 * project yet), each with a box; 가져오기 moves the ticked ones (PATCH /api/chats/:id each). Files Trina saved in them stay
 * where they are, which one line says. */
function ImportChatsDialog({ project, onClose, onMoved }: { project: Project; onClose: () => void; onMoved: (c: Chat) => void }) {
  const t = useT()
  const locale = useLocale()
  const all = useChats((s) => s.chats)
  const loaded = useChats((s) => s.chatsLoaded)
  useEffect(() => {
    if (!loaded) void useChats.getState().loadChats(true).catch(() => {})
  }, [loaded])
  const choices = useMemo(() => all.filter((c) => !c.projectId && !c.shared && !c.sideRoomId && !isUnused(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30), [all])
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bring = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const id of ticked) onMoved(await api.call(API.updateChat, { params: { id }, body: { projectId: project.id } }))
      toast({ level: 'success', text: t('chat.project.moved', { name: project.name }) })
      onClose()
    } catch (e) {
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('projects.page.import')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!ticked.size} onClick={() => void bring()} data-testid="project-import-do">{t('projects.page.importDo')}</Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-faint">{t('projects.page.importNote', { ai: aiName(t) })}</p>
      {/* a team project: what comes in stays mine until I share it (docs/DECISIONS.md "Team project chats shared by
          default"; QA TC-960) */}
      {isTeamProject(project) && <p className="mb-2 text-xs break-keep text-faint" data-testid="project-import-private">{t('projects.page.importPrivate')}</p>}
      {!loaded && <Skeleton lines={3} />}
      {loaded && !choices.length && <p className="py-2 text-sm text-faint">{t('projects.page.importNone')}</p>}
      <ul className="max-h-80 space-y-0.5 overflow-y-auto" data-testid="project-import-list">
        {choices.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-hover max-md:min-h-11">
              <input type="checkbox" checked={ticked.has(c.id)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })} />
              <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
              <span className="shrink-0 text-xs text-faint">{formatRelative(c.updatedAt, locale)}</span>
            </label>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Modal>
  )
}

/** The project of a page, as this window knows it without asking: its page seen a moment ago, or the projects store. */
const knownProject = (id: string | undefined): Project | null => {
  const p = id ? useProjectPage.getState().pages[id]?.project ?? useProjects.getState().byId[id] ?? null : null
  // its folder moved since it was read (renamed in another window): the project is asked for again
  return p && !folderMoved(p.folderPath) ? p : null
}
/** A folder's first page as last listed, for a phone's project files. */
const keptList = (path: string | null) => {
  const r = path === null ? null : keptFolder(path)
  return r && { entries: r.entries, cursor: r.nextCursor }
}

/** A folder of a project's files as the address says it (`?dir=`, relative to the project's folder): no leading or
 * trailing "/", no "." or ".." parts. */
export const projectDir = (raw: string | null) => (raw ?? '').split('/').filter((x) => x && x !== '.' && x !== '..').join('/')

/**
 * A project's files on a phone (QA TC-254): /projects/:id/files, a screen of the 트리나 tab under the project's page
 * (lib/screens.ts), so Back goes up a folder and then to the project, never into the team folder. No folder path line
 * (QA TC-380: "projects/QA 프로젝트" is the server's word for it; the bar names where you are). Its folders open
 * further down here (?dir=, relative to the project's folder); a file opens in the file sheet over it (lib/sidePanel.ts,
 * Back closes it). The bar: "‹ name · 파일 (or the folder's name)" and a button to the same folder on the 파일 screen,
 * where it can be changed (upload, rename, move). A computer has the 파일 line on the project's page and the 파일 screen:
 * this address takes it to that folder there.
 */
export function ProjectFiles() {
  const t = useT()
  const locale = useLocale()
  const { projectId } = useParams()
  const [params] = useSearchParams()
  const dir = projectDir(params.get('dir'))
  const navigate = useNavigate()
  const phone = useMediaQuery(PHONE)
  // the project as this window knows it (its page a moment ago, or the projects store): a computer goes on to its
  // folder at once, a phone lists the folder without waiting for it
  const [p, setP] = useState<Project | null>(() => knownProject(projectId))
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const loads = useRef(0)
  const path = p ? [p.folderPath, dir].filter(Boolean).join('/') : null
  /** the folder as last listed (store/teamFiles.ts), at once; the next pages (더 보기) are this screen's own */
  const [list, setList] = useState<{ entries: FileEntry[]; cursor: string | null } | null>(() => keptList(path))
  useEffect(() => {
    let live = true
    setMissing(false)
    // a computer that knows the project goes to its folder (below) and asks nothing here
    if (!phone && knownProject(projectId)) return
    api.call(API.getProject, { params: { id: projectId! }, query: { manage: '1' } }).then(
      (x) => { if (!live) return; setP(x); useProjects.getState().put(x) },
      (e) => { if (!live) return; if (isApiError(e, 'not_found')) setMissing(true); else setError(errorText(e, locale, t('error.network'))) },
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
  const read = (cursor?: string) => {
    if (path === null) return
    const mine = cursor ? loads.current : ++loads.current
    if (cursor) setMore(true)
    const page = cursor ? api.call(API.tree, { query: { path, limit: FOLDER_PAGE, cursor } }) : readFolder(path)
    page.then(
      (r) => { if (mine !== loads.current) return; setList((cur) => ({ entries: cursor && cur ? [...cur.entries, ...r.entries] : r.entries, cursor: r.nextCursor })); setError(null) },
      (e) => { if (mine === loads.current) setError(errorText(e, locale, t('error.network'))) },
    ).finally(() => { if (cursor) setMore(false) })
  }
  useEffect(() => {
    setList(keptList(path))
    setError(null)
    // (a computer goes to the 파일 screen, which lists the folder itself)
    if (phone && p?.member !== false) read()
    return () => { loads.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, p?.member])
  // a computer: the folder on the 파일 screen (the project's page for someone who is not a member: no files for them)
  if (!phone && p && path !== null) return <Navigate to={p.member === false ? `/projects/${p.id}` : `/files?path=${encodeURIComponent(path)}`} replace />
  if (missing) return <EmptyState screen title={t('projects.missing')}><Link to="/projects" className="text-accent-text underline">{t('projects.title')}</Link></EmptyState>
  const name = dir ? dir.slice(dir.lastIndexOf('/') + 1) : t('files.title')
  const down = (f: FileEntry) => `/projects/${projectId}/files?dir=${encodeURIComponent(dir ? `${dir}/${f.name}` : f.name)}`
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="project-files-page">
      <h1 className="sr-only">{name}</h1>
      <PhoneBarTitle>{name}</PhoneBarTitle>
      {/* not for the owner or an admin who is not a member: the 파일 screen would not open the folder for them */}
      {path !== null && p?.member !== false && (
        <PhoneBarAction>
          <Tooltip label={t('projects.openFolder')}>
            <button type="button" onClick={() => navigate(`/files?path=${encodeURIComponent(path)}`)} aria-label={t('projects.openFolder')} className="grid size-11 place-items-center rounded-md text-muted transition hover:bg-hover hover:text-ink" data-testid="project-files-in-files">
              <FolderOpen size={20} aria-hidden />
            </button>
          </Tooltip>
        </PhoneBarAction>
      )}
      <div className="px-4 pt-2 pb-8">
        {error && <ErrorNote onRetry={() => read()}>{error}</ErrorNote>}
        {p?.member === false && <p className="py-3 text-sm break-keep text-muted" data-testid="project-files-members-only">{t('projects.membersOnly')}</p>}
        {!list && !error && p?.member !== false && <Skeleton lines={4} />}
        {list && !list.entries.length && <p className="py-3 text-sm text-faint">{t('files.emptyReadOnly')}</p>}
        <ul className="-mx-3">
          {list?.entries.map((f) =>
            f.type === 'folder' ? (
              <ListRow key={f.path} to={down(f)} icon={<Folder className="text-accent-text" />} name={f.name} nameTitle={f.name} end={<ChevronRight size={16} className="shrink-0 self-center text-faint" aria-hidden />} testId="project-file" link={{ 'data-type': 'folder' }} />
            ) : (
              <ListRow key={f.path} onClick={() => openTeamFile(f.path)} icon={<FileText />} name={f.name} nameTitle={f.name} end={<span className="shrink-0 self-center text-meta text-faint tabular-nums">{formatRelative(f.mtime, locale)}</span>} testId="project-file" link={{ 'data-type': 'file' }} />
            ),
          )}
        </ul>
        {list?.cursor && (
          <Button className="mt-3 w-full" busy={more} onClick={() => read(list.cursor!)} data-testid="project-files-more">
            {t('common.loadMore')}
          </Button>
        )}
      </div>
    </div>
  )
}


/** The 멤버 line of a team project's page: who sees it (whoSeesProject). A team project in projects/ is its members'
 * (docs/DECISIONS.md "Project contents only for members"): "나만 봐요" when I am its only member, else how many ("3명";
 * "남은 멤버 없음" when nobody active is one), also for the owner or an admin who is not a member. A project made before
 * outside projects/ says it in the words and by the rule of the line under the box (components/chat/WhoSees.tsx
 * whoSeesText, docs/DECISIONS.md "Who sees it, always"): "나만 봐요", "나와 관리자만 봐요" (Project.alone), else its people
 * by its rules for the owner and admins ("3명", Project.audienceSplit) or the total. Whoever may change its members gets
 * 관리 (the members dialog) and nothing to open; anyone else opens the line to read who changes them: the creator by
 * name only while they can (Project.creatorChangesMembers: their account active, the folder theirs), else 관리자 (never
 * an admin's name). An admin on a project made before on another folder reads where to change it instead. The faces
 * of who is in it are under the page's name only (ProjectPeople.tsx), not here again. */
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

/** "멤버 추가" on a personal project: it becomes a team project in a new projects/<name>, seen by me and the people
 * chosen here; its files move there (docs/DECISIONS.md "Making a project"). One dialog (QA TC-1069): the picker, the
 * one count ("5 people", me included: QA TC-1065), and under it plainly what sharing does: they see and edit its files
 * and instructions and the chats started from now on, my chats so far stay mine (how many), and it can't go back. No
 * second confirm: Share is the yes. */
function ShareProjectDialog({ project, chats, onClose, onShared }: { project: Project; chats: number; onClose: () => void; onShared: (p: Project) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const [participants, setParticipants] = useState<ProjectParticipant[]>([])
  const options = useParticipantOptions()
  const fixed = useMemo(() => new Map(me ? [[participantKey({ subjectType: 'user', subjectId: me.user.id }), t('projects.youTag')]] : []), [me, t])
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
        if (await confirmDialog({ title: t('files.skillsOnTitle'), body: t('projects.skillsOnBody', { n: skills.length, names: skills.join(', '), ai: aiName(t) }), confirm: t('projects.shareConfirm') })) await share(true)
        return
      }
      setError(errorText(e, locale, t('error.network')))
    } finally {
      setBusy(false)
    }
  }
  const note = [t('projects.shareNote'), ...(chats ? [t('projects.shareConfirmChats', { n: chats })] : []), t('projects.shareConfirmFinal')].join(' ')
  return (
    <Modal open onClose={onClose} title={t('projects.members.add')} width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!participants.length} onClick={() => void share()} data-testid="project-share-confirm">{t('projects.shareConfirm')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <MembersField label={t('projects.participants')}>
          <div className="space-y-2">
            <ParticipantPicker options={options} value={participants} onChange={setParticipants} fixed={fixed} />
            <AccessSummary count={count} />
          </div>
        </MembersField>
        <p className="text-sm leading-6 break-keep text-muted" data-testid="project-share-note">{note}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

/** Per person and project, whether the private chats line was closed (this browser only: a convenience). */
const noticeKey = (me: string, project: string) => `mycel.privateChatsNotice.${me}.${project}`
const noticeClosed = (k: string) => { try { return localStorage.getItem(k) === '1' } catch { return false } }

/**
 * A team project's page, for whoever has chats there only they see (from before the update, brought in, or "Only me"):
 * one quiet line, "🔒 N chats only you see · Choose chats to share", until closed. The choice lists those chats, each with
 * the existing share (its check and confirm: components/chat/ShareChat.tsx); no bulk share in this phase
 * (docs/DECISIONS.md "Team project chats shared by default"; QA TC-957).
 */
function PrivateChatsNotice({ project, chats }: { project: Project; chats: Chat[] }) {
  const t = useT()
  const me = useMe()
  const safeOps = !!me?.server?.allChatsConfidential
  const mine = chats.filter((c) => mayShareChat(c, project, safeOps))
  const key = noticeKey(me?.user.id ?? '', project.id)
  const [closed, setClosed] = useState(() => noticeClosed(key))
  const [open, setOpen] = useState(false)
  if (!mine.length || !isTeamProject(project)) return null
  return (
    <>
      {!closed && (
        <p className="mb-1 flex items-center gap-1.5 py-1 text-sm text-faint" data-testid="private-chats-notice">
          <Lock size={13} className="shrink-0" aria-hidden />
          <span className="min-w-0 break-keep">
            {t('projects.privateChats', { n: mine.length })}
            {' · '}
            <button type="button" className="touch-hit text-accent-text hover:underline" onClick={() => setOpen(true)} data-testid="private-chats-choose">{t('projects.privateChatsChoose')}</button>
          </span>
          <Tooltip label={t('projects.privateChatsDismiss')}>
            <button
              type="button"
              className="touch-hit ml-auto shrink-0 rounded p-1 hover:bg-hover hover:text-ink"
              aria-label={t('projects.privateChatsDismiss')}
              onClick={() => { try { localStorage.setItem(key, '1') } catch { /* this browser keeps nothing: it shows again */ } setClosed(true) }}
              data-testid="private-chats-dismiss"
            >
              <X size={14} aria-hidden />
            </button>
          </Tooltip>
        </p>
      )}
      {open && (
        <Modal open onClose={() => setOpen(false)} title={t('projects.privateChatsTitle')} width={480} footer={<Button variant="ghost" onClick={() => setOpen(false)}>{t('common.close')}</Button>}>
          <p className="mb-2 text-xs break-keep text-faint">{t('projects.privateChatsHint')}</p>
          <ul className="max-h-80 divide-y divide-line overflow-y-auto" data-testid="private-chats-list">
            {mine.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2 text-sm max-md:min-h-11">
                <Lock size={12} className="shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
                <Button size="sm" onClick={() => { setOpen(false); openShareChat(c.id) }} data-testid="private-chats-share">{t('projects.privateChatsShare')}</Button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  )
}
