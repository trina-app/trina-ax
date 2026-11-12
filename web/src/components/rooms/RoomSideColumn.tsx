// The column on a room's right (docs/DECISIONS.md "The room's right column"): the frame around what shows there, one
// thing at a time: a thread (components/rooms/ThreadPanel.tsx) or my Trina side chat (components/rooms/
// SideChatPanel.tsx), each drawn with frame={false} inside it. Two places use it:
// - the room page (pages/Room.tsx): beside the room on computers, 400 px (440 from 1280 px) unless resized, never so wide
//   the room keeps under 420 px, at least 320, with a divider on its left edge to resize it (components/PanelDivider.tsx,
//   THREAD_PANEL: one remembered width for both); the whole screen on phones;
// - the file viewer (components/rooms/ViewerColumn.tsx): a 400 px column at the viewer's right on computers, placed by
//   the viewer (no divider: the stage beside it is not a column the divider could share the width with).
import clsx from 'clsx'
import type { MouseEventHandler, ReactNode } from 'react'
import { THREAD_PANEL } from '../../lib/panelWidth'
import { useT } from '../../i18n'
import { PanelDivider } from '../PanelDivider'

/** `divider`: the room page's resizable column, its divider's test ids prefixed with this ('thread', 'side-chat');
 * absent: sized and placed by `className`. */
export function RoomSideColumn({ label, testId, divider, className, onClickCapture, tabIndex, children, ...rest }: { label: string; testId: string; divider?: 'thread' | 'side-chat'; className?: string; onClickCapture?: MouseEventHandler<HTMLElement>; tabIndex?: number; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const t = useT()
  return (
    <section
      className={clsx(
        'flex min-h-0 min-w-0 flex-col bg-surface',
        divider
          ? [
              'flex-1 md:relative md:flex-none md:border-l md:border-line',
              // 400 px (440 from 1280 px) unless resized, never so wide the room keeps under 420 px (THREAD_PANEL), at least 320
              'md:w-[var(--panel-w,clamp(320px,calc(100%-420px),400px))] md:min-w-[320px] xl:w-[var(--panel-w,clamp(320px,calc(100%-420px),440px))]',
            ]
          : 'border-l border-line',
        className,
      )}
      aria-label={label}
      data-testid={testId}
      onClickCapture={onClickCapture}
      tabIndex={tabIndex}
      {...rest}
    >
      {children}
      {divider && <PanelDivider sizing={THREAD_PANEL} label={t('rooms.threadResize')} testId={`${divider}-divider`} overlayTestId={`${divider}-drag-overlay`} />}
    </section>
  )
}
