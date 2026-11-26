// What can be done to a project from more than one place (its page, its card on the Projects page, its row in 프로젝트's
// list beside the rail and on the phone's tab): who may rename and delete it, its rename (the one call and its
// optimistic queue), its delete or move to the trash (one confirm, by what it is on the server now) and the list menu's
// items. Kept out of pages/Projects.tsx so the list beside the rail does not load the page.
import type { Project } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../lib/api'
import { optimistic } from '../lib/optimistic'
import { chatTrashDays } from '../lib/chat-trash'
import { isProjectsFolder } from '../lib/projectFolders'
import { useLocale, useT } from '../i18n'
import { toast } from '../store/ui'
import { useChats } from '../store/chats'
import { useMe } from '../store/session'
import { hideProject, showProject, unhideProject, useProjects } from '../store/projects'
import { projectNow } from './ProjectMembersDialog'
import { leaveItems, useLeaveProject } from './LeaveProject'
import { projectLink, useCopyLink, useTeamOrigin } from './ShareCopyLink'
import { menuOpener, promptDialog } from './ui'
import { destructive } from '../lib/destructive'
import { menuItem, orderMenu, type EntityItem } from './menus/entityMenu'

/** A project's longest name (the server's UpdateProjectBody) */
export const PROJECT_NAME_MAX = 100

/** The address of a project's page (components/ShareCopyLink.tsx, kept there for its Copy link). */
export { projectLink }

/** Who may rename and delete it, also without reading it (Project.canManage; older servers: whoever may edit it). */
export const mayManage = (p: Project) => p.canManage ?? p.canEdit
/** Delete is offered only where the server takes it (Project.canDelete: a member's older project on an admin's folder
 * is an admin's to delete, QA TC-1016) */
export const mayDelete = (p: Project) => p.canDelete ?? mayManage(p)

/** The menu item that deletes it says what it does (QA TC-1064): a team project in projects/ goes to the trash ("Move to
 * trash", as its confirm asks); in the trash, or any other project, "Delete". */
export const deleteLabel = (t: ReturnType<typeof useT>, p: Project) => t(isProjectsFolder(p.folderPath) && !p.inTrash ? 'files.moveToTrash' : 'common.delete')

/** What deleting did: `gone` (deleted for good, or not found any more), the project in the trash now (a team project in
 * projects/ the caller still manages: the owner and admins), or null (cancelled, refused). */
export type Deleted = 'gone' | Project | null

/**
 * A team project into the trash, or back out of it, at once (lib/optimistic.ts, key `project:<id>:trash`): the owner
 * and admins keep its card and its page, saying it is in the trash; anyone else's card goes. `onShown` gets what is on
 * screen each time it changes ('gone': not on the list any more). A refusal puts it back with the server's words.
 * The answer: the project as the server has it now (null: not the caller's to see any more).
 */
export function trashProject(p: Project, trashed: boolean, keeps: boolean, onShown?: (now: Project | 'gone') => void, failText?: false) {
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
  // the files trash keeps it this long (Admin > Team settings; an older server does not say: no number is named)
  const trashDays = me?.team.trashRetentionDays
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
    const toTrash = isProjectsFolder(now.folderPath) && !now.inTrash
    // its guests are switched off with it (and come back when it is restored): said before, with how many (QA TC-2240)
    let guests = 0
    if (toTrash) try { guests = (await api.call(API.getProjectPeople, { params: { id: p.id } })).people.filter((x) => x.guest).length } catch { /* not known: the general words */ }
    // the person left the page while it was asked: no confirm on another page
    if (opener && !opener.isConnected) return null
    opener?.focus()
    const forGood = !!now.inTrash
    const trashBody = trashDays ? t('projects.trashBodyDays', { days: trashDays, files: t('files.title'), trash: t('files.trash') }) : t('projects.trashBody')
    const ask = toTrash
      ? { title: t('projects.trashTitle', { name: now.name }), body: guests ? <>{trashBody}<span className="mt-2 block" data-testid="project-trash-guests">{t('projects.trashGuests', { n: guests })}</span></> : trashBody, confirm: t('files.moveToTrash') }
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
    // lib/destructive.ts: the confirm above, then one toast: in the trash with its Undo when the server says I may bring
    // it back (Project.canRestore on the project it answers with; the restore is trashProject's own, on the same
    // optimistic key), deleted for good with none
    let gone = false
    const r = await destructive<Exclude<Deleted, null>>({
      confirm: ask,
      run: async () => {
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
              gone = true
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
            gone = true
            return 'gone'
          }
          toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
          return null
        }
        deleted(p.id)
        return 'gone'
      },
      done: (d) => {
        // gone before I asked (someone else deleted it): "not found" said it already
        if (gone) return null
        if (!toTrash) return { text: t('projects.deletedToast', { name: now.name }) }
        const kept = d === 'gone' ? null : d
        // back out of the trash, as its note's 되돌리기 does; a refusal says the server's words (trashProject)
        const undo = kept?.canRestore ? () => trashProject(kept, false, true, onShown) : undefined
        return { text: t('projects.trashedToast', { name: now.name }), ...(undo ? { undo } : {}) }
      },
    })
    return r === false ? null : r
  }
}

