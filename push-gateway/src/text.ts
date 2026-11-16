// Lock-screen text. Never message content (App Review 4.5.4): the gateway picks one of these generic lines from the
// request's `code` and `locale`. The event texts are the team server's (server/src/notifications/text.ts); a test keeps
// them equal.
import type { PushLocale } from '../../shared/src/cloud-protocol/push-gateway.ts'

type ByLocale = Record<PushLocale, string>

export const DEFAULT_APP_TITLE = 'Trina AX'

export const EVENT_TEXT: Record<'schedule.success' | 'schedule.failure' | 'connection.reconnect' | 'chat.answer_done' | 'chat.shared' | 'room_app.paused' | 'file.shared' | 'chat.thread_reply' | 'file.access_requested' | 'access.requested', ByLocale> = {
  'schedule.success': {
    ko: '예약 작업이 완료됐어요.',
    en: 'A scheduled task completed.',
    id: 'Tugas terjadwal selesai.', ja: '定期タスクが完了しました。', es: 'Se completó una tarea programada.', zh: '定时任务已完成。',
  },
  'schedule.failure': {
    ko: '예약 작업에 확인할 일이 있어요. 앱에서 확인해 주세요.',
    en: 'A scheduled task needs your attention.',
    id: 'Tugas terjadwal perlu perhatian Anda.', ja: '定期タスクの確認が必要です。', es: 'Una tarea programada requiere su atención.', zh: '有一个定时任务需要你查看。',
  },
  'connection.reconnect': {
    ko: '연결에 다시 로그인이 필요해요.',
    en: 'A connection needs you to sign in again.',
    id: 'Koneksi perlu login ulang.', ja: '接続のために再ログインが必要です。', es: 'Una conexión requiere que vuelva a iniciar sesión.', zh: '有一个连接需要你重新登录。',
  },
  // an answer in my own AI chat needs me (finished, failed or waits for me); older team servers never send it
  'chat.answer_done': {
    ko: '트리나가 대화에 답했어요.',
    en: 'Trina replied in your chat.',
    id: 'Trina membalas di obrolan Anda.', ja: 'トリナがチャットで返信しました。', es: 'Trina respondió en su chat.', zh: 'Trina在你的对话中回复了。',
  },
  // someone shared a chat with the person by name; older team servers never send it. An iPhone app with the notification
  // extension asks its own team for who (never the chat's title) and shows that instead (apns.ts mutableCode)
  'chat.shared': {
    ko: '누군가 채팅을 공유했어요.',
    en: 'Someone shared a chat with you.',
    id: 'Seseorang membagikan obrolan dengan Anda.', ja: '誰かがチャットを共有しました。', es: 'Alguien compartió un chat con usted.', zh: '有人与你共享了一个对话。',
  },
  // someone shared a file, or several in one press, with the person by name; older team servers never send it. Never
  // who or which file
  'file.shared': {
    ko: '누군가 파일을 공유했어요.',
    en: 'Someone shared files with you.',
    id: 'Seseorang membagikan file dengan Anda.', ja: '誰かがファイルを共有しました。', es: 'Alguien compartió archivos con usted.', zh: '有人与你共享了文件。',
  },
  // someone asked to open a file the person answers for; older team servers never send it. Never the file, the asker or
  // the note
  'file.access_requested': {
    ko: '누군가 파일을 열게 해 달라고 요청했어요.',
    en: 'Someone asked to open a file.',
    id: 'Seseorang meminta untuk membuka file.', ja: 'ファイルを開くリクエストが届きました。', es: 'Alguien pidió abrir un archivo.', zh: '有人请求打开文件。',
  },
  // someone asked to open a chat or project I answer for (docs/decisions/20261116-chat-project-ask-access.md; older team
  // servers never send it): never the title, the asker or the note
  'access.requested': {
    ko: '누군가 채팅이나 프로젝트를 열게 해 달라고 요청했어요.',
    en: 'Someone asked for access to a chat or project.',
    id: 'Seseorang meminta akses ke obrolan atau proyek.', ja: 'チャットまたはプロジェクトへのアクセスリクエストが届きました。', es: 'Alguien pidió acceso a un chat o proyecto.', zh: '有人请求访问对话或项目。',
  },
  // an app in a room the person manages paused for the day; older team servers never send it
  'room_app.paused': {
    ko: '대화에 추가한 앱이 오늘 하루 멈췄어요.',
    en: 'An app in a conversation was paused for today.',
    id: 'Sebuah aplikasi di percakapan dijeda untuk hari ini.', ja: 'トークのアプリが今日は一時停止されました。', es: 'Una aplicación de una conversación se pausó por hoy.', zh: '聊天中的一个应用今天已暂停。',
  },
  // a reply in a thread I follow under an AI answer of a shared chat: older team servers never send it; never who, the chat's title or the reply's text
  'chat.thread_reply': {
    ko: '스레드에 답글이 달렸어요.',
    en: 'Someone replied in a thread.',
    id: 'Seseorang membalas di utas.', ja: 'スレッドに返信がありました。', es: 'Alguien respondió en un hilo.', zh: '有人在话题中回复了。',
  },
}

export const MESSAGE_TEXT: ByLocale = {
  ko: '새 메시지가 있어요', en: 'You have a new message', id: 'Ada pesan baru', ja: '新しいメッセージがあります', es: 'Tienes un mensaje nuevo', zh: '你有一条新消息',
}

export const OTHER_TEXT: ByLocale = {
  ko: '새 알림이 있어요', en: 'You have a new notification', id: 'Ada notifikasi baru', ja: '新しいお知らせがあります', es: 'Tienes una notificación nueva', zh: '你有一条新通知',
}

export function alertBody(code: string, locale: PushLocale): string {
  if (Object.hasOwn(EVENT_TEXT, code)) return EVENT_TEXT[code as keyof typeof EVENT_TEXT][locale]
  if (code.startsWith('room.') || code.startsWith('chat.')) return MESSAGE_TEXT[locale]
  return OTHER_TEXT[locale]
}
