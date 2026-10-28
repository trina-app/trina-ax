import { afterEach, expect, test } from 'bun:test'
import { PRODUCT } from '@mycel/shared'
import { Locale, NotificationEventType, PushSettings } from '@mycel/shared/api'
import { harness, withOwner, type Harness } from './a-lib'
import { setUserLocale } from '../../server/src/auth/users'
import { updateTeamSettings } from '../../server/src/admin/settings'

let h: Harness
afterEach(async () => { await h?.close() })
const expected = {
  ko: ['예약 작업이 완료됐어요.', '예약 작업을 마치지 못했어요. 실행 결과를 확인해 주세요.', '연결에 다시 로그인이 필요해요.'],
  en: ['A scheduled task completed.', 'A scheduled task needs your attention.', 'A connection needs you to sign in again.'],
  id: ['Tugas terjadwal selesai.', 'Tugas terjadwal perlu perhatian Anda.', 'Koneksi perlu login ulang.'],
}
function check(settings: unknown, locale: Locale) {
  const { messages } = PushSettings.parse(settings)
  expect(messages.title).toBe(PRODUCT.displayName)
  expect(NotificationEventType.options.map(event => messages.bodies[event])).toEqual(expected[locale])
}

test.each(Locale.options)('%s account gets localized text for every push event, overriding team and browser language', async locale => {
  h = await harness('push-locale')
  const c = await withOwner(h)
  const other = locale === 'ko' ? 'en' : 'ko'
  updateTeamSettings(h.ctx.db, { defaultLocale: other })
  setUserLocale(h.ctx.db, 'olga', locale)
  check(await c.call('GET', '/api/push', undefined, { 'Accept-Language': other }), locale)
  expect(c.lastHeaders?.get('Cache-Control')).toBe('no-store')
  // A later team change does not overwrite an explicit account choice.
  updateTeamSettings(h.ctx.db, { defaultLocale: 'id' })
  check(await c.call('GET', '/api/push'), locale)
})

test('no account choice follows the current team default, or English without a team setting', async () => {
  h = await harness('push-locale')
  const c = await withOwner(h)
  h.ctx.db.query("DELETE FROM settings WHERE key='defaultLocale'").run()
  setUserLocale(h.ctx.db, 'olga', null)
  check(await c.call('GET', '/api/push'), 'en')
  for (const locale of Locale.options) {
    updateTeamSettings(h.ctx.db, { defaultLocale: locale })
    check(await c.call('GET', '/api/push'), locale)
  }
  // Changing the account choice takes effect on the next display-time request.
  setUserLocale(h.ctx.db, 'olga', 'ko')
  check(await c.call('GET', '/api/push'), 'ko')
  setUserLocale(h.ctx.db, 'olga', null)
  check(await c.call('GET', '/api/push'), 'id')
})
