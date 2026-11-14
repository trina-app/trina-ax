import { PRODUCT } from '@mycel/shared'
import type { Locale, PushEventType } from '@mycel/shared/api'

/** Lock-screen text is generic: never interpolate task names, results or connection details.
 *  'schedule.failure' also covers a run that finished with problems and tasks paused until their owner checks them
 *  again, so its text says "needs attention", not "failed". */
export const TEXT = {
  title: { ko: PRODUCT.displayName, en: PRODUCT.displayName, id: PRODUCT.displayName, ja: PRODUCT.displayName, es: PRODUCT.displayName, zh: PRODUCT.displayName },
  'schedule.success': {
    ko: '예약 작업이 완료됐어요.',
    en: 'A scheduled task completed.',
    id: 'Tugas terjadwal selesai.', ja: "定期タスクが完了しました。", es: "Se completó una tarea programada.", zh: "定时任务已完成。",
  },
  'schedule.failure': {
    ko: '예약 작업에 확인할 일이 있어요. 앱에서 확인해 주세요.',
    en: 'A scheduled task needs your attention.',
    id: 'Tugas terjadwal perlu perhatian Anda.', ja: "定期タスクの確認が必要です。", es: "Una tarea programada requiere su atención.", zh: "有一个定时任务需要你查看。",
  },
  'connection.reconnect': {
    ko: '연결에 다시 로그인이 필요해요.',
    en: 'A connection needs you to sign in again.',
    id: 'Koneksi perlu login ulang.', ja: "接続のために再ログインが必要です。", es: "Una conexión requiere que vuelva a iniciar sesión.", zh: "有一个连接需要你重新登录。",
  },
  // rooms: who wrote what stays in the app; the lock screen only says that something came
  'room.dm': {
    ko: '새 메시지가 왔어요.',
    en: 'You have a new message.',
    id: 'Ada pesan baru untuk Anda.', ja: "新しいメッセージが届きました。", es: "Tiene un mensaje nuevo.", zh: "你有一条新消息。",
  },
  'room.mention': {
    ko: '대화방에서 나를 언급한 메시지가 있어요.',
    en: 'Someone mentioned you in a room.',
    id: 'Seseorang menyebut Anda di ruang obrolan.', ja: "ルームであなたがメンションされました。", es: "Alguien le mencionó en una sala.", zh: "有人在群聊中提到了你。",
  },
  // 팀장 넘기기: someone joined with the owner's lead link; who it was stays in the app
  'owner.lead_joined': {
    ko: '팀장 링크로 누군가 들어왔어요. 앱에서 확인해 주세요.',
    en: 'Someone joined with your team lead link. Check it in the app.',
    id: 'Seseorang bergabung lewat tautan ketua tim. Periksa di aplikasi.', ja: "リーダー用リンクで誰かが参加しました。アプリで確認してください。", es: "Alguien entró con su enlace para el responsable. Revíselo en la aplicación.", zh: "有人通过你的团队负责人链接加入。请在应用中查看。",
  },
  // the owner's password re-check locked after too many wrong tries: what to do is in the app
  'owner.reauth_locked': {
    ko: '비밀번호 확인이 여러 번 틀렸어요. 앱에서 확인해 주세요.',
    en: 'Your password was entered wrong several times. Check it in the app.',
    id: 'Kata sandi Anda beberapa kali salah dimasukkan. Periksa di aplikasi.', ja: "パスワードの確認で何度も間違いがありました。アプリで確認してください。", es: "Su contraseña se introdujo mal varias veces. Revíselo en la aplicación.", zh: "你的密码多次输入错误。请在应用中查看。",
  },
  // an answer in my own AI chat finished, failed or waits for me: one line for all three, never the chat's title or the
  // answer's text (the push gateway has the same words: push-gateway/src/text.ts)
  'chat.answer_done': {
    ko: '트리나가 대화에 답했어요.',
    en: 'Trina replied in your chat.',
    id: 'Trina membalas di obrolan Anda.', ja: 'トリナがチャットで返信しました。', es: 'Trina respondió en su chat.', zh: 'Trina在你的对话中回复了。',
  },
  // someone shared a chat with me by name: who stays in the app (an iPhone with the notification extension shows the
  // name: CHAT_SHARED_BY), never the chat's title (the push gateway has the same words: push-gateway/src/text.ts)
  'chat.shared': {
    ko: '누군가 채팅을 공유했어요.',
    en: 'Someone shared a chat with you.',
    id: 'Seseorang membagikan obrolan dengan Anda.', ja: '誰かがチャットを共有しました。', es: 'Alguien compartió un chat con usted.', zh: '有人与你共享了一个对话。',
  },
  // an app in a room I manage paused for the day (room_app_notices): never the app's or the room's name (the push
  // gateway has the same words: push-gateway/src/text.ts)
  'room_app.paused': {
    ko: '대화방의 앱이 오늘 하루 멈췄어요.',
    en: 'An app in a room was paused for today.',
    id: 'Sebuah aplikasi di ruang obrolan dijeda untuk hari ini.', ja: 'ルームのアプリが今日は一時停止されました。', es: 'Una aplicación de una sala se pausó por hoy.', zh: '群聊中的一个应用今天已暂停。',
  },
} satisfies Record<'title' | PushEventType, Record<Locale, string>>
/** The line under the sharer's name (the title) when an iPhone's notification extension names them
 * (notifications/chat-shares.ts chatShareLabel). Never the chat's title. */
