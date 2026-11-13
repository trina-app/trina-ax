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
import { Bell, Eye, EyeOff, Link2, LogOut, Pencil, Pin, PinOff } from 'lucide-react'
import { useRef, useState, type MouseEvent, type RefObject } from 'react'
import { ROOM_NAME_MAX, type Room } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { confirmDialog, promptDialog, useCopy } from '../ui'
import { useNameFallback } from './RoomIcon'
import { MenuButton, useLongPress, type MenuItem } from './MenuButton'
import { RoomNotifyMenu, roomNotify } from './RoomNotifyMenu'
import { useFolderRowItems } from '../nav/NavFolders'

/** What a room's "⋯" holds for me, in order (a pure list of what each kind offers; the words and actions are the
 * component's). */
export type RoomMenuAction = 'pin' | 'unpin' | 'notify' | 'rename' | 'copyLink' | 'leave' | 'hide' | 'show'
export function roomMenuActions(room: Pick<Room, 'kind'> & Partial<Pick<Room, 'hidden' | 'canRename' | 'pinnedAt'>>): RoomMenuAction[] {
  const hidden = room.kind !== 'group' && !!room.hidden
  const last: RoomMenuAction = room.kind === 'group' ? 'leave' : hidden ? 'show' : 'hide'
  const pin: RoomMenuAction[] = hidden ? [] : [room.pinnedAt ? 'unpin' : 'pin']
  return [...pin, 'notify', ...(room.canRename ? (['rename'] as const) : []), 'copyLink', last]
}

