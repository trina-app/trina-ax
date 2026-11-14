// Words the Slack connector says in Slack (docs/SLACK.md), in the asker's language (an unlinked person: the team's),
// and Slack's message text as the question (the answer's way back is rich-text.ts).
import { PRODUCT } from '@mycel/shared'
import { ErrorCode, errorMessage, type Locale } from '@mycel/shared/api'
import { dropDoubleHonorifics } from '@mycel/shared/honorific'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

/** a bot or a person of another workspace: the asker in Slack and the owner proposing them read the same words */
const OUTSIDER = t('이 워크스페이스의 구성원만 {product}를 쓸 수 있어요.', 'Only members of this workspace can use {product}.', 'Hanya anggota workspace ini yang bisa memakai {product}.', "{product}を使えるのはこのワークスペースのメンバーだけです。", "Solo los miembros de este espacio de trabajo pueden usar {product}.", "只有这个工作区的成员才能使用{product}。")

export const TEXT = {
  linkPrompt: t('여기서 {product}에게 물어보려면 먼저 {product} 계정을 연결해 주세요. 이 링크는 10분 동안 한 번만, 나만 쓸 수 있어요.', 'To ask {product} here, first connect your {product} account. The link works once, for 10 minutes, and only for you.', 'Untuk bertanya ke {product} di sini, hubungkan dulu akun {product} Anda. Tautan ini berlaku sekali, selama 10 menit, dan hanya untuk Anda.', "ここで{product}に質問するには、まず{product}アカウントを連携してください。このリンクは10分間・1回だけ、あなただけが使えます。", "Para preguntar a {product} aquí, conecte primero su cuenta de {product}. El enlace funciona una vez, durante 10 minutos, y solo para usted.", "要在这里向{product}提问，请先连接你的{product}账号。这个链接只能用一次，10分钟内有效，并且只对你有效。"),
  linkButton: t('{product} 계정 연결하기', 'Connect {product} account', 'Hubungkan akun {product}', "{product}アカウントを連携", "Conectar cuenta de {product}", "连接{product}账号"),
  linkWait: t('조금 전에 보낸 연결 링크를 써 주세요. 몇 분 뒤에 새 링크를 받을 수 있어요.', 'Use the connect link sent a moment ago. You can get a new one in a few minutes.', 'Gunakan tautan penghubung yang baru saja dikirim. Anda bisa mendapat yang baru beberapa menit lagi.', "先ほど送った連携リンクを使ってください。数分後に新しいリンクを受け取れます。", "Use el enlace de conexión enviado hace un momento. Podrá recibir uno nuevo en unos minutos.", "请使用刚才发送的连接链接。几分钟后可以获取新链接。"),
  outsider: OUTSIDER,
  empty: t('질문을 함께 적어 주세요.', 'Write your question with it.', 'Tulis pertanyaan Anda bersamanya.', "質問も一緒に書いてください。", "Escriba su pregunta junto con la mención.", "请把你的问题一起写上。"),
  working: t('답을 만들고 있어요…', 'Working on it…', 'Sedang dikerjakan…', "回答を作成しています…", "Trabajando en ello…", "正在处理…"),
  busy: t('이 스레드의 앞 질문에 아직 답하고 있어요. 끝난 뒤 다시 물어봐 주세요.', 'I am still answering your earlier question in this thread. Ask again when it is done.', 'Saya masih menjawab pertanyaan Anda sebelumnya di utas ini. Tanyakan lagi setelah selesai.', "このスレッドの前の質問にまだ回答中です。終わってからもう一度質問してください。", "Todavía estoy respondiendo su pregunta anterior en este hilo. Pregunte de nuevo cuando termine.", "我还在回答你在这个话题中的上一个问题。等它完成后再问吧。"),
  queueFull: t('지금 요청이 많아요. 잠시 뒤 다시 물어봐 주세요.', 'There are many requests right now. Ask again in a moment.', 'Sedang banyak permintaan. Tanyakan lagi sebentar lagi.', "現在リクエストが集中しています。しばらくしてからもう一度質問してください。", "Hay muchas solicitudes en este momento. Pregunte de nuevo en un momento.", "现在请求很多。请稍后再问。"),
  cannotStart: t('답을 시작하지 못했어요. {reason}', 'Could not start the answer. {reason}', 'Tidak bisa memulai jawaban. {reason}', "回答を開始できませんでした。{reason}", "No se pudo empezar la respuesta. {reason}", "无法开始回答。{reason}"),
  failed: t('답하지 못했어요. {reason}', 'Could not answer. {reason}', 'Tidak bisa menjawab. {reason}', "回答できませんでした。{reason}", "No se pudo responder. {reason}", "无法回答。{reason}"),
  stopped: t('답이 멈췄어요.', 'The answer was stopped.', 'Jawaban dihentikan.', "回答が停止しました。", "La respuesta se detuvo.", "回答已停止。"),
  more: t('답이 길어서 나머지는 {product}에서 볼 수 있어요.', 'The answer is longer: read the rest in {product}.', 'Jawabannya lebih panjang: baca sisanya di {product}.', "回答が長いため、続きは{product}で確認できます。", "La respuesta es más larga: lea el resto en {product}.", "回答还有更多内容：请在{product}中查看剩余部分。"),
  open: t('{product}에서 열기', 'Open in {product}', 'Buka di {product}', "{product}で開く", "Abrir en {product}", "在{product}中打开"),
  onlyYou: t('나만 보이는 답이에요. 채널에 올리면 이 스레드에 보여요.', 'Only you can see this answer. Post it to show it in this thread.', 'Hanya Anda yang melihat jawaban ini. Kirim ke kanal agar tampil di utas ini.', "この回答はあなただけに表示されています。チャンネルに投稿するとこのスレッドに表示されます。", "Solo usted ve esta respuesta. Publíquela para mostrarla en este hilo.", "只有你能看到这个回答。发布后它会显示在这个话题中。"),
  post: t('채널에 올리기', 'Post to channel', 'Kirim ke kanal', "チャンネルに投稿", "Publicar en el canal", "发布到频道"),
  posted: t('스레드에 올렸어요.', 'Posted to the thread.', 'Dikirim ke utas.', "スレッドに投稿しました。", "Publicada en el hilo.", "已发布到话题。"),
  postedAlready: t('이 답은 이미 올렸어요.', 'This answer was already posted.', 'Jawaban ini sudah dikirim.', "この回答はすでに投稿済みです。", "Esta respuesta ya se publicó.", "这个回答已经发布过了。"),
  postGone: t('이 답은 더 이상 올릴 수 없어요.', 'This answer can no longer be posted.', 'Jawaban ini tidak bisa dikirim lagi.', "この回答はもう投稿できません。", "Esta respuesta ya no se puede publicar.", "这个回答已无法发布。"),
  postFailed: t('채널에 올리지 못했어요. {product}를 이 채널에 초대했는지 확인해 주세요.', 'Could not post to the channel. Check that {product} was invited to this channel.', 'Tidak bisa mengirim ke kanal. Pastikan {product} sudah diundang ke kanal ini.', "チャンネルに投稿できませんでした。{product}がこのチャンネルに招待されているか確認してください。", "No se pudo publicar en el canal. Compruebe que {product} fue invitado a este canal.", "无法发布到频道。请确认{product}已被邀请到这个频道。"),
  askedBy: t('{name}님의 질문', 'Asked by {name}', 'Ditanyakan oleh {name}', "{name}さんの質問", "Pregunta de {name}", "{name}的提问"),
  needsAnswer: t('{product}가 확인할 것이 있어요. {product}에서 답해 주세요.', '{product} needs your answer. Answer it in {product}.', '{product} memerlukan jawaban Anda. Jawab di {product}.', "{product}があなたの確認を待っています。{product}で回答してください。", "{product} necesita su respuesta. Respóndala en {product}.", "{product}需要你的回复。请在{product}中回复。"),
  linked: t('{product} 계정 {name}과(와) 연결했어요. 다시 물어봐 주세요.', 'Linked to the {product} account {name}. Ask again.', 'Tertaut ke akun {product} {name}. Tanyakan lagi.', "{product}アカウント{name}と連携しました。もう一度質問してください。", "Vinculada a la cuenta de {product} {name}. Pregunte de nuevo.", "已关联到{product}账号{name}。请重新提问。"),
  as: t('{name} 계정으로 답해요.', 'Answering as {name}.', 'Menjawab sebagai {name}.', "{name}として回答します。", "Responde como {name}.", "以{name}的身份回答。"),
  tooLong: t('2시간 안에 답이 끝나지 않았어요. 나중에 끝나면 {product}에서 볼 수 있어요.', 'The answer did not finish within 2 hours. If it finishes later, it is in {product}.', 'Jawaban tidak selesai dalam 2 jam. Jika selesai nanti, ada di {product}.', "2時間以内に回答が終わりませんでした。後で終わった場合は{product}で確認できます。", "La respuesta no terminó en 2 horas. Si termina más tarde, estará en {product}.", "回答没有在2小时内完成。如果之后完成了，可以在{product}中查看。"),
  signInFirst: t('먼저 {product}에 로그인해서 비밀번호를 바꿔 주세요. 그다음 다시 물어봐 주세요.', 'First sign in to {product} and change your password, then ask again.', 'Masuk dulu ke {product} dan ganti kata sandi Anda, lalu tanyakan lagi.', "まず{product}にサインインしてパスワードを変更し、それからもう一度質問してください。", "Primero inicie sesión en {product} y cambie su contraseña; después pregunte de nuevo.", "请先登录{product}并修改密码，然后再提问。"),
  mapped: t('이 Slack 계정이 {product} 계정 {name}과(와) 연결됐어요. 연결은 {product}의 설정 › 커넥터에서 끊을 수 있어요.', 'This Slack account is now linked to the {product} account {name}. You can unlink it in Settings › Connectors in {product}.', 'Akun Slack ini kini tertaut ke akun {product} {name}. Anda bisa memutuskannya di Pengaturan › Konektor {product}.', "このSlackアカウントは{product}アカウント{name}と連携しました。連携は{product}の設定 › コネクターで解除できます。", "Esta cuenta de Slack quedó vinculada a la cuenta de {product} {name}. Puede desvincularla en Configuración › Conectores de {product}.", "这个 Slack 账号现在已关联到{product}账号{name}。你可以在{product}的“设置 › 连接器”中取消关联。"),
  sharedChannel: t('다른 회사와 함께 쓰는 채널이라 채널에 올리기는 없어요.', 'This channel is shared with another organization, so the answer cannot be posted to it.', 'Kanal ini dibagi dengan organisasi lain, jadi jawaban tidak bisa dikirim ke sana.', "このチャンネルは他の組織と共有されているため、回答をチャンネルに投稿できません。", "Este canal se comparte con otra organización, así que la respuesta no se puede publicar en él.", "这个频道与其他组织共享，所以回答不能发布到这里。"),
  postCheckFailed: t('Slack에서 이 채널이 다른 회사와 함께 쓰는 채널인지 확인하지 못해서 올리지 않았어요. 잠시 뒤 다시 눌러 주세요.', 'Slack did not say whether this channel is shared with another organization, so nothing was posted. Try again in a moment.', 'Slack tidak memastikan apakah kanal ini dibagi dengan organisasi lain, jadi tidak ada yang dikirim. Coba lagi sebentar lagi.', "このチャンネルが他の組織と共有されているかをSlackで確認できなかったため、投稿しませんでした。しばらくしてからもう一度押してください。", "Slack no confirmó si este canal se comparte con otra organización, así que no se publicó nada. Inténtelo de nuevo en un momento.", "Slack 没有告诉我们这个频道是否与其他组织共享，所以没有发布任何内容。请稍后重试。"),
  emailChangedNotice: t('관리자가 내 계정의 이메일을 바꿨어요. 7일 동안은 이 이메일로 Slack 연결을 확인할 수 없어요.', 'An admin changed the e-mail of your account. For 7 days it cannot be used to confirm a Slack link.', 'Admin mengubah e-mail akun Anda. Selama 7 hari e-mail itu tidak bisa dipakai untuk memastikan tautan Slack.', "管理者があなたのアカウントのメールアドレスを変更しました。7日間はこのメールアドレスでSlack連携を確認できません。", "Un administrador cambió el correo de su cuenta. Durante 7 días no sirve para confirmar un vínculo de Slack.", "管理员更改了你账号的邮箱。7天内不能用它来确认 Slack 关联。"),
  teammate: t('팀원', 'a teammate', 'rekan tim', "チームメンバー", "un compañero", "一位团队成员"),
  notLinked: t('Slack 계정이 더 이상 연결되어 있지 않아요.', 'Your Slack account is no longer connected.', 'Akun Slack Anda tidak lagi terhubung.', "Slackアカウントの連携は解除されています。", "Su cuenta de Slack ya no está conectada.", "你的 Slack 账号已不再连接。"),
  // "Post to channel" for an answer that used places not everyone on the team can see (post-check.ts)
  postCheck: t('이 답에는 팀 사람 모두가 볼 수는 없는 곳의 내용이 들어 있어요: {places}. 그래도 채널에 올릴까요?', 'This answer used places not everyone on the team can see: {places}. Post it to the channel anyway?', 'Jawaban ini memakai isi dari tempat yang tidak bisa dilihat semua orang di tim: {places}. Tetap kirim ke kanal?', "この回答には、チームの全員は見られない場所の内容が含まれています：{places}。それでもチャンネルに投稿しますか？", "Esta respuesta usó lugares que no todo el equipo puede ver: {places}. ¿Publicarla en el canal de todos modos?", "这个回答用到了团队中不是所有人都能看到的地方：{places}。仍要发布到频道吗？"),
  postConfidential: t('보안 작업을 한 대화라 답을 채널에 올릴 수 없어요.', 'This is a confidential conversation, so its answers cannot be posted to the channel.', 'Ini percakapan rahasia, jadi jawabannya tidak bisa dikirim ke kanal.', "機密扱いの会話なので、回答をチャンネルに投稿できません。", "Esta es una conversación confidencial, así que sus respuestas no se pueden publicar en el canal.", "这是机密对话，所以它的回答不能发布到频道。"),
  postHidden: t('이 답이 읽은 대화방의 예전 답 중에 팀 사람 일부에게 가려진 것이 있어 채널에 올릴 수 없어요.', 'This answer cannot be posted: it used an earlier answer in a room that some people on the team cannot see.', 'Jawaban ini tidak bisa dikirim: jawaban ini memakai jawaban sebelumnya di ruang obrolan yang tidak bisa dilihat sebagian orang di tim.', "この回答は投稿できません。チームの一部のメンバーには表示されない、トークルームの以前の回答を使っています。", "Esta respuesta no se puede publicar: usó una respuesta anterior de una sala que algunas personas del equipo no pueden ver.", "这个回答不能发布：它用到了群聊中一个团队里有些人看不到的早先回答。"),
  postAnyway: t('그래도 올리기', 'Post anyway', 'Tetap kirim', "それでも投稿", "Publicar de todos modos", "仍然发布"),
  postCancel: t('올리지 않기', 'Cancel', 'Batal', "投稿しない", "Cancelar", "取消"),
  placeTop: t('팀 폴더', 'the team folder', 'folder tim', "チームフォルダー", "la carpeta del equipo", "团队文件夹"),
  placeMine: t('내 폴더', 'your folder', 'folder Anda', "あなたのフォルダー", "su carpeta", "你的文件夹"),
  placeBrowser: t('앱 안 브라우저', 'the in-app browser', 'browser di dalam aplikasi', "アプリ内ブラウザー", "el navegador de la aplicación", "应用内浏览器"),
  placeConnection: t('내 개인 연결', 'your personal connections', 'koneksi pribadi Anda', "あなたの個人用の連携", "sus conexiones personales", "你的个人连接"),
  placeRoom: t('{name} 대화방', 'the {name} chat room', 'ruang obrolan {name}', "{name} トークルーム", "la sala de chat {name}", "“{name}”群聊"),
  placeEveryone: t('전체 대화방', 'the everyone chat room', 'ruang obrolan Semua', "全員のトークルーム", "la sala de chat Todos", "所有人群聊"),
  placeConversation: t('1:1·그룹 대화', '1:1 and group conversations', 'percakapan 1:1 dan grup', "1:1・グループの会話", "conversaciones 1:1 y de grupo", "私信和群组对话"),
  placeOther: t('그 밖의 자료', 'other material', 'materi lain', "その他の資料", "otro material", "其他资料"),
}
export type TextKey = keyof typeof TEXT

