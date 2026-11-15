// The room's bell (docs/DECISIONS.md "대화방 알림 설정"): my level for this room, one tap away in its header. Four choices,
// the chosen one ticked: 기본값 (my default from Settings › Notifications, with what it gives this room now), 모든 메시지,
// 멘션만, 끄기. The bell shows how it is now (crossed out at 끄기). What each level means is the server's and the room
// sound's one rule (shared room-alerts.ts); the server answers with the room as it is now. The room's "⋯" menu
// (RoomMenu.tsx) opens the same menu from its "알림 설정" (`openRequest`); a row has no bell of its own (`bare`: no button,
// the menu only), and neither has the room header on a phone (QA TC-257: ⋯ › 알림 설정 is the one way there).
import { Bell, BellOff } from 'lucide-react'
import { roomLevel, type Room, type RoomNotifyLevel } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { MenuButton } from './MenuButton'

/** The room's notify fields, also from an older server (muted only). */
export function roomNotify(room: Pick<Room, 'kind' | 'muted' | 'notify'>): NonNullable<Room['notify']> {
  if (room.notify) return room.notify
  const own: RoomNotifyLevel | null = room.muted ? 'off' : null, byDefault = roomLevel(room.kind, null, 'direct')
  return { own, byDefault, level: own ?? byDefault }
}

export function RoomNotifyMenu({ room, openRequest = 0, bare = false, className, focusBack }: { room: Room; openRequest?: number; bare?: boolean; className?: string; focusBack?: () => void }) {
  const t = useT()
  const n = roomNotify(room)
  // on screen at once; a failure puts it back with its own toast (store/rooms.ts setNotifyLevel)
  const choose = (level: RoomNotifyLevel | null) => {
    if (level === n.own) return
    void useRooms.getState().setNotifyLevel(room.id, level)
  }
  const word = (l: RoomNotifyLevel) => t(`rooms.notify.${l}`)
  return (
    <MenuButton
      label={t('rooms.notify.button', { level: word(n.level) })}
      heading={t('rooms.notify.heading')}
      icon={n.level === 'off' ? <BellOff size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
      muted
      className={className ?? 'shrink-0'}
      buttonClassName={bare ? 'hidden!' : 'touch-hit'}
      openRequest={openRequest}
      focusBack={focusBack}
      testId={bare ? 'room-notify-row' : 'room-notify'}
      items={[
        { label: t('rooms.notify.default'), hint: `· ${word(n.byDefault)}`, checked: n.own === null, onSelect: () => choose(null), testId: 'room-notify-default' },
        ...(['all', 'mentions', 'off'] as const).map((l) => ({ label: word(l), checked: n.own === l, onSelect: () => choose(l), testId: `room-notify-${l}` })),
      ]}
    />
  )
}
