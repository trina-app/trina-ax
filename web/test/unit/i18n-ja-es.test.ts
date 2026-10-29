import { expect, test } from 'bun:test'
import { asLocale, Locale } from '@mycel/shared/api'
import { formatDateTime, formatNumber, formatRelative, formatSize } from '../../src/lib/format'
import { translate } from '../../src/i18n'

test('regional account input normalizes to Japanese or Spanish; unsupported input stays unknown', () => {
  for (const [raw, locale] of [['ja', 'ja'], ['ja-JP', 'ja'], ['es', 'es'], ['es-MX', 'es'], ['es_ES', 'es']] as const) {
    expect(asLocale(raw)).toBe(locale)
    expect(Locale.parse(locale)).toBe(locale)
  }
  expect(asLocale('fr-FR')).toBeNull()
})

test('Japanese counts use other; Spanish counts distinguish one and other', () => {
  expect(translate('ja', 'steps.summary', { n: 1 })).toBe('1ステップ')
  expect(translate('ja', 'steps.summary', { n: 3 })).toBe('3ステップ')
  expect(translate('es', 'steps.summary', { n: 1 })).toBe('1 paso')
  expect(translate('es', 'steps.summary', { n: 3 })).toBe('3 pasos')
})

test('dates, decimal separators, sizes and relative times follow the display language', () => {
  expect(formatNumber(12345.6, 'ja')).toBe('12,345.6')
  expect(formatNumber(12345.6, 'es')).toBe('12.345,6')
  expect(formatSize(1536, 'ja')).toBe('1.5 KB')
  expect(formatSize(1536, 'es')).toBe('1,5 KB')
  const date = '2026-10-29T12:00:00Z'
  for (const locale of ['ja', 'es'] as const) {
    expect(formatDateTime(date, locale, 'UTC')).toBe(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(date)))
    expect(formatRelative(date, locale, Date.parse(date) + 86400000)).toBe(locale === 'ja' ? '昨日' : 'ayer')
  }
})