/** Why an answer could not start or failed, as a sentence: a reason code (the chat gone, an error code, a message's
 * status) in plain words; a sentence (a budget's, an engine's error) stays as it is. */
const REASON: Record<string, T> = {
  gone: t('이 채팅이 지워졌어요.', 'The chat was deleted.', 'Obrolan ini sudah dihapus.', "このチャットは削除されました。", "El chat se eliminó.", "对话已被删除。"),
  internal: t('서버에 문제가 생겼어요. 잠시 뒤 다시 물어봐 주세요.', 'Something went wrong on the server. Ask again in a moment.', 'Terjadi masalah di server. Tanyakan lagi sebentar lagi.', "サーバーで問題が発生しました。しばらくしてからもう一度質問してください。", "Algo falló en el servidor. Pregunte de nuevo en un momento.", "服务器出了点问题。请稍后再问。"),
  error: t('답을 만드는 중에 문제가 생겼어요.', 'Something went wrong while answering.', 'Terjadi masalah saat menjawab.', "回答の作成中に問題が発生しました。", "Algo falló al responder.", "回答时出了点问题。"),
}
export function reasonText(reason: string, locale: Locale): string {
  const r = REASON[reason]
  if (r) return r[locale] ?? r.en
  const code = ErrorCode.safeParse(reason)
  if (code.success) return errorMessage(code.data, locale)
  return /^[a-z_]+$/.test(reason) ? REASON.error![locale] ?? REASON.error!.en : reason
}

