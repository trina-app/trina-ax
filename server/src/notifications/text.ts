import { PRODUCT } from '@mycel/shared'
import type { Locale, PushEventType } from '@mycel/shared/api'

/** Lock-screen text is generic: never interpolate task names, results or connection details.
 *  'schedule.failure' also covers a run that finished with problems and tasks paused until their owner checks them
 *  again, so its text says "needs attention", not "failed". */
export const TEXT = {
  title: { ko: PRODUCT.displayName, en: PRODUCT.displayName, id: PRODUCT.displayName, ja: PRODUCT.displayName, es: PRODUCT.displayName },
  'schedule.success': {
    ko: '예약 작업이 완료됐어요.',
    en: 'A scheduled task completed.',
    id: 'Tugas terjadwal selesai.', ja: "定期タスクが完了しました。", es: "Se completó una tarea programada.",
  },
  'schedule.failure': {
    ko: '예약 작업에 확인할 일이 있어요. 앱에서 확인해 주세요.',
    en: 'A scheduled task needs your attention.',
    id: 'Tugas terjadwal perlu perhatian Anda.', ja: "定期タスクの確認が必要です。", es: "Una tarea programada requiere su atención.",
  },
  'connection.reconnect': {
    ko: '연결에 다시 로그인이 필요해요.',
    en: 'A connection needs you to sign in again.',
    id: 'Koneksi perlu login ulang.', ja: "接続のために再ログインが必要です。", es: "Una conexión requiere que vuelva a iniciar sesión.",
  },
  // rooms: who wrote what stays in the app; the lock screen only says that something came
  'room.dm': {
    ko: '새 메시지가 왔어요.',
    en: 'You have a new message.',
    id: 'Ada pesan baru untuk Anda.', ja: "新しいメッセージが届きました。", es: "Tiene un mensaje nuevo.",
  },
  'room.mention': {
    ko: '대화방에서 나를 언급한 메시지가 있어요.',
    en: 'Someone mentioned you in a room.',
    id: 'Seseorang menyebut Anda di ruang obrolan.', ja: "ルームであなたがメンションされました。", es: "Alguien le mencionó en una sala.",
  },
} satisfies Record<'title' | PushEventType, Record<Locale, string>>

/** The words of a room notice's title on a device ("민준 · #마케팅 › 스레드": rooms/inbox.ts roomLabel, shown by the web
 * app's service worker), the same as the app's (rooms.thread, rooms.all, rooms.aiName, rooms.nameSep,
 * rooms.groupNamesMore). Names only, never a message's text. */
export const ROOM_WORDS: Record<Locale, { thread: string; all: string; ai: string; sep: string; more: (names: string, n: number) => string }> = {
  ko: { thread: '스레드', all: '전체', ai: '트리나', sep: ', ', more: (names, n) => `${names} 외 ${n}명` },
  en: { thread: 'Thread', all: 'Everyone', ai: 'Trina', sep: ', ', more: (names, n) => `${names} and ${n} more` },
  id: { thread: 'Utas', all: 'Semua', ai: 'Trina', sep: ', ', more: (names, n) => `${names} dan ${n} lainnya` },
  ja: { thread: 'スレッド', all: '全員', ai: 'トリナ', sep: '、', more: (names, n) => `${names}ほか${n}人` },
  es: { thread: 'Hilo', all: 'Todos', ai: 'Trina', sep: ', ', more: (names, n) => `${names} y ${n} más` },
}

export function pushMessages(locale: Locale) {
  return { title: TEXT.title[locale], bodies: {
    'schedule.success': TEXT['schedule.success'][locale],
    'schedule.failure': TEXT['schedule.failure'][locale],
    'connection.reconnect': TEXT['connection.reconnect'][locale],
    'room.dm': TEXT['room.dm'][locale],
    'room.mention': TEXT['room.mention'][locale],
  } }
}
