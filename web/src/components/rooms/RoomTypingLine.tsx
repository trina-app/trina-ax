// "Alice is typing…" (docs/DECISIONS.md "입력 중 표시"): one quiet line just above a room's or a thread's message box,
// with the other people writing in that place (store/typing.ts), named as this app names them elsewhere (the people
// directory, then the room's member list). It floats in the space the messages keep free at their bottom (pb-6 in
// pages/Room.tsx and ThreadPanel.tsx), so the box never moves when it comes or goes; scrolled up, it has the page's own
// background behind it (--typing-bg: the side column and the phone's sheet set their surface), and the room's "to newest"
// button sits above it (pages/Room.tsx). A short
// fade (none with reduced motion, index.css). Screen readers hear it politely, and only when the people change (the
// words stay the same between pings). Trina answering keeps its own line under the messages (RoomAiStatus), so it is
// not repeated here.
import clsx from 'clsx'
import type { UserRef } from '@mycel/shared/api'
import { useT } from '../../i18n'
import { typingWords } from '../../lib/roomTyping'
import { usePeople } from '../../store/people'
import { useTypingIds } from '../../store/typing'

export function RoomTypingLine({ roomId, threadRootId, members, meId, hidden = false }: { roomId: string; threadRootId: string | null; members: readonly UserRef[]; meId: string | null; hidden?: boolean }) {
  const t = useT()
  const ids = useTypingIds(roomId, threadRootId, meId)
  const byId = usePeople((s) => s.byId)
  const names: string[] = []
  for (const id of ids) {
    const name = byId[id]?.name ?? members.find((m) => m.id === id)?.name
    if (name) names.push(name)
  }
  const words = typingWords(t, names)
  const show = !!words && !hidden
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-[1] sm:px-4" data-testid="room-typing" data-place={threadRootId ? 'thread' : 'room'}>
      <p
        aria-live="polite"
        aria-atomic="true"
        className={clsx(
          'mx-auto flex max-w-[780px] min-w-0 items-center gap-1.5 bg-[var(--typing-bg,var(--c-canvas))] px-1 py-0.5 text-xs text-muted transition-opacity duration-200 max-sm:px-4',
          show ? 'opacity-100' : 'opacity-0',
        )}
        data-testid="room-typing-line"
        data-shown={show ? '' : undefined}
      >
        {show && (
          <>
            <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
              <span className="dot size-1 rounded-full bg-faint" />
              <span className="dot size-1 rounded-full bg-faint" />
              <span className="dot size-1 rounded-full bg-faint" />
            </span>
            <span className="truncate">{words}</span>
          </>
        )}
      </p>
    </div>
  )
}
