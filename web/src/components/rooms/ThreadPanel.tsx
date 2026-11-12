// A thread (docs/DECISIONS.md "스레드와 반응"), at /rooms/:roomId/t/:messageId: on computers a plain column beside the
// room (a hairline on its left, a divider there to resize it: components/PanelDivider.tsx; the room keeps 420 px), on
// phones the whole screen (the room's header gives way to the thread's, with a back arrow; the bottom tabs stay away
// as in the room). The column is components/rooms/RoomSideColumn.tsx: drawn here (`frame`), or by the room page or the
// file viewer (components/rooms/ViewerColumn.tsx) around this (frame={false}). The root on top with its reactions, a
// hairline with how many replies, the replies (the room's list: runs, reactions, my AI questions asked here), and the
// reply box with "대화방에도 보내기" (a file dropped anywhere on the thread goes into it: components/FileDropZone.tsx). What
// I see is marked read in the thread (POST …/thread/read) while the window has
// the focus and the end of the thread is in sight. A thread I cannot see (I joined after its root, it is gone) says so.
// `alone`: a message that cannot have a thread (an AI answer only its asker sees), shown by itself from what this window
// has, with no reply count and no box. `closeX`: the ✕ at every width, never the phone's ‹ (the file viewer's sheet on a
// phone, which closes back to the file).
import clsx from 'clsx'
import { ChevronLeft, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { RoomMessage, UserRef } from '@mycel/shared/api'
import { ApiError, errorText, isApiError } from '../../lib/api'
import { lookingAt, onWindowFocus } from '../../lib/attention'
import { newestSeq, TARGET_PAGES } from '../../lib/rooms'
import { holdPlace, ROOM_ROW, useStickToBottom } from '../../lib/stickToBottom'
import { useLocale, useT } from '../../i18n'
import { findMessage, placeKey, useRooms, type PendingSend } from '../../store/rooms'
import { ErrorNote, IconButton, Skeleton } from '../ui'
import { RoomAiStatus } from './RoomAiStatus'
import { RoomComposer } from './RoomComposer'
import { RoomMessages } from './RoomMessages'
import { RoomSideColumn } from './RoomSideColumn'
import { ImageGroup } from '../ImageViewer'
import { FileDropZone } from '../FileDropZone'

const NO_PENDING: PendingSend[] = []
const NO_REPLIES: RoomMessage[] = []
/** a message shown alone that this window no longer has: as a thread that cannot be seen */
const ALONE_GONE = new ApiError(404, { code: 'not_found', message: '' })

/** `highlight`: a message a link points at (an Inbox row), the root or a reply, scrolled to and marked once. `frame`
 * false: the column around it is the caller's (RoomSideColumn). `alone`: `rootId` is a message without a thread, shown
 * by itself. */
export function ThreadPanel({ roomId, rootId, roomTitle, members, meId, onClose, onAskTrina, focusBox = false, highlight = null, frame = true, alone = false, closeX = false }: { roomId: string; rootId: string; roomTitle: string; members: UserRef[]; meId: string | null; onClose: () => void; onAskTrina?: (m: RoomMessage) => void; focusBox?: boolean; highlight?: string | null; frame?: boolean; alone?: boolean; closeX?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const key = placeKey(roomId, rootId)
  const threaded = useRooms((s) => (alone ? null : s.threadViews[key] ?? null))
  // alone: the message as this window has it (the timeline), never asked for as a thread (the server has none for it)
  const single = useRooms((s) => (alone ? findMessage(s, roomId, rootId) ?? null : null))
  const view = alone ? { root: single, replies: NO_REPLIES, loading: false, error: single ? null : ALONE_GONE, nextCursor: null } : threaded
  const allPending = useRooms((s) => s.pending[roomId]) ?? NO_PENDING
  const pending = useMemo(() => allPending.filter((p) => p.threadRootId === rootId), [allPending, rootId])
  const replies = view?.replies ?? NO_REPLIES
  const root = view?.root ?? null
  // new replies, pictures loading and a phone's keyboard: at the bottom it stays there (lib/stickToBottom.ts)
  const list = useStickToBottom()
  const { scroller, content, stick } = list
  const last = replies.at(-1)
  const aiKey = useRooms((s) => (s.ai[roomId]?.runs ?? []).filter((r) => r.threadRootId === rootId).map((r) => `${r.state}${r.steps.length}`).join(','))

  useEffect(() => {
    stick.current = true
    if (alone) return
    useRooms.getState().openThread(roomId, rootId)
    return () => useRooms.getState().closeThread(roomId, rootId)
  }, [roomId, rootId, alone])
  useLayoutEffect(() => {
    list.follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, replies.length, pending.length, aiKey, root?.id])

  const tryRead = useCallback(() => {
    const el = scroller.current
    const tv = alone ? undefined : useRooms.getState().threadViews[placeKey(roomId, rootId)]
    if (!el || !tv || tv.loading || !tv.root) return
    // on screen and looked at (the phone app: on screen; lib/attention.ts)
    if (!lookingAt()) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return
    // my position in a thread I follow (the server leaves it alone when I do not follow it)
    const seq = newestSeq(tv.replies)
    if (seq > 0) void useRooms.getState().markThreadRead(roomId, rootId, seq)
  }, [roomId, rootId, alone])
  useEffect(() => {
    tryRead()
  }, [tryRead, last?.seq, root?.thread?.newReplies, view?.loading])
  useEffect(() => {
    window.addEventListener('focus', tryRead)
    document.addEventListener('visibilitychange', tryRead)
    // the desktop app's window came to the front (its page may get no focus event of its own)
    const offWindow = onWindowFocus(tryRead)
    return () => {
      window.removeEventListener('focus', tryRead)
      document.removeEventListener('visibilitychange', tryRead)
      offWindow()
    }
  }, [tryRead])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    list.onScroll()
    const tv = useRooms.getState().threadViews[key]
    if (el.scrollTop < 200 && tv?.nextCursor && !tv.loading) {
      // the reply in sight stays where it is (lib/stickToBottom.ts holdPlace)
      const keep = holdPlace(el, ROOM_ROW)
      void useRooms
        .getState()
        .loadOlderReplies(roomId, rootId)
        .finally(() => requestAnimationFrame(keep))
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

  const body = (
    // a file dropped anywhere on the thread goes into its reply box (none: the overlay says nothing can be attached)
    <FileDropZone className="flex min-h-0 flex-1 flex-col" data-testid="thread-drop">
      {/* the ✕ keeps the same 16 px from the right edge as the replies and the reply box */}
      <div className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line', closeX ? 'pr-2 pl-4 md:px-4' : 'px-2 max-md:pl-0.5 md:px-4')}>
        {!closeX && (
          <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="thread-back">
            <ChevronLeft size={20} aria-hidden />
          </IconButton>
        )}
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-base font-medium text-ink">{t('rooms.thread')}</span>
          <span className="truncate text-xs text-faint" data-testid="thread-room">{roomTitle}</span>
        </h2>
        <IconButton tip label={t('rooms.closeThread')} onClick={onClose} className={clsx('touch-hit', !closeX && 'max-md:hidden')} data-testid="thread-close">
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
            // the thread's pictures, root and replies: ← → in the image viewer walks through these
            <ImageGroup>
              {!root && view?.loading && <Skeleton lines={3} className="pt-2" />}
              {!!view?.error && !notFound && <ErrorNote onRetry={() => void useRooms.getState().loadThread(roomId, rootId)}>{errorText(view.error, locale, t('error.network'))}</ErrorNote>}
              {root && <RoomMessages roomId={roomId} messages={[root]} pending={NO_PENDING} meId={meId} members={members} variant="root" onAskTrina={onAskTrina} highlight={highlight} />}
              {root && !alone && (
                <div role="separator" className="flex items-center gap-3 pt-3 pb-1 text-xs text-faint" data-testid="thread-count">
                  {count > 0 ? t('rooms.threadReplies', { n: count }) : t('rooms.threadNone')}
                  <span className="h-px flex-1 bg-line" aria-hidden />
                </div>
              )}
              {view?.loading && root && !replies.length && <Loader2 size={16} className="mx-auto my-2 animate-spin text-faint" aria-label={t('common.loading')} />}
              <RoomMessages roomId={roomId} messages={replies} pending={pending} meId={meId} members={members} variant="reply" onAskTrina={onAskTrina} threadRootId={rootId} dayBefore={root?.createdAt ?? null} highlight={highlight} />
              <RoomAiStatus roomId={roomId} threadRootId={rootId} />
            </ImageGroup>
          )}
        </div>
      </div>
      {!notFound && root && !root.deletedAt && !alone && (
        <RoomComposer roomId={roomId} threadRootId={rootId} members={members} meId={meId} autoFocus={focusBox} onSent={() => { stick.current = true }} />
      )}
    </FileDropZone>
  )
  if (!frame) return body
  return (
    <RoomSideColumn label={t('rooms.thread')} testId="room-thread" divider="thread">
      {body}
    </RoomSideColumn>
  )
}
