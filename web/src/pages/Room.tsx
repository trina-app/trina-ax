// One room (/rooms/:roomId; the mobile app links here from a notice): a 48px header with the room's name (its mark
// beside it on computers), its member count (opens the member list) and the bell (mute, its only setting); the messages (components/rooms/RoomMessages.tsx),
// older ones loaded on scrolling up; the message box at the bottom. What I see is marked read (POST
// /api/rooms/:id/read with the newest message) while the window has the focus and the bottom of the room is in sight.
// Phones: a back arrow in the header (the bottom tab bar stays away here: the box and the keyboard need the room).
import { Bell, BellOff, ChevronLeft, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isUuid7, type RoomMember, type RoomMessage, type RoomQuote } from '@mycel/shared/api'
import { errorText, isApiError } from '../lib/api'
import { newestSeq } from '../lib/rooms'
import { stickToBottom } from '../lib/stickToBottom'
import { useLocale, useT } from '../i18n'
import { usePeople, usePeopleList } from '../store/people'
import { useRooms, type PendingSend } from '../store/rooms'
import { useMe } from '../store/session'
import { toast } from '../store/ui'
import { MembersDialog } from '../components/rooms/MembersDialog'
import { RoomComposer } from '../components/rooms/RoomComposer'
import { RoomMessages } from '../components/rooms/RoomMessages'
import { RoomAiStatus } from '../components/rooms/RoomAiStatus'
import { RoomIcon, useRoomTitle } from '../components/rooms/RoomIcon'
import { EmptyState, ErrorNote, IconButton, Skeleton } from '../components/ui'

const NO_MESSAGES: RoomMessage[] = []
const NO_PENDING: PendingSend[] = []

export default function RoomPage() {
  const { roomId = '' } = useParams()
  if (!isUuid7(roomId)) return <RoomNotFound />
  return <RoomView key={roomId} roomId={roomId} />
}

function RoomNotFound() {
  const t = useT()
  return (
    <div className="flex h-full flex-col justify-center" data-testid="room-not-found">
      <EmptyState title={t('rooms.notFound')}>
        <p>{t('rooms.notFoundHint')}</p>
        <Link to="/rooms" className="mt-3 inline-block font-medium text-accent-text underline">
          {t('rooms.back')}
        </Link>
      </EmptyState>
    </div>
  )
}

