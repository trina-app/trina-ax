// The "Est. cost" text (QA TC-3143, TC-3467): real usage never reads as a plain $0, in the tiles, the breakdown rows and
// the total row alike.
import { expect, test } from 'bun:test'
import { costParts, costText } from '../../src/lib/usage-cost'

test('an amount reads as dollars; an unknown part adds "+?"; nothing priced reads "No price", not $0', () => {
  expect(costText({ costUsd: 1.5, turns: 3 }, 'en', 'No price')).toBe('$1.50')
  expect(costText({ costUsd: 1.5, turns: 3, unpricedTurns: 1 }, 'en', 'No price')).toBe('$1.50 +?')
  expect(costText({ costUsd: 0, turns: 2, unpricedTurns: 2 }, 'en', 'No price')).toBe('No price')
  expect(costText({ costUsd: 0, turns: 0 }, 'en', 'No price')).toBe('$0.00')
})

test('breakdown rows and the total row use the same rule as the tile (TC-3467)', () => {
  // a person whose answers are all unpriced: "No price", never "$0.00 +?"
  expect(costParts({ costUsd: 0, turns: 4, unpricedTurns: 4 }, 'en')).toEqual({ noPrice: true })
  // partly priced: the amount and "+?"
  expect(costParts({ costUsd: 0.25, turns: 4, unpricedTurns: 1 }, 'en')).toEqual({ noPrice: false, usd: '$0.25', partial: true })
  // fully priced, and a row with no answers: just the amount
  expect(costParts({ costUsd: 2, turns: 4 }, 'en')).toEqual({ noPrice: false, usd: '$2.00', partial: false })
  expect(costParts({ costUsd: 0, turns: 0, unpricedTurns: 0 }, 'en')).toEqual({ noPrice: false, usd: '$0.00', partial: false })
  // the tile text is built from the same parts
  for (const a of [{ costUsd: 0, turns: 4, unpricedTurns: 4 }, { costUsd: 0.25, turns: 4, unpricedTurns: 1 }, { costUsd: 2, turns: 4 }]) {
    const p = costParts(a, 'en')
    expect(costText(a, 'en', 'No price')).toBe(p.noPrice ? 'No price' : `${p.usd}${p.partial ? ' +?' : ''}`)
  }
})
