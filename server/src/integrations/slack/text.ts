// Words the Slack connector says in Slack (docs/SLACK.md), in the asker's language (an unlinked person: the team's),
// and the two text conversions: Slack's message text to the question, the AI's Markdown answer to Slack's mrkdwn.
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const TEXT = {
  linkPrompt: t('여기서 {product}에게 물어보려면 먼저 {product} 계정을 연결해 주세요. 이 링크는 10분 동안 한 번만, 나만 쓸 수 있어요.', 'To ask {product} here, first connect your {product} account. The link works once, for 10 minutes, and only for you.', 'Untuk bertanya ke {product} di sini, hubungkan dulu akun {product} Anda. Tautan ini berlaku sekali, selama 10 menit, dan hanya untuk Anda.', "ここで{product}に質問するには、まず{product}アカウントを連携してください。このリンクは10分間・1回だけ、あなただけが使えます。", "Para preguntar a {product} aquí, conecte primero su cuenta de {product}. El enlace funciona una vez, durante 10 minutos, y solo para usted."),
  linkButton: t('{product} 계정 연결하기', 'Connect {product} account', 'Hubungkan akun {product}', "{product}アカウントを連携", "Conectar cuenta de {product}"),
  linkWait: t('조금 전에 보낸 연결 링크를 써 주세요. 몇 분 뒤에 새 링크를 받을 수 있어요.', 'Use the connect link sent a moment ago. You can get a new one in a few minutes.', 'Gunakan tautan penghubung yang baru saja dikirim. Anda bisa mendapat yang baru beberapa menit lagi.', "先ほど送った連携リンクを使ってください。数分後に新しいリンクを受け取れます。", "Use el enlace de conexión enviado hace un momento. Podrá recibir uno nuevo en unos minutos."),
  outsider: t('이 워크스페이스의 구성원만 여기서 {product}를 쓸 수 있어요.', 'Only members of this workspace can use {product} here.', 'Hanya anggota workspace ini yang bisa memakai {product} di sini.', "ここで{product}を使えるのはこのワークスペースのメンバーだけです。", "Solo los miembros de este espacio de trabajo pueden usar {product} aquí."),
  empty: t('질문을 함께 적어 주세요.', 'Write your question with it.', 'Tulis pertanyaan Anda bersamanya.', "質問も一緒に書いてください。", "Escriba su pregunta junto con la mención."),
  working: t('답을 만들고 있어요…', 'Working on it…', 'Sedang dikerjakan…', "回答を作成しています…", "Trabajando en ello…"),
  busy: t('이 스레드의 앞 질문에 아직 답하고 있어요. 끝난 뒤 다시 물어봐 주세요.', 'I am still answering your earlier question in this thread. Ask again when it is done.', 'Saya masih menjawab pertanyaan Anda sebelumnya di utas ini. Tanyakan lagi setelah selesai.', "このスレッドの前の質問にまだ回答中です。終わってからもう一度質問してください。", "Todavía estoy respondiendo su pregunta anterior en este hilo. Pregunte de nuevo cuando termine."),
  queueFull: t('지금 요청이 많아요. 잠시 뒤 다시 물어봐 주세요.', 'There are many requests right now. Ask again in a moment.', 'Sedang banyak permintaan. Tanyakan lagi sebentar lagi.', "現在リクエストが集中しています。しばらくしてからもう一度質問してください。", "Hay muchas solicitudes en este momento. Pregunte de nuevo en un momento."),
  cannotStart: t('답을 시작하지 못했어요: {reason}', 'Could not start the answer: {reason}', 'Tidak bisa memulai jawaban: {reason}', "回答を開始できませんでした：{reason}", "No se pudo empezar la respuesta: {reason}"),
  failed: t('답하지 못했어요: {reason}', 'Could not answer: {reason}', 'Tidak bisa menjawab: {reason}', "回答できませんでした：{reason}", "No se pudo responder: {reason}"),
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
  linked: t('{product} 계정 {name}과(와) 연결했어요. 이제 다시 물어봐 주세요. 내 계정이 아니면 그 계정의 설정에서 연결을 끊어 달라고 해 주세요.', 'This Slack account is connected to the {product} account {name}. Ask your question again. If that is not your account, have it unlinked in its Settings.', 'Akun Slack ini terhubung ke akun {product} {name}. Ajukan pertanyaan Anda lagi. Jika itu bukan akun Anda, minta agar diputuskan di Pengaturannya.', "このSlackアカウントは{product}アカウント{name}と連携しました。もう一度質問してください。ご自身のアカウントでなければ、そのアカウントの設定で連携を解除してもらってください。", "Esta cuenta de Slack está conectada a la cuenta de {product} {name}. Haga su pregunta de nuevo. Si no es su cuenta, pida que la desvinculen en su Configuración."),
  as: t('{name} 계정으로 답해요.', 'Answering as {name}.', 'Menjawab sebagai {name}.', "{name}として回答します。", "Responde como {name}."),
  tooLong: t('2시간 안에 답이 끝나지 않았어요. 나중에 끝나면 {product}에서 볼 수 있어요.', 'The answer did not finish within 2 hours. If it finishes later, it is in {product}.', 'Jawaban tidak selesai dalam 2 jam. Jika selesai nanti, ada di {product}.', "2時間以内に回答が終わりませんでした。後で終わった場合は{product}で確認できます。", "La respuesta no terminó en 2 horas. Si termina más tarde, estará en {product}."),
  signInFirst: t('먼저 {product}에 로그인해서 비밀번호를 바꿔 주세요. 그다음 다시 물어봐 주세요.', 'First sign in to {product} and change your password, then ask again.', 'Masuk dulu ke {product} dan ganti kata sandi Anda, lalu tanyakan lagi.', "まず{product}にサインインしてパスワードを変更し、それからもう一度質問してください。", "Primero inicie sesión en {product} y cambie su contraseña; después pregunte de nuevo."),
  notLinked: t('Slack 계정이 더 이상 연결되어 있지 않아요.', 'Your Slack account is no longer connected.', 'Akun Slack Anda tidak lagi terhubung.', "Slackアカウントの連携は解除されています。", "Su cuenta de Slack ya no está conectada."),
}
export type TextKey = keyof typeof TEXT

