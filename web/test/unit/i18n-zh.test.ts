import { expect, test } from 'bun:test'
import { asLocale, Locale, LOCALE_NAMES, LOCALE_ORDER } from '@mycel/shared/api'
import { formatNumber, formatSize } from '../../src/lib/format'
import { browserLocale, translate } from '../../src/i18n'
import { recoveryLocale } from '../../src/i18n/recovery-locale'
import { skillQuote } from '../../src/lib/teamGoal'

test('every Chinese tag is Simplified Chinese, Traditional ones too (the only Chinese we have)', () => {
  for (const raw of ['zh', 'zh-CN', 'zh-cn', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW']) {
    expect({ raw, locale: asLocale(raw) }).toEqual({ raw, locale: 'zh' })
  }
  expect(Locale.parse('zh')).toBe('zh')
  expect(browserLocale(['fr-FR', 'zh-TW', 'en-US'])).toBe('zh')
  expect(recoveryLocale(null, 'zh')).toBe('zh')
})

test('the pickers list it last, in its own name', () => {
  expect(LOCALE_ORDER.at(-1)).toBe('zh')
  expect(LOCALE_NAMES.zh).toBe('简体中文')
})

test('Chinese counts use other, numbers and sizes follow zh-CN, skill names are quoted “…”', () => {
  for (const n of [1, 3]) {
    const text = translate('zh', 'steps.summary', { n })
    expect(text).toContain(String(n))
    expect(text).not.toMatch(/[{}#a-z]/)
  }
  expect(formatNumber(12345.6, 'zh')).toBe('12,345.6')
  expect(formatSize(1536, 'zh')).toBe('1.5 KB')
  expect(skillQuote('zh', '广告文案')).toBe('“广告文案”')
})
