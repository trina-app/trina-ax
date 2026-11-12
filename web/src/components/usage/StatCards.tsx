// The Console's stat cards: a quiet label over one big number, in a row of equal cards. On a phone (below 768 px) the
// numbers stand without frames, two or three to a row, one size down so a nine-digit total stays on one line in a third
// of a 390 px screen (docs/DECISIONS.md "Admin and Settings on phones": four framed cards one or two per row pushed the
// chart off the first screen).
import clsx from 'clsx'

export function StatCards({ items, testId = 'usage-stats' }: { items: { label: string; value: string; testId?: string }[]; testId?: string }) {
  return (
    <dl className={clsx('grid gap-3 max-md:gap-x-3 max-md:gap-y-4', items.length === 2 ? 'grid-cols-2' : items.length === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4')} data-testid={testId}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0 rounded-xl border border-line bg-surface p-4 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0 md:p-5" data-testid={it.testId}>
          <dt className="truncate text-sm text-muted max-md:text-xs">{it.label}</dt>
          <dd className="mt-2 break-words text-xl font-medium tabular-nums tracking-tight [overflow-wrap:anywhere] max-md:mt-1 max-md:text-lg md:mt-3 2xl:text-2xl">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}
