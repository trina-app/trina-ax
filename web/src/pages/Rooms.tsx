// The rooms list (/rooms): the 대화 tab on phones, my rooms by latest activity, each with its last line, when, and my
// unread count, separated by their own spacing, no cards. On a computer the 대화 panel beside the page is the list
// (panels/ChatsPanel.tsx, with its ⊕ 새 대화), so this page says to pick one and keeps only what the panel has not: the
// hidden conversations.
// "새 대화" opens the people list for a DM or a group chat (also asked for with /rooms?new=1). The app's top bar is the
// header ("대화" and the new chat icon, components/PhoneTopBar.tsx): no second title row here.
// Each row has the room's "⋯" (components/rooms/RoomMenu.tsx) on hover or keyboard focus and with a right-click; on a
// phone a long press opens it as a sheet. Rooms I hid (docs/DECISIONS.md "대화 숨기기") are not in the list: a quiet
// "숨긴 대화 N" at its end opens them, each with 다시 보이기 (opening one shows it again too).
// The list has the 대화 panel's sections in its order (panels/RoomsByKind.tsx roomsByKind): 고정 (all my pins, the most
// recently pinned first, a pin after the name), my folders (one with nothing in it is left out here), 팀 대화방 (전체
// first), 그룹 대화, 1:1 대화, each under its name. Someone with no 1:1 or group conversation yet gets one quiet line
// under the list that opens the people list ("동료에게 새 대화 시작하기"), as the top bar's ⊕ does.
// The list starts with "멘션·스레드" (QA TC-256): the Activity page's conversations (mentions and replies in
// threads I follow, lib/screens.ts CHATS_ACTIVITY), a page of this tab. A dot while one is unread, no number: their rooms
// count them already, on their rows and on the 대화 tab. Search is the top bar's 🔍 (components/PhoneTopBar.tsx).
import clsx from 'clsx'
import { ListHeading, ListIcon, rowName } from '../components/list/List'
import { AtSign, BellOff, ChevronDown, Plus } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import type { Room } from '@mycel/shared/api'
import { errorText } from '../lib/api'
import { listTime } from '../lib/format'
import { plainLine, roomUnread } from '../lib/rooms'
import { CHATS_ACTIVITY } from '../lib/screens'
import { useLocale, useT } from '../i18n'
import { useRooms } from '../store/rooms'
import { useRoomNoticeUnread } from '../store/inbox'
import { toast } from '../store/ui'
import { useMe } from '../store/session'
import { PeoplePicker } from '../components/rooms/PeoplePicker'
import { RoomIcon, RoomName, useRoomTitle } from '../components/rooms/RoomIcon'
import { ROW_MENU_BUTTON, ROW_MENU_SHOWN, RoomPinIcon, SECTION_WORD, UnreadBadge } from '../components/nav/RoomsList'
import { useFolders } from '../components/nav/NavFolders'
import { roomsByKind } from '../components/panels/RoomsByKind'
import { RoomMenu, useRowMenu } from '../components/rooms/RoomMenu'
import { Button, Skeleton, useMediaQuery } from '../components/ui'
import { LoadError } from '../components/LoadError'
import { useNameOf } from '../store/people'
import { useResumeOnLanding } from '../components/onboarding/WelcomeResume'
import { PresenceText } from '../components/Presence'


