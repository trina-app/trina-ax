// Home's suggestions on a phone (below 768 px; QA TC-253): one row of chips right above the docked box, which scrolls
// sideways (its edges fade where more is behind them), like the suggestions of the ChatGPT and Claude apps. Each chip is
// one target at least 44 px tall. The blocks that use it (components/onboarding/TeamPrepared.tsx,
// components/OftenAsked.tsx) keep their own content and rules; a computer keeps their lists under the box.
import clsx from 'clsx'
import { useRef, type ReactNode } from 'react'
import { useEdgeFade } from './ui'

/** A chip's frame: a rounded box with a hairline, its text left-aligned (a button, a link or a list item). */
export const chip = 'flex min-h-11 shrink-0 items-center rounded-2xl border border-line bg-surface text-left transition hover:bg-hover'

export function SuggestionRow({ id, children, testId, className }: { id?: string; children: ReactNode; testId?: string; className?: string }) {
  const ref = useRef<HTMLUListElement>(null)
  useEdgeFade(ref)
  return (
    // the row runs to the screen's edges (the page's 16 px gutter as its padding), its scrollbar hidden: a swipe moves it.
    // The fade is wider than the gutter (3.5rem): a chip cut by the screen's edge fades out and reads as "more this way",
    // not as a chip cut off (owner report 2026-11-25 at 390 px: the third chip read as clipped)
    <ul ref={ref} id={id} className={clsx('edge-fade -mx-4 flex gap-2 overflow-x-auto px-4 [--fade:3.5rem]! [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} data-testid={testId}>
      {children}
    </ul>
  )
}
