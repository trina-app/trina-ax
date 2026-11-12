// The one bar of a page on a phone (below 768 px): ‹ on the left, with the name of where it goes when there is one
// ("‹ Admin", "‹ Settings"), the page's name in the middle, and one action at most on the right. Admin's pages and root,
// Settings' sections and the top bar's pages under a tab (PhoneTopBar.tsx) all use it, so there is one look. The name
// stays centred: the two sides are equal columns; the label shows only when it fits whole beside ‹ (never "Admin…":
// ‹ alone then, its name still read out), and the title is cut last. Every button is 44 px. A tab's own top (Files at
// the team folder) has no ‹ (`onBack` left out); `heading`: the title is the page's h1 (the page has no other).
import clsx from 'clsx'
import { ChevronLeft } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { Tooltip } from '../Tooltip'

export function PhonePageBar({ onBack, backLabel, title, titleHidden, heading, action, backTestId, titleTestId = 'phone-bar-title', className }: {
  /** none: no ‹ (the top of a tab) */
  onBack?: () => void
  /** the name of where ‹ goes; none: ‹ alone */
  backLabel?: string | null
  title: ReactNode
  /** the page says its own name to screen readers (a heading): the bar's is for the eye only */
  titleHidden?: boolean
  /** the title is the page's heading (h1) */
  heading?: boolean
  action?: ReactNode
  backTestId: string
  titleTestId?: string
  className?: string
}) {
  const t = useT()
  const labelRef = useRef<HTMLSpanElement>(null)
  const [fits, setFits] = useState(true)
  // measured as laid out (an invisible label keeps its place), again whenever the bar's width changes
  useLayoutEffect(() => {
    const el = labelRef.current
    if (!el) return
    const measure = () => setFits(el.scrollWidth <= el.clientWidth + 1)
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el.parentElement ?? el)
    return () => ro?.disconnect()
  }, [backLabel, title])
  return (
    <div className={clsx('grid h-12 shrink-0 grid-cols-[minmax(44px,1fr)_minmax(0,auto)_minmax(44px,1fr)] items-center border-b border-line px-1', className)} data-testid="phone-page-bar">
      <div className="flex min-w-0 items-center">
        {onBack && (
          <Tooltip label={backLabel ? t('tabs.backTo', { page: backLabel }) : t('tabs.back')}>
            <button
              type="button"
              onClick={onBack}
              aria-label={backLabel ? t('tabs.backTo', { page: backLabel }) : t('tabs.back')}
              className={clsx('flex items-center rounded-md text-muted transition hover:bg-hover hover:text-ink', backLabel ? 'h-11 max-w-full min-w-11 pr-2' : 'size-11 justify-center')}
              data-testid={backTestId}
            >
              <span className="grid size-11 shrink-0 place-items-center" aria-hidden>
                <ChevronLeft size={22} />
              </span>
              {backLabel && (
                <span ref={labelRef} className={clsx('-ml-2.5 min-w-0 truncate text-sm', !fits && 'invisible')} aria-hidden data-fits={fits ? '' : undefined} data-testid={`${backTestId}-label`}>
                  {backLabel}
                </span>
              )}
            </button>
          </Tooltip>
        )}
      </div>
      {heading ? (
        <h1 className="min-w-0 truncate px-1 text-center text-sm font-semibold" data-testid={titleTestId}>
          {title}
        </h1>
      ) : (
        <span aria-hidden={titleHidden || undefined} className="min-w-0 truncate px-1 text-center text-sm font-semibold" data-testid={titleTestId}>
          {title}
        </span>
      )}
      <div className="flex min-w-0 items-center justify-end">{action}</div>
    </div>
  )
}
