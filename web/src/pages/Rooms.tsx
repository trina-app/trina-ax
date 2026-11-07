// The rooms list (/rooms; the 대화 tab on phones): first a pinned row for the AI chat (like KakaoTalk's "나와의
// 채팅"; called like "@트리나" in the Trina edition), then my rooms by latest activity, each with its last line, when,
// and my unread count. Rows are separated by hairlines on computers and by their own spacing on phones, no cards.
// "새 대화" opens the people list for a DM or a group chat (/rooms?new=1). On a phone the app's top bar is the header ("대화" and the new
// chat icon, components/Layout.tsx): no second title row here.
// Each row has the room's "⋯" (components/rooms/RoomMenu.tsx) on hover or keyboard focus and with a right-click; on a
// phone a long press opens it as a sheet. Rooms I hid (docs/DECISIONS.md "대화 숨기기") are not in the list: a quiet
// "숨긴 대화 N" at its end opens them, each with 다시 보이기 (opening one shows it again too).
import clsx from 'clsx'
import { BellOff, ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, type Locale, type Room } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { dateBucket, formatDate, intlTag } from '../lib/format'
import { plainLine, roomUnread } from '../lib/rooms'
import { useLocale, useT } from '../i18n'
import { useRooms } from '../store/rooms'
import { toast } from '../store/ui'
import { useMe } from '../store/session'
import { PeoplePicker } from '../components/rooms/PeoplePicker'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { ROW_MENU_BUTTON, ROW_MENU_SHOWN, UnreadBadge } from '../components/rooms/SidebarRooms'
import { RoomMenu, useRowMenu } from '../components/rooms/RoomMenu'
import { Button, ErrorNote, PageHeader, Skeleton } from '../components/ui'
import { useNameOf } from '../store/people'
import { useResumeOnLanding } from '../components/onboarding/WelcomeResume'

/** today: the time; yesterday: the word; before: the date */
export function listTime(iso: string, locale: Locale, yesterday: string): string {
  const b = dateBucket(iso)
  if (b === 'today') return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
  if (b === 'yesterday') return yesterday
  return formatDate(iso, locale)
}

