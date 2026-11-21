// The "Est. cost" text of a usage amount (Admin › Usage, Settings › Usage; QA TC-3143, TC-3467). Real usage never reads
// as a plain $0: an amount with no priced part says "No price", one with an unknown part gets "+?" (the note under it
// says why). The tiles, every breakdown row and the total row all go through costParts, so they cannot drift.
import type { Locale } from '@mycel/shared/api'
import { formatUsd } from './format'

type Amount = { costUsd: number; turns: number; unpricedTurns?: number }

/** nothing priced → noPrice; otherwise the dollar text and whether an unknown part follows it ("+?") */
export type CostParts = { noPrice: true } | { noPrice: false; usd: string; partial: boolean }

export function costParts(a: Amount, locale: Locale): CostParts {
  if (a.unpricedTurns && a.costUsd <= 0) return { noPrice: true }
  return { noPrice: false, usd: formatUsd(a.costUsd, locale), partial: !!a.unpricedTurns }
}

export function costText(a: Amount, locale: Locale, noPrice: string): string {
  const p = costParts(a, locale)
  return p.noPrice ? noPrice : `${p.usd}${p.partial ? ' +?' : ''}`
}