/** The address of a room as people in it open it (the app's own route; anyone else gets "not found"). */
export const roomLink = (roomId: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/rooms/${roomId}`

/** The room header's "⋯" on a phone: what goes before the rest (the threads with new replies). */
export interface PhoneHeaderMenu { first?: MenuItem[] }

/** The menu's items for a room: `onNotify` opens the room's level menu (the header's bell; a row has its own, bare).
 * `phone`: the room header's "⋯" on a phone (no 이름 바꾸기, the level after 알림 설정, `first` before the rest). */
export function useRoomMenuItems(room: Room, onNotify: () => void, phone?: PhoneHeaderMenu): MenuItem[] {
  const t = useT()
  const locale = useLocale()
  const { copy } = useCopy()
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
    const ok = await confirmDialog({ title: t('rooms.info.leaveTitle'), body: t('rooms.info.leaveBody'), confirm: t('rooms.info.leave'), danger: true })
    if (ok) await useRooms.getState().leave(room.id).catch(fail)
  }
  const fallbackOf = useNameFallback()
  const rename = async () => {
    const name = await promptDialog({
      title: t('rooms.info.rename'),
      body: t(room.kind === 'group' ? 'rooms.info.nameHintGroup' : 'rooms.info.nameHintTeam'),
      label: t('rooms.info.nameLabel'),
      initial: room.name ?? '',
      placeholder: fallbackOf(room),
      allowEmpty: true,
      maxLength: ROOM_NAME_MAX,
      confirm: t('common.save'),
    })
    if (name === null || name === (room.name ?? '')) return
    // on screen at once; a failure puts the old name back with its own toast (store/rooms.ts rename)
    await useRooms.getState().rename(room.id, name || null)
  }
  const copyLink = async () => {
    await copy(roomLink(room.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  const level = phone ? t(`rooms.notify.${roomNotify(room).level}`) : null
  const items = roomMenuActions(room).filter((a) => !(phone && a === 'rename')).map((a): MenuItem => {
    switch (a) {
      case 'pin': return { label: t('chat.pin'), icon: <Pin size={14} aria-hidden />, onSelect: () => setPinned(true), testId: 'room-menu-pin' }
      case 'unpin': return { label: t('chat.unpin'), icon: <PinOff size={14} aria-hidden />, onSelect: () => setPinned(false), testId: 'room-menu-unpin' }
      case 'notify': return { label: t('rooms.menu.notify'), ...(level ? { hint: `· ${level}` } : {}), icon: <Bell size={14} aria-hidden />, onSelect: onNotify, testId: 'room-menu-notify' }
      case 'rename': return { label: t('rooms.info.rename'), icon: <Pencil size={14} aria-hidden />, onSelect: () => void rename(), testId: 'room-menu-rename' }
      case 'copyLink': return { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink(), testId: 'room-menu-link' }
      case 'leave': return { label: t('rooms.info.leave'), icon: <LogOut size={14} aria-hidden />, danger: true, onSelect: () => void leave(), testId: 'room-menu-leave' }
      case 'hide': return { label: t(room.kind === 'dm' ? 'rooms.menu.hideDm' : 'rooms.menu.hide'), icon: <EyeOff size={14} aria-hidden />, onSelect: () => void hide(), testId: 'room-menu-hide' }
      case 'show': return { label: t('rooms.menu.show'), icon: <Eye size={14} aria-hidden />, onSelect: show, testId: 'room-menu-show' }
    }
  })
  return phone?.first?.length ? [...phone.first, ...items] : items
}

/**
 * The "⋯" and its menu. `onNotify`: the header's bell opens for 알림 설정; without it (a row) the level menu is its own,
 * opened in the same place. `openSignal`: a long press opened it (a sheet on a phone); `openRequest`: a right-click.
 * `label`: the button's name for a screen reader (a row says which room); the tooltip says "더 보기". `title`: a row's
 * room name on top of a phone's sheet (the header's menu needs none: the name is right above it). `phone`: the room
 * header's on a phone (useRoomMenuItems); `dot`: a mark on the button (threads with new replies inside); `buttonRef`:
 * the "⋯" itself (where the keyboard goes back from the header's level menu when the bell is not shown).
 */
export function RoomMenu({ room, onNotify, openSignal, openRequest, label, title, className, buttonClassName, compact, testId = 'room-menu', phone, dot, buttonRef, folders = false }: { room: Room; onNotify?: () => void; openSignal?: number; openRequest?: number; label?: string; title?: string; className?: string; buttonClassName?: string; compact?: boolean; testId?: string; phone?: PhoneHeaderMenu; dot?: boolean; buttonRef?: RefObject<HTMLButtonElement | null>; folders?: boolean }) {
  const t = useT()
  const [notify, setNotify] = useState(0)
  const own = useRef<HTMLButtonElement>(null)
  const more = buttonRef ?? own
  const base = useRoomMenuItems(room, onNotify ?? (() => setNotify((n) => n + 1)), phone)
  // a row of the 대화 list (`folders`): 폴더로 옮기기 / 폴더에서 빼기 before the last item (나가기 or
  // 숨기기); a hidden room has none (it is shown again first, as a pin)
  const folder = useFolderRowItems({ on: folders && !room.hidden, kind: 'rooms', id: room.id, folderId: room.folderId, more })
  const items = folder.items.length ? [...base.slice(0, -1), ...folder.items, ...base.slice(-1)] : base
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

/** A row's ways to its menu: a right-click (or the keyboard's menu key) on the row, and on a touch screen a long press
 * (a sheet on a phone). Spread `row` on the row's <li>; `guard` on its link's click (the finger lifting after a long press
 * opens no room); `openSignal` / `openRequest` go to the row's RoomMenu. */
export function useRowMenu() {
  const [openSignal, setPress] = useState(0)
  const [openRequest, setRequest] = useState(0)
  const pressedAt = useRef(0)
  const longPress = useLongPress(() => {
    pressedAt.current = Date.now()
    setPress((n) => n + 1)
  })
  return {
    openSignal,
    openRequest,
    row: {
      ...longPress,
      onContextMenu: (e: MouseEvent) => {
        longPress.onContextMenu(e)
        // a finger's long press opened it already (and kept the phone's own menu away); Shift keeps the browser's own
        // menu (open in a new tab, copy the address)
        if (e.defaultPrevented || e.shiftKey) return
        e.preventDefault()
        setRequest((n) => n + 1)
      },
    },
    guard: (e: MouseEvent) => {
      if (Date.now() - pressedAt.current < 800) e.preventDefault()
    },
  }
}
