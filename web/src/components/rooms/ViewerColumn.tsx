// The file viewer's right column (components/ImageViewer.tsx; docs/DECISIONS.md "The room's right column"), like
// Slack's: beside a picture or file sent in a room, DM, group chat or thread, on computers, one thing at a time:
// - the file's thread: its message's root (a reply's thread, the reply marked) through ThreadPanel itself, with its
//   reply box; a message without replies shows alone with the box, and the first reply starts the thread; a message
//   that cannot have a thread (an AI answer only its asker sees) shows alone, without a box. A step to another
//   message's file moves the thread with it;
// - my Trina side chat of the room (SideChatPanel, the same chat, draft and quote as the room page's:
//   store/sideChats.ts), with the file quoted when ✦ in the viewer's bar asked about it (its file_id goes with the
//   question and the AI reads it with room_file). A step keeps it and quotes nothing new; "스레드로 돌아가기" at its top
//   brings the file's thread back.
// It starts on the side chat when the room page had it open (the rooms store's side), else on the thread. The bar's
// toggle hides and shows it; a panel's ✕ hides it too. For the side chat that is not a close (the same chat shows again,
// in the column or a phone's sheet); closing the viewer after it showed the side chat is, also from the thread, unless
// the room page has it open (the next ✦ opens it afresh: SideChatPanel.tsx viewerClosedOn). 400 px wide; the stage
// beside it narrows from the right
// (--viewer-col). A link in it that opens the side panel closes the viewer, which would cover the panel.
// Phones (< 768 px, the phone app): the same column in a sheet over the viewer (ViewerSheet below), opened by the bar's
// 💬 (the thread) or ✦ (Trina with the file quoted), about 70 % of the screen high; its handle drags it to the whole
// height or down to close, a tap beside it or its ✕ closes it, and so does Back (its own history entry,
// lib/imageViewer.ts openViewerSheet), back to the file. With the keyboard up it takes the whole height above it.
import clsx from 'clsx'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RoomMember, RoomMessage } from '@mycel/shared/api'
import { closeImageViewer, sheetSnap, type RoomPlace } from '../../lib/imageViewer'
import { getSidePanel } from '../../lib/sidePanel'
import { messageSeed } from '../../lib/sideChatAsk'
import { aiName } from '../../lib/tabs'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { useRoomTitle } from './RoomIcon'
import { RoomSideColumn } from './RoomSideColumn'
import { SideChatPanel, viewerClosedOn, type SideSeed } from './SideChatPanel'
import { ThreadPanel } from './ThreadPanel'

/** the column's width on computers */
export const VIEWER_COLUMN_PX = 400

export interface ViewerColumnState {
  /** shown (the bar's toggle) */
  open: boolean
  show: 'thread' | 'trina'
  /** what the side chat was last asked about here (a file from the bar's ✦, a message from the thread's ✦) */
  seed: SideSeed | null
  /** the side chat's box takes the focus as it shows (it was asked for; not when the viewer opens on it) */
  focus: boolean
}

/** The column's state for one opening of the viewer, starting as the room page's right side is. */
export function useViewerColumn(roomId: string | null) {
  const [state, setState] = useState<ViewerColumnState>(() => ({ open: true, show: roomId && useRooms.getState().side[roomId] === 'trina' ? 'trina' : 'thread', seed: null, focus: false }))
  // this opening of the viewer showed the side chat: the viewer closing (or leaving the room's files) closes it, also
  // when the column is back on the thread
  const showed = useRef(false)
  if (state.show === 'trina') showed.current = true
  useEffect(() => () => { if (roomId && showed.current) viewerClosedOn(roomId) }, [roomId])
  return {
    state,
    /** the side chat, this asked about */
    ask: (seed: SideSeed) => setState({ open: true, show: 'trina', seed, focus: true }),
    /** the file's thread again */
    toThread: () => setState((s) => ({ ...s, open: true, show: 'thread' })),
    toggle: () => setState((s) => ({ ...s, open: !s.open })),
    hide: () => setState((s) => ({ ...s, open: false })),
  }
}

const NO_MEMBERS: RoomMember[] = []

/** `sheet`: inside the phone's ViewerSheet (its height, ✕ instead of ‹), not at the viewer's right. */
export function ViewerColumn({ place, state, onAsk, onThread, onHide, sheet = false }: { place: RoomPlace & { messageId: string }; state: ViewerColumnState; onAsk: (seed: SideSeed) => void; onThread: () => void; onHide: () => void; sheet?: boolean }) {
  const t = useT()
  const title = useRoomTitle()
  const { roomId, messageId } = place
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const roomTitle = room ? title(room) : ''
  const roomMembers = useRooms((s) => s.members[roomId]) ?? NO_MEMBERS
  // the room may not be open (a file opened from elsewhere, or its list dropped by a resync): read it when missing
  useEffect(() => { void useRooms.getState().loadMembers(roomId) }, [roomId])
  const members = useMemo(() => roomMembers.map((m) => m.user), [roomMembers])
  const meId = useMe()?.user.id ?? null
  const name = aiName(t)
  const rootId = place.rootId ?? messageId
  const alone = place.threadable === false
  const trina = state.show === 'trina'
  // a link in the column that opens the side panel (a team file named in a message or an answer): the panel is under the
  // viewer, so the viewer closes and leaves it in view, as a link in the document does (ViewerDocument)
  const onClickCapture = () => {
    const before = getSidePanel()
    // after the click's handlers have all run
    setTimeout(() => {
      if (getSidePanel() !== before) closeImageViewer()
    })
  }
  return (
    <RoomSideColumn
      label={trina ? t('sideChat.title', { name }) : t('rooms.thread')}
      testId="viewer-column"
      data-show={state.show}
      data-viewer-column=""
      // under the bar, at the window's right (a phone: the sheet's body); the app's own colours on the dark viewer, its
      // text selectable
      className={clsx('text-ink outline-none select-text', sheet ? 'min-h-0 flex-1 max-md:border-l-0' : 'absolute top-14 right-0 bottom-0 w-[var(--viewer-col)]')}
      onClickCapture={onClickCapture}
      // a click on its text keeps the focus in the viewer (not on the page behind, where ← → and ⌘K would go)
      tabIndex={-1}
    >
      {trina ? (
        <>
          <button type="button" onClick={onThread} className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3 text-xs font-medium text-muted hover:bg-hover hover:text-ink" data-testid="viewer-column-back">
            <ChevronLeft size={14} aria-hidden />
            {t('viewer.backToThread')}
          </button>
          <SideChatPanel frame={false} key={roomId} roomId={roomId} roomTitle={roomTitle} seed={state.seed} autoFocus={state.focus} onClose={onHide} closeX={sheet} />
        </>
      ) : (
        <ThreadPanel
          frame={false}
          key={`${rootId}:${alone ? 'alone' : 'thread'}`}
          roomId={roomId}
          rootId={alone ? messageId : rootId}
          alone={alone}
          roomTitle={roomTitle}
          members={members}
          meId={meId}
          onClose={onHide}
          onAskTrina={(m: RoomMessage) => onAsk(messageSeed(m, name))}
          highlight={messageId !== rootId ? messageId : null}
          closeX={sheet}
        />
      )}
    </RoomSideColumn>
  )
}