/** A project's new name saved (name only, so also for the owner or an admin who is not a member: never the edit
 * dialog, which sends its instructions; the server's rule is Project.canManage). On screen at once wherever the project
 * is named (lib/optimistic.ts, key `project:<id>:name`; `onName`: a page's own copy), back with the server's words when
 * it refuses. The project as saved (null: nothing to save, refused, or renamed again meanwhile). The one way a project
 * is renamed: the name's menu, the click on the page's title (EditableTitle), the list's row menus. */
export async function saveProjectName(p: Project, name: string, onName?: (name: string) => void): Promise<Project | null> {
  const to = name.trim()
  if (!to || to === p.name) return null
  const r = await optimistic<string, Project>({
    key: `project:${p.id}:name`,
    from: p.name,
    to,
    show: (v) => {
      showProject({ ...(useProjects.getState().byId[p.id] ?? p), name: v })
      onName?.(v)
    },
    send: () => api.call(API.updateProject, { params: { id: p.id }, body: { name: to } }),
    confirmed: (r) => r.name,
    settle: (r) => {
      useProjects.getState().put(r)
      onName?.(r.name)
    },
  })
  return r.ok && r.newest ? r.reply : null
}

/** A new name for a project in the chat rename's small prompt, then saved as above (saveProjectName). */
export function useRenameProject() {
  const t = useT()
  return async (p: Project, onName?: (name: string) => void): Promise<Project | null> => {
    const name = await promptDialog({ title: t('chat.rename'), label: t('projects.name'), initial: p.name, confirm: t('common.save'), maxLength: PROJECT_NAME_MAX })
    return name ? saveProjectName(p, name, onName) : null
  }
}

/** Who may rename it here: whoever manages it (mayManage), not while it is in the trash (its page has no name menu then) */
export const mayRename = (p: Project) => !!mayManage(p) && !p.inTrash

/** A project menu's Copy link (its page's name menu and its rows): its address on the team address
 * (components/ShareCopyLink.tsx), and no "copied" when the browser refused it. */
export function useProjectMenuLink() {
  const t = useT()
  const copyHref = useCopyLink()
  const origin = useTeamOrigin()
  return async (p: Pick<Project, 'id'>) => {
    if (!(await copyHref(projectLink(p.id, origin)))) return
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
}

/** The menu of a project in a list (a card on the Projects page, a row of 프로젝트's list beside the rail and on the
 * phone's tab): 이름 바꾸기 and 삭제 for whoever manages it (the same prompt and confirm as on its page), 멤버 for whoever
 * may change its members (`onMembers`: the members dialog, without leaving the list), 링크 복사 for everyone, 나가기
 * for a member. `select` wraps each item (the keyboard back on the "…"); `testId` prefixes the items' test ids. */
export function useProjectMenuItems(p: Project, o: { testId: string; select: (fn: () => unknown) => () => void; onRenamed?: (p: Project) => void; onDeleted: (d: Exclude<Deleted, null>) => void; onMembers: () => void }): EntityItem[] {
  const t = useT()
  const copyProjectLink = useProjectMenuLink()
  const remove = useDeleteProject()
  const renameProject = useRenameProject()
  const leaveProject = useLeaveProject()
  const { select, testId: id } = o
  const rename = async () => {
    const r = await renameProject(p)
    if (r) o.onRenamed?.(r)
  }
  const del = async () => {
    // (gone at once, then again with the answer: the keyboard moves on once)
    let gone = false
    const d = await remove(p, (now) => {
      if (now !== 'gone' || gone) return
      gone = true
      o.onDeleted('gone')
    })
    if (d && !(d === 'gone' && gone)) o.onDeleted(d)
  }
  const copyLink = () => copyProjectLink(p)
  // the one list's order (components/menus/entityMenu.tsx): link, open in the app, rename, members, leave, delete
  return orderMenu([
    menuItem(t, 'copyLink', { onSelect: select(copyLink), testId: `${id}-copy-link` }),
    ...(mayManage(p) ? [menuItem(t, 'rename', { onSelect: select(rename), testId: `${id}-rename` })] : []),
    ...(p.membersEditable ? [menuItem(t, 'members', { onSelect: select(o.onMembers), testId: `${id}-members` })] : []),
    ...leaveItems(t, p, select(async () => { if (await leaveProject(p)) o.onDeleted('gone') }), `${id}-leave`),
    // the trash shows at once: the card says so, or (not kept there for me) goes
    ...(mayDelete(p) ? [menuItem(t, 'delete', { label: deleteLabel(t, p), onSelect: select(del), testId: `${id}-delete` })] : []),
  ])
}
