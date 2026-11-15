// The "Est. cost" tile text (QA TC-3143): real usage never reads as a plain $0.
import { expect, test } from 'bun:test'
import { costText } from '../../src/lib/usage-cost'

test('an amount reads as dollars; an unknown part adds "+?"; nothing priced reads "No price", not $0', () => {
  expect(costText({ costUsd: 1.5, turns: 3 }, 'en', 'No price')).toBe('$1.50')
  expect(costText({ costUsd: 1.5, turns: 3, unpricedTurns: 1 }, 'en', 'No price')).toBe('$1.50 +?')
  expect(costText({ costUsd: 0, turns: 2, unpricedTurns: 2 }, 'en', 'No price')).toBe('No price')
  expect(costText({ costUsd: 0, turns: 0 }, 'en', 'No price')).toBe('$0.00')
})
