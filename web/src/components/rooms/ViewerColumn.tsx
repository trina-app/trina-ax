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
// toggle hides and shows it; a panel's ✕ hides it too. 400 px wide; the stage beside it narrows from the right
// (--viewer-col). A link in it that opens the side panel closes the viewer, which would cover the panel. Phones have no
// column here (the bar's ✦ opens the room page's side chat instead).
import { ChevronLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RoomMember, RoomMessage } from '@mycel/shared/api'
import { closeImageViewer, type RoomPlace } from '../../lib/imageViewer'
import { getSidePanel } from '../../lib/sidePanel'
import { messageSeed } from '../../lib/sideChatAsk'
import { aiName } from '../../lib/tabs'
import { useT } from '../../i18n'
import { useRooms } from '../../store/rooms'
import { useMe } from '../../store/session'
import { useRoomTitle } from './RoomIcon'
import { RoomSideColumn } from './RoomSideColumn'
import { SideChatPanel, type SideSeed } from './SideChatPanel'
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

export function ViewerColumn({ place, state, onAsk, onThread, onHide }: { place: RoomPlace & { messageId: string }; state: ViewerColumnState; onAsk: (seed: SideSeed) => void; onThread: () => void; onHide: () => void }) {
  const t = useT()
  const title = useRoomTitle()
  const { roomId, messageId } = place
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId) ?? null)
  const roomTitle = room ? title(room) : ''
  const roomMembers = useRooms((s) => s.members[roomId]) ?? NO_MEMBERS
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
      // under the bar, at the window's right; the app's own colours on the dark viewer, its text selectable
      className="absolute top-14 right-0 bottom-0 w-[var(--viewer-col)] text-ink outline-none select-text"
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
          <SideChatPanel frame={false} key={roomId} roomId={roomId} roomTitle={roomTitle} seed={state.seed} autoFocus={state.focus} onClose={onHide} />
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
        />
      )}
    </RoomSideColumn>
  )
}