export default function Rooms() {
  const t = useT()
  // a phone's sign-in lands here when the app opens on 대화 (lib/tabs.ts START_TAB): the owner who left the welcome
  // steps unfinished goes to them instead
  const resuming = useResumeOnLanding((useLocation().state as { landing?: unknown } | null)?.landing === true)
  const locale = useLocale()
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  // the people list is in the address, so the phone top bar's icon can open it too
  const [params, setParams] = useSearchParams()
  const picking = params.has('new')
  const setPicking = (on: boolean) => setParams(on ? { new: '1' } : {}, { replace: true })
  const row = 'flex items-center gap-3 px-4 py-3 hover:bg-hover sm:px-6'
  if (resuming) return <div className="h-full" />
  const rooms = everyRoom.filter((r) => !r.hidden)
  const hidden = everyRoom.filter((r) => r.hidden)
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="rooms-page">
      <div className="max-md:hidden">
        <PageHeader
          title={t('rooms.title')}
          actions={
            <Button size="sm" onClick={() => setPicking(true)} data-testid="rooms-page-new-dm">
              <Plus size={14} aria-hidden /> {t('rooms.newChat')}
            </Button>
          }
        />
      </div>
      <div className="mx-auto w-full max-w-2xl">
        <ul className="divide-y divide-line border-b border-line max-md:divide-y-0 max-md:border-b-0">
          {/* computers only: a phone has the AI as its own tab (트리나), first in the tab bar */}
          <li className="max-md:hidden">
            <Link to="/" className={row} data-testid="rooms-ai">
              <img src="/favicon.svg" alt="" aria-hidden className="size-10 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{PRODUCT_NAMED_AFTER_AI ? t('rooms.aiName') : PRODUCT.displayName}</span>
                <span className="block truncate text-sm text-muted">{t('rooms.ai.hint')}</span>
              </span>
            </Link>
          </li>
          {rooms.map((r) => (
            <RoomListRow key={r.id} room={r} className={row} />
          ))}
        </ul>
        {hidden.length > 0 && <HiddenRooms rooms={hidden} />}
        {!loaded && <Skeleton lines={4} className="px-4 py-4 sm:px-6" />}
        {loaded && !!failed && (
          <div className="px-4 py-4 sm:px-6">
            <ErrorNote onRetry={() => void useRooms.getState().loadRooms()}>{errorText(failed, locale, t('error.network'))}</ErrorNote>
          </div>
        )}
        {loaded && !failed && !everyRoom.length && <p className="px-4 py-4 text-sm text-muted sm:px-6">{t('rooms.listEmpty')}</p>}
      </div>
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

const HIDDEN_KEY = 'mycel.rooms.hiddenOpen'
const rememberedOpen = () => { try { return localStorage.getItem(HIDDEN_KEY) === 'open' } catch { return false } }

/** "숨긴 대화 N" at the end of the list, folded until opened (remembered in this browser): one quiet row per room, its
 * name opening it (which shows it again) and 다시 보이기 at its end. No preview or count: they wait here. */
function HiddenRooms({ rooms }: { rooms: Room[] }) {
  const t = useT()
  const title = useRoomTitle()
  const locale = useLocale()
  const [open, setOpen] = useState(rememberedOpen)
  const toggle = () => setOpen((v) => { try { localStorage.setItem(HIDDEN_KEY, v ? 'closed' : 'open') } catch { /* not kept */ } return !v })
  const show = (id: string) => void useRooms.getState().setHidden(id, false).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  return (
    <section className="pt-4 pb-8" data-testid="rooms-hidden">
      <h2>
        <button type="button" aria-expanded={open} onClick={toggle} className="flex min-h-11 w-full items-center gap-1 px-4 text-sm text-muted hover:text-ink sm:px-6 md:min-h-9 md:text-xs" data-testid="rooms-hidden-toggle">
          {t('rooms.hidden.title', { n: rooms.length })}
          <ChevronDown size={14} className={clsx('transition-transform motion-reduce:transition-none', !open && '-rotate-90')} aria-hidden />
        </button>
      </h2>
      {open && (
        <ul>
          {rooms.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 hover:bg-hover sm:px-6" data-testid="rooms-hidden-row">
              <Link to={`/rooms/${r.id}`} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-muted hover:text-ink md:min-h-11">
                <span className="opacity-70">
                  <RoomIcon room={r} size={28} tile />
                </span>
                <span className="truncate text-sm">{title(r)}</span>
              </Link>
              <Button size="sm" variant="ghost" className="shrink-0" aria-label={t('rooms.menu.showName', { name: title(r) })} onClick={() => show(r.id)} data-testid="rooms-hidden-show">
                {t('rooms.menu.show')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  const unread = roomUnread(room)
  const menu = useRowMenu()
  return (
    <li className="group relative" {...menu.row}>
    <Link to={`/rooms/${room.id}`} onClick={menu.guard} className={clsx(className, 'pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] group-has-[[aria-expanded=true]]:bg-hover')} data-testid="rooms-row">
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
          {m && <span className={clsx('ml-auto shrink-0 pl-2 text-xs text-faint', ROW_MENU_SHOWN)}>{listTime(m.createdAt, locale, t('sidebar.yesterday'))}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{who ? `${who}: ${what}` : what}</span>
          <UnreadBadge room={room} className={ROW_MENU_SHOWN} testId="rooms-row-unread" />
        </span>
      </span>
    </Link>
    {/* the row's "⋯" in the place of its time and count (a mouse or the keyboard); a phone's long press opens it as a sheet */}
    <RoomMenu
      room={room}
      label={t('rooms.menu.rowLabel', { name: title })}
      className="absolute inset-y-0 right-3 flex items-center sm:right-5"
      buttonClassName={clsx('hover:bg-surface', ROW_MENU_BUTTON)}
      openSignal={menu.openSignal}
      openRequest={menu.openRequest}
      testId="rooms-row-menu"
    />
    </li>
  )
}