export const CHAT_SHARED_BY: Record<Locale, string> = {
  ko: '채팅을 공유했어요.', en: 'Shared a chat with you.', id: 'Membagikan obrolan dengan Anda.', ja: 'チャットを共有しました。', es: 'Compartió un chat con usted.', zh: '与你共享了一个对话。',
}
/** the button on a room notification that marks the room (or the thread) read without opening the app */
export const MARK_READ: Record<Locale, string> = { ko: '읽음으로 표시', en: 'Mark as read', id: 'Tandai dibaca', ja: '既読にする', es: 'Marcar como leído', zh: '标为已读' }
/** a phone whose notifications another person's live session gets (push-service.ts registerDevice): never says who */
export const PHONE_TAKEN: Record<Locale, string> = {
  ko: '이 휴대폰 알림은 지금 다른 계정이 받고 있어요. 그 계정에서 로그아웃한 뒤 다시 켜 주세요.',
  en: 'Another account gets this phone\'s notifications right now. Sign out of that account, then turn them on again.',
  id: 'Notifikasi ponsel ini sedang diterima akun lain. Keluar dari akun itu, lalu aktifkan lagi.',
  ja: 'この端末の通知は今、別のアカウントが受け取っています。そのアカウントからログアウトしてから、もう一度オンにしてください。',
  es: 'Otra cuenta recibe ahora las notificaciones de este teléfono. Cierre la sesión de esa cuenta y vuelva a activarlas.',
  zh: '这台手机的通知现在由另一个账号接收。请先退出那个账号，再重新开启通知。',
}

/** The words of a room notice's title on a device ("민준 · #마케팅 › 스레드": rooms/inbox.ts roomLabel, shown by the web
 * app's service worker), the same as the app's (rooms.thread, rooms.all, rooms.aiName, rooms.nameSep,
 * rooms.groupNamesMore). Names only, never a message's text. */
const ROOM_WORD = {
  thread: { ko: '스레드', en: 'Thread', id: 'Utas', ja: 'スレッド', es: 'Hilo', zh: '话题' },
  all: { ko: '전체', en: 'Everyone', id: 'Semua', ja: '全員', es: 'Todos', zh: '所有人' },
  ai: { ko: '트리나', en: 'Trina', id: 'Trina', ja: 'トリナ', es: 'Trina', zh: 'Trina' },
  sep: { ko: ', ', en: ', ', id: ', ', ja: '、', es: ', ', zh: '、' },
} satisfies Record<string, Record<Locale, string>>
const ROOM_MORE: Record<Locale, (names: string, n: number) => string> = {
  ko: (names, n) => `${names} 외 ${n}명`,
  en: (names, n) => `${names} and ${n} more`,
  id: (names, n) => `${names} dan ${n} lainnya`,
  ja: (names, n) => `${names}ほか${n}人`,
  es: (names, n) => `${names} y ${n} más`,
  zh: (names, n) => `${names}及另外${n}人`,
}
const roomWords = (l: Locale) => ({ thread: ROOM_WORD.thread[l], all: ROOM_WORD.all[l], ai: ROOM_WORD.ai[l], sep: ROOM_WORD.sep[l], more: ROOM_MORE[l] })
export const ROOM_WORDS: Record<Locale, { thread: string; all: string; ai: string; sep: string; more: (names: string, n: number) => string }> = {
  ko: roomWords('ko'), en: roomWords('en'), id: roomWords('id'), ja: roomWords('ja'), es: roomWords('es'), zh: roomWords('zh'),
}

export function pushMessages(locale: Locale) {
  return { title: TEXT.title[locale], bodies: {
    'schedule.success': TEXT['schedule.success'][locale],
    'schedule.failure': TEXT['schedule.failure'][locale],
    'connection.reconnect': TEXT['connection.reconnect'][locale],
    'room.dm': TEXT['room.dm'][locale],
    'room.mention': TEXT['room.mention'][locale],
    'owner.lead_joined': TEXT['owner.lead_joined'][locale],
    'owner.reauth_locked': TEXT['owner.reauth_locked'][locale],
    'chat.answer_done': TEXT['chat.answer_done'][locale],
    'chat.shared': TEXT['chat.shared'][locale],
    'room_app.paused': TEXT['room_app.paused'][locale],
  }, markRead: MARK_READ[locale], chatSharedBy: CHAT_SHARED_BY[locale] }
}
