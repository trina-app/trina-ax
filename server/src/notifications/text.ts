import { PRODUCT } from '@mycel/shared'
import type { Locale, NotificationEventType } from '@mycel/shared/api'

/** Lock-screen text is generic: never interpolate task names, results or connection details.
 *  'schedule.failure' also covers a run that finished with problems, so its text says "needs attention", not "failed". */
export const TEXT = {
  title: { ko: PRODUCT.displayName, en: PRODUCT.displayName, id: PRODUCT.displayName },
  'schedule.success': {
    ko: '예약 작업이 완료됐어요.',
    en: 'A scheduled task completed.',
    id: 'Tugas terjadwal selesai.',
  },
  'schedule.failure': {
    ko: '예약 작업에 확인할 일이 있어요. 실행 결과를 확인해 주세요.',
    en: 'A scheduled task needs your attention.',
    id: 'Tugas terjadwal perlu perhatian Anda.',
  },
  'connection.reconnect': {
    ko: '연결에 다시 로그인이 필요해요.',
    en: 'A connection needs you to sign in again.',
    id: 'Koneksi perlu login ulang.',
  },
} satisfies Record<'title' | NotificationEventType, Record<Locale, string>>

export function pushMessages(locale: Locale) {
  return { title: TEXT.title[locale], bodies: {
    'schedule.success': TEXT['schedule.success'][locale],
    'schedule.failure': TEXT['schedule.failure'][locale],
    'connection.reconnect': TEXT['connection.reconnect'][locale],
  } }
}
