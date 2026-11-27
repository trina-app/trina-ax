// A conversation's "⋯" (docs/DECISIONS.md "대화 숨기기"): one menu wherever a room shows. In the room's header beside the
// bell (on a phone that header is the top bar); on each row of the 대화 panel and of the full list (/rooms) on hover
// or keyboard focus and with a right-click; on a phone a long press on a row of the 대화 list opens it as a sheet.
// Its items and their order are the one list's (components/menus/entityMenu.tsx; docs/decisions/20261126-shared-menus.md),
// shared with the AI chats' and the projects' menus: 이 대화에서 검색 (the header's, as ⌘F:
// docs/decisions/20261120-search-shortcuts-slack.md), 상단에 고정 / 고정 해제 (mine only; a hidden room has none), the
// sections (a row's and the header's), 알림 설정 (the bell's four levels: RoomNotifyMenu; a phone header says the level
// now after it and opens the level menu as a sheet), 링크 복사 (/rooms/<id>, for people in the room), 앱에서 열기 (the
// header's, a computer's browser), 이름 바꾸기 for those who may (Room.canRename; a group chat's 비공개 채널로 만들기; a
// phone header too), 프로젝트로 만들기 / "New project with {name}" for whoever may make team projects
// (docs/decisions/20261121-make-project-from-room.md), 초대하기 (the header's, a group chat or a DM, not a guest), 앱
//추가, then the ways out: a group chat's 대화방 나가기 (its confirm, then a toast), a DM's, a team room's or the everyone
// room's 내 목록에서 숨기기 (with an undo that pins it again when it was pinned), a hidden room's 다시 보이기, a project's
// chat room's 프로젝트 나가기 (docs/decisions/20261120-project-is-room.md D5). Hiding and leaving go through
// lib/destructive.ts. A phone header's `phone.first` (the threads with new replies) stays above the list.
import { useRef, useState, type RefObject } from 'react'
import { PRODUCT } from '@mycel/shared'
import { ROOM_NAME_MAX, type Project, type Room } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { markLeaving, useRooms } from '../../store/rooms'
import { mayManageApps, useRoomApps } from '../../store/roomApps'
import { mayMakeTeamProject, useMe } from '../../store/session'
import { isGuestMe } from '../../lib/guests'
import { isPrivateChannel, isProjectRoom, projectRoomOf } from '../../lib/rooms'
import { useLeaveProject } from '../LeaveProject'
import { navigateTo } from '../../lib/nav'
import { platform } from '../../lib/pwa'
import { clientKind } from '../../lib/desktop'
import { pageOpenInAppHref } from '../../lib/team-link'
import { destructive } from '../../lib/destructive'
import { menuItem, orderMenu, type EntityItem } from '../menus/entityMenu'
import { toast } from '../../store/ui'
import { promptDialog, useCopy, useMediaQuery } from '../ui'
import { useNameFallback, useRoomTitle } from './RoomIcon'
import { MenuButton, type MenuItem } from './MenuButton'
import { RoomNotifyMenu, roomNotify } from './RoomNotifyMenu'
import { canSection, useSectionRowItems } from '../nav/SidebarSections'
import { openDmProject, openMakeProject } from './MakeProjectDialog'

/** What a room's "⋯" holds for me, in order (a pure list of what each kind offers; the words and actions are the
 * component's). */
export type RoomMenuAction = 'pin' | 'unpin' | 'notify' | 'rename' | 'apps' | 'makeProject' | 'dmProject' | 'copyLink' | 'leave' | 'leaveProject' | 'hide' | 'show'
/** `apps`: I manage the room's apps ("Add an app" / "Apps posting here", docs/DECISIONS.md "Apps posting in rooms"): in
 * a team room or the everyone room its owners and admins, in a 1:1 or a group chat its members (store/roomApps.ts).
 * `projects`: I may make team projects (store/session.ts mayMakeTeamProject: not a guest, and the team lets me): a group
 * chat that is not a project's room yet offers Make it a project, a 1:1 New project with {name}
 * (docs/decisions/20261121-make-project-from-room.md), before Copy link. */
