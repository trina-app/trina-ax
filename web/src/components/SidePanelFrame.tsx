// The box of the right-hand panel (file preview, artifact, Browser pane) and the divider between it and the chat
// (components/PanelDivider.tsx: drag or the arrow keys to resize, double-click to reset; the chat keeps 360 px, a room
// with its thread open 420 + 320 px). Phones (< 768 px) get the full-screen sheet and no divider.
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { useT } from '../i18n'
import { SIDE_PANEL, SIDE_PANEL_BESIDE_THREAD } from '../lib/panelWidth'
import { PanelDivider } from './PanelDivider'

/** `besideThread`: the page beside the panel is a room with its thread open (pages/Room.tsx). */
export default function SidePanelFrame({ children, besideThread = false }: { children: ReactNode; besideThread?: boolean }) {
  const t = useT()
  return (
    <div
      data-testid="side-panel"
      className={clsx(
        'min-w-0 border-line md:relative bg-surface md:border-l',
        // phones: a full-screen sheet over everything (no edge of its own)
        'max-md:fixed max-md:inset-0 max-md:z-40 max-md:pt-[var(--safe-top)] max-md:pb-[var(--safe-bottom)]',
        'md:w-[var(--panel-w,min(46%,880px))] md:min-w-[320px]',
      )}
    >
      {children}
      <PanelDivider sizing={besideThread ? SIDE_PANEL_BESIDE_THREAD : SIDE_PANEL} label={t('preview.resize')} />
    </div>
  )
}
