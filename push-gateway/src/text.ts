// Lock-screen text. Never message content (App Review 4.5.4): the gateway picks one of these generic lines from the
// request's `code` and `locale`. The three event texts are the team server's (server/src/notifications/text.ts); a test
// keeps them equal.
import type { PushLocale } from '../../shared/src/cloud-protocol/push-gateway.ts'

type ByLocale = Record<PushLocale, string>

export const DEFAULT_APP_TITLE = 'Trina AX'

export const EVENT_TEXT: Record<'schedule.success' | 'schedule.failure' | 'connection.reconnect', ByLocale> = {
  'schedule.success': {
    ko: '예약 작업이 완료됐어요.',
    en: 'A scheduled task completed.',
    id: 'Tugas terjadwal selesai.', ja: '定期タスクが完了しました。', es: 'Se completó una tarea programada.',
  },
  'schedule.failure': {
    ko: '예약 작업에 확인할 일이 있어요. 앱에서 확인해 주세요.',
    en: 'A scheduled task needs your attention.',
    id: 'Tugas terjadwal perlu perhatian Anda.', ja: '定期タスクの確認が必要です。', es: 'Una tarea programada requiere su atención.',
  },
  'connection.reconnect': {
    ko: '연결에 다시 로그인이 필요해요.',
    en: 'A connection needs you to sign in again.',
    id: 'Koneksi perlu login ulang.', ja: '接続のために再ログインが必要です。', es: 'Una conexión requiere que vuelva a iniciar sesión.',
  },
}

export const MESSAGE_TEXT: ByLocale = {
  ko: '새 메시지가 있어요', en: 'You have a new message', id: 'Ada pesan baru', ja: '新しいメッセージがあります', es: 'Tienes un mensaje nuevo',
}

export const OTHER_TEXT: ByLocale = {
  ko: '새 알림이 있어요', en: 'You have a new notification', id: 'Ada notifikasi baru', ja: '新しいお知らせがあります', es: 'Tienes una notificación nueva',
}

export function alertBody(code: string, locale: PushLocale): string {
  if (Object.hasOwn(EVENT_TEXT, code)) return EVENT_TEXT[code as keyof typeof EVENT_TEXT][locale]
  if (code.startsWith('room.') || code.startsWith('chat.')) return MESSAGE_TEXT[locale]
  return OTHER_TEXT[locale]
}