/** The phone's sheet around the column, over the viewer: 70 % of the screen high (`--app-h`: the part above the
 * keyboard), the whole height (under the status bar) once dragged or tapped up, or while the keyboard is up. The handle
 * drags it (lib/imageViewer.ts sheetSnap: up to the whole height, back, or down to close) and a tap or Enter on it
 * switches between the two heights; a tap on the dimmed file beside it closes it. */
export function ViewerSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  /** its height while the finger holds the handle */
  const [drag, setDrag] = useState<number | null>(null)
  const hold = useRef<{ id: number; y0: number; h0: number; y: number; t: number; vy: number; moved: boolean } | null>(null)
  /** a drag ends in a click on the handle: that click is not a tap */
  const dragged = useRef(false)
  // opened: the focus goes into it (unless the side chat's box took it, asked about the file), so a screen reader is there
  useEffect(() => {
    const el = sheet.current
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('[data-viewer-column]')?.focus({ preventScroll: true })
  }, [])
  const heights = () => {
    const h = layer.current?.clientHeight ?? 0
    return { part: h * 0.7, full: h - (top.current?.offsetHeight ?? 0) }
  }
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const h0 = sheet.current?.offsetHeight ?? 0
    hold.current = { id: e.pointerId, y0: e.clientY, h0, y: e.clientY, t: e.timeStamp, vy: 0, moved: false }
    dragged.current = false
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = hold.current
    if (!g || g.id !== e.pointerId) return
    const dt = Math.max(1, e.timeStamp - g.t)
    g.vy = (e.clientY - g.y) / dt
    g.y = e.clientY
    g.t = e.timeStamp
    if (!g.moved && Math.abs(e.clientY - g.y0) < 6) return
    g.moved = true
    setDrag(Math.max(0, Math.min(heights().full, g.h0 - (e.clientY - g.y0))))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const g = hold.current
    if (!g || g.id !== e.pointerId) return
    hold.current = null
    if (!g.moved) return
    dragged.current = true
    setDrag(null)
    if (cancelled) return
    const h = heights()
    // a finger held still before it lifts sends no move: no flick then
    const vy = e.timeStamp - g.t > 80 ? 0 : g.vy
    const to = sheetSnap(Math.max(0, Math.min(h.full, g.h0 - (e.clientY - g.y0))), h.part, h.full, vy)
    if (to === 'closed') onClose()
    else setFull(to === 'full')
  }
  return (
    <div ref={layer} className="absolute inset-x-0 top-0 h-[var(--app-h,100%)]" data-testid="viewer-sheet-layer">
      {/* the status bar's height, measured for the drag (the whole height ends under it) */}
      <div ref={top} aria-hidden className="pointer-events-none absolute top-0 h-[var(--safe-top)]" />
      <div aria-hidden className="absolute inset-0 bg-black/50" onClick={onClose} data-testid="viewer-sheet-backdrop" />
      <div
        ref={sheet}
        className={clsx(
          'absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-2xl bg-surface text-ink shadow-xl starting:translate-y-full',
          drag === null && 'transition-[height,translate] duration-200 ease-out',
          full ? 'h-[calc(100%-var(--safe-top))]' : 'h-[70%] in-[.keyboard-open]:h-[calc(100%-var(--safe-top))]',
        )}
        style={drag === null ? undefined : { height: drag }}
        // keys typed in it, its handle's too, are its own (ImageViewer: never a step, a zoom or a copy of the file under it)
        data-viewer-column=""
        data-viewer-sheet=""
        data-testid="viewer-sheet"
        data-size={full ? 'full' : 'part'}
      >
        <button
          type="button"
          aria-label={full ? t('viewer.sheetShrink') : t('viewer.sheetGrow')}
          onClick={() => {
            if (dragged.current) dragged.current = false
            else setFull((f) => !f)
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => onPointerUp(e)}
          onPointerCancel={(e) => onPointerUp(e, true)}
          className="touch-hit flex h-6 shrink-0 cursor-grab touch-none items-center justify-center outline-none focus-visible:bg-hover"
          data-testid="viewer-sheet-handle"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-line-strong" />
        </button>
        {children}
      </div>
    </div>
  )
}