function RoomView({ roomId }: { roomId: string }) {
  const t = useT()
  const locale = useLocale()
  const me = useMe()
  const meId = me?.user.id ?? null
  const title = useRoomTitle()
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const loaded = useRooms((s) => s.loaded)
  const thread = useRooms((s) => (s.thread?.roomId === roomId ? s.thread : null))
  const pending = useRooms((s) => s.pending[roomId]) ?? NO_PENDING
  const roomMembers = useRooms((s) => s.members[roomId]) as RoomMember[] | undefined
  const members = useMemo(() => (roomMembers ?? []).map((m) => m.user), [roomMembers])
  const [missing, setMissing] = useState(false)
  const [reply, setReply] = useState<RoomQuote | null>(null)
  const [showMembers, setShowMembers] = useState(false)
  usePeopleList()

  useEffect(() => {
    useRooms.getState().open(roomId)
    return () => useRooms.getState().close(roomId)
  }, [roomId])
  // not in my list (yet): ask for the room itself; "not found" when I am not in it
  useEffect(() => {
    if (!loaded || room || missing) return
    useRooms
      .getState()
      .fetchRoom(roomId)
      .then((r) => !r && setMissing(true), () => {})
  }, [loaded, room, roomId, missing])
  const notFound = missing || (!!thread?.error && (isApiError(thread.error, 'not_found') || isApiError(thread.error, 'forbidden')))

  const messages = thread?.messages ?? NO_MESSAGES
  // the AI at work here (components/rooms/RoomAiStatus.tsx): the bottom follows its steps too
  const aiKey = useRooms((s) => { const a = s.ai[roomId]; return a ? `${a.answering}:${a.runs.map((r) => `${r.state}${r.steps.length}`).join(',')}` : '' })
  const peerTitle = usePeople((s) => (room?.kind === 'dm' && room.peers[0] ? s.byId[room.peers[0].id]?.title : undefined)) || null
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const last = messages.at(-1)

  // follow new messages while the reader is at the bottom (and always after my own send)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [last?.id, messages.length, pending.length, aiKey])
  // thumbnails load after the text, and a phone's keyboard shrinks the list: stay at the bottom if we were there
  useEffect(() => {
    const s = scroller.current, c = content.current
    if (!s || !c) return
    return stickToBottom(s, c, () => stick.current)
  }, [])

  const tryRead = useCallback(() => {
    const el = scroller.current
    const s = useRooms.getState()
    const r = s.rooms.find((x) => x.id === roomId)
    const th = s.thread
    if (!el || !r || !th || th.roomId !== roomId || !th.messages.length) return
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
    const seq = newestSeq(th.messages)
    if (seq > r.lastReadSeq) void s.markRead(roomId, seq)
  }, [roomId])
  useEffect(() => {
    tryRead()
  }, [tryRead, last?.seq, room?.lastReadSeq, room?.unreadCount])
  useEffect(() => {
    window.addEventListener('focus', tryRead)
    document.addEventListener('visibilitychange', tryRead)
    return () => {
      window.removeEventListener('focus', tryRead)
      document.removeEventListener('visibilitychange', tryRead)
    }
  }, [tryRead])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    const th = useRooms.getState().thread
    if (el.scrollTop < 200 && th?.roomId === roomId && th.nextCursor && !th.loading) {
      const before = el.scrollHeight
      void useRooms
        .getState()
        .loadOlder(roomId)
        .then(() =>
          requestAnimationFrame(() => {
            if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before
          }),
        )
    }
    tryRead()
  }

  if (notFound) return <RoomNotFound />

  const toggleMute = async () => {
    if (!room) return
    try {
      await useRooms.getState().setMuted(roomId, !room.muted)
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="room">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 max-md:gap-1 max-md:pl-0.5 sm:px-4">
        <Link to="/rooms" aria-label={t('rooms.back')} title={t('rooms.back')} className="inline-flex items-center justify-center rounded-md p-3 text-muted hover:bg-hover hover:text-ink md:hidden" data-testid="room-back">
          <ChevronLeft size={20} aria-hidden />
        </Link>
        {/* the room's mark beside its name: computers only (on a phone the name is enough; a DM's picture is on the
            person's messages) */}
        {room && (
          <span className="flex shrink-0 max-md:hidden">
            <RoomIcon room={room} size={24} />
          </span>
        )}
        {/* a DM: the other person's title (직함) small under their name, as the people list shows it */}
        <div className="min-w-0">
          <h1 className="truncate text-base font-medium text-ink" data-testid="room-title">
            {room ? title(room) : ''}
          </h1>
          {peerTitle && (
            <p className="truncate text-xs text-muted" data-testid="room-peer-title">
              {peerTitle}
            </p>
          )}
        </div>
        {room && room.kind !== 'dm' && (
          <button type="button" onClick={() => setShowMembers(true)} className="touch-hit shrink-0 rounded px-1 py-1 text-xs text-faint hover:text-ink max-sm:py-2" data-testid="room-members-button">
            {t('rooms.members', { n: room.memberCount })}
          </button>
        )}
        {/* the room's one setting, right here (a menu of one item is one tap too many): the bell shows how it is now */}
        {room && (
          <IconButton label={room.muted ? t('rooms.unmute') : t('rooms.mute')} className="touch-hit ml-auto" onClick={() => void toggleMute()} data-testid="room-mute">
            {room.muted ? <BellOff size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
          </IconButton>
        )}
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="room-scroller">
        <div ref={content} className="mx-auto max-w-[780px] px-4 pt-2 pb-4">
          {thread?.loading && messages.length > 0 && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
          {thread?.loading && !messages.length && <Skeleton lines={5} className="pt-4" />}
          {!!thread?.error && !notFound && (
            <div className="pt-4">
              <ErrorNote onRetry={() => void useRooms.getState().loadNewest(roomId)}>{errorText(thread.error, locale, t('error.network'))}</ErrorNote>
            </div>
          )}
          {thread && !thread.loading && !thread.error && !messages.length && !pending.length && <p className="py-12 text-center text-sm text-muted">{t('rooms.empty')}</p>}
          <RoomMessages roomId={roomId} messages={messages} pending={pending} meId={meId} members={members} onReply={setReply} />
          <RoomAiStatus roomId={roomId} />
        </div>
      </div>
      <RoomComposer
        roomId={roomId}
        members={members}
        meId={meId}
        reply={reply}
        onCancelReply={() => setReply(null)}
        onReply={setReply}
        empty={!!thread && !thread.loading && !thread.error && !messages.length && !pending.length}
        onSent={() => {
          stick.current = true
        }}
        gone={t('rooms.goneUser')}
      />
      <MembersDialog open={showMembers} onClose={() => setShowMembers(false)} members={roomMembers} meId={meId} />
    </div>
  )
}
