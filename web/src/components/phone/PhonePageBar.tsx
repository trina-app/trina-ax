// The one bar of a page on a phone (below 768 px): ‹ on the left, with the name of where it goes when there is one
// ("‹ Admin", "‹ Settings"), the page's name in the middle, and one action at most on the right. Admin's pages and root,
// Settings' sections and the top bar's pages under a tab (PhoneTopBar.tsx) all use it, so there is one look. The name
// stays centred (the two sides are equal columns) while the label fits whole beside it; a label that does not (an
// engine's page under "Team AI accounts") keeps its name and the title moves over, centred in the room left, as iOS does
// with a wide left button; only when even that does not fit is ‹ alone (never "Admin…": its name is still read out).
// The title is cut last. Every button is 44 px. A tab's own top (Files at the team folder) has no ‹ (`onBack` left
// out); `heading`: the title is the page's h1 (the page has no other).
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
  const barRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const titleRef = useRef<HTMLElement | null>(null)
  const setTitle = (el: HTMLElement | null) => {
    titleRef.current = el
  }
  const actionRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<BarFit>('centred')
  // measured from what each part needs (the same in every layout, so the choice holds once made), again whenever the
  // bar's width, the title or the right side changes; an invisible label keeps its place
  useLayoutEffect(() => {
    const bar = barRef.current
    const label = labelRef.current
    if (!bar || !label) return setFit('centred')
    const measure = () => {
      // not laid out (hidden, or no layout at all): as before, the label stays
      if (!bar.clientWidth) return setFit('centred')
      const style = getComputedStyle(bar)
      setFit(barFit({
        bar: bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
        // ‹ (44 px, the label pulled 10 px into it) + the label + the button's 8 px after it
        back: 44 - 10 + label.scrollWidth + 8,
        // the title's own text (its box is the column's), and its 4 px each side
        title: textWidth(titleRef.current) + 8,
        right: Math.max(44, actionRef.current?.getBoundingClientRect().width ?? 0),
      }))
    }
    measure()
    // the app's font may come in after the first look, and change the widths
    let live = true
    void document.fonts?.ready.then(() => live && measure())
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    for (const el of [bar, label, actionRef.current]) if (el) ro?.observe(el)
    return () => {
      live = false
      ro?.disconnect()
    }
  }, [backLabel, title])
  const fits = fit !== 'alone'
  return (
    <div ref={barRef} className={clsx('grid h-12 shrink-0 items-center border-b border-line px-1', fit === 'moved' ? 'grid-cols-[auto_minmax(0,1fr)_minmax(44px,auto)]' : 'grid-cols-[minmax(44px,1fr)_minmax(0,auto)_minmax(44px,1fr)]', className)} data-testid="phone-page-bar" data-fit={onBack && backLabel ? fit : undefined}>
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
        <h1 ref={setTitle} className="min-w-0 truncate px-1 text-center text-sm font-semibold" data-testid={titleTestId}>
          {title}
        </h1>
      ) : (
        <span ref={setTitle} aria-hidden={titleHidden || undefined} className="min-w-0 truncate px-1 text-center text-sm font-semibold" data-testid={titleTestId}>
          {title}
        </span>
      )}
      <div className="flex min-w-0 items-center justify-end">
        <div ref={actionRef} className="flex min-w-0 items-center">{action}</div>
      </div>
    </div>
  )
}

/** The width of an element's text as laid out on one line, also where its box cuts it or is wider. */
function textWidth(el: HTMLElement | null): number {
  if (!el?.firstChild) return 0
  const range = document.createRange()
  range.selectNodeContents(el)
  return range.getBoundingClientRect().width
}

/** How the bar is laid out: 'centred' (the label fits beside the centred title, or there is no label), 'moved' (the
 * label whole, the title in the room left between it and the right side), 'alone' (‹ without its label). Widths in px:
 * the bar inside its padding, and what ‹ with its label, the title and the right side (44 px at least) need. */
export type BarFit = 'centred' | 'moved' | 'alone'
export function barFit(w: { bar: number; back: number; title: number; right: number }): BarFit {
  if (2 * Math.max(w.back, w.right) + w.title <= w.bar + 1) return 'centred'
  if (w.back + w.title + w.right <= w.bar + 1) return 'moved'
  return 'alone'
}
