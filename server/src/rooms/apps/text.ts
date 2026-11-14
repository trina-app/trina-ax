// The words an app's cards and lines carry (docs/DECISIONS.md "Apps posting in rooms"). Written by the server in the
// team's language when the card is posted (like event lines), so search, push and the AI see what people see. English
// is the source; never the word "webhook".
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const APP_TEXT = {
  // Sentry
  sentryNew: t('새 이슈', 'New issue', 'Masalah baru', '新しい問題', 'Nuevo problema'),
  sentryBack: t('이슈가 다시 생겼어요', 'Issue came back', 'Masalah muncul lagi', '問題が再発しました', 'El problema volvió'),
  sentryResolvedBy: t('{actor} 님이 해결함', 'Resolved by {actor}', 'Diselesaikan oleh {actor}', '{actor}さんが解決', 'Resuelto por {actor}'),
  sentryResolved: t('해결됨', 'Resolved', 'Diselesaikan', '解決済み', 'Resuelto'),
  sentryArchived: t('보관됨', 'Archived', 'Diarsipkan', 'アーカイブ済み', 'Archivado'),
  sentryAssigned: t('{name} 님에게 배정됨', 'Assigned to {name}', 'Ditugaskan ke {name}', '{name}さんに割り当て', 'Asignado a {name}'),
  sentryAlert: t('알림 규칙 실행: {rule}', 'Alert fired: {rule}', 'Peringatan aktif: {rule}', 'アラート発生: {rule}', 'Alerta activada: {rule}'),
  sentryMetric: t('지표 알림: {status}', 'Metric alert: {status}', 'Peringatan metrik: {status}', 'メトリクスアラート: {status}', 'Alerta de métrica: {status}'),
  statusUnresolved: t('미해결', 'Unresolved', 'Belum selesai', '未解決', 'Sin resolver'),
  // GitHub
  prOpened: t('풀 리퀘스트 열림', 'Pull request opened', 'Pull request dibuka', 'プルリクエストが作成されました', 'Pull request abierta'),
  prReopened: t('풀 리퀘스트 다시 열림', 'Pull request reopened', 'Pull request dibuka lagi', 'プルリクエストが再オープンされました', 'Pull request reabierta'),
  prReady: t('리뷰 준비됨', 'Ready for review', 'Siap ditinjau', 'レビュー準備完了', 'Lista para revisión'),
  prMerged: t('풀 리퀘스트 병합됨', 'Pull request merged', 'Pull request digabung', 'プルリクエストがマージされました', 'Pull request fusionada'),
  prClosed: t('풀 리퀘스트 닫힘', 'Pull request closed', 'Pull request ditutup', 'プルリクエストがクローズされました', 'Pull request cerrada'),
  issueOpened: t('이슈 열림', 'Issue opened', 'Isu dibuka', 'イシューが作成されました', 'Incidencia abierta'),
  issueClosed: t('이슈 닫힘', 'Issue closed', 'Isu ditutup', 'イシューがクローズされました', 'Incidencia cerrada'),
  issueReopened: t('이슈 다시 열림', 'Issue reopened', 'Isu dibuka lagi', 'イシューが再オープンされました', 'Incidencia reabierta'),
  checksFailed: t('검사 실패: {workflow}', 'Checks failed: {workflow}', 'Pemeriksaan gagal: {workflow}', 'チェック失敗: {workflow}', 'Comprobaciones fallidas: {workflow}'),
  release: t('릴리스 게시: {tag}', 'Release published: {tag}', 'Rilis diterbitkan: {tag}', 'リリース公開: {tag}', 'Versión publicada: {tag}'),
  pushedOne: t('{branch}에 커밋 1개 푸시', 'Pushed 1 commit to {branch}', 'Mengirim 1 commit ke {branch}', '{branch} に1件のコミットをプッシュ', 'Se envió 1 commit a {branch}'),
  pushedMany: t('{branch}에 커밋 {n}개 푸시', 'Pushed {n} commits to {branch}', 'Mengirim {n} commit ke {branch}', '{branch} に{n}件のコミットをプッシュ', 'Se enviaron {n} commits a {branch}'),
  byActor: t('{actor} 님', 'by {actor}', 'oleh {actor}', '{actor}さん', 'por {actor}'),
  statusOpen: t('열림', 'Open', 'Terbuka', 'オープン', 'Abierta'),
  statusMerged: t('병합됨', 'Merged', 'Digabung', 'マージ済み', 'Fusionada'),
  statusClosed: t('닫힘', 'Closed', 'Ditutup', 'クローズ', 'Cerrada'),
  statusFailed: t('실패', 'Failed', 'Gagal', '失敗', 'Fallida'),
  // Google Forms
  formsNew: t('{form}에 새 응답', 'New response to {form}', 'Tanggapan baru untuk {form}', '{form} への新しい回答', 'Nueva respuesta a {form}'),
  formsEdited: t('응답이 수정됨', 'Response edited', 'Tanggapan diubah', '回答が編集されました', 'Respuesta editada'),
  formsEmail: t('이메일: {email}', 'Email: {email}', 'Email: {email}', 'メール: {email}', 'Correo: {email}'),
  formsMore: t('답변 {n}개 더', '{n} more answers', '{n} jawaban lagi', 'ほか{n}件の回答', '{n} respuestas más'),
  // every app
  status: t('상태: {status}', 'Status: {status}', 'Status: {status}', '状態: {status}', 'Estado: {status}'),
  unverified: t('(확인 안 됨)', '(unverified)', '(belum diverifikasi)', '(未確認)', '(sin verificar)'),
  example: t('예시', 'Example', 'Contoh', '例', 'Ejemplo'),
  exampleTitle: t('{app}의 메시지가 여기에 이렇게 보여요', 'This is how messages from {app} look here', 'Beginilah pesan dari {app} tampil di sini', '{app} からのメッセージはここにこう表示されます', 'Así se ven aquí los mensajes de {app}'),
  pausedLine: t('{app}이(가) 오늘 메시지 {cap}개에 도달해 멈췄어요. 내일 다시 시작해요.', '{app} reached {cap} messages today and was paused. It starts again tomorrow.', '{app} mencapai {cap} pesan hari ini dan dijeda. Mulai lagi besok.', '{app} は今日 {cap} 件のメッセージに達したため一時停止しました。明日また始まります。', '{app} llegó a {cap} mensajes hoy y se pausó. Vuelve a empezar mañana.'),
  resumedLine: t('{name} 님이 오늘 {app}을(를) 다시 켰어요.', '{name} turned {app} back on for today.', '{name} menyalakan {app} lagi untuk hari ini.', '{name}さんが今日の {app} を再開しました。', '{name} volvió a activar {app} por hoy.'),
  someone: t('누군가', 'Someone', 'Seseorang', '誰か', 'Alguien'),
  // refusals of the management API
  nameIsPerson: t('이 팀 사람의 이름과 다른 이름을 골라 주세요.', "Pick a name that isn't a person's in this team.", 'Pilih nama yang bukan nama orang di tim ini.', 'このチームの人の名前ではない名前を選んでください。', 'Elija un nombre que no sea el de una persona de este equipo.'),
  sentrySecretShape: t('Sentry의 Client Secret 같지 않아요.', "That doesn't look like a Sentry Client Secret.", 'Itu tidak terlihat seperti Client Secret Sentry.', 'Sentry の Client Secret ではないようです。', 'Eso no parece un Client Secret de Sentry.'),
  noAddress: t('앱이 이 서버에 닿으려면 인터넷 주소가 있어야 하는데 아직 없어요.', "Apps need this server to have an internet address, and it doesn't have one yet.", 'Aplikasi memerlukan alamat internet untuk server ini, dan server ini belum memilikinya.', 'アプリがこのサーバーに届くにはインターネットアドレスが必要ですが、まだありません。', 'Las aplicaciones necesitan que este servidor tenga una dirección de internet, y todavía no la tiene.'),
  full: t('이 방에는 앱이 {max}개 있어요. 하나를 빼야 다른 앱을 추가할 수 있어요.', 'This room has {max} apps. Remove one to add another.', 'Ruangan ini punya {max} aplikasi. Hapus satu untuk menambah yang lain.', 'このルームにはアプリが{max}個あります。別のアプリを追加するには1つ削除してください。', 'Esta sala tiene {max} aplicaciones. Quite una para añadir otra.'),
  notPaused: t('이 앱은 멈춰 있지 않아요.', "This app isn't paused.", 'Aplikasi ini tidak dijeda.', 'このアプリは一時停止していません。', 'Esta aplicación no está en pausa.'),
  alreadyResumed: t('오늘은 이미 한 번 다시 켰어요. 내일 다시 시작해요.', 'It was already turned back on once today. It starts again tomorrow.', 'Aplikasi ini sudah dinyalakan lagi sekali hari ini. Mulai lagi besok.', '今日はすでに一度再開しています。明日また始まります。', 'Ya se volvió a activar una vez hoy. Vuelve a empezar mañana.'),
  teamCap: t('오늘 이 팀의 모든 앱 메시지가 {cap}개에 도달했어요. 내일 다시 시작해요.', "This team's apps reached {cap} messages today. They start again tomorrow.", 'Aplikasi tim ini mencapai {cap} pesan hari ini. Mulai lagi besok.', 'このチームのアプリは今日 {cap} 件のメッセージに達しました。明日また始まります。', 'Las aplicaciones de este equipo llegaron a {cap} mensajes hoy. Vuelven a empezar mañana.'),
  noSecretForKind: t('이 앱에는 비밀값을 쓸 수 없어요.', "This app doesn't take a secret.", 'Aplikasi ini tidak memakai rahasia.', 'このアプリにはシークレットを設定できません。', 'Esta aplicación no admite un secreto.'),
} satisfies Record<string, T>

export type AppTextKey = keyof typeof APP_TEXT
/** A text in the locale with {name} filled in (the values are plain text already). */
export function appText(key: AppTextKey, locale: Locale, vars: Record<string, string | number> = {}): string {
  const s = APP_TEXT[key][locale] ?? APP_TEXT[key].en
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
