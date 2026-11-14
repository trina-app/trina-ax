// The row at the bottom of every message box, inside its frame (QA TC-1400): the text on top, this row under it, as in
// the AI apps' boxes. `start` holds attach (+ or the clip) and the box's own quiet choices (who sees a new project
// chat); `end` holds the AI picker, the mic and send (or stop). Nothing of the box sits under or beside its frame.
// Used by the AI chat's box (Composer.tsx), a room's box on a computer (rooms/RoomComposer.tsx) and the ✦ side chat
// (rooms/SideChatPanel.tsx), so all of them keep one padding and one gap.
import clsx from 'clsx'
import type { ReactNode } from 'react'

export function ComposerToolbar({ start, end, className, testId }: { start?: ReactNode; end: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={clsx('box-content flex min-h-9 min-w-0 items-center gap-1.5 px-3 pt-1 pb-2.5', className)} data-testid={testId}>
      <div className="flex min-w-0 items-center gap-1.5">{start}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">{end}</div>
    </div>
  )
}