export function say(key: TextKey, locale: Locale, params: Record<string, string> = {}): string {
  const all: Record<string, string> = { product: PRODUCT.displayName, ...params }
  if (params.reason !== undefined) all.reason = reasonText(params.reason, locale)
  // no second honorific after a name that has one ("{name}님의 질문" with 대표님, shared/src/honorific.ts)
  return dropDoubleHonorifics(TEXT[key][locale] ?? TEXT[key].en, all).replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m)
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Slack's message text as the question: the app's own mention out, the rest of Slack's markup as plain text. */
export function questionText(raw: string, botUserId: string | null): string {
  let s = raw
  if (botUserId) s = s.split(`<@${botUserId}>`).join(' ')
  s = s.replace(/<([^<>]{1,2048})>/g, (_all, inner: string) => {
    const [target, label] = inner.split('|', 2) as [string, string | undefined]
    if (target.startsWith('@')) return label ? `@${label}` : target
    if (target.startsWith('#')) return label ? `#${label}` : target
    if (target.startsWith('!')) { const name = target.slice(1).split('^')[0]!; return label ?? `@${name}` }
    return label && label !== target ? `${label} (${target})` : target
  })
  return decode(s).replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, '')
}

/** Characters Slack reads as markup in mrkdwn and a message's text are written out, so nothing there can mention
 * @channel or a person, or link somewhere other than what it shows. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Text with no markup at all (the notification text of a message, a Slack name): nothing in it mentions or links. */