export function say(key: TextKey, locale: Locale, params: Record<string, string> = {}): string {
  const all: Record<string, string> = { product: PRODUCT.displayName, ...params }
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
  not_bot_token: t('Bot User OAuth Token(xoxb-로 시작)을 넣어 주세요.', 'Enter the Bot User OAuth Token (it starts with xoxb-).', 'Masukkan Bot User OAuth Token (diawali xoxb-).', "Bot User OAuth Token（xoxb-で始まる）を入力してください。", "Introduzca el Bot User OAuth Token (empieza por xoxb-)."),
  not_app_token: t('connections:write 권한이 있는 App-Level Token(xapp-로 시작)을 넣어 주세요.', 'Enter an App-Level Token with connections:write (it starts with xapp-).', 'Masukkan App-Level Token dengan connections:write (diawali xapp-).', "connections:write権限のあるApp-Level Token（xapp-で始まる）を入力してください。", "Introduzca un App-Level Token con connections:write (empieza por xapp-)."),
  invalid_auth: t('Slack이 이 토큰을 받지 않았어요. 앱을 워크스페이스에 설치했는지, 토큰을 다시 복사했는지 확인해 주세요.', 'Slack did not accept this token. Check that the app is installed in the workspace and copy the token again.', 'Slack tidak menerima token ini. Pastikan aplikasi sudah dipasang di workspace lalu salin token lagi.', "Slackがこのトークンを受け付けませんでした。アプリがワークスペースにインストールされているか確認し、トークンをもう一度コピーしてください。", "Slack no aceptó este token. Compruebe que la aplicación está instalada en el espacio de trabajo y copie el token de nuevo."),
  token_revoked: t('이 토큰은 취소됐어요. Slack에서 새 토큰을 복사해 주세요.', 'This token was revoked. Copy a new one from Slack.', 'Token ini sudah dicabut. Salin yang baru dari Slack.', "このトークンは取り消されています。Slackから新しいトークンをコピーしてください。", "Este token fue revocado. Copie uno nuevo de Slack."),
  missing_scope: t('앱에 권한이 빠져 있어요: {scopes}. 여기의 매니페스트로 앱을 만들거나 권한을 추가한 뒤 다시 설치해 주세요.', 'The app is missing permissions: {scopes}. Create it from the manifest here, or add them and reinstall the app.', 'Aplikasi kekurangan izin: {scopes}. Buat dari manifest di sini, atau tambahkan lalu pasang ulang aplikasi.', "アプリに権限が不足しています：{scopes}。ここのマニフェストでアプリを作成するか、権限を追加して再インストールしてください。", "A la aplicación le faltan permisos: {scopes}. Créela con el manifiesto de aquí, o añádalos y vuelva a instalarla."),
  enterprise_install: t('조직 전체 설치는 아직 쓸 수 없어요. 앱을 워크스페이스 하나에 설치해 주세요.', 'Organization-wide installs are not supported yet. Install the app in one workspace.', 'Pemasangan untuk seluruh organisasi belum didukung. Pasang aplikasi di satu workspace.', "組織全体へのインストールにはまだ対応していません。1つのワークスペースにインストールしてください。", "Todavía no se admiten instalaciones en toda la organización. Instale la aplicación en un espacio de trabajo."),
  unreachable: t('Slack에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.', 'Could not reach Slack. Try again in a moment.', 'Tidak bisa menghubungi Slack. Coba lagi sebentar lagi.', "Slackに接続できませんでした。しばらくしてからもう一度お試しください。", "No se pudo conectar con Slack. Inténtelo de nuevo en un momento."),
  ratelimited: t('Slack이 잠시 요청을 막았어요. 잠시 뒤 다시 해 주세요.', 'Slack is limiting requests right now. Try again in a moment.', 'Slack sedang membatasi permintaan. Coba lagi sebentar lagi.', "Slackが一時的にリクエストを制限しています。しばらくしてからもう一度お試しください。", "Slack está limitando las solicitudes. Inténtelo de nuevo en un momento."),
  key_unsafe: t('서버의 키 폴더를 쓸 수 없어요. 관리자에게 서버 설정을 확인해 달라고 해 주세요.', 'The server cannot use its key folder. Ask whoever runs the server to check it.', 'Server tidak bisa memakai folder kuncinya. Minta pengelola server memeriksanya.', "サーバーのキーフォルダーを使用できません。サーバーの管理者に確認を依頼してください。", "El servidor no puede usar su carpeta de claves. Pida a quien administra el servidor que la revise."),
  app_mismatch: t('두 토큰이 서로 다른 Slack 앱의 것이에요. 같은 앱의 Bot User OAuth Token과 App-Level Token을 넣어 주세요.', 'The two tokens belong to different Slack apps. Enter the Bot User OAuth Token and the App-Level Token of the same app.', 'Kedua token berasal dari aplikasi Slack yang berbeda. Masukkan Bot User OAuth Token dan App-Level Token dari aplikasi yang sama.', "2つのトークンが別々のSlackアプリのものです。同じアプリのBot User OAuth TokenとApp-Level Tokenを入力してください。", "Los dos tokens son de aplicaciones de Slack distintas. Introduzca el Bot User OAuth Token y el App-Level Token de la misma aplicación."),
  no_tokens: t('먼저 두 토큰을 저장해 주세요.', 'Save both tokens first.', 'Simpan kedua token terlebih dahulu.', "先に2つのトークンを保存してください。", "Guarde primero los dos tokens."),
  link_expired: t('이 링크는 쓸 수 없어요(이미 썼거나 10분이 지났어요). Slack에서 다시 물어보면 새 링크를 받을 수 있어요.', 'This link cannot be used (it was used, or 10 minutes passed). Ask again in Slack to get a new one.', 'Tautan ini tidak bisa dipakai (sudah dipakai, atau lewat 10 menit). Tanyakan lagi di Slack untuk mendapat yang baru.', "このリンクは使用できません（使用済み、または10分が経過しました）。Slackでもう一度質問すると新しいリンクを受け取れます。", "Este enlace no se puede usar (ya se usó o pasaron 10 minutos). Pregunte de nuevo en Slack para recibir uno nuevo."),
  linked_elsewhere: t('이 계정은 이미 다른 Slack 계정과 연결되어 있어요. 설정에서 먼저 연결을 끊어 주세요.', 'This account is already linked to another Slack account. Unlink it in Settings first.', 'Akun ini sudah tertaut ke akun Slack lain. Putuskan dulu di Pengaturan.', "このアカウントはすでに別のSlackアカウントと連携しています。先に設定で連携を解除してください。", "Esta cuenta ya está vinculada a otra cuenta de Slack. Desvincúlela primero en Configuración."),
  slack_taken: t('이 Slack 계정은 이미 다른 사람의 계정과 연결되어 있어요. 그 사람이 먼저 연결을 끊어야 해요.', 'This Slack account is already linked to someone else\'s account. That person has to unlink it first.', 'Akun Slack ini sudah tertaut ke akun orang lain. Orang itu harus memutuskannya dulu.', "このSlackアカウントはすでに別の人のアカウントと連携しています。先にその人が連携を解除する必要があります。", "Esta cuenta de Slack ya está vinculada a la cuenta de otra persona. Esa persona debe desvincularla primero."),
}

export function refusal(reason: string, locale: Locale, params: Record<string, string> = {}): string | undefined {
  const r = REFUSAL[reason]
  return r ? (r[locale] ?? r.en).replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m) : undefined
}
