// A conversation's "⋯" (docs/DECISIONS.md "대화 숨기기"): one menu wherever a room shows. In the room's header beside the
// bell (on a phone that header is the top bar); on each row of the sidebar's 대화 and of the full list (/rooms) on hover
// or keyboard focus and with a right-click; on a phone a long press on a row of the 대화 list opens it as a sheet.
// Items by kind: 알림 설정 (the bell's four levels: RoomNotifyMenu), 링크 복사 (/rooms/<id>, for people in the room),
// then a group chat's 대화방 나가기 (the members dialog's leave, with its confirm), a DM's 대화 숨기기 and a team room's
// or the everyone room's 숨기기 (they follow the groups, so they cannot be left); a hidden room has 다시 보이기 there.
// Hiding says where it went and how it comes back, with an undo.
import { Bell, Eye, EyeOff, Link2, LogOut } from 'lucide-react'
import { useRef, useState, type MouseEvent } from 'react'
import type { Room } from '@mycel/shared/api'
import { errorText } from '../../lib/api'
import { useLocale, useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { toast } from '../../store/ui'
import { confirmDialog, useCopy } from '../ui'
import { MenuButton, useLongPress, type MenuItem } from './MenuButton'
import { RoomNotifyMenu } from './RoomNotifyMenu'

/** What a room's "⋯" holds for me, in order (a pure list of what each kind offers; the words and actions are the
 * component's). */
export type RoomMenuAction = 'notify' | 'copyLink' | 'leave' | 'hide' | 'show'
export function roomMenuActions(room: Pick<Room, 'kind'> & Partial<Pick<Room, 'hidden'>>): RoomMenuAction[] {
  const last: RoomMenuAction = room.kind === 'group' ? 'leave' : room.hidden ? 'show' : 'hide'
  return ['notify', 'copyLink', last]
}

/** The address of a room as people in it open it (the app's own route; anyone else gets "not found"). */
export const roomLink = (roomId: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/rooms/${roomId}`

/** The menu's items for a room: `onNotify` opens the room's level menu (the header's bell; a row has its own, bare). */
export function useRoomMenuItems(room: Room, onNotify: () => void): MenuItem[] {
  const t = useT()
  const locale = useLocale()
  const { copy } = useCopy()
  const fail = (e: unknown) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
  const show = () => void useRooms.getState().setHidden(room.id, false).catch(fail)
  const hide = async () => {
    try {
      await useRooms.getState().setHidden(room.id, true)
    } catch (e) {
      return fail(e)
    }
    toast({ level: 'info', text: t(room.kind === 'dm' ? 'rooms.menu.hiddenDm' : 'rooms.menu.hiddenRoom'), action: { label: t('common.undo'), run: show } })
  }
  const leave = async () => {
    const ok = await confirmDialog({ title: t('rooms.info.leaveTitle'), body: t('rooms.info.leaveBody'), confirm: t('rooms.info.leave'), danger: true })
    if (ok) await useRooms.getState().leave(room.id).catch(fail)
  }
  const copyLink = async () => {
    await copy(roomLink(room.id))
    toast({ level: 'success', text: t('rooms.menu.linkCopied') })
  }
  return roomMenuActions(room).map((a): MenuItem => {
    switch (a) {
      case 'notify': return { label: t('rooms.menu.notify'), icon: <Bell size={14} aria-hidden />, onSelect: onNotify, testId: 'room-menu-notify' }
      case 'copyLink': return { label: t('rooms.menu.copyLink'), icon: <Link2 size={14} aria-hidden />, onSelect: () => void copyLink(), testId: 'room-menu-link' }
      case 'leave': return { label: t('rooms.info.leave'), icon: <LogOut size={14} aria-hidden />, danger: true, onSelect: () => void leave(), testId: 'room-menu-leave' }
      case 'hide': return { label: t(room.kind === 'dm' ? 'rooms.menu.hideDm' : 'rooms.menu.hide'), icon: <EyeOff size={14} aria-hidden />, onSelect: () => void hide(), testId: 'room-menu-hide' }
      case 'show': return { label: t('rooms.menu.show'), icon: <Eye size={14} aria-hidden />, onSelect: show, testId: 'room-menu-show' }
    }
  })
}

/**
 * The "⋯" and its menu. `onNotify`: the header's bell opens for 알림 설정; without it (a row) the level menu is its own,
 * opened in the same place. `openSignal`: a long press opened it (a sheet on a phone); `openRequest`: a right-click.
 * `label`: the button's name for a screen reader (a row says which room); the tooltip says "더 보기".
 */
export function RoomMenu({ room, onNotify, openSignal, openRequest, label, className, buttonClassName, testId = 'room-menu' }: { room: Room; onNotify?: () => void; openSignal?: number; openRequest?: number; label?: string; className?: string; buttonClassName?: string; testId?: string }) {
  const t = useT()
  const [notify, setNotify] = useState(0)
  const items = useRoomMenuItems(room, onNotify ?? (() => setNotify((n) => n + 1)))
  return (
    <>
      <MenuButton
        label={label ?? t('rooms.menu.label')}
        tip={t('rooms.menu.label')}
        items={items}
        muted
        className={className}
        buttonClassName={buttonClassName}
        openSignal={openSignal}
        openRequest={openRequest}
        testId={testId}
      />
      {/* a row's own level menu, where its "⋯" opens (the button is the row's "⋯": this one has none) */}
      {!onNotify && <RoomNotifyMenu room={room} bare openRequest={notify} className="absolute right-1.5 bottom-0" />}
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
        // a finger's long press opened it already (and kept the phone's own menu away)
        if (e.defaultPrevented) return
        e.preventDefault()
        setRequest((n) => n + 1)
      },
    },
    guard: (e: MouseEvent) => {
      if (Date.now() - pressedAt.current < 800) e.preventDefault()
    },
  }
}
