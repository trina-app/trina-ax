// Words the Slack connector says in Slack (docs/SLACK.md), in the asker's language (an unlinked person: the team's),
// and the two text conversions: Slack's message text to the question, the AI's Markdown answer to Slack's mrkdwn.
import { PRODUCT } from '@mycel/shared'
import { ErrorCode, errorMessage, type Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

/** a bot or a person of another workspace: the asker in Slack and the owner proposing them read the same words */
const OUTSIDER = t('이 워크스페이스의 구성원만 {product}를 쓸 수 있어요.', 'Only members of this workspace can use {product}.', 'Hanya anggota workspace ini yang bisa memakai {product}.', "{product}を使えるのはこのワークスペースのメンバーだけです。", "Solo los miembros de este espacio de trabajo pueden usar {product}.")

export const TEXT = {
  linkPrompt: t('여기서 {product}에게 물어보려면 먼저 {product} 계정을 연결해 주세요. 이 링크는 10분 동안 한 번만, 나만 쓸 수 있어요.', 'To ask {product} here, first connect your {product} account. The link works once, for 10 minutes, and only for you.', 'Untuk bertanya ke {product} di sini, hubungkan dulu akun {product} Anda. Tautan ini berlaku sekali, selama 10 menit, dan hanya untuk Anda.', "ここで{product}に質問するには、まず{product}アカウントを連携してください。このリンクは10分間・1回だけ、あなただけが使えます。", "Para preguntar a {product} aquí, conecte primero su cuenta de {product}. El enlace funciona una vez, durante 10 minutos, y solo para usted."),
  linkButton: t('{product} 계정 연결하기', 'Connect {product} account', 'Hubungkan akun {product}', "{product}アカウントを連携", "Conectar cuenta de {product}"),
  linkWait: t('조금 전에 보낸 연결 링크를 써 주세요. 몇 분 뒤에 새 링크를 받을 수 있어요.', 'Use the connect link sent a moment ago. You can get a new one in a few minutes.', 'Gunakan tautan penghubung yang baru saja dikirim. Anda bisa mendapat yang baru beberapa menit lagi.', "先ほど送った連携リンクを使ってください。数分後に新しいリンクを受け取れます。", "Use el enlace de conexión enviado hace un momento. Podrá recibir uno nuevo en unos minutos."),
  outsider: OUTSIDER,
  empty: t('질문을 함께 적어 주세요.', 'Write your question with it.', 'Tulis pertanyaan Anda bersamanya.', "質問も一緒に書いてください。", "Escriba su pregunta junto con la mención."),
  working: t('답을 만들고 있어요…', 'Working on it…', 'Sedang dikerjakan…', "回答を作成しています…", "Trabajando en ello…"),
  busy: t('이 스레드의 앞 질문에 아직 답하고 있어요. 끝난 뒤 다시 물어봐 주세요.', 'I am still answering your earlier question in this thread. Ask again when it is done.', 'Saya masih menjawab pertanyaan Anda sebelumnya di utas ini. Tanyakan lagi setelah selesai.', "このスレッドの前の質問にまだ回答中です。終わってからもう一度質問してください。", "Todavía estoy respondiendo su pregunta anterior en este hilo. Pregunte de nuevo cuando termine."),
  queueFull: t('지금 요청이 많아요. 잠시 뒤 다시 물어봐 주세요.', 'There are many requests right now. Ask again in a moment.', 'Sedang banyak permintaan. Tanyakan lagi sebentar lagi.', "現在リクエストが集中しています。しばらくしてからもう一度質問してください。", "Hay muchas solicitudes en este momento. Pregunte de nuevo en un momento."),
  cannotStart: t('답을 시작하지 못했어요. {reason}', 'Could not start the answer. {reason}', 'Tidak bisa memulai jawaban. {reason}', "回答を開始できませんでした。{reason}", "No se pudo empezar la respuesta. {reason}"),
  failed: t('답하지 못했어요. {reason}', 'Could not answer. {reason}', 'Tidak bisa menjawab. {reason}', "回答できませんでした。{reason}", "No se pudo responder. {reason}"),
  stopped: t('답이 멈췄어요.', 'The answer was stopped.', 'Jawaban dihentikan.', "回答が停止しました。", "La respuesta se detuvo."),
  more: t('답이 길어서 나머지는 {product}에서 볼 수 있어요.', 'The answer is longer: read the rest in {product}.', 'Jawabannya lebih panjang: baca sisanya di {product}.', "回答が長いため、続きは{product}で確認できます。", "La respuesta es más larga: lea el resto en {product}."),
  open: t('{product}에서 열기', 'Open in {product}', 'Buka di {product}', "{product}で開く", "Abrir en {product}"),
  onlyYou: t('나만 보이는 답이에요. 채널에 올리면 이 스레드에 보여요.', 'Only you can see this answer. Post it to show it in this thread.', 'Hanya Anda yang melihat jawaban ini. Kirim ke kanal agar tampil di utas ini.', "この回答はあなただけに表示されています。チャンネルに投稿するとこのスレッドに表示されます。", "Solo usted ve esta respuesta. Publíquela para mostrarla en este hilo."),
  post: t('채널에 올리기', 'Post to channel', 'Kirim ke kanal', "チャンネルに投稿", "Publicar en el canal"),
  posted: t('스레드에 올렸어요.', 'Posted to the thread.', 'Dikirim ke utas.', "スレッドに投稿しました。", "Publicada en el hilo."),
  postedAlready: t('이 답은 이미 올렸어요.', 'This answer was already posted.', 'Jawaban ini sudah dikirim.', "この回答はすでに投稿済みです。", "Esta respuesta ya se publicó."),
  postGone: t('이 답은 더 이상 올릴 수 없어요.', 'This answer can no longer be posted.', 'Jawaban ini tidak bisa dikirim lagi.', "この回答はもう投稿できません。", "Esta respuesta ya no se puede publicar."),
  postFailed: t('채널에 올리지 못했어요. {product}를 이 채널에 초대했는지 확인해 주세요.', 'Could not post to the channel. Check that {product} was invited to this channel.', 'Tidak bisa mengirim ke kanal. Pastikan {product} sudah diundang ke kanal ini.', "チャンネルに投稿できませんでした。{product}がこのチャンネルに招待されているか確認してください。", "No se pudo publicar en el canal. Compruebe que {product} fue invitado a este canal."),
  askedBy: t('{name}님의 질문', 'Asked by {name}', 'Ditanyakan oleh {name}', "{name}さんの質問", "Pregunta de {name}"),
  needsAnswer: t('{product}가 확인할 것이 있어요. {product}에서 답해 주세요.', '{product} needs your answer. Answer it in {product}.', '{product} memerlukan jawaban Anda. Jawab di {product}.', "{product}があなたの確認を待っています。{product}で回答してください。", "{product} necesita su respuesta. Respóndala en {product}."),
  linked: t('{product} 계정 {name}과(와) 연결했어요. 다시 물어봐 주세요.', 'Linked to the {product} account {name}. Ask again.', 'Tertaut ke akun {product} {name}. Tanyakan lagi.', "{product}アカウント{name}と連携しました。もう一度質問してください。", "Vinculada a la cuenta de {product} {name}. Pregunte de nuevo."),
  as: t('{name} 계정으로 답해요.', 'Answering as {name}.', 'Menjawab sebagai {name}.', "{name}として回答します。", "Responde como {name}."),
  tooLong: t('2시간 안에 답이 끝나지 않았어요. 나중에 끝나면 {product}에서 볼 수 있어요.', 'The answer did not finish within 2 hours. If it finishes later, it is in {product}.', 'Jawaban tidak selesai dalam 2 jam. Jika selesai nanti, ada di {product}.', "2時間以内に回答が終わりませんでした。後で終わった場合は{product}で確認できます。", "La respuesta no terminó en 2 horas. Si termina más tarde, estará en {product}."),
  signInFirst: t('먼저 {product}에 로그인해서 비밀번호를 바꿔 주세요. 그다음 다시 물어봐 주세요.', 'First sign in to {product} and change your password, then ask again.', 'Masuk dulu ke {product} dan ganti kata sandi Anda, lalu tanyakan lagi.', "まず{product}にサインインしてパスワードを変更し、それからもう一度質問してください。", "Primero inicie sesión en {product} y cambie su contraseña; después pregunte de nuevo."),
  mapped: t('이 Slack 계정이 {product} 계정 {name}과(와) 연결됐어요. 연결은 {product} 설정 › 앱 커넥터에서 끊을 수 있어요.', 'This Slack account is now linked to the {product} account {name}. You can unlink it in {product} Settings › App connectors.', 'Akun Slack ini kini tertaut ke akun {product} {name}. Anda bisa memutuskannya di Pengaturan {product} › Konektor aplikasi.', "このSlackアカウントは{product}アカウント{name}と連携しました。連携は{product}の設定 › アプリコネクタで解除できます。", "Esta cuenta de Slack quedó vinculada a la cuenta de {product} {name}. Puede desvincularla en Configuración de {product} › Conectores de aplicaciones."),
  sharedChannel: t('다른 회사와 함께 쓰는 채널이라 채널에 올리기는 없어요.', 'This channel is shared with another organization, so the answer cannot be posted to it.', 'Kanal ini dibagi dengan organisasi lain, jadi jawaban tidak bisa dikirim ke sana.', "このチャンネルは他の組織と共有されているため、回答をチャンネルに投稿できません。", "Este canal se comparte con otra organización, así que la respuesta no se puede publicar en él."),
  postCheckFailed: t('Slack에서 이 채널이 다른 회사와 함께 쓰는 채널인지 확인하지 못해서 올리지 않았어요. 잠시 뒤 다시 눌러 주세요.', 'Slack did not say whether this channel is shared with another organization, so nothing was posted. Try again in a moment.', 'Slack tidak memastikan apakah kanal ini dibagi dengan organisasi lain, jadi tidak ada yang dikirim. Coba lagi sebentar lagi.', "このチャンネルが他の組織と共有されているかをSlackで確認できなかったため、投稿しませんでした。しばらくしてからもう一度押してください。", "Slack no confirmó si este canal se comparte con otra organización, así que no se publicó nada. Inténtelo de nuevo en un momento."),
  emailChangedNotice: t('관리자가 내 계정의 이메일을 바꿨어요. 7일 동안은 이 이메일로 Slack 연결을 확인할 수 없어요.', 'An admin changed the e-mail of your account. For 7 days it cannot be used to confirm a Slack link.', 'Admin mengubah e-mail akun Anda. Selama 7 hari e-mail itu tidak bisa dipakai untuk memastikan tautan Slack.', "管理者があなたのアカウントのメールアドレスを変更しました。7日間はこのメールアドレスでSlack連携を確認できません。", "Un administrador cambió el correo de su cuenta. Durante 7 días no sirve para confirmar un vínculo de Slack."),
  teammate: t('팀원', 'a teammate', 'rekan tim', "チームメンバー", "un compañero"),
  notLinked: t('Slack 계정이 더 이상 연결되어 있지 않아요.', 'Your Slack account is no longer connected.', 'Akun Slack Anda tidak lagi terhubung.', "Slackアカウントの連携は解除されています。", "Su cuenta de Slack ya no está conectada."),
}
export type TextKey = keyof typeof TEXT

/** Why an answer could not start or failed, as a sentence: a reason code (the chat gone, an error code, a message's
 * status) in plain words; a sentence (a budget's, an engine's error) stays as it is. */
const REASON: Record<string, T> = {
  gone: t('이 채팅이 지워졌어요.', 'The chat was deleted.', 'Obrolan ini sudah dihapus.', "このチャットは削除されました。", "El chat se eliminó."),
  internal: t('서버에 문제가 생겼어요. 잠시 뒤 다시 물어봐 주세요.', 'Something went wrong on the server. Ask again in a moment.', 'Terjadi masalah di server. Tanyakan lagi sebentar lagi.', "サーバーで問題が発生しました。しばらくしてからもう一度質問してください。", "Algo falló en el servidor. Pregunte de nuevo en un momento."),
  error: t('답을 만드는 중에 문제가 생겼어요.', 'Something went wrong while answering.', 'Terjadi masalah saat menjawab.', "回答の作成中に問題が発生しました。", "Algo falló al responder."),
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
  return (TEXT[key][locale] ?? TEXT[key].en).replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m)
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

/** Characters Slack reads as markup are written out, so an answer can never mention @channel or a person, or link
 * somewhere other than what it shows. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Text with no markup at all (the notification text of a message, a Slack name): nothing in it mentions or links. */
export const plain = (s: string) => escape(s.replace(/\u0000/g, ''))
/** a link's text that reads like an address: shown next to the real address instead of hiding it */
const looksLikeAddress = (s: string) => /:\/\/|^www\.|[a-z0-9-]\.[a-z]{2,}(\/|$|\s)/i.test(s.trim())

/** The AI's Markdown answer in Slack's mrkdwn (https://docs.slack.dev/messaging/formatting-message-text). */
export function toMrkdwn(md: string): string {
  md = md.replace(/\u0000/g, '')
  const out: string[] = []
  // code blocks stay as they are (without the language after ```), everything else is converted
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g)
  for (const part of parts) {
    if (part.startsWith('```')) { out.push('```\n' + escape(part.replace(/^```[^\n]*\n/, '').replace(/```$/, '')) + '```'); continue }
    const lines = part.split('\n').map((line) => {
      const codes: string[] = []
      let l = line.replace(/`([^`\n]+)`/g, (_m, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000` })
      l = escape(l)
      l = l.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/, (_m, h: string) => `*${h.replace(/\*\*/g, '')}*`)
      l = l.replace(/^(\s*)[-*+]\s+/, '$1• ')
      l = l.replace(/\[([^\]\n]{1,500})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, text: string, url: string) => {
        const u = url.replace(/\|/g, '%7C')
        return looksLikeAddress(text) && text.trim() !== url ? `${text} (<${u}>)` : `<${u}|${text.replace(/\|/g, '/')}>`
      })
      l = l.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*').replace(/__(?=\S)([^_\n]+?)__/g, '*$1*').replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~')
      return l.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => '`' + escape(codes[Number(i)]!) + '`')
    })
    out.push(lines.join('\n'))
  }
  return out.join('')
}

