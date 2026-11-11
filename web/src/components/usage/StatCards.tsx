// The Console's stat cards: a quiet label over one big number, in a row of equal cards (two per row on a phone).
export function StatCards({ items, testId = 'usage-stats' }: { items: { label: string; value: string; testId?: string }[]; testId?: string }) {
  return (
    <dl className={items.length === 2 ? 'grid grid-cols-2 gap-3' : items.length === 3 ? 'grid grid-cols-1 gap-3 sm:grid-cols-3' : 'grid grid-cols-2 gap-3 lg:grid-cols-4'} data-testid={testId}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-5" data-testid={it.testId}>
          <dt className="truncate text-sm text-muted">{it.label}</dt>
          <dd className="mt-2 break-words text-xl font-medium tabular-nums tracking-tight [overflow-wrap:anywhere] sm:mt-3 2xl:text-2xl">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}
