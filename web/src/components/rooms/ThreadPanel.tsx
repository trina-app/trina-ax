// A thread (docs/DECISIONS.md "스레드와 반응"), at /rooms/:roomId/t/:messageId: on computers a plain column beside the
// room (a hairline on its left, a divider there to resize it: components/PanelDivider.tsx; the room keeps 420 px), on
// phones the whole screen (the room's header gives way to the thread's, with a back arrow; the bottom tabs stay away
// as in the room). The root on top with its reactions, a hairline with how many replies, the replies (the room's list:
// runs, reactions, my AI questions asked here), and the reply box with "대화방에도 보내기". What I see is marked read in the thread (POST …/thread/read) while the window has the focus and
// the end of the thread is in sight. A thread I cannot see (I joined after its root, it is gone) says so.
import { ChevronLeft, Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { RoomMessage, UserRef } from '@mycel/shared/api'
import { errorText, isApiError } from '../../lib/api'
import { lookingAt } from '../../lib/attention'
import { newestSeq, TARGET_PAGES } from '../../lib/rooms'
import { followsAfterScroll, stickToBottom } from '../../lib/stickToBottom'
import { THREAD_PANEL } from '../../lib/panelWidth'
import { useLocale, useT } from '../../i18n'
import { useRooms, type PendingSend } from '../../store/rooms'
import { PanelDivider } from '../PanelDivider'
import { ErrorNote, IconButton, Skeleton } from '../ui'
import { RoomAiStatus } from './RoomAiStatus'
import { RoomComposer } from './RoomComposer'
import { RoomMessages } from './RoomMessages'

const NO_PENDING: PendingSend[] = []
const NO_REPLIES: RoomMessage[] = []

/** `highlight`: a message a link points at (an Inbox row), the root or a reply, scrolled to and marked once. */
export function ThreadPanel({ roomId, rootId, roomTitle, members, meId, onClose, focusBox = false, highlight = null }: { roomId: string; rootId: string; roomTitle: string; members: UserRef[]; meId: string | null; onClose: () => void; focusBox?: boolean; highlight?: string | null }) {
  const t = useT()
  const locale = useLocale()
  const view = useRooms((s) => (s.threadView?.roomId === roomId && s.threadView.rootId === rootId ? s.threadView : null))
  const allPending = useRooms((s) => s.pending[roomId]) ?? NO_PENDING
  const pending = useMemo(() => allPending.filter((p) => p.threadRootId === rootId), [allPending, rootId])
  const replies = view?.replies ?? NO_REPLIES
  const root = view?.root ?? null
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** where the last scroll event left the list (followsAfterScroll) */
  const lastTop = useRef(0)
  const last = replies.at(-1)
  const aiKey = useRooms((s) => (s.ai[roomId]?.runs ?? []).filter((r) => r.threadRootId === rootId).map((r) => `${r.state}${r.steps.length}`).join(','))

  useEffect(() => {
    stick.current = true
    useRooms.getState().openThread(roomId, rootId)
    return () => useRooms.getState().closeThread(roomId, rootId)
  }, [roomId, rootId])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [last?.id, replies.length, pending.length, aiKey, root?.id])
  useEffect(() => {
    const s = scroller.current, c = content.current
    if (!s || !c) return
    return stickToBottom(s, c, () => stick.current)
  }, [])

  const tryRead = useCallback(() => {
    const el = scroller.current
    const tv = useRooms.getState().threadView
    if (!el || !tv || tv.roomId !== roomId || tv.rootId !== rootId || tv.loading || !tv.root) return
    // on screen and looked at (the phone app: on screen; lib/attention.ts)
    if (!lookingAt()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
    // my position in a thread I follow (the server leaves it alone when I do not follow it)
    const seq = newestSeq(tv.replies)
    if (seq > 0) void useRooms.getState().markThreadRead(roomId, rootId, seq)
  }, [roomId, rootId])
  useEffect(() => {
    tryRead()
  }, [tryRead, last?.seq, root?.thread?.newReplies, view?.loading])
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
    stick.current = followsAfterScroll(el, stick.current, lastTop.current)
    lastTop.current = el.scrollTop
    const tv = useRooms.getState().threadView
    if (el.scrollTop < 200 && tv?.rootId === rootId && tv.nextCursor && !tv.loading) {
      const before = el.scrollHeight
      void useRooms
        .getState()
        .loadOlderReplies(roomId, rootId)
        .then(() =>
          requestAnimationFrame(() => {
            if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before
          }),
        )
    }
    tryRead()
  }

  // the reply a link points at but older than the newest page: older pages until it is there, at most TARGET_PAGES
  const tries = useRef(0)
  useEffect(() => {
    if (!highlight || !view || view.loading || view.error || !view.root || !view.nextCursor || tries.current >= TARGET_PAGES) return
    if (view.root.id === highlight || view.replies.some((m) => m.id === highlight)) return
    tries.current++
    void useRooms.getState().loadOlderReplies(roomId, rootId)
  }, [highlight, view, roomId, rootId])

  const notFound = !!view?.error && (isApiError(view.error, 'not_found') || isApiError(view.error, 'forbidden'))
  const count = root?.thread?.replyCount ?? replies.filter((m) => !m.deletedAt).length

  return (
    <section
      className={clsx(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-surface md:relative md:flex-none md:border-l md:border-line',
        // 400 px (440 from 1280 px) unless resized, never so wide the room keeps under 420 px (THREAD_PANEL), at least 320
        'md:w-[var(--panel-w,clamp(320px,calc(100%-420px),400px))] md:min-w-[320px] xl:w-[var(--panel-w,clamp(320px,calc(100%-420px),440px))]',
      )}
      aria-label={t('rooms.thread')}
      data-testid="room-thread"
    >
      {/* the ✕ keeps the same 16 px from the right edge as the replies and the reply box */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 max-md:pl-0.5 md:px-4">
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="thread-back">
          <ChevronLeft size={20} aria-hidden />
        </IconButton>
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-base font-medium text-ink">{t('rooms.thread')}</span>
          <span className="truncate text-xs text-faint" data-testid="thread-room">{roomTitle}</span>
        </h2>
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit max-md:hidden" data-testid="thread-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="thread-scroller">
        <div ref={content} className="px-4 pt-3 pb-4">
          {notFound ? (
            <div className="py-12 text-center" data-testid="thread-not-found">
              <p className="text-sm text-muted">{t('rooms.threadNotFound')}</p>
            </div>
          ) : (
            <>
              {!root && view?.loading && <Skeleton lines={3} className="pt-2" />}
              {!!view?.error && !notFound && <ErrorNote onRetry={() => void useRooms.getState().loadThread(roomId, rootId)}>{errorText(view.error, locale, t('error.network'))}</ErrorNote>}
              {root && <RoomMessages roomId={roomId} messages={[root]} pending={NO_PENDING} meId={meId} members={members} variant="root" highlight={highlight} />}
              {root && (
                <div role="separator" className="flex items-center gap-3 pt-3 pb-1 text-xs text-faint" data-testid="thread-count">
                  {count > 0 ? t('rooms.threadReplies', { n: count }) : t('rooms.threadNone')}
                  <span className="h-px flex-1 bg-line" aria-hidden />
                </div>
              )}
              {view?.loading && root && !replies.length && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
              <RoomMessages roomId={roomId} messages={replies} pending={pending} meId={meId} members={members} variant="reply" threadRootId={rootId} dayBefore={root?.createdAt ?? null} highlight={highlight} />
              <RoomAiStatus roomId={roomId} threadRootId={rootId} />
            </>
          )}
        </div>
      </div>
      {!notFound && root && !root.deletedAt && (
        <RoomComposer roomId={roomId} threadRootId={rootId} members={members} meId={meId} autoFocus={focusBox} onSent={() => { stick.current = true }} />
      )}
      <PanelDivider sizing={THREAD_PANEL} label={t('rooms.threadResize')} testId="thread-divider" overlayTestId="thread-drag-overlay" />
    </section>
  )
}
