// The box of the right-hand panel (file preview, artifact, Browser pane) and the divider between it and the chat
// (components/PanelDivider.tsx: drag or the arrow keys to resize, double-click to reset; the chat keeps 360 px, a room
// with its thread open 420 + 320 px). Phones (< 768 px) get the full-screen sheet and no divider.
// "크게 보기" (PanelExpandButton, in the file and artifact panels' headers): the box takes the whole area beside the
// sidebar (components/Layout.tsx hides the page) and the divider goes; side by side again, the divider comes back and
// sets the width it remembers.
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useT } from '../i18n'
import { SIDE_PANEL, SIDE_PANEL_BESIDE_THREAD } from '../lib/panelWidth'
import { setPanelExpanded, usePanelExpanded } from '../lib/sidePanel'
import { PanelDivider } from './PanelDivider'
import { IconButton } from './ui'

/** `besideThread`: the page beside the panel is a room with its thread open (pages/Room.tsx). `expanded`: big. */
export default function SidePanelFrame({ children, besideThread = false, expanded = false }: { children: ReactNode; besideThread?: boolean; expanded?: boolean }) {
  const t = useT()
  return (
    <div
      id="side-panel"
      // big, it stands in for the page: the skip link (components/Layout.tsx) lands here, as on <main>
      tabIndex={expanded ? -1 : undefined}
      data-testid="side-panel"
      data-expanded={expanded || undefined}
      className={clsx(
        // big: the sidebar's own edge is the line on its left
        'min-w-0 border-line outline-none md:relative bg-surface',
        !expanded && 'md:border-l',
        // phones: a full-screen sheet over everything (no edge of its own)
        'max-md:fixed max-md:inset-0 max-md:z-40 max-md:pt-[var(--safe-top)] max-md:pb-[var(--safe-bottom)]',
        expanded ? 'md:flex-1' : 'md:w-[var(--panel-w,min(46%,880px))] md:min-w-[320px]',
      )}
    >
      {children}
      {!expanded && <PanelDivider sizing={besideThread ? SIDE_PANEL_BESIDE_THREAD : SIDE_PANEL} label={t('preview.resize')} />}
    </div>
  )
}

/** ⤢ 크게 보기 / ⤡ 나란히 보기, left of a panel's ✕. Computers only: on a phone the panel is full screen already. */
export function PanelExpandButton() {
  const t = useT()
  const expanded = usePanelExpanded()
  return (
    <IconButton label={expanded ? t('preview.sideBySide') : t('preview.expand')} className="max-md:hidden" onClick={() => setPanelExpanded(!expanded)} data-testid="panel-expand">
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </IconButton>
  )
}