export default function Rooms() {
  const t = useT()
  // a phone's sign-in lands here when the app opens on 대화 (lib/tabs.ts START_TAB): the owner who left the welcome
  // steps unfinished goes to them instead
  const resuming = useResumeOnLanding((useLocation().state as { landing?: unknown } | null)?.landing === true)
  const everyRoom = useRooms((s) => s.rooms)
  const loaded = useRooms((s) => s.loaded)
  const failed = useRooms((s) => s.failed)
  // the people list: opened here, or asked for in the address (?new=1: the phone top bar's ⊕, a link), which then
  // leaves the address. Open, it is a dialog with its own history entry on a phone (lib/backCloses.ts): Back closes it
  // and stays on the list, and a chat opened from it takes that entry, so Back from the chat comes back to the list
  const [params, setParams] = useSearchParams()
  const [picking, setPicking] = useState(false)
  const asked = params.has('new')
  useEffect(() => {
    if (!asked) return
    setPicking(true)
    setParams((p) => {
      p.delete('new')
      return p
    }, { replace: true })
  }, [asked, setParams])
  // the phone's rows, sized by the list tokens (index.css): at least a ListRow's height, faces as big as a ListIcon
  const row = 'flex min-h-row-min items-center gap-3 px-4 py-2 hover:bg-hover sm:px-6'
  // a computer: the 대화 panel beside the page is the list (with its ⊕ 새 대화), so the page says to pick one and keeps
  // only what the panel has not: the hidden conversations
  const computer = useMediaQuery('(min-width: 768px)')
  const titleOf = useRoomTitle()
  const locale = useLocale()
  const folders = useFolders('rooms', !computer)
  if (resuming) return <div className="h-full" />
  const hidden = everyRoom.filter((r) => r.hidden)
  if (computer)
    return (
      <div className="flex h-full flex-col overflow-y-auto" data-testid="rooms-page" data-rail="">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
          <p className="px-6 pt-24 pb-8 text-center text-sm text-muted" data-testid="rooms-pick">{t('rail.pickConversation')}</p>
          {hidden.length > 0 && <HiddenRooms rooms={hidden} />}
        </div>
        {/* /rooms?new=1 (a link that asks for a new conversation) opens the people list here too */}
        <PeoplePicker open={picking} onClose={() => setPicking(false)} />
      </div>
    )
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="rooms-page">
      <div className="mx-auto w-full max-w-2xl">
        <ul>
          <ChatsActivityRow className={row} />
        </ul>
        {roomsByKind(everyRoom.filter((r) => !r.hidden), titleOf, locale, folders)
          .filter((s) => s.rooms.length > 0)
          .map((s) => {
            const key = s.folder ? `folder-${s.folder.id}` : s.key
            return (
              <section key={key} aria-labelledby={`rooms-section-${key}`} data-testid="rooms-section" data-section={s.key}>
                <ListHeading as="h2" id={`rooms-section-${key}`} className="px-4 pt-4 pb-1 sm:px-6">
                  {s.folder ? s.folder.name : s.key === 'pinned' ? t('chat.pinned') : t(SECTION_WORD[s.key])}
                </ListHeading>
                <ul>
                  {s.rooms.map((r) => (
                    <RoomListRow key={r.id} room={r} className={row} />
                  ))}
                </ul>
              </section>
            )
          })}
        {loaded && !failed && everyRoom.length > 0 && !everyRoom.some((r) => r.kind === 'dm' || r.kind === 'group') && (
          <button type="button" onClick={() => setPicking(true)} className="mt-2 flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm text-muted hover:text-ink sm:px-6" data-testid="rooms-start-hint">
            <Plus size={16} aria-hidden />
            {t('rooms.startHint')}
          </button>
        )}
        {hidden.length > 0 && <HiddenRooms rooms={hidden} />}
        {!loaded && <Skeleton lines={4} className="px-4 py-4 sm:px-6" />}
        {loaded && !!failed && (
          <div className="px-4 py-4 sm:px-6">
            <LoadError error={failed} onRetry={() => useRooms.getState().loadRooms()} what="rooms" />
          </div>
        )}
        {loaded && !failed && !everyRoom.length && <p className="px-4 py-4 text-sm text-muted sm:px-6">{t('rooms.listEmpty')}</p>}
      </div>
      <PeoplePicker open={picking} onClose={() => setPicking(false)} />
    </div>
  )
}

