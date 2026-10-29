// Server texts of the AI connections (ko, en, id): the state line under a connection and the notices the owner and
// admins get. D1 explicitly distinguishes personal connections from shared subscriptions.
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string): T => ({ ko, en, id, ja, es })

export const CT = {
  // state details
  unverified: t('첫 질문 때 확인돼요.', 'Checked on the first question.', 'Diperiksa saat pertanyaan pertama.', "最初の質問時に確認します。", "Se comprueba con la primera pregunta."),
  expiring: t('{date}에 만료돼요. `claude setup-token`으로 새 토큰을 만들어 바꿔 주세요.', 'Expires on {date}. Make a new token with `claude setup-token` and replace it.', 'Kedaluwarsa pada {date}. Buat token baru dengan `claude setup-token` lalu ganti.', "{date}に期限が切れます。`claude setup-token`で新しいトークンを作成して置換してください。", "Vence el {date}. Cree un token nuevo con `claude setup-token` y reemplácelo."),
  expired: t('만료되었어요. 새 토큰으로 바꿔 주세요.', 'Expired. Replace it with a new token.', 'Kedaluwarsa. Ganti dengan token baru.', "期限切れです。新しいトークンに置換してください。", "Venció. Reemplácelo con un token nuevo."),
  invalid: t('공급자가 이 연결을 거절했어요(취소되었거나 잘못 붙여 넣음). 토큰·키를 바꿔 주세요.', 'The provider refused this connection (revoked or pasted wrong). Replace the token or key.', 'Penyedia menolak koneksi ini (dicabut atau salah tempel). Ganti token atau kuncinya.', "プロバイダーがこの接続を拒否しました（取り消されたか、貼り付けが不正確です）。トークンまたはキーを置換してください。", "El proveedor rechazó esta conexión (revocada o mal pegada). Reemplace el token o la clave."),
  invalidPlan: t('이 ChatGPT 플랜에는 Codex가 포함되어 있지 않아요.', 'This ChatGPT plan does not include Codex.', 'Paket ChatGPT ini tidak mencakup Codex.', "このChatGPTプランにはCodexが含まれていません。", "Este plan de ChatGPT no incluye Codex."),
  needsReconnect: t('다시 연결해야 해요.', 'Needs to be connected again.', 'Perlu dihubungkan lagi.', "再接続が必要です。", "Se requiere volver a conectar."),
  decryptFailed: t('이 서버의 열쇠로 풀 수 없어요(다른 서버에서 복원됨). 다시 연결해 주세요.', 'This server\'s key cannot open it (restored from another server). Connect it again.', 'Kunci server ini tidak bisa membukanya (dipulihkan dari server lain). Hubungkan lagi.', "このサーバーのキーでは復号できません（別のサーバーから復元されています）。再接続してください。", "La clave de este servidor no puede descifrarla (se restauró desde otro servidor). Vuelva a conectarla."),
  limited: t('한도 도달 · {time}부터 다시', 'Limit reached · again from {time}', 'Batas tercapai · lagi mulai {time}', "上限に到達 · {time}から再開", "Límite alcanzado · disponible desde {time}"),
  overLimit: t('이번 달 한도를 다 썼어요.', 'This month\'s limit is used up.', 'Batas bulan ini sudah habis.', "今月の上限を使い切りました。", "Se agotó el límite de este mes."),
  disabled: t('꺼져 있어요.', 'Switched off.', 'Dimatikan.', "オフになっています。", "Está desactivada."),
  kindOff: t('이 서버에서는 쓸 수 없는 종류예요.', 'This kind is not available on this server.', 'Jenis ini tidak tersedia di server ini.', "この種類はこのサーバーで利用できません。", "Este tipo no está disponible en este servidor."),
  sharedSubscriptionsOff: t('구독 공유가 꺼져 있어요. 개인 연결이나 회사 API 키를 사용해 주세요.', 'Subscription sharing is off. Use a personal connection or a company API key.', 'Berbagi langganan dinonaktifkan. Gunakan koneksi pribadi atau kunci API perusahaan.', "サブスクリプションの共有はオフです。個人接続または会社のAPIキーを使用してください。", "El uso compartido de suscripciones está desactivado. Use una conexión personal o una clave de API de la empresa."),
  sharedRiskAcknowledgement: t('구독 공유의 계정 정지 위험과 공동 사용 한도를 확인해 주세요.', 'Confirm the account suspension risk and shared usage limits before enabling subscription sharing.', 'Konfirmasi risiko penangguhan akun dan batas penggunaan bersama sebelum mengaktifkan berbagi langganan.', "サブスクリプションの共有を有効にする前に、アカウント停止のリスクと共有時の使用量上限を確認してください。", "Confirme el riesgo de suspensión de cuenta y los límites de uso compartidos antes de activar el uso compartido de suscripciones."),

  // validation / conflicts (never the value)
  badClaudeToken: t('Claude 구독 토큰이 아니에요. `claude setup-token`이 보여 준 sk-ant-oat01-로 시작하는 토큰 전체를 붙여 넣어 주세요.', 'Not a Claude subscription token. Paste the whole token that starts with sk-ant-oat01- from `claude setup-token`.', 'Bukan token langganan Claude. Tempel seluruh token yang diawali sk-ant-oat01- dari `claude setup-token`.', "Claudeのサブスクリプショントークンではありません。`claude setup-token`のsk-ant-oat01-で始まるトークン全体を貼り付けてください。", "No es un token de suscripción de Claude. Pegue el token completo de `claude setup-token` que empieza por sk-ant-oat01-."),
  badAnthropicKey: t('Anthropic API 키가 아니에요(sk-ant-api…).', 'Not an Anthropic API key (sk-ant-api…).', 'Bukan kunci API Anthropic (sk-ant-api…).', "Anthropic APIキー（sk-ant-api…）ではありません。", "No es una clave de API de Anthropic (sk-ant-api…)."),
  badOpenaiKey: t('OpenAI API 키가 아니에요(sk-…).', 'Not an OpenAI API key (sk-…).', 'Bukan kunci API OpenAI (sk-…).', "OpenAI APIキー（sk-…）ではありません。", "No es una clave de API de OpenAI (sk-…)."),
  refusedClaude: t('Claude가 이 토큰을 받지 않았어요. `claude setup-token`으로 새로 만들어 주세요.', 'Claude did not accept this token. Make a new one with `claude setup-token`.', 'Claude tidak menerima token ini. Buat yang baru dengan `claude setup-token`.', "Claudeがこのトークンを受け付けませんでした。`claude setup-token`で新しく作成してください。", "Claude no aceptó este token. Cree uno nuevo con `claude setup-token`."),
  refusedKey: t('공급자가 이 키를 받지 않았어요. 키를 다시 확인해 주세요.', 'The provider did not accept this key. Check the key again.', 'Penyedia tidak menerima kunci ini. Periksa kuncinya lagi.', "プロバイダーがこのキーを受け付けませんでした。キーを再確認してください。", "El proveedor no aceptó esta clave. Revísela de nuevo."),
  duplicate: t('이미 연결된 토큰·키예요.', 'This token or key is already connected.', 'Token atau kunci ini sudah terhubung.', "このトークンまたはキーは接続済みです。", "Este token o clave ya está conectado."),
  kindNotAllowed: t('이 서버에서는 이 종류의 연결을 추가할 수 없어요.', 'This kind of connection cannot be added on this server.', 'Jenis koneksi ini tidak bisa ditambahkan di server ini.', "この種類の接続はこのサーバーに追加できません。", "No se puede añadir este tipo de conexión en este servidor."),
  planNotice: t('구독 요금제 안내를 확인해 주세요.', 'Confirm the subscription plan notice.', 'Konfirmasi pemberitahuan paket langganan.', "サブスクリプションプランの案内を確認してください。", "Confirme el aviso del plan de suscripción."),
  sealed: t('보낸 값을 열 수 없어요. 페이지를 새로 고친 뒤 다시 붙여 넣어 주세요.', 'The value could not be opened. Reload the page and paste it again.', 'Nilai tidak dapat dibuka. Muat ulang halaman lalu tempel lagi.', "値を復号できませんでした。ページを再読み込みし、貼り付け直してください。", "No se pudo descifrar el valor. Recargue la página y péguelo de nuevo."),
  memberOwnOff: t('팀에서 개인 AI 연결을 허용하지 않았어요.', 'Your team does not allow personal AI connections.', 'Tim Anda tidak mengizinkan koneksi AI pribadi.', "チームは個人のAI接続を許可していません。", "Su equipo no permite conexiones personales de IA."),
  otherAccount: t('다른 ChatGPT 계정이에요. 이 연결의 계정으로 로그인해 주세요.', 'That is another ChatGPT account. Sign in with this connection\'s account.', 'Itu akun ChatGPT lain. Masuk dengan akun koneksi ini.', "別のChatGPTアカウントです。この接続のアカウントでログインしてください。", "Es otra cuenta de ChatGPT. Inicie sesión con la cuenta de esta conexión."),
  sameAccount: t('이 ChatGPT 계정은 이미 연결되어 있어요. 그 연결의 [다시 연결]을 써 주세요.', 'This ChatGPT account is already connected. Use "Reconnect" on that connection.', 'Akun ChatGPT ini sudah terhubung. Gunakan "Hubungkan ulang" pada koneksi itu.', "このChatGPTアカウントは接続済みです。その接続の「再接続」を使用してください。", "Esta cuenta de ChatGPT ya está conectada. Use \"Volver a conectar\" en esa conexión."),
  loginBusy: t('다른 ChatGPT 로그인이 진행 중이에요. 끝나거나 취소한 뒤 다시 시작해 주세요.', 'Another ChatGPT sign-in is in progress. Wait for it or cancel it first.', 'Login ChatGPT lain sedang berjalan. Tunggu atau batalkan dulu.', "別のChatGPTログインが進行中です。完了を待つか、先にキャンセルしてください。", "Hay otro inicio de sesión de ChatGPT en curso. Espere o cancélelo primero."),
  loginUnavailable: t('이 서버에서는 ChatGPT 로그인을 시작할 수 없어요(Codex 또는 실행기가 없음).', 'A ChatGPT sign-in cannot start on this server (no Codex or launcher).', 'Login ChatGPT tidak bisa dimulai di server ini (tidak ada Codex atau launcher).', "このサーバーではChatGPTログインを開始できません（Codexまたはランチャーがありません）。", "No se puede iniciar sesión en ChatGPT en este servidor (falta Codex o el lanzador)."),
  sameKind: t('같은 종류의 토큰·키로만 바꿀 수 있어요.', 'Only a token or key of the same kind can replace it.', 'Hanya token atau kunci jenis yang sama yang bisa menggantinya.', "同じ種類のトークンまたはキーでのみ置換できます。", "Solo se puede reemplazar con un token o clave del mismo tipo."),
  unknownAssignee: t('없는 그룹이나 사람이 지정되었어요.', 'A group or person in the list does not exist.', 'Ada grup atau orang dalam daftar yang tidak ada.', "一覧に存在しないグループまたはメンバーが含まれています。", "Un grupo o una persona de la lista no existe."),

  // notices to the owner and admins
  nRejected: t("AI 연결 '{label}'이(가) 거절되었어요. 관리자 > AI 연결에서 토큰·키를 바꿔 주세요.", "The AI connection '{label}' was refused. Replace its token or key in Admin > AI connections.", "Koneksi AI '{label}' ditolak. Ganti token atau kuncinya di Admin > Koneksi AI.", "AI接続'{label}'が拒否されました。「管理 > AI接続」でトークンまたはキーを置換してください。", "Se rechazó la conexión de IA '{label}'. Reemplace su token o clave en Administración > Conexiones de IA."),
  nNeedsReconnect: t("AI 연결 '{label}'을(를) 다시 연결해야 해요(관리자 > AI 연결).", "The AI connection '{label}' needs to be connected again (Admin > AI connections).", "Koneksi AI '{label}' perlu dihubungkan lagi (Admin > Koneksi AI).", "AI接続'{label}'の再接続が必要です（管理 > AI接続）。", "La conexión de IA '{label}' debe volver a conectarse (Administración > Conexiones de IA)."),
  nLimited: t("AI 연결 '{label}'이(가) 사용 한도에 닿았어요. {time}부터 다시 쓸 수 있어요.", "The AI connection '{label}' reached its usage limit. It works again from {time}.", "Koneksi AI '{label}' mencapai batas pemakaian. Bisa dipakai lagi mulai {time}.", "AI接続'{label}'が使用量上限に達しました。{time}から再び使えます。", "La conexión de IA '{label}' alcanzó su límite de uso. Volverá a funcionar a partir de {time}."),
  nExpiring: t("AI 연결 '{label}'이(가) {date}에 만료돼요. 새 토큰으로 바꿔 주세요.", "The AI connection '{label}' expires on {date}. Replace it with a new token.", "Koneksi AI '{label}' kedaluwarsa pada {date}. Ganti dengan token baru.", "AI接続'{label}'は{date}に期限が切れます。新しいトークンに置換してください。", "La conexión de IA '{label}' vence el {date}. Reemplácela con un token nuevo."),
  nLimitNear: t("AI 연결 '{label}'의 이번 달 한도를 80% 썼어요.", "80% of this month's limit of the AI connection '{label}' is used.", "80% batas bulan ini untuk koneksi AI '{label}' sudah terpakai.", "AI接続'{label}'の今月の上限の80%を使用しました。", "Se usó el 80% del límite mensual de la conexión de IA '{label}'."),
  nLimitReached: t("AI 연결 '{label}'의 이번 달 한도를 다 썼어요.", "This month's limit of the AI connection '{label}' is used up.", "Batas bulan ini untuk koneksi AI '{label}' sudah habis.", "AI接続'{label}'の今月の上限を使い切りました。", "Se agotó el límite mensual de la conexión de IA '{label}'."),
  nBudgetNear: t('{subject}의 {period} AI 사용 한도를 80% 썼어요. 다 쓰면 막혀요.', '80% of {period} AI usage limit of {subject} is used. It blocks when used up.', '80% batas pemakaian AI {period} untuk {subject} sudah terpakai. Akan diblokir saat habis.', "{subject}の{period}のAI使用量上限の80%を使用しました。使い切るとブロックされます。", "Se usó el 80% del límite de IA {period} de {subject}. Se bloqueará al agotarlo."),
  nBudgetReached: t('{subject}의 {period} AI 사용 한도를 다 썼어요.', '{period} AI usage limit of {subject} is used up.', 'Batas pemakaian AI {period} untuk {subject} sudah habis.', "{subject}の{period}のAI使用量上限を使い切りました。", "Se agotó el límite de uso de IA {period} de {subject}."),
  subjectTeam: t('팀 전체', 'the whole team', 'seluruh tim', "チーム全体", "todo el equipo"),
} satisfies Record<string, T>

export function ct(key: keyof typeof CT, locale: Locale, vars: Record<string, string> = {}): string {
  let s = CT[key][locale] ?? CT[key].en
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v)
  return s
}
/** all five languages (notices go to people with different languages) */
export function ctAll(key: keyof typeof CT, vars: Record<string, string> = {}): T {
  return { ko: ct(key, 'ko', vars), en: ct(key, 'en', vars), id: ct(key, 'id', vars), ja: ct(key, 'ja', vars), es: ct(key, 'es', vars) }
}
export const fmtTime = (iso: string, locale: Locale) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
export const fmtDate = (iso: string, locale: Locale) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { dateStyle: 'medium' }).format(new Date(iso))
