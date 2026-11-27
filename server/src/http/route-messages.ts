// Refusals of the API routes that say more than the code's default message, in the caller's language (all six; bun run
// check:i18n checks the table). A route never puts an English sentence into fail()/HttpError: tests/unit/
// no-english-server-messages.test.ts fails on one (language audit 2026-11-27: these came through in English to a
// Japanese or Indonesian person).
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>

export const ROUTE_MESSAGES = {
  // routes/rooms.ts setAutoMode: the team turned auto mode off for this person
  autoModeOff: { ko: '팀에서 자동 모드를 쓰지 않도록 했어요.', en: 'Your team does not let you use auto mode.', id: 'Tim Anda tidak mengizinkan Anda memakai mode otomatis.', ja: 'チームの設定で、自動モードは使えません。', es: 'Su equipo no le permite usar el modo automático.', zh: '你的团队不允许你使用自动模式。' },
  // routes/auth.ts setMyWebAccess
  webAllowAllOff: { ko: '팀에서 팀원이 "모든 웹사이트 허용"을 켜지 못하도록 했어요.', en: 'Your team does not let members turn on "Allow all websites".', id: 'Tim Anda tidak mengizinkan anggota mengaktifkan "Izinkan semua situs web".', ja: 'チームの設定で、「すべてのWebサイトを許可」は有効にできません。', es: 'Su equipo no permite que los miembros activen "Permitir todos los sitios web".', zh: '你的团队不允许成员开启“允许所有网站”。' },
  webAllowAllWarning: { ko: '먼저 지금의 안내를 확인해 주세요.', en: 'Accept the current warning first.', id: 'Terima peringatan yang berlaku terlebih dahulu.', ja: '先に最新の注意事項を確認してください。', es: 'Acepte primero la advertencia actual.', zh: '请先确认当前的提醒。' },
  // routes/dev-env.ts previewMyDevEnvRun
  devPreviewNotRunning: { ko: '개발 서버가 실행 중이 아니에요. AI에게 다시 시작해 달라고 해 주세요.', en: 'The dev server is not running. Ask the AI to start it again.', id: 'Server pengembangan tidak berjalan. Minta AI untuk menjalankannya lagi.', ja: '開発サーバーが動いていません。AIにもう一度起動するよう頼んでください。', es: 'El servidor de desarrollo no está en marcha. Pida a la IA que lo inicie de nuevo.', zh: '开发服务器没有在运行。请让 AI 重新启动它。' },
  devPreviewPort: { ko: '{port}번 포트는 미리 볼 수 없어요.', en: 'Port {port} cannot be previewed.', id: 'Port {port} tidak bisa dipratinjau.', ja: 'ポート{port}はプレビューできません。', es: 'El puerto {port} no se puede previsualizar.', zh: '无法预览端口 {port}。' },
  devPreviewNotConfigured: { ko: '이 서버에서는 미리 보기를 쓸 수 없어요. AI에게 curl 명령 하나로 개발 서버를 확인해 달라고 해 주세요.', en: 'Preview is not available on this server. Ask the AI to test the dev server with curl in one command.', id: 'Pratinjau tidak tersedia di server ini. Minta AI menguji server pengembangan dengan curl dalam satu perintah.', ja: 'このサーバーではプレビューを使えません。開発サーバーをcurlの1コマンドで確認するようAIに頼んでください。', es: 'La vista previa no está disponible en este servidor. Pida a la IA que pruebe el servidor de desarrollo con curl en un solo comando.', zh: '此服务器上无法使用预览。请让 AI 用一条 curl 命令测试开发服务器。' },
  devPreviewSameSite: { ko: '미리 보기 주소는 앱과 다른 도메인에 있어야 해요. 관리자에게 알려 주세요.', en: 'The preview address must be on another domain than the app. Tell an admin.', id: 'Alamat pratinjau harus berada di domain lain dari aplikasi. Beri tahu admin.', ja: 'プレビューのアドレスはアプリとは別のドメインにする必要があります。管理者に知らせてください。', es: 'La dirección de la vista previa debe estar en un dominio distinto al de la aplicación. Avise a un administrador.', zh: '预览地址必须位于与应用不同的域名上。请告诉管理员。' },
  // rooms/save-to-team.ts
  pickFolder: { ko: '폴더를 골라 주세요.', en: 'Pick a folder.', id: 'Pilih folder.', ja: 'フォルダーを選んでください。', es: 'Elija una carpeta.', zh: '请选择一个文件夹。' },
  saveSkillsFolder: { ko: '대화의 파일은 스킬 폴더에 저장하지 않아요.', en: 'Files from a conversation are not saved in a skills folder.', id: 'Berkas dari percakapan tidak disimpan di folder skill.', ja: '会話のファイルはスキルフォルダーには保存できません。', es: 'Los archivos de una conversación no se guardan en una carpeta de habilidades.', zh: '对话中的文件不会保存到技能文件夹。' },
  saveHeld: { ko: '이 파일은 팀의 안전 검사에 걸려 보류 중이에요.', en: "This file is held by the team's safety check.", id: 'Berkas ini ditahan oleh pemeriksaan keamanan tim.', ja: 'このファイルはチームの安全チェックで保留されています。', es: 'Este archivo está retenido por la comprobación de seguridad del equipo.', zh: '此文件被团队的安全检查暂扣。' },
  saveTooLarge: { ko: '50MB보다 커요. 내려받은 뒤 파일 화면에서 올려 주세요.', en: 'Larger than 50 MB: download it and upload it on the Files screen.', id: 'Lebih besar dari 50 MB: unduh lalu unggah di layar Berkas.', ja: '50 MBを超えています。ダウンロードしてから、ファイル画面でアップロードしてください。', es: 'Supera los 50 MB: descárguelo y súbalo en la pantalla Archivos.', zh: '大于 50 MB：请下载后在“文件”页面上传。' },
  saveBadName: { ko: '이 이름의 파일은 대화에서 저장하지 않아요.', en: 'A file with this name is not saved from a conversation.', id: 'Berkas dengan nama ini tidak disimpan dari percakapan.', ja: 'この名前のファイルは会話から保存できません。', es: 'Un archivo con este nombre no se guarda desde una conversación.', zh: '不会从对话中保存这个名称的文件。' },
} as const satisfies Record<string, T>

export type RouteMessageKey = keyof typeof ROUTE_MESSAGES

/** A route's refusal in the caller's language (English for one we lack), with its {placeholders} filled in. */
export function routeMsg(key: RouteMessageKey, locale: Locale, params: Record<string, string | number> = {}): string {
  const s: string = ROUTE_MESSAGES[key][locale] ?? ROUTE_MESSAGES[key].en
  return s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] === undefined ? all : String(params[k])))
}
