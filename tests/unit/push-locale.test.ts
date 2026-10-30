import { afterEach, expect, test } from 'bun:test'
import { PRODUCT } from '@mycel/shared'
import { Locale, PushEventType, PushSettings } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { setUserLocale } from '../../server/src/auth/users'
import { updateTeamSettings } from '../../server/src/admin/settings'

let h: Harness
afterEach(async () => { await h?.close() })
const expected = {
  ja: ['定期タスクが完了しました。', '定期タスクの確認が必要です。', '接続のために再ログインが必要です。'],
  es: ['Se completó una tarea programada.', 'Una tarea programada requiere su atención.', 'Una conexión requiere que vuelva a iniciar sesión.'],
  ko: ['예약 작업이 완료됐어요.', '예약 작업에 확인할 일이 있어요. 앱에서 확인해 주세요.', '연결에 다시 로그인이 필요해요.'],
  en: ['A scheduled task completed.', 'A scheduled task needs your attention.', 'A connection needs you to sign in again.'],
  id: ['Tugas terjadwal selesai.', 'Tugas terjadwal perlu perhatian Anda.', 'Koneksi perlu login ulang.'],
}
function check(settings: unknown, locale: Locale) {
  const messages = PushSettings.parse(settings).messages!
  expect(messages.title).toBe(PRODUCT.displayName)
  expect(PushEventType.options.map(event => messages.bodies[event])).toEqual(expected[locale])
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

test('recipients in the same team retain separate display languages across requests', async () => {
  h = await harness('push-locale-recipients')
  const owner = await withOwner(h)
  const member = await addMember(h, owner, { username: 'reader' })
  setUserLocale(h.ctx.db, 'olga', 'ko')
  setUserLocale(h.ctx.db, member.id, 'id')
  updateTeamSettings(h.ctx.db, { defaultLocale: 'en' })
  for (let round = 0; round < 2; round++) {
    const [a, b] = await Promise.all([owner.call('GET', '/api/push'), member.client.call('GET', '/api/push')])
    check(a, 'ko')
    check(b, 'id')
  }
})

test('push settings remain readable from an older server without localized text', () => {
  const legacy = { configured: true, enabled: true, publicKey: null, subscriptionId: 'old-subscription' }
  expect(PushSettings.parse(legacy)).toEqual(legacy)
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
  check(await c.call('GET', '/api/push'), Locale.options.at(-1)!)
})
