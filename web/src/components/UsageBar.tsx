// A thin usage bar like Claude's Settings > Usage: a quiet track, the used part in the accent colour, red only once a
// limit is passed. Decorative: the percent next to it says the same in words.
import clsx from 'clsx'

export function UsageBar({ pct, over, className }: { pct: number; over?: boolean; className?: string }) {
  return (
    <div className={clsx('h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle', className)} aria-hidden data-testid="usage-bar">
      <div className={clsx('h-full rounded-full', over ? 'bg-danger' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}