/** Cut text to at most `max` characters at a line or word end; `cut` says whether anything was left out. */
export function clip(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false }
  let end = s.lastIndexOf('\n', max)
  if (end < max * 0.6) end = s.lastIndexOf(' ', max)
  if (end < max * 0.6) end = max
  return { text: s.slice(0, end).trimEnd() + ' …', cut: true }
}

/** mrkdwn in sections of at most 2,900 characters (Slack allows 3,000 per text), at most `max` of them; `cut`: something
 * was left out */
export function sections(mrkdwn: string, max: number): { blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[]; cut: boolean } {
  const blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[] = []
  let rest = mrkdwn
  while (rest.length && blocks.length < max) {
    const piece = clip(rest, 2900)
    // the last section allowed: what does not fit is left out (marked " …" by clip)
    if (!piece.cut || blocks.length === max - 1) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: piece.text || ' ' } }); return { blocks, cut: piece.cut } }
    const chunk = piece.text.slice(0, -2) // without clip's " …": the next section goes on
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk || ' ' } })
    rest = rest.slice(chunk.length).replace(/^\s+/, '')
  }
  return { blocks, cut: rest.length > 0 }
}

/** Why a request of the Slack screens was refused, for the reader (the reason code is in params.reason too) */
export const REFUSAL: Record<string, T> = {
  not_bot_token: t('봇 토큰이 아니에요. Slack 앱 설정 › Install App에서 Bot User OAuth Token을 복사해 주세요.', 'This is not a bot token. Copy the Bot User OAuth Token from Slack app settings › Install App.', 'Ini bukan token bot. Salin Bot User OAuth Token dari Pengaturan aplikasi Slack › Install App.', "ボットトークンではありません。Slackアプリの設定 › Install AppでBot User OAuth Tokenをコピーしてください。", "No es un token de bot. Copie el Bot User OAuth Token en Configuración de la aplicación de Slack › Install App."),
  not_app_token: t('Slack이 이 앱 토큰을 받지 않아요. Slack 앱 설정 › Basic Information › App-Level Tokens에서 connections:write 권한으로 만든 토큰을 복사해 주세요.', 'Slack does not accept this app token. Copy one made with connections:write from Slack app settings › Basic Information › App-Level Tokens.', 'Slack tidak menerima token aplikasi ini. Salin token yang dibuat dengan connections:write dari Pengaturan aplikasi Slack › Basic Information › App-Level Tokens.', "Slackがこのアプリトークンを受け付けません。Slackアプリの設定 › Basic Information › App-Level Tokensでconnections:write権限で作成したトークンをコピーしてください。", "Slack no acepta este token de aplicación. Copie uno creado con connections:write en Configuración de la aplicación de Slack › Basic Information › App-Level Tokens."),
  invalid_auth: t('Slack이 이 토큰을 받지 않아요. Slack 앱 설정 › Install App에서 Bot User OAuth Token을 다시 복사해 주세요.', 'Slack does not accept this token. Copy the Bot User OAuth Token again from Slack app settings › Install App.', 'Slack tidak menerima token ini. Salin lagi Bot User OAuth Token dari Pengaturan aplikasi Slack › Install App.', "Slackがこのトークンを受け付けません。Slackアプリの設定 › Install AppでBot User OAuth Tokenをもう一度コピーしてください。", "Slack no acepta este token. Copie de nuevo el Bot User OAuth Token en Configuración de la aplicación de Slack › Install App."),
  token_revoked: t('이 토큰은 취소됐어요. Slack에서 새 토큰을 복사해 주세요.', 'This token was revoked. Copy a new one from Slack.', 'Token ini sudah dicabut. Salin yang baru dari Slack.', "このトークンは取り消されています。Slackから新しいトークンをコピーしてください。", "Este token fue revocado. Copie uno nuevo de Slack."),
  missing_scope: t('앱에 권한이 빠져 있어요({scopes}). Slack 앱 설정 › OAuth & Permissions에서 추가하고 앱을 다시 설치해 주세요.', 'The app is missing permissions ({scopes}). Add them in Slack app settings › OAuth & Permissions and reinstall the app.', 'Aplikasi kekurangan izin ({scopes}). Tambahkan di Pengaturan aplikasi Slack › OAuth & Permissions lalu pasang ulang aplikasinya.', "アプリに権限が不足しています（{scopes}）。Slackアプリの設定 › OAuth & Permissionsで追加し、アプリを再インストールしてください。", "A la aplicación le faltan permisos ({scopes}). Añádalos en Configuración de la aplicación de Slack › OAuth & Permissions y vuelva a instalarla."),
  enterprise_install: t('조직 전체 설치는 아직 쓸 수 없어요. Slack 앱 설정 › Install App에서 워크스페이스 하나에 설치해 주세요.', 'Organization-wide installs are not supported yet. Install the app in one workspace in Slack app settings › Install App.', 'Pemasangan untuk seluruh organisasi belum didukung. Pasang aplikasi di satu workspace lewat Pengaturan aplikasi Slack › Install App.', "組織全体へのインストールにはまだ対応していません。Slackアプリの設定 › Install Appで1つのワークスペースにインストールしてください。", "Todavía no se admiten instalaciones en toda la organización. Instale la aplicación en un espacio de trabajo en Configuración de la aplicación de Slack › Install App."),
  unreachable: t('Slack에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.', 'Could not reach Slack. Try again in a moment.', 'Tidak bisa menghubungi Slack. Coba lagi sebentar lagi.', "Slackに接続できませんでした。しばらくしてからもう一度お試しください。", "No se pudo conectar con Slack. Inténtelo de nuevo en un momento."),
  ratelimited: t('Slack이 잠시 요청을 막았어요. 잠시 뒤 다시 해 주세요.', 'Slack is limiting requests right now. Try again in a moment.', 'Slack sedang membatasi permintaan. Coba lagi sebentar lagi.', "Slackが一時的にリクエストを制限しています。しばらくしてからもう一度お試しください。", "Slack está limitando las solicitudes. Inténtelo de nuevo en un momento."),
  key_unsafe: t('서버의 키 폴더를 쓸 수 없어요. 관리자에게 서버 설정을 확인해 달라고 해 주세요.', 'The server cannot use its key folder. Ask whoever runs the server to check it.', 'Server tidak bisa memakai folder kuncinya. Minta pengelola server memeriksanya.', "サーバーのキーフォルダーを使用できません。サーバーの管理者に確認を依頼してください。", "El servidor no puede usar su carpeta de claves. Pida a quien administra el servidor que la revise."),
  app_mismatch: t('두 토큰이 서로 다른 Slack 앱의 것이에요. 봇 토큰과 같은 앱의 Basic Information › App-Level Tokens에서 앱 토큰을 복사해 주세요.', 'The two tokens belong to different Slack apps. Copy the app token from Basic Information › App-Level Tokens of the bot token\'s app.', 'Kedua token berasal dari aplikasi Slack yang berbeda. Salin token aplikasi dari Basic Information › App-Level Tokens milik aplikasi token bot.', "2つのトークンが別々のSlackアプリのものです。ボットトークンと同じアプリのBasic Information › App-Level Tokensでアプリトークンをコピーしてください。", "Los dos tokens son de aplicaciones de Slack distintas. Copie el token de aplicación en Basic Information › App-Level Tokens de la aplicación del token de bot."),
  email_mismatch: t('이 Slack 계정의 이메일이 {product} 계정과 달라서 바로 연결할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'The e-mail of this Slack account is not the one of your {product} account, so it cannot be linked directly. Link it with "Sign in with Slack" instead.', 'E-mail akun Slack ini berbeda dari akun {product} Anda, jadi tidak bisa langsung ditautkan. Tautkan dengan "Masuk dengan Slack" saja.', "このSlackアカウントのメールアドレスが{product}アカウントと異なるため、直接は連携できません。「Slackでサインイン」で連携してください。", "El correo de esta cuenta de Slack no es el de su cuenta de {product}, así que no se puede vincular directamente. Vincúlela con «Iniciar sesión con Slack»."),
  email_missing: t('Slack이나 {product} 계정에 이메일이 없어서 이메일로 확인할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'The Slack account or your {product} account has no e-mail, so it cannot be checked by e-mail. Link it with "Sign in with Slack" instead.', 'Akun Slack atau akun {product} Anda tidak punya e-mail, jadi tidak bisa diperiksa lewat e-mail. Tautkan dengan "Masuk dengan Slack" saja.', "Slackアカウントまたは{product}アカウントにメールアドレスがないため、メールで確認できません。「Slackでサインイン」で連携してください。", "La cuenta de Slack o su cuenta de {product} no tiene correo, así que no se puede comprobar por correo. Vincúlela con «Iniciar sesión con Slack»."),
  email_recent: t('최근 7일 안에 다른 사람이 내 계정의 이메일을 바꿔서 이메일로 확인할 수 없어요. Slack으로 로그인해서 연결해 주세요.', 'Someone else changed the e-mail of your account in the last 7 days, so it cannot be checked by e-mail. Link it with "Sign in with Slack" instead.', 'Orang lain mengubah e-mail akun Anda dalam 7 hari terakhir, jadi tidak bisa diperiksa lewat e-mail. Tautkan dengan "Masuk dengan Slack" saja.', "過去7日以内に他の人があなたのアカウントのメールアドレスを変更したため、メールで確認できません。「Slackでサインイン」で連携してください。", "Otra persona cambió el correo de su cuenta en los últimos 7 días, así que no se puede comprobar por correo. Vincúlela con «Iniciar sesión con Slack»."),
  outsider: OUTSIDER,
  not_client_id: t('Client ID가 아니에요. Slack 앱 설정 › Basic Information › App Credentials에서 Client ID를 복사해 주세요.', 'This is not a Client ID. Copy the Client ID from Basic Information › App Credentials in the Slack app\'s settings.', 'Ini bukan Client ID. Salin Client ID dari Basic Information › App Credentials di pengaturan aplikasi Slack.', "Client IDではありません。Slackアプリ設定 › Basic Information › App CredentialsからClient IDをコピーしてください。", "No es un Client ID. Copie el Client ID de Basic Information › App Credentials en la configuración de la aplicación de Slack."),
  not_client_secret: t('Client Secret이 아니에요. Slack 앱 설정 › Basic Information › App Credentials에서 Client Secret을 복사해 주세요.', 'This is not a Client Secret. Copy the Client Secret from Basic Information › App Credentials in the Slack app\'s settings.', 'Ini bukan Client Secret. Salin Client Secret dari Basic Information › App Credentials di pengaturan aplikasi Slack.', "Client Secretではありません。Slackアプリ設定 › Basic Information › App CredentialsからClient Secretをコピーしてください。", "No es un Client Secret. Copie el Client Secret de Basic Information › App Credentials en la configuración de la aplicación de Slack."),
  signin_off: t('지금은 Slack으로 로그인해서 연결할 수 없어요. 팀장에게 관리자 › Slack 설정을 확인해 달라고 하세요.', '"Sign in with Slack" cannot be used now. Ask your team owner to check Admin › Slack.', '"Masuk dengan Slack" tidak bisa dipakai sekarang. Minta pemilik tim memeriksa Admin › Slack.', "現在「Slackでサインイン」は使えません。チームのオーナーに管理 › Slackの設定を確認してもらってください。", "Ahora no se puede usar «Iniciar sesión con Slack». Pida al propietario del equipo que revise Administración › Slack."),
  https_needed: t('Slack으로 로그인하려면 팀의 https 주소가 필요해요.', '"Sign in with Slack" needs the team\'s https address.', '"Masuk dengan Slack" memerlukan alamat https tim.', "「Slackでサインイン」にはチームのhttpsアドレスが必要です。", "«Iniciar sesión con Slack» necesita la dirección https del equipo."),
  no_tokens: t('먼저 두 토큰을 저장해 주세요.', 'Save both tokens first.', 'Simpan kedua token terlebih dahulu.', "先に2つのトークンを保存してください。", "Guarde primero los dos tokens."),
  link_expired: t('이 링크는 쓸 수 없어요(이미 썼거나 10분이 지났어요). Slack에서 다시 물어보면 새 링크를 받을 수 있어요.', 'This link cannot be used (it was used, or 10 minutes passed). Ask again in Slack to get a new one.', 'Tautan ini tidak bisa dipakai (sudah dipakai, atau lewat 10 menit). Tanyakan lagi di Slack untuk mendapat yang baru.', "このリンクは使用できません（使用済み、または10分が経過しました）。Slackでもう一度質問すると新しいリンクを受け取れます。", "Este enlace no se puede usar (ya se usó o pasaron 10 minutos). Pregunte de nuevo en Slack para recibir uno nuevo."),
  linked_elsewhere: t('이 계정은 이미 다른 Slack 계정과 연결되어 있어요. 설정에서 먼저 연결을 끊어 주세요.', 'This account is already linked to another Slack account. Unlink it in Settings first.', 'Akun ini sudah tertaut ke akun Slack lain. Putuskan dulu di Pengaturan.', "このアカウントはすでに別のSlackアカウントと連携しています。先に設定で連携を解除してください。", "Esta cuenta ya está vinculada a otra cuenta de Slack. Desvincúlela primero en Configuración."),
  slack_taken: t('이 Slack 계정은 이미 다른 사람의 계정과 연결되어 있어요. 그 사람이 먼저 연결을 끊어야 해요.', 'This Slack account is already linked to someone else\'s account. That person has to unlink it first.', 'Akun Slack ini sudah tertaut ke akun orang lain. Orang itu harus memutuskannya dulu.', "このSlackアカウントはすでに別の人のアカウントと連携しています。先にその人が連携を解除する必要があります。", "Esta cuenta de Slack ya está vinculada a la cuenta de otra persona. Esa persona debe desvincularla primero."),
}

export function refusal(reason: string, locale: Locale, params: Record<string, string> = {}): string | undefined {
  const r = REFUSAL[reason]
  const all: Record<string, string> = { product: PRODUCT.displayName, ...params }
  return r ? (r[locale] ?? r.en).replace(/\{(\w+)\}/g, (m, k: string) => all[k] ?? m) : undefined
}
