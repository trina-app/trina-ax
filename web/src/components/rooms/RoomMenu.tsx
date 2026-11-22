// A conversation's "⋯" (docs/DECISIONS.md "대화 숨기기"): one menu wherever a room shows. In the room's header beside the
// bell (on a phone that header is the top bar); on each row of the 대화 panel and of the full list (/rooms) on hover
// or keyboard focus and with a right-click; on a phone a long press on a row of the 대화 list opens it as a sheet.
// Items by kind: 알림 설정 (the bell's four levels: RoomNotifyMenu), 이름 바꾸기 for those who may (Room.canRename: a
// group chat's members, owners and admins in a team room or the everyone room; the room info's name field in a prompt,
// with its hint and the name an empty field goes back to), 링크 복사 (/rooms/<id>, for people in the room), then a group
// chat's 대화방 나가기 (with its confirm; the room's info has no second one), a DM's 대화 숨기기 and a team room's or
// the everyone room's 숨기기 (they follow the groups, so they cannot be left); a hidden room has 다시 보이기 there.
// Hiding says where it went and how it comes back, with an undo (which pins it again when it was pinned).
// First of all, 상단에 고정 / 고정 해제 (docs/DECISIONS.md "Pinned conversations"), as on the AI chats' rows: mine only. A
// hidden room has none (hiding unpins it; showing it again comes first).
// The room header's "⋯" on a phone (`phone`, QA TC-257): the header there has no bell, so 알림 설정 says the level now
// after it and opens the level menu as a sheet; no 이름 바꾸기 (the name opens the room's info, where it is changed); and
// `phone.first` before the rest (the threads with new replies, whose button the header has no room for).
// The room header's "⋯" of a group chat or a DM also has 초대하기 (`onInvite`, for everyone but a guest; docs/DECISIONS.md
// "Guests from Invite people"): the room info's add list, whose first row is "Invite a guest". Before 알림 설정, right
// after the pin; a row of a list has none (it opens the room first).
// The room header's "⋯" starts with 이 대화에서 검색 (`onSearch`; docs/decisions/20261120-search-shortcuts-slack.md):
// search with "This conversation" on, as ⌘F there; the way to it on a phone and with a mouse.
// A project's chat room (docs/decisions/20261120-project-is-room.md D5) ends with 프로젝트 나가기 in place of 대화방 나가기
// and has no 초대하기: its people are the project's (the room's info has Manage people).
// Before 링크 복사, for whoever may make team projects (not a guest; members when the team lets them): a group chat that
// is no project's room yet has 프로젝트로 만들기 and a 1:1 has "New project with {name}" (MakeProjectDialog.tsx;
// docs/decisions/20261121-make-project-from-room.md).
import { Bell, Blocks, Eye, EyeOff, FolderPlus, Link2, Lock, LogOut, Pencil, Pin, PinOff, Search, UserPlus } from 'lucide-react'
import { useRef, useState, type RefObject } from 'react'
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
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog, useCopy } from '../ui'
import { useNameFallback } from './RoomIcon'
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
  return [...pin, 'notify', ...(room.canRename ? (['rename'] as const) : []), ...(apps ? (['apps'] as const) : []), ...project, 'copyLink', ...last]
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
  // a named group room: a private channel (its words say so)
  const locked = isPrivateChannel(room)
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const show = () => void useRooms.getState().setHidden(room.id, false).catch(fail)
  // on screen at once; a failure undoes it with its own toast (store/rooms.ts setPinned)
  const setPinned = (pinned: boolean) => void useRooms.getState().setPinned(room.id, pinned)
  const hide = async () => {
    // hiding unpins it: the undo pins it again
    const wasPinned = !!room.pinnedAt
    try {
      await useRooms.getState().setHidden(room.id, true)
    } catch (e) {
      return fail(e)
    }
    const undo = async () => {
      try {
        await useRooms.getState().setHidden(room.id, false)
        if (wasPinned) await useRooms.getState().setPinned(room.id, true)
      } catch (e) {
        fail(e)
      }
    }
    toast({ level: 'info', text: t(room.kind === 'dm' ? 'rooms.menu.hiddenDm' : 'rooms.menu.hiddenRoom'), action: { label: t('common.undo'), run: () => void undo() } })
  }
  const leave = async () => {
    const ok = await confirmDialog(locked
      ? { title: t('rooms.info.leaveTitlePrivate'), body: t(isGuestMe(me) ? 'rooms.info.leaveBodyGuestPrivate' : 'rooms.info.leaveBodyPrivate'), confirm: t('rooms.info.leavePrivate'), danger: true }
      : { title: t('rooms.info.leaveTitle'), body: t(isGuestMe(me) ? 'rooms.info.leaveBodyGuest' : 'rooms.info.leaveBody'), confirm: t('rooms.info.leave'), danger: true })
    if (ok) await useRooms.getState().leave(room.id).catch(fail)
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
      title: t(group && !locked ? 'rooms.menu.makePrivate' : 'rooms.info.rename'),
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
  const items = roomMenuActions(room, apps, mayMakeTeamProject(me)).filter((a) => !(phone && a === 'rename')).map((a): MenuItem => {
    switch (a) {
      case 'pin': return { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: () => setPinned(true), testId: 'room-menu-pin' }
      case 'unpin': return { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: () => setPinned(false), testId: 'room-menu-unpin' }
      case 'notify': return { label: t('rooms.menu.notify'), ...(level ? { hint: `· ${level}` } : {}), icon: <Bell size={14} aria-hidden />, onSelect: onNotify, testId: 'room-menu-notify' }
      case 'rename': return { label: t(room.kind === 'group' && !locked ? 'rooms.menu.makePrivate' : 'rooms.info.rename'), icon: room.kind === 'group' && !locked ? <Lock size={14} aria-hidden /> : <Pencil size={14} aria-hidden />, onSelect: () => void rename(), testId: 'room-menu-rename' }
      case 'apps': return { label: appCount ? t('roomApps.menuList', { count: appCount }) : t('roomApps.menuAdd'), icon: <Blocks size={14} aria-hidden />, onSelect: () => useRoomApps.getState().open(room.id), testId: 'room-menu-apps' }
      case 'makeProject': return { label: t('rooms.makeProject.menu'), icon: <FolderPlus size={14} aria-hidden />, onSelect: () => openMakeProject(room.id), testId: 'room-menu-make-project' }
      case 'dmProject': return { label: t('rooms.makeProject.dmMenu', { name: peer?.name ?? '' }), icon: <FolderPlus size={14} aria-hidden />, onSelect: () => peer && openDmProject(peer), testId: 'room-menu-dm-project' }
      case 'copyLink': return { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink(), testId: 'room-menu-link' }
      case 'leave': return { label: t(locked ? 'rooms.info.leavePrivate' : 'rooms.info.leave'), icon: <LogOut size={14} aria-hidden />, danger: true, onSelect: () => void leave(), testId: 'room-menu-leave' }
      case 'leaveProject': return { label: t('projects.leave'), icon: <LogOut size={14} aria-hidden />, danger: true, onSelect: () => void leaveTheProject(), testId: 'room-menu-leave-project', ...(project?.leave === 'last' ? { disabled: true, hint: t('projects.leaveLast') } : {}) }
      case 'hide': return { label: t(room.kind === 'dm' ? 'rooms.menu.hideDm' : 'rooms.menu.hide'), icon: <EyeOff size={14} aria-hidden />, onSelect: () => void hide(), testId: 'room-menu-hide' }
      case 'show': return { label: t('rooms.menu.show'), icon: <Eye size={14} aria-hidden />, onSelect: show, testId: 'room-menu-show' }
    }
  })
  // 초대하기 after the pin (or first), for a group chat or a DM, never for a guest
  if (onInvite && (room.kind === 'group' || room.kind === 'dm') && !isProjectRoom(room) && !room.gone && !isGuestMe(me)) {
    const at = items[0]?.testId === 'room-menu-pin' || items[0]?.testId === 'room-menu-unpin' ? 1 : 0
    items.splice(at, 0, { label: t(locked ? 'rooms.info.invitePrivate' : 'rooms.info.addPeople'), icon: <UserPlus size={14} aria-hidden />, onSelect: onInvite, testId: 'room-menu-invite' })
  }
  // 이 대화에서 검색 first (the room header's: ⌘F does the same)
  if (onSearch) items.unshift({ label: t('rooms.menu.search'), icon: <Search size={14} aria-hidden />, onSelect: onSearch, keys: platform() === 'mac' || platform() === 'ios' ? 'Meta+F' : 'Control+F', testId: 'room-menu-search' })
  return phone?.first?.length ? [...phone.first, ...items] : items
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
  const pinAt = base.findIndex((it) => it.testId === 'room-menu-pin' || it.testId === 'room-menu-unpin')
  const items = folder.items.length ? [...base.slice(0, pinAt + 1), ...folder.items, ...base.slice(pinAt + 1)] : base
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
