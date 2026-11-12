// The list panel beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1): one list at a time, the place's
// name on top with its own buttons, then the list in its own scroll. 268 px at 1440, 240 px at 1280 and below, never
// more than 300 px at a large text size. Below 1052 px its header has "목록 숨기기" (rail/railPanel.ts); the rail then
// shows the button that brings it back. A <nav> named by its title; the skip link "목록으로" lands on it (Layout.tsx).
import clsx from 'clsx'
import { PanelLeftClose } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { IconButton, useMediaQuery } from '../ui'
import { PANEL_ALWAYS_PX, useRailPanel } from '../rail/railPanel'

export const PANEL_ID = 'rail-panel'

export function PanelFrame({ title, actions, top, children, onScroll, testId }: { title: ReactNode; actions?: ReactNode; top?: ReactNode; children: ReactNode; onScroll?: () => void; testId: string }) {
  const t = useT()
  const id = useId()
  const wide = useMediaQuery(`(min-width: ${PANEL_ALWAYS_PX}px)`)
  // the list is scrolled away from its top: a hairline under the rows above it (as the old sidebar's)
  const [scrolled, setScrolled] = useState(false)
  return (
    <nav id={PANEL_ID} tabIndex={-1} aria-labelledby={id} className="flex h-full w-[clamp(240px,min(16.75rem,18.6vw),300px)] shrink-0 flex-col border-r border-line bg-subtle outline-none" data-testid={testId}>
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2 id={id} className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold tracking-tight text-ink" data-testid="panel-title">
          {title}
        </h2>
        {actions}
        {!wide && (
          <IconButton label={t('rail.hideList')} onClick={() => useRailPanel.getState().setHidden(true)} data-testid="panel-hide">
            <PanelLeftClose size={16} aria-hidden />
          </IconButton>
        )}
      </div>
      {top && <div className="shrink-0 space-y-0.5 px-2 pb-2">{top}</div>}
      <div
        className={clsx('scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-2 pt-2 pb-2', scrolled ? 'border-line' : 'border-transparent')}
        onScroll={(e) => {
          onScroll?.()
          setScrolled(e.currentTarget.scrollTop > 0)
        }}
        data-testid="panel-scroll"
      >
        {children}
      </div>
    </nav>
  )
}

/** a row at the top of a panel or a quiet row at a list's end: 36 px, a 16 px icon, the words */
export const panelRow = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-ink hover:bg-hover focus-visible:-outline-offset-2'
export const panelRowActive = ({ isActive }: { isActive: boolean }) => clsx(panelRow, isActive && 'bg-hover font-medium')