export function roomMenuActions(room: Pick<Room, 'kind'> & Partial<Pick<Room, 'name' | 'hidden' | 'canRename' | 'pinnedAt' | 'project' | 'projectRoom' | 'gone'>>, apps = false, projects = false): RoomMenuAction[] {
  const hidden = room.kind !== 'group' && !!room.hidden
  // a project's chat room: Leave project when the server says I may (Room.project.leave; the last person sees it off),
  // else nothing (a member who cannot open the project now)
  const last: RoomMenuAction[] = isProjectRoom(room) ? (room.project?.leave ? ['leaveProject'] : []) : [room.kind === 'group' ? 'leave' : hidden ? 'show' : 'hide']
  const pin: RoomMenuAction[] = hidden ? [] : [room.pinnedAt ? 'unpin' : 'pin']
  const project: RoomMenuAction[] = !projects || room.gone || isProjectRoom(room) ? [] : room.kind === 'group' ? ['makeProject'] : room.kind === 'dm' && !hidden ? ['dmProject'] : []
  // in the one list's order (components/menus/entityMenu.tsx MENU_ORDER)
  return [...pin, 'notify', 'copyLink', ...(room.canRename ? (['rename'] as const) : []), ...project, ...(apps ? (['apps'] as const) : []), ...last]
}

