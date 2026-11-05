// The rooms list (/rooms; the 대화 tab on phones): first a pinned row for the AI chat (like KakaoTalk's "나와의
// 채팅"), then my rooms by latest activity, each with its last line, when, and my unread count. Rows are separated by
// hairlines, no cards. "새 1:1 대화" opens the people list.
import { BellOff, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import type { Locale, Room } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { dateBucket, formatDate, intlTag } from '../lib/format'
import { badgeText } from '../lib/rooms'
import { useLocale, useT } from '../i18n'
import { useRooms } from '../store/rooms'
import { useMe } from '../store/session'
import { PeoplePicker } from '../components/rooms/PeoplePicker'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { Button, ErrorNote, PageHeader, Skeleton } from '../components/ui'

/** today: the time; yesterday: the word; before: the date */
export function listTime(iso: string, locale: Locale, yesterday: string): string {
  const b = dateBucket(iso)
  if (b === 'today') return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
  if (b === 'yesterday') return yesterday
  return formatDate(iso, locale)
}

export default function Rooms() {
  const t = useT()
  const locale = useLocale()
  const rooms = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  const [picking, setPicking] = useState(false)
  const row = 'flex items-center gap-3 px-4 py-3 hover:bg-hover sm:px-6'
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="rooms-page">
      <PageHeader
        title={t('rooms.title')}
        actions={
          <Button size="sm" onClick={() => setPicking(true)} data-testid="rooms-page-new-dm">
            <Plus size={14} aria-hidden /> {t('rooms.newDm')}
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-2xl">
        <ul className="divide-y divide-line border-b border-line">
          <li>
            <Link to="/" className={row} data-testid="rooms-ai">
              <img src="/favicon.svg" alt="" aria-hidden className="size-10 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{PRODUCT.displayName}</span>
                <span className="block truncate text-sm text-muted">{t('rooms.ai.hint')}</span>
              </span>
            </Link>
          </li>
          {rooms.map((r) => (
            <li key={r.id}>
              <RoomListRow room={r} className={row} />
            </li>
          ))}
        </ul>
        {!loaded && <Skeleton lines={4} className="px-4 py-4 sm:px-6" />}
        {loaded && !!failed && (
          <div className="px-4 py-4 sm:px-6">
            <ErrorNote onRetry={() => void useRooms.getState().loadRooms()}>{errorText(failed, locale, t('error.network'))}</ErrorNote>
          </div>
        )}
        {loaded && !failed && !rooms.length && <p className="px-4 py-4 text-sm text-muted sm:px-6">{t('rooms.listEmpty')}</p>}
      </div>
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

function RoomListRow({ room, className }: { room: Room; className: string }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const title = useRoomTitle()(room)
  const m = room.lastMessage
  const what = !m ? '' : m.deleted ? t('rooms.deleted') : m.excerpt.replace(/\s+/g, ' ').trim() || (m.fileCount ? t('rooms.lastFiles', { n: m.fileCount }) : '')
  const who = !m ? null : m.author?.id === me?.user.id ? t('rooms.you') : room.kind === 'dm' ? null : (m.author?.name ?? null)
  const unread = room.unreadCount
  return (
    <Link to={`/rooms/${room.id}`} className={className} data-testid="rooms-row">
      <RoomIcon room={room} size={40} tile />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={unread > 0 ? 'truncate font-semibold text-ink' : 'truncate font-medium text-ink'}>{title}</span>
          {room.kind !== 'dm' && <span className="shrink-0 text-xs text-faint tabular-nums">{room.memberCount}</span>}
          {room.muted && (
            <>
              <BellOff size={12} className="shrink-0 text-faint" aria-hidden />
              <span className="sr-only">{t('rooms.muted')}</span>
            </>
          )}
        </span>
        <span className="block truncate text-sm text-muted">{who ? `${who}: ${what}` : what}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 self-start pt-0.5">
        {m && <span className="text-xs text-faint">{listTime(m.createdAt, locale, t('sidebar.yesterday'))}</span>}
        {unread > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-ink" data-testid="rooms-row-unread">
            <span aria-hidden>
              {room.mentioned && '@'}
              {badgeText(unread)}
            </span>
            <span className="sr-only">
              {t('rooms.unread', { n: unread })}
              {room.mentioned && `, ${t('rooms.mentionedYou')}`}
            </span>
          </span>
        )}
      </span>
    </Link>
  )
}
