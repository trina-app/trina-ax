// The "Est. cost" text of a usage amount (Admin › Usage, Settings › Usage; QA TC-3143). Real usage never reads as a plain
// $0: an amount with no priced part says "No price", one with an unknown part gets "+?" (the note under it says why).
import type { Locale } from '@mycel/shared/api'
import { formatUsd } from './format'

type Amount = { costUsd: number; turns: number; unpricedTurns?: number }

export function costText(a: Amount, locale: Locale, noPrice: string): string {
  if (a.unpricedTurns && a.costUsd <= 0) return noPrice
  return `${formatUsd(a.costUsd, locale)}${a.unpricedTurns ? ' +?' : ''}`
}
