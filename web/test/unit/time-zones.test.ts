// Admin > Settings team time zone dropdown: every zone appears once and the team's current
// zone is always offered first (web/src/lib/time-zones.ts).
import { expect, test } from 'bun:test'
import { timeZoneOptions } from '../../src/lib/time-zones'

type IntlWithList = { supportedValuesOf?: (k: string) => string[] }

/** Chromium omits UTC from Intl.supportedValuesOf('timeZone'); simulate a short list. */
function withZoneList<T>(zones: string[], run: () => T): T {
  const intl = Intl as unknown as IntlWithList
  const orig = intl.supportedValuesOf
  intl.supportedValuesOf = (k: string) => (k === 'timeZone' ? zones : orig ? orig(k) : [])
  try {
    return run()
  } finally {
    intl.supportedValuesOf = orig
  }
}

test('a current zone appended to the browser list is not offered twice', () => {
  withZoneList(['Asia/Seoul', 'Europe/London'], () => {
    const opts = timeZoneOptions('UTC')
    expect(opts.filter((z) => z === 'UTC')).toHaveLength(1)
    expect(opts[0]).toBe('UTC')
  })
})

test('a current zone missing from both lists is still offered first, once', () => {
  withZoneList(['Asia/Seoul'], () => {
    const opts = timeZoneOptions('Asia/Tokyo')
    expect(opts[0]).toBe('Asia/Tokyo')
    expect(opts.filter((z) => z === 'Asia/Tokyo')).toHaveLength(1)
  })
})

test('a current zone present in the browser list only gains the UTC fallback', () => {
  withZoneList(['Asia/Seoul', 'Europe/London'], () => {
    expect(timeZoneOptions('Asia/Seoul')).toEqual(['Asia/Seoul', 'Europe/London', 'UTC'])
  })
})
