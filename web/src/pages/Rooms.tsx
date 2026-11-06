// The rooms list (/rooms; the 대화 tab on phones): first a pinned row for the AI chat (like KakaoTalk's "나와의
// 채팅"; called like "@트리나" in the Trina edition), then my rooms by latest activity, each with its last line, when,
// and my unread count. Rows are separated by hairlines on computers and by their own spacing on phones, no cards.
// "새 1:1 대화" opens the people list (/rooms?new=1). On a phone the app's top bar is the header ("대화" and the new
// 1:1 icon, components/Layout.tsx): no second title row here.
import { BellOff, Plus } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Locale, type Room } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { dateBucket, formatDate, intlTag } from '../lib/format'
import { plainLine } from '../lib/rooms'
import { useLocale, useT } from '../i18n'
import { useRooms } from '../store/rooms'
import { useMe } from '../store/session'
import { PeoplePicker } from '../components/rooms/PeoplePicker'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { UnreadBadge } from '../components/rooms/SidebarRooms'
import { Button, ErrorNote, PageHeader, Skeleton } from '../components/ui'
import { useNameOf } from '../store/people'

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
  // the people list is in the address, so the phone top bar's icon can open it too
  const [params, setParams] = useSearchParams()
  const picking = params.has('new')
  const setPicking = (on: boolean) => setParams(on ? { new: '1' } : {}, { replace: true })
  const row = 'flex items-center gap-3 px-4 py-3 hover:bg-hover sm:px-6'
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="rooms-page">
      <div className="max-md:hidden">
        <PageHeader
          title={t('rooms.title')}
          actions={
            <Button size="sm" onClick={() => setPicking(true)} data-testid="rooms-page-new-dm">
              <Plus size={14} aria-hidden /> {t('rooms.newDm')}
            </Button>
          }
        />
      </div>
      <div className="mx-auto w-full max-w-2xl">
        <ul className="divide-y divide-line border-b border-line max-md:divide-y-0 max-md:border-b-0">
          <li>
            <Link to="/" className={row} data-testid="rooms-ai">
              <img src="/favicon.svg" alt="" aria-hidden className="size-10 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{PRODUCT_NAMED_AFTER_AI ? t('rooms.aiName') : PRODUCT.displayName}</span>
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
  // an AI answer (no author) is Markdown: one plain line of it
  const line = !m ? '' : m.author ? m.excerpt.replace(/\s+/g, ' ').trim() : plainLine(m.excerpt)
  const what = !m ? '' : m.deleted ? t('rooms.deleted') : line || (m.fileCount ? t('rooms.lastFiles', { n: m.fileCount }) : '')
  const nameOf = useNameOf()
  const who = !m ? null : m.author?.id === me?.user.id ? t('rooms.you') : room.kind === 'dm' ? null : nameOf(m.author)
  const unread = room.unreadCount
  return (
    <Link to={`/rooms/${room.id}`} className={className} data-testid="rooms-row">
      <RoomIcon room={room} size={40} tile />
      {/* the time on the name's line and the count on the preview's, so the preview has the whole width */}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={unread > 0 ? 'truncate text-base font-semibold text-ink' : 'truncate text-base font-medium text-ink'}>{title}</span>
          {room.muted && (
            <>
              <BellOff size={12} className="shrink-0 text-faint" aria-hidden />
              <span className="sr-only">{t('rooms.muted')}</span>
            </>
          )}
          {m && <span className="ml-auto shrink-0 pl-2 text-xs text-faint">{listTime(m.createdAt, locale, t('sidebar.yesterday'))}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{who ? `${who}: ${what}` : what}</span>
          <UnreadBadge room={room} testId="rooms-row-unread" />
        </span>
      </span>
    </Link>
  )
}