export const plain = (s: string) => escape(s.replace(/\u0000/g, ''))
/** Cut text to at most `max` characters at a line or word end; `cut` says whether anything was left out. */
export function clip(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false }
  let end = s.lastIndexOf('\n', max)
  if (end < max * 0.6) end = s.lastIndexOf(' ', max)
  if (end < max * 0.6) end = max
  return { text: s.slice(0, end).trimEnd() + ' …', cut: true }
}

/** Why a request of the Slack screens was refused, for the reader (the reason code is in params.reason too) */
export const REFUSAL: Record<string, T> = {
  not_bot_token: t('봇 토큰이 아니에요. Slack 앱 설정 › Install App에서 Bot User OAuth Token을 복사해 주세요.', 'This is not a bot token. Copy the Bot User OAuth Token from Slack app settings › Install App.', 'Ini bukan token bot. Salin Bot User OAuth Token dari Pengaturan aplikasi Slack › Install App.', "ボットトークンではありません。Slackアプリの設定 › Install AppでBot User OAuth Tokenをコピーしてください。", "No es un token de bot. Copie el Bot User OAuth Token en Configuración de la aplicación de Slack › Install App.", "这不是机器人令牌。请从 Slack 应用设置 › Install App 中复制 Bot User OAuth Token。"),
  not_app_token: t('Slack이 이 앱 토큰을 받지 않아요. Slack 앱 설정 › Basic Information › App-Level Tokens에서 connections:write 권한으로 만든 토큰을 복사해 주세요.', 'Slack does not accept this app token. Copy one made with connections:write from Slack app settings › Basic Information › App-Level Tokens.', 'Slack tidak menerima token aplikasi ini. Salin token yang dibuat dengan connections:write dari Pengaturan aplikasi Slack › Basic Information › App-Level Tokens.', "Slackがこのアプリトークンを受け付けません。Slackアプリの設定 › Basic Information › App-Level Tokensでconnections:write権限で作成したトークンをコピーしてください。", "Slack no acepta este token de aplicación. Copie uno creado con connections:write en Configuración de la aplicación de Slack › Basic Information › App-Level Tokens.", "Slack 不接受这个应用令牌。请从 Slack 应用设置 › Basic Information › App-Level Tokens 中复制一个带 connections:write 的令牌。"),
  invalid_auth: t('Slack이 이 토큰을 받지 않아요. Slack 앱 설정 › Install App에서 Bot User OAuth Token을 다시 복사해 주세요.', 'Slack does not accept this token. Copy the Bot User OAuth Token again from Slack app settings › Install App.', 'Slack tidak menerima token ini. Salin lagi Bot User OAuth Token dari Pengaturan aplikasi Slack › Install App.', "Slackがこのトークンを受け付けません。Slackアプリの設定 › Install AppでBot User OAuth Tokenをもう一度コピーしてください。", "Slack no acepta este token. Copie de nuevo el Bot User OAuth Token en Configuración de la aplicación de Slack › Install App.", "Slack 不接受这个令牌。请从 Slack 应用设置 › Install App 中重新复制 Bot User OAuth Token。"),
  token_revoked: t('이 토큰은 취소됐어요. Slack에서 새 토큰을 복사해 주세요.', 'This token was revoked. Copy a new one from Slack.', 'Token ini sudah dicabut. Salin yang baru dari Slack.', "このトークンは取り消されています。Slackから新しいトークンをコピーしてください。", "Este token fue revocado. Copie uno nuevo de Slack.", "这个令牌已被撤销。请从 Slack 复制一个新的。"),
  missing_scope: t('앱에 권한이 빠져 있어요({scopes}). Slack 앱 설정 › OAuth & Permissions에서 추가하고 앱을 다시 설치해 주세요.', 'The app is missing permissions ({scopes}). Add them in Slack app settings › OAuth & Permissions and reinstall the app.', 'Aplikasi kekurangan izin ({scopes}). Tambahkan di Pengaturan aplikasi Slack › OAuth & Permissions lalu pasang ulang aplikasinya.', "アプリに権限が不足しています（{scopes}）。Slackアプリの設定 › OAuth & Permissionsで追加し、アプリを再インストールしてください。", "A la aplicación le faltan permisos ({scopes}). Añádalos en Configuración de la aplicación de Slack › OAuth & Permissions y vuelva a instalarla.", "应用缺少权限（{scopes}）。请在 Slack 应用设置 › OAuth & Permissions 中添加，然后重新安装应用。"),
  enterprise_install: t('조직 전체 설치는 아직 쓸 수 없어요. Slack 앱 설정 › Install App에서 워크스페이스 하나에 설치해 주세요.', 'Organization-wide installs are not supported yet. Install the app in one workspace in Slack app settings › Install App.', 'Pemasangan untuk seluruh organisasi belum didukung. Pasang aplikasi di satu workspace lewat Pengaturan aplikasi Slack › Install App.', "組織全体へのインストールにはまだ対応していません。Slackアプリの設定 › Install Appで1つのワークスペースにインストールしてください。", "Todavía no se admiten instalaciones en toda la organización. Instale la aplicación en un espacio de trabajo en Configuración de la aplicación de Slack › Install App.", "暂不支持整个组织范围的安装。请在 Slack 应用设置 › Install App 中把应用安装到一个工作区。"),
  unreachable: t('Slack에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.', 'Could not reach Slack. Try again in a moment.', 'Tidak bisa menghubungi Slack. Coba lagi sebentar lagi.', "Slackに接続できませんでした。しばらくしてからもう一度お試しください。", "No se pudo conectar con Slack. Inténtelo de nuevo en un momento.", "无法连接 Slack。请稍后重试。"),
  ratelimited: t('Slack이 잠시 요청을 막았어요. 잠시 뒤 다시 해 주세요.', 'Slack is limiting requests right now. Try again in a moment.', 'Slack sedang membatasi permintaan. Coba lagi sebentar lagi.', "Slackが一時的にリクエストを制限しています。しばらくしてからもう一度お試しください。", "Slack está limitando las solicitudes. Inténtelo de nuevo en un momento.", "Slack 现在限制了请求。请稍后重试。"),
  key_unsafe: t('서버의 키 폴더를 쓸 수 없어요. 관리자에게 서버 설정을 확인해 달라고 해 주세요.', 'The server cannot use its key folder. Ask whoever runs the server to check it.', 'Server tidak bisa memakai folder kuncinya. Minta pengelola server memeriksanya.', "サーバーのキーフォルダーを使用できません。サーバーの管理者に確認を依頼してください。", "El servidor no puede usar su carpeta de claves. Pida a quien administra el servidor que la revise.", "服务器无法使用它的密钥文件夹。请让负责服务器的人检查一下。"),
  app_mismatch: t('두 토큰이 서로 다른 Slack 앱의 것이에요. 봇 토큰과 같은 앱의 Basic Information › App-Level Tokens에서 앱 토큰을 복사해 주세요.', 'The two tokens belong to different Slack apps. Copy the app token from Basic Information › App-Level Tokens of the bot token\'s app.', 'Kedua token berasal dari aplikasi Slack yang berbeda. Salin token aplikasi dari Basic Information › App-Level Tokens milik aplikasi token bot.', "2つのトークンが別々のSlackアプリのものです。ボットトークンと同じアプリのBasic Information › App-Level Tokensでアプリトークンをコピーしてください。", "Los dos tokens son de aplicaciones de Slack distintas. Copie el token de aplicación en Basic Information › App-Level Tokens de la aplicación del token de bot.", "这两个令牌属于不同的 Slack 应用。请从机器人令牌所属应用的 Basic Information › App-Level Tokens 中复制应用令牌。"),
  email_mismatch: t('이 Slack 계정의 이메일이 {product} 계정과 달라서 바로 연결할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'The e-mail of this Slack account is not the one of your {product} account, so it cannot be linked directly. Link it with "Sign in with Slack" instead.', 'E-mail akun Slack ini berbeda dari akun {product} Anda, jadi tidak bisa langsung ditautkan. Tautkan dengan "Masuk dengan Slack" saja.', "このSlackアカウントのメールアドレスが{product}アカウントと異なるため、直接は連携できません。「Slackでサインイン」で連携してください。", "El correo de esta cuenta de Slack no es el de su cuenta de {product}, así que no se puede vincular directamente. Vincúlela con «Iniciar sesión con Slack».", "这个 Slack 账号的邮箱与你的{product}账号不一致，所以不能直接关联。请改用“用 Slack 登录”来关联。"),
  email_missing: t('Slack이나 {product} 계정에 이메일이 없어서 이메일로 확인할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'The Slack account or your {product} account has no e-mail, so it cannot be checked by e-mail. Link it with "Sign in with Slack" instead.', 'Akun Slack atau akun {product} Anda tidak punya e-mail, jadi tidak bisa diperiksa lewat e-mail. Tautkan dengan "Masuk dengan Slack" saja.', "Slackアカウントまたは{product}アカウントにメールアドレスがないため、メールで確認できません。「Slackでサインイン」で連携してください。", "La cuenta de Slack o su cuenta de {product} no tiene correo, así que no se puede comprobar por correo. Vincúlela con «Iniciar sesión con Slack».", "Slack 账号或你的{product}账号没有邮箱，所以无法通过邮箱核对。请改用“用 Slack 登录”来关联。"),
  email_recent: t('최근 7일 안에 다른 사람이 내 계정의 이메일을 바꿔서 이메일로 확인할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'Someone else changed the e-mail of your account in the last 7 days, so it cannot be checked by e-mail. Link it with "Sign in with Slack" instead.', 'Orang lain mengubah e-mail akun Anda dalam 7 hari terakhir, jadi tidak bisa diperiksa lewat e-mail. Tautkan dengan "Masuk dengan Slack" saja.', "過去7日以内に他の人があなたのアカウントのメールアドレスを変更したため、メールで確認できません。「Slackでサインイン」で連携してください。", "Otra persona cambió el correo de su cuenta en los últimos 7 días, así que no se puede comprobar por correo. Vincúlela con «Iniciar sesión con Slack».", "最近7天内有其他人更改了你账号的邮箱，所以无法通过邮箱核对。请改用“用 Slack 登录”来关联。"),
  outsider: OUTSIDER,
  not_client_id: t('Client ID가 아니에요. Slack 앱 설정 › Basic Information › App Credentials에서 Client ID를 복사해 주세요.', 'This is not a Client ID. Copy the Client ID from Basic Information › App Credentials in the Slack app\'s settings.', 'Ini bukan Client ID. Salin Client ID dari Basic Information › App Credentials di pengaturan aplikasi Slack.', "Client IDではありません。Slackアプリ設定 › Basic Information › App CredentialsからClient IDをコピーしてください。", "No es un Client ID. Copie el Client ID de Basic Information › App Credentials en la configuración de la aplicación de Slack.", "这不是 Client ID。请从 Slack 应用设置的 Basic Information › App Credentials 中复制 Client ID。"),
  not_client_secret: t('Client Secret이 아니에요. Slack 앱 설정 › Basic Information › App Credentials에서 Client Secret을 복사해 주세요.', 'This is not a Client Secret. Copy the Client Secret from Basic Information › App Credentials in the Slack app\'s settings.', 'Ini bukan Client Secret. Salin Client Secret dari Basic Information › App Credentials di pengaturan aplikasi Slack.', "Client Secretではありません。Slackアプリ設定 › Basic Information › App CredentialsからClient Secretをコピーしてください。", "No es un Client Secret. Copie el Client Secret de Basic Information › App Credentials en la configuración de la aplicación de Slack.", "这不是 Client Secret。请从 Slack 应用设置的 Basic Information › App Credentials 中复制 Client Secret。"),
  signin_off: t('지금은 Slack으로 로그인해서 연결할 수 없어요. 팀장에게 관리자 › 연결한 서비스 › Slack 설정을 확인해 달라고 하세요.', '"Sign in with Slack" cannot be used now. Ask your team owner to check Admin › Connected apps › Slack.', '"Masuk dengan Slack" tidak bisa dipakai sekarang. Minta pemilik tim memeriksa Admin › Aplikasi terhubung › Slack.', "現在「Slackでサインイン」は使えません。チームのオーナーに管理 › 連携サービス › Slackの設定を確認してもらってください。", "Ahora no se puede usar «Iniciar sesión con Slack». Pida al propietario del equipo que revise Administración › Apps conectadas › Slack.", "现在无法使用“用 Slack 登录”。请让团队所有者检查“管理 › 已连接的应用 › Slack”。"),
  https_needed: t('Slack으로 로그인하려면 팀의 https 주소가 필요해요.', '"Sign in with Slack" needs the team\'s https address.', '"Masuk dengan Slack" memerlukan alamat https tim.', "「Slackでサインイン」にはチームのhttpsアドレスが必要です。", "«Iniciar sesión con Slack» necesita la dirección https del equipo.", "“用 Slack 登录”需要团队的 https 地址。"),
  no_tokens: t('먼저 두 토큰을 저장해 주세요.', 'Save both tokens first.', 'Simpan kedua token terlebih dahulu.', "先に2つのトークンを保存してください。", "Guarde primero los dos tokens.", "请先保存两个令牌。"),
  link_expired: t('이 링크는 쓸 수 없어요(이미 썼거나 10분이 지났어요). Slack에서 다시 물어보면 새 링크를 받을 수 있어요.', 'This link cannot be used (it was used, or 10 minutes passed). Ask again in Slack to get a new one.', 'Tautan ini tidak bisa dipakai (sudah dipakai, atau lewat 10 menit). Tanyakan lagi di Slack untuk mendapat yang baru.', "このリンクは使用できません（使用済み、または10分が経過しました）。Slackでもう一度質問すると新しいリンクを受け取れます。", "Este enlace no se puede usar (ya se usó o pasaron 10 minutos). Pregunte de nuevo en Slack para recibir uno nuevo.", "这个链接无法使用（已经用过，或已超过10分钟）。请在 Slack 中重新提问以获取新链接。"),
  linked_elsewhere: t('이 계정은 이미 다른 Slack 계정과 연결되어 있어요. {product}의 설정 › 커넥터에서 먼저 연결을 끊어 주세요.', 'This account is already linked to another Slack account. Unlink it in Settings › Connectors in {product} first.', 'Akun ini sudah tertaut ke akun Slack lain. Putuskan dulu di Pengaturan › Konektor {product}.', "このアカウントはすでに別のSlackアカウントと連携しています。先に{product}の設定 › コネクターで連携を解除してください。", "Esta cuenta ya está vinculada a otra cuenta de Slack. Desvincúlela primero en Configuración › Conectores de {product}.", "这个账号已关联到另一个 Slack 账号。请先在{product}的“设置 › 连接器”中取消关联。"),
  official_off: t('지금은 Slack에 추가할 수 없어요. 호스팅 서비스가 이 서버에 Slack 앱을 제공하지 않아요.', 'Add to Slack cannot be used here now: the hosting service does not serve this server.', '"Tambahkan ke Slack" tidak bisa dipakai di sini sekarang: layanan hosting tidak melayani server ini.', "現在ここでは「Slackに追加」を使えません。ホスティングサービスがこのサーバーにSlackアプリを提供していません。", "Ahora no se puede usar «Añadir a Slack» aquí: el servicio de alojamiento no atiende a este servidor.", "这里现在无法使用“添加到 Slack”：托管服务不为这台服务器提供服务。"),
  owner_only: t('이 Slack 앱은 팀장만 바꾸거나 뺄 수 있어요.', 'Only the team owner can change or remove this Slack app.', 'Hanya pemilik tim yang bisa mengubah atau menghapus aplikasi Slack ini.', "このSlackアプリを変更・削除できるのはチームのオーナーだけです。", "Solo el propietario del equipo puede cambiar o quitar esta aplicación de Slack.", "只有团队所有者可以更改或删除这个 Slack 应用。"),
  own_app_saved: t('직접 만든 Slack 앱이 연결돼 있어요. 먼저 그 앱을 빼 주세요.', 'Your own Slack app is set up here. Remove it first.', 'Aplikasi Slack milik tim sudah terpasang di sini. Hapus dulu.', "独自のSlackアプリが設定されています。先に削除してください。", "Aquí ya está configurada su propia aplicación de Slack. Quítela primero.", "这里已设置了你们自己的 Slack 应用。请先删除它。"),
  official_saved: t('{product} 앱이 Slack에 추가돼 있어요. 직접 만든 앱의 토큰을 넣으려면 먼저 Slack 연결을 빼 주세요.', 'The {product} app is added to Slack here. Remove it first to use the tokens of your own app.', 'Aplikasi {product} sudah ditambahkan ke Slack di sini. Hapus dulu untuk memakai token aplikasi sendiri.', "ここでは{product}アプリがSlackに追加されています。独自アプリのトークンを使うには、先に削除してください。", "Aquí la aplicación {product} ya está añadida a Slack. Quítela primero para usar los tokens de su propia aplicación.", "这里已把{product}应用添加到 Slack。要使用你们自己应用的令牌，请先删除它。"),
  broker_unreachable: t('지금 호스팅 서비스에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.', 'Could not reach the hosting service. Try again in a moment.', 'Tidak bisa menghubungi layanan hosting. Coba lagi sebentar lagi.', "ホスティングサービスに接続できませんでした。しばらくしてからもう一度お試しください。", "No se pudo contactar con el servicio de alojamiento. Inténtelo de nuevo en un momento.", "无法连接托管服务。请稍后重试。"),
  slack_taken: t('이 Slack 계정은 이미 다른 사람의 계정과 연결되어 있어요. 그 사람이 먼저 연결을 끊어야 해요.', 'This Slack account is already linked to someone else\'s account. That person has to unlink it first.', 'Akun Slack ini sudah tertaut ke akun orang lain. Orang itu harus memutuskannya dulu.', "このSlackアカウントはすでに別の人のアカウントと連携しています。先にその人が連携を解除する必要があります。", "Esta cuenta de Slack ya está vinculada a la cuenta de otra persona. Esa persona debe desvincularla primero.", "这个 Slack 账号已关联到其他人的账号。需要那个人先取消关联。"),
}

export function refusal(reason: string, locale: Locale, params: Record<string, string> = {}): string | undefined {
  const r = REFUSAL[reason]
  const all: Record<string, string> = { product: PRODUCT.displayName, ...params }
  return r ? dropDoubleHonorifics(r[locale] ?? r.en, all).replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m) : undefined
}
