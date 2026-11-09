// A conversation row in the Inbox (docs/DECISIONS.md "알림함의 대화 알림"), read like a line of the 대화 list: the newest
// writer's photo; who and where ("민준 외 2명 · #마케팅 › 스레드") with the time on the right; the newest message's first
// line, after a small "@" when the row mentions me (or "@전체"), with the unread count's pill on the right. One place (a
// thread, or a room's timeline) is one row. The whole row opens that place at my first unread message (?m=,
// pages/Room.tsx) and reads it. Names and the line are people's words: one line each, cut with an ellipsis, inside
// <bdi>. No button and no card: a row is a row.
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import type { InboxNotification } from '@mycel/shared/api'
import { listTime } from '../../lib/format'
import { badgeText, plainLine } from '../../lib/rooms'
import { useLocale, useT } from '../../i18n'
import { useAvatarOf } from '../../store/people'
import { useRooms } from '../../store/rooms'
import { Avatar } from '../Avatar'
import { AiFace } from '../rooms/AiFace'
import { useRoomTitle } from '../rooms/RoomIcon'

type RoomOf = NonNullable<InboxNotification['room']>
/** A room notice from a server that says where and why (older ones send only the room and who: the line they had). */
export type RoomNotice = InboxNotification & { room: RoomOf & { reason: NonNullable<RoomOf['reason']> } }
export const isRoomRow = (item: InboxNotification): item is RoomNotice =>
  (item.code === 'room.dm' || item.code === 'room.mention') && item.link === 'room' && !!item.room?.reason

type T = ReturnType<typeof useT>

/** The words of a row. `title`: the room's name as the app shows it, when the rooms list has the room (an unnamed group
 * chat is named after its people there). `mark`: "@" when the row mentions me or everyone, with what it means for a
 * screen reader. */
export function roomRowText(room: RoomNotice['room'], t: T, title?: string | null): { who: string; where: string; line: string; mark: string | null } {
  const name = room.ai ? t('rooms.aiName') : room.from ?? t('rooms.goneUser')
  const people = room.people ?? 1
  const who = people > 1 ? t('rooms.groupNamesMore', { names: name, n: people - 1 }) : name
  const named = room.name ?? title ?? (room.kind === 'all' ? t('rooms.all') : t('notifications.room.group'))
  const place = room.kind === 'dm' ? t('notifications.room.dm') : room.kind === 'team' ? `#${named}` : named
  const where = room.thread ? `${place} › ${t('rooms.thread')}` : place
  // an AI answer is Markdown: one plain line of it, as the 대화 list shows it
  const text = room.preview ? (room.ai ? plainLine(room.preview) : room.preview) : ''
  const line = text || (room.files ? t('rooms.lastFiles', { n: room.files }) : '')
  const mark = room.reason === 'mention' ? t('notifications.room.mention') : room.reason === 'everyone' ? `@${t('rooms.mentionAll')}` : null
  return { who, where, line, mark }
}

/** Where a row goes: the thread or the room, with the message to start at (the first unread one). */
export function roomNoticeLink(room: Pick<RoomOf, 'id' | 'thread' | 'message'>): string {
  const base = `/rooms/${encodeURIComponent(room.id)}${room.thread ? `/t/${encodeURIComponent(room.thread)}` : ''}`
  return room.message ? `${base}?m=${encodeURIComponent(room.message)}` : base
}

export function RoomNoticeRow({ item, onOpen }: { item: RoomNotice; onOpen: () => void }) {
  const t = useT()
  const locale = useLocale()
  const title = useRoomTitle()
  const listed = useRooms((s) => s.rooms.find((r) => r.id === item.room.id) ?? null)
  const { who, where, line, mark } = roomRowText(item.room, t, listed ? title(listed) : null)
  const unread = !item.readAt
  const n = item.room.count ?? 1
  const at = item.room.at ?? item.createdAt
  return (
    <Link to={roomNoticeLink(item.room)} onClick={onOpen} className="-mx-2 flex min-w-0 items-start gap-3 rounded-lg px-2 py-3 hover:bg-hover" data-testid="notification-room-row" data-unread={unread ? '' : undefined}>
      <Face room={item.room} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="flex min-w-0 flex-1 items-baseline text-sm">
            <bdi className={clsx('max-w-[65%] shrink-0 truncate text-ink', unread ? 'font-semibold' : 'font-medium')} data-testid="notification-room-who">{who}</bdi>
            <span className="min-w-0 truncate text-muted" data-testid="notification-room-where">&nbsp;· <bdi>{where}</bdi></span>
          </span>
          <time dateTime={at} className="shrink-0 text-xs text-faint">{listTime(at, locale, t('sidebar.yesterday'))}</time>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className={clsx('min-w-0 flex-1 truncate text-sm', unread ? 'text-ink' : 'text-muted')} data-testid="notification-room-line">
            {mark && (
              <>
                <span aria-hidden className="mr-1 font-semibold text-accent-text">@</span>
                <span className="sr-only">{mark}: </span>
              </>
            )}
            <bdi>{line}</bdi>
          </span>
          {unread && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 text-micro font-medium text-accent-ink" data-testid="notification-room-count">
              <span aria-hidden>{badgeText(n)}</span>
              <span className="sr-only">{t('rooms.unread', { n })}</span>
            </span>
          )}
        </span>
      </span>
    </Link>
  )
}

/** The newest writer's photo (the AI's mark for an answer of the AI). */
function Face({ room }: { room: RoomOf }) {
  const user = useAvatarOf(room.fromId && room.from ? { id: room.fromId, name: room.from } : null)
  if (room.ai) return <AiFace size={36} className="mt-0.5" />
  return user ? <Avatar user={user} size={36} className="mt-0.5" /> : <span aria-hidden className="mt-0.5 size-9 shrink-0 rounded-full bg-hover" />
}