/** The address of a room as people in it open it (the app's own route; anyone else gets "not found"). */
export const roomLink = (roomId: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/rooms/${roomId}`

/** The room header's "⋯" on a phone: what goes before the rest (the threads with new replies). */
export interface PhoneHeaderMenu { first?: MenuItem[] }

/** The menu's items for a room: `onNotify` opens the room's level menu (the header's bell; a row has its own, bare).
 * `phone`: the room header's "⋯" on a phone (no 이름 바꾸기, the level after 알림 설정, `first` before the rest). */
export function useRoomMenuItems(room: Room, onNotify: () => void, phone?: PhoneHeaderMenu, onInvite?: () => void, onSearch?: () => void): MenuItem[] {
  const t = useT()
  const locale = useLocale()
  const { copy } = useCopy()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  const roomTitle = useRoomTitle()
  // a named group room: a private channel (its words say so)
  const locked = isPrivateChannel(room)
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const show = () => void useRooms.getState().setHidden(room.id, false).catch(fail)
  // on screen at once; a failure undoes it with its own toast (store/rooms.ts setPinned)
  const setPinned = (pinned: boolean) => void useRooms.getState().setPinned(room.id, pinned)
  // hiding (lib/destructive.ts): no confirm, says where it went, with an undo (which pins it again when it was pinned)
  const hide = () => {
    const wasPinned = !!room.pinnedAt
    const undo = async () => {
      try {
        await useRooms.getState().setHidden(room.id, false)
        if (wasPinned) await useRooms.getState().setPinned(room.id, true)
      } catch (e) {
        fail(e)
      }
    }
    return destructive({
      run: () => useRooms.getState().setHidden(room.id, true).then(() => true, (e) => (fail(e), false)),
      done: () => ({ text: t(room.kind === 'dm' ? 'rooms.menu.hiddenDm' : 'rooms.menu.hiddenRoom'), undo }),
    })
  }
  // leaving a group chat (lib/destructive.ts): its confirm, then a toast that says so (no undo: only someone in it can
  // add me again)
  const leave = () => {
    const name = roomTitle(room)
    return destructive({
      confirm: locked
        ? { title: t('rooms.info.leaveTitlePrivate'), body: t(isGuestMe(me) ? 'rooms.info.leaveBodyGuestPrivate' : 'rooms.info.leaveBodyPrivate'), confirm: t('rooms.info.leavePrivate') }
        : { title: t('rooms.info.leaveTitle'), body: t(isGuestMe(me) ? 'rooms.info.leaveBodyGuest' : 'rooms.info.leaveBody'), confirm: t('rooms.info.leave') },
      run: () => useRooms.getState().leave(room.id).then(() => true, (e) => (fail(e), false)),
      done: () => ({ text: t('rooms.menu.left', { name }) }),
    })
  }
  // a project's chat room: leaving it is leaving the project (its confirm, components/LeaveProject.tsx); the room's own
  // "removed" that follows is no news here (markLeaving)
  const leaveProject = useLeaveProject()
  const project = projectRoomOf(room)
  const leaveTheProject = async () => {
    if (!project || project.leave !== 'yes') return
    markLeaving(room.id)
    if (await leaveProject({ id: project.id, name: project.name } as Project)) navigateTo('/rooms', { replace: true })
  }
  const fallbackOf = useNameFallback()
  const rename = async (typed?: string): Promise<void> => {
    // a group room: a group DM is turned into a private channel by naming it, and a private channel keeps a name (it
    // stays a channel: docs/decisions/20261117-named-groups-private-channels.md); a team room's empty name goes back
    const group = room.kind === 'group'
    const name = await promptDialog({
      title: t(group && !locked ? 'rooms.menu.makePrivate' : 'chat.rename'),
      ...(group ? (locked ? {} : { body: t('rooms.menu.makePrivateBody') }) : { body: t('rooms.info.nameHintTeam') }),
      label: t(group ? 'rooms.info.nameLabelPrivate' : 'rooms.info.nameLabelChannel'),
      initial: typed ?? room.name ?? '',
      placeholder: group ? '' : fallbackOf(room),
      allowEmpty: !group,
      maxLength: ROOM_NAME_MAX,
      confirm: t('common.save'),
    })
    if (name === null || name === (room.name ?? '')) return
    // on screen at once; a failure puts the old name back with its own toast (store/rooms.ts rename) and asks again
    // with the name typed
    if (!(await useRooms.getState().rename(room.id, name || null))) await rename(name)
  }
  const copyLink = async () => {
    await copy(roomLink(room.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const level = phone ? t(`rooms.notify.${roomNotify(room).level}`) : null
  // the room's apps: "Apps posting here · 2" once there are some (the list is read on the room's page), else "Add an app"
  const me = useMe()
  const apps = mayManageApps(room, me)
  const appCount = useRoomApps((s) => s.lists[room.id]?.items.length ?? 0)
  const peer = room.peers[0]
  // "Open in the app": the room header's menu only (a row opens the room first), as a chat's title menu
  const appHref = onSearch && !room.gone ? pageOpenInAppHref({ scheme: PRODUCT.linkScheme, origin: typeof location === 'undefined' ? '' : location.origin, path: `/rooms/${room.id}`, platform: platform(), client: clientKind(), phone: narrow }) : null
  const rename1: 'makePrivate' | 'rename' = room.kind === 'group' && !locked ? 'makePrivate' : 'rename'
  const actions = roomMenuActions(room, apps, mayMakeTeamProject(me))
  const items = actions.map((a): EntityItem => {
    switch (a) {
      case 'pin': return menuItem(t, 'pin', { onSelect: () => setPinned(true), testId: 'room-menu-pin' })
      case 'unpin': return menuItem(t, 'unpin', { onSelect: () => setPinned(false), testId: 'room-menu-unpin' })
      case 'notify': return menuItem(t, 'notify', { ...(level ? { hint: `· ${level}` } : {}), onSelect: onNotify, testId: 'room-menu-notify' })
      case 'rename': return menuItem(t, rename1, { onSelect: () => void rename(), testId: 'room-menu-rename' })
      case 'apps': return menuItem(t, 'apps', { label: appCount ? t('roomApps.menuList', { count: appCount }) : t('roomApps.menuAdd'), onSelect: () => useRoomApps.getState().open(room.id), testId: 'room-menu-apps' })
      case 'makeProject': return menuItem(t, 'makeProject', { onSelect: () => openMakeProject(room.id), testId: 'room-menu-make-project' })
      case 'dmProject': return menuItem(t, 'dmProject', { label: t('rooms.makeProject.dmMenu', { name: peer?.name ?? '' }), onSelect: () => peer && openDmProject(peer), testId: 'room-menu-dm-project' })
      case 'copyLink': return menuItem(t, 'copyLink', { onSelect: () => void copyLink(), testId: 'room-menu-link' })
      case 'leave': return menuItem(t, 'leave', { label: t(locked ? 'rooms.info.leavePrivate' : 'rooms.info.leave'), onSelect: () => void leave(), testId: 'room-menu-leave' })
      case 'leaveProject': return menuItem(t, 'leave', { label: t('projects.leave'), onSelect: () => void leaveTheProject(), testId: 'room-menu-leave-project', ...(project?.leave === 'last' ? { disabled: true, hint: t('projects.leaveLast') } : {}) })
      case 'hide': return menuItem(t, 'hide', { onSelect: () => void hide(), testId: 'room-menu-hide' })
      case 'show': return menuItem(t, 'show', { onSelect: show, testId: 'room-menu-show' })
    }
  })
  // 초대하기 for a group chat or a DM, never for a guest (the room header's)
  if (onInvite && (room.kind === 'group' || room.kind === 'dm') && !isProjectRoom(room) && !room.gone && !isGuestMe(me))
    items.push(menuItem(t, 'invite', { label: t(locked ? 'rooms.info.invitePrivate' : 'rooms.info.addPeople'), onSelect: onInvite, testId: 'room-menu-invite' }))
  // 이 대화에서 검색 (the room header's: ⌘F does the same)
  if (onSearch) items.push(menuItem(t, 'search', { onSelect: onSearch, keys: platform() === 'mac' || platform() === 'ios' ? 'Meta+F' : 'Control+F', testId: 'room-menu-search' }))
  if (appHref) items.push(menuItem(t, 'openInApp', { onSelect: () => { location.href = appHref }, testId: 'room-menu-open-in-app' }))
  const ordered = orderMenu(items)
  return phone?.first?.length ? [...phone.first, ...ordered] : ordered
}

/**
 * The "⋯" and its menu. `onNotify`: the header's bell opens for 알림 설정; without it (a row) the level menu is its own,
 * opened in the same place. `openSignal`: a long press opened it (a sheet on a phone); `openRequest`: a right-click.
 * `label`: the button's name for a screen reader (a row says which room); the tooltip says "더 보기". `title`: a row's
 * room name on top of a phone's sheet (the header's menu needs none: the name is right above it). `phone`: the room
 * header's on a phone (useRoomMenuItems); `dot`: a mark on the button (threads with new replies inside); `buttonRef`:
 * the "⋯" itself (where the keyboard goes back from the header's level menu when the bell is not shown). `onInvite`: the
 * room header's 초대하기 (the add list). `onSearch`: the room header's 이 대화에서 검색.
 */
export function RoomMenu({ room, onNotify, onInvite, onSearch, openSignal, openRequest, label, title, className, buttonClassName, compact, testId = 'room-menu', phone, dot, buttonRef, folders = false }: { room: Room; onNotify?: () => void; onInvite?: () => void; onSearch?: () => void; openSignal?: number; openRequest?: number; label?: string; title?: string; className?: string; buttonClassName?: string; compact?: boolean; testId?: string; phone?: PhoneHeaderMenu; dot?: boolean; buttonRef?: RefObject<HTMLButtonElement | null>; folders?: boolean }) {
  const t = useT()
  const [notify, setNotify] = useState(0)
  const own = useRef<HTMLButtonElement>(null)
  const more = buttonRef ?? own
  const base = useRoomMenuItems(room, onNotify ?? (() => setNotify((n) => n + 1)), phone, onInvite, onSearch)
  // `folders` (a row of the Chats list, its phone long-press sheet, the conversation's header): Move to section and
  // Remove from section second, under Pin (docs/decisions/20261121-personal-sidebar-sections.md); a hidden one has none
  const folder = useSectionRowItems({ on: folders && canSection(room), id: room.id, folderId: room.folderId, more })
  // (the one list's order: the section items right under the pin; a phone header's `first` stays above it all)
  const first = phone?.first?.length ? base.slice(0, phone.first.length) : []
  const items = folder.items.length ? [...first, ...orderMenu([...(base.slice(first.length) as EntityItem[]), ...folder.items])] : base
  return (
    <>
      <MenuButton
        label={label ?? t('rooms.menu.label')}
        tip={t('rooms.menu.label')}
        items={items}
        muted
        className={className}
        buttonClassName={buttonClassName}
        compact={compact}
        openSignal={openSignal}
        openRequest={openRequest}
        testId={testId}
        sheetTitle={title}
        buttonRef={more}
        dot={dot}
      />
      {/* a row's own level menu, where its "⋯" opens (the button is the row's "⋯": this one has none) */}
      {!onNotify && <RoomNotifyMenu room={room} bare openRequest={notify} className="absolute right-1.5 bottom-0" focusBack={() => more.current?.focus()} />}
      {folder.picker}
    </>
  )
}

/** A row's ways to its menu (right-click, long press): in MenuButton.tsx beside the menu, so a ListRow can use it too */
export { useRowMenu } from './MenuButton'
