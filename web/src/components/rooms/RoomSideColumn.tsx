// A column on a room's right (docs/DECISIONS.md "The room's right column"; docs/decisions/20261117-thread-plus-trina.md):
// the frame around a thread (components/rooms/ThreadPanel.tsx) or my Trina side chat (components/rooms/
// SideChatPanel.tsx), each drawn with frame={false} inside it. Two places use it:
// - the room page (pages/Room.tsx): beside the room on computers, 400 px (440 from 1280 px) unless resized, never so wide
//   the room keeps under 420 px, at least 320, with a divider on its left edge to resize it (components/PanelDivider.tsx,
//   THREAD_PANEL: one remembered width for both); the whole screen on phones. With the thread and the side chat both
//   open (`shared`) each is a column of its own: an equal share of what the room's 420 px leaves, 320 to 440 px, and
//   no divider (the remembered width is a single panel's). Where the row is too narrow for three, the page places the
//   two itself (`className`: half and half over the room, or one over the other);
// - the file viewer (components/rooms/ViewerColumn.tsx): a 400 px column at the viewer's right on computers, placed by
//   the viewer (no divider: the stage beside it is not a column the divider could share the width with).
import clsx from 'clsx'
import type { MouseEventHandler, ReactNode } from 'react'
import { THREAD_PANEL } from '../../lib/panelWidth'
import { useT } from '../../i18n'
import { PanelDivider } from '../PanelDivider'

/** `divider`: the room page's resizable column, its divider's test ids prefixed with this ('thread', 'side-chat');
 * absent: sized and placed by `className`. `shared`: one of the room page's two columns side by side. */
/** `modal`: a sheet over the room (a narrow window, pages/Room.tsx): a modal dialog for screen
 * readers, focusable as a whole. `inert`: under another panel (the side chat over the thread): out of reach */
export function RoomSideColumn({ label, testId, divider, shared, className, onClickCapture, tabIndex, modal, inert, children, ...rest }: { label: string; testId: string; divider?: 'thread' | 'side-chat'; shared?: boolean; className?: string; onClickCapture?: MouseEventHandler<HTMLElement>; tabIndex?: number; modal?: boolean; inert?: boolean; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const t = useT()
  return (
    <section
      className={clsx(
        'flex min-h-0 min-w-0 flex-col bg-surface [--typing-bg:var(--c-surface)]',
        divider
          ? [
              'flex-1 md:relative md:flex-none md:border-l md:border-line',
              // 400 px (440 from 1280 px) unless resized, never so wide the room keeps under 420 px (THREAD_PANEL), at least 320
              'md:w-[var(--panel-w,clamp(320px,calc(100%-420px),400px))] md:min-w-[320px] xl:w-[var(--panel-w,clamp(320px,calc(100%-420px),440px))]',
            ]
          : shared
            // beside the other panel: an equal share of what the room's 420 px leaves, 320 to 440 px
            ? 'w-[clamp(320px,calc((100%-420px)/2),440px)] flex-none border-l border-line'
            : 'border-l border-line',
        className,
      )}
      aria-label={label}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal || undefined}
      data-testid={testId}
      onClickCapture={onClickCapture}
      tabIndex={modal ? -1 : tabIndex}
      inert={inert || undefined}
      {...rest}
    >
      {children}
      {divider && <PanelDivider sizing={THREAD_PANEL} label={t('rooms.threadResize')} testId={`${divider}-divider`} overlayTestId={`${divider}-drag-overlay`} />}
    </section>
  )
}
