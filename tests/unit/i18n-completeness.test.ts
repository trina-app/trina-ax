import { expect, test } from 'bun:test'
import { auditI18n } from '../../scripts/check-i18n'

test('all app dictionaries and locale tables are complete; ja/es match English placeholders and ICU forms', () => {
  const { problems, counts } = auditI18n()
  expect(counts.localeTables).toBeGreaterThan(350)
  expect(problems).toEqual([])
})