/** The first row: 멘션·스레드, the conversations' part of Activity (a page of this tab), a dot while one is unread. */
function ChatsActivityRow({ className }: { className: string }) {
  const t = useT()
  const unread = useRoomNoticeUnread() > 0
  return (
    <li>
      <Link to={CHATS_ACTIVITY} className={className} data-testid="rooms-activity">
        <ListIcon>
          <AtSign />
        </ListIcon>
        <span className={clsx('min-w-0 flex-1 truncate', rowName({ unread }))}>{t('feed.chats')}</span>
        {unread && (
          <span className="mr-1 size-2.5 shrink-0 rounded-full bg-accent" data-testid="rooms-activity-unread">
            <span className="sr-only">{t('feed.chatsUnread')}</span>
          </span>
        )}
      </Link>
    </li>
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
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const toggle = () => setOpen((v) => { try { localStorage.setItem(HIDDEN_KEY, v ? 'closed' : 'open') } catch { /* not kept */ } return !v })
  const show = (id: string) => {
    // its row goes from here: the keyboard stays in the section (on its heading) while others are left in it
    if (rooms.length > 1) toggleRef.current?.focus()
    void useRooms.getState().setHidden(id, false).catch((e) => toast({ level: 'error', text: errorText(e, locale, t('error.network')) }))
  }
  return (
    <section className="pt-4 pb-8" data-testid="rooms-hidden">
      <h2>
        <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={listId} onClick={toggle} className="flex min-h-11 w-full items-center gap-1 px-4 text-xs text-muted hover:text-ink sm:px-6 md:min-h-9" data-testid="rooms-hidden-toggle">
          {t('rooms.hidden.title', { n: rooms.length })}
          <ChevronDown size={14} className={clsx('transition-transform motion-reduce:transition-none', !open && '-rotate-90')} aria-hidden />
        </button>
      </h2>
      {open && (
        <ul id={listId}>
          {rooms.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 hover:bg-hover sm:px-6" data-testid="rooms-hidden-row">
              <Link to={`/rooms/${r.id}`} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-muted hover:text-ink md:min-h-11">
                <span className="opacity-70">
                  <RoomIcon room={r} size={28} tile />
                </span>
                <span className="truncate text-sm">{title(r)}</span>
              </Link>
              <Button size="sm" variant="ghost" className="touch-hit shrink-0" aria-label={t('rooms.menu.showName', { name: title(r) })} onClick={() => show(r.id)} data-testid="rooms-hidden-show">
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
  // a message is Markdown (a person's too: the room shows **굵게** bold): one plain line of it, no marks
  const line = !m ? '' : plainLine(m.excerpt)
  const what = !m ? '' : m.deleted ? t('rooms.deleted') : line || (m.fileCount ? t('rooms.lastFiles', { n: m.fileCount }) : '')
  const nameOf = useNameOf()
  // an app's message: the app's name (docs/DECISIONS.md "Apps posting in rooms")
  const who = !m ? null : m.app ? m.app.name : m.author?.id === me?.user.id ? t('rooms.you') : room.kind === 'dm' ? null : nameOf(m.author)
  const unread = roomUnread(room)
  const menu = useRowMenu()
  return (
    <li className="group relative" {...menu.row}>
    <Link to={`/rooms/${room.id}`} onClick={menu.guard} className={clsx(className, 'pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] group-has-[[aria-expanded=true]]:bg-hover',
      // the ring of a DM's online dot takes the row's colour (index.css .presence-dot)
      '[--presence-bg:var(--c-canvas)] hover:[--presence-bg:var(--c-hover)] group-has-[[aria-expanded=true]]:[--presence-bg:var(--c-hover)]',
      // while the "⋯" shows over the row's end, the preview stops before it (the time and the count give way)
      'pointer-fine:group-hover:pr-14 group-has-[:focus-visible]:pr-14 pointer-fine:group-has-[[aria-expanded=true]]:pr-14')} data-testid="rooms-row">
      <RoomIcon room={room} size={32} glyph={18} tile presence />
      {/* the time on the name's line and the count on the preview's, so the preview has the whole width */}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={clsx('truncate', rowName({ unread: unread > 0 }))}><RoomName room={room} /></span>
          {room.kind === 'dm' && room.peers[0] && <PresenceText userId={room.peers[0].id} />}
          {room.muted && (
            <>
              <BellOff size={12} className="shrink-0 text-faint" aria-hidden />
              <span className="sr-only">{t('rooms.muted')}</span>
            </>
          )}
          <RoomPinIcon room={room} />
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
      title={title}
      className="absolute inset-y-0 right-3 flex items-center sm:right-5"
      buttonClassName={clsx('hover:bg-surface', ROW_MENU_BUTTON)}
      openSignal={menu.openSignal}
      openRequest={menu.openRequest}
      testId="rooms-row-menu"
    />
    </li>
  )
}
