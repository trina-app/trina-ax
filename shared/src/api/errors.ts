// User-facing error messages per code and language (tab 4: `message` is in the user's language).
// Handlers may pass their own, more specific message; these are the defaults.
import { DEFAULT_LOCALE, asLocale, type ApiErrorBody, type ErrorCode, type Locale } from './common'

export const ERROR_MESSAGES: Record<ErrorCode, Record<Locale, string>> = {
  bad_request: { ko: '요청 형식이 올바르지 않습니다.', en: 'The request is malformed.', id: 'Format permintaan tidak valid.', ja: "リクエストの形式が正しくありません。", es: "La solicitud tiene un formato incorrecto." },
  validation: { ko: '입력값을 확인해 주세요.', en: 'Please check the input.', id: 'Periksa kembali isian Anda.', ja: "入力内容を確認してください。", es: "Revise los datos introducidos." },
  unauthorized: { ko: '로그인이 필요합니다.', en: 'Please sign in.', id: 'Silakan masuk terlebih dahulu.', ja: "ログインしてください。", es: "Inicie sesión." },
  password_change_required: { ko: '비밀번호를 먼저 바꿔 주세요.', en: 'Please change your password first.', id: 'Silakan ganti kata sandi Anda terlebih dahulu.', ja: "先にパスワードを変更してください。", es: "Cambie primero su contraseña." },
  forbidden: { ko: '권한이 없습니다.', en: 'You do not have permission to do this.', id: 'Anda tidak memiliki izin.', ja: "この操作を行う権限がありません。", es: "No tiene permiso para realizar esta acción." },
  csrf: { ko: '보안 확인에 실패했습니다. 페이지를 새로 고쳐 주세요.', en: 'Security check failed. Please reload the page.', id: 'Pemeriksaan keamanan gagal. Muat ulang halaman.', ja: "セキュリティ確認に失敗しました。ページを再読み込みしてください。", es: "Falló la verificación de seguridad. Recargue la página." },
  not_found: { ko: '찾을 수 없거나 접근 권한이 없습니다.', en: 'Not found or no access.', id: 'Tidak ditemukan atau tidak ada akses.', ja: "見つからないか、アクセス権がありません。", es: "No se encuentra o no tiene acceso." },
  conflict: { ko: '다른 변경과 충돌했습니다. 새로 고친 뒤 다시 시도해 주세요.', en: 'This conflicts with another change. Reload and try again.', id: 'Bertabrakan dengan perubahan lain. Muat ulang lalu coba lagi.', ja: "別の変更と競合しています。再読み込みして再試行してください。", es: "Hay un conflicto con otro cambio. Recargue y vuelva a intentarlo." },
  gone: { ko: '만료되었거나 더 이상 사용할 수 없습니다.', en: 'This has expired or is no longer available.', id: 'Sudah kedaluwarsa atau tidak tersedia lagi.', ja: "有効期限が切れたか、利用できなくなりました。", es: "Venció o ya no está disponible." },
  payload_too_large: { ko: '파일이 너무 큽니다.', en: 'The file is too large.', id: 'Berkas terlalu besar.', ja: "ファイルが大きすぎます。", es: "El archivo es demasiado grande." },
  range_not_satisfiable: { ko: '요청한 범위를 보낼 수 없습니다.', en: 'The requested range is not available.', id: 'Rentang yang diminta tidak tersedia.', ja: "指定された範囲は利用できません。", es: "El intervalo solicitado no está disponible." },
  rate_limited: { ko: '요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', en: 'Too many requests. Please try again shortly.', id: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.', ja: "リクエストが多すぎます。しばらくしてから再試行してください。", es: "Hay demasiadas solicitudes. Vuelva a intentarlo en un momento." },
  budget_exceeded: { ko: 'AI 사용 한도에 도달했습니다. 관리자에게 문의해 주세요.', en: 'The AI usage limit has been reached. Please contact your admin.', id: 'Batas penggunaan AI tercapai. Hubungi admin Anda.', ja: "AIの使用量上限に達しました。管理者にお問い合わせください。", es: "Se alcanzó el límite de uso de IA. Consulte a su administrador." },
  engine_unavailable: { ko: '지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).', en: 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).', id: 'Mesin AI sedang tidak tersedia. Beri tahu pemilik tim (Admin > Sistem > Diagnostik menunjukkan penyebabnya).', ja: "現在AIエンジンを利用できません。チームオーナーに知らせてください（管理 > システム > 診断で理由を確認できます）。", es: "El motor de IA no está disponible ahora. Avise al propietario del equipo (Administración > Sistema > Diagnóstico muestra el motivo)." },
  busy: { ko: '지금은 처리할 수 없습니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.', en: 'Busy right now. Try again when the running work is done.', id: 'Sedang sibuk. Coba lagi setelah pekerjaan yang berjalan selesai.', ja: "現在処理中です。実行中の作業が終わってから再試行してください。", es: "Está ocupado. Vuelva a intentarlo cuando termine el trabajo en curso." },
  unavailable: { ko: '팀 서버가 잠시 사용할 수 없습니다.', en: 'The team server is temporarily unavailable.', id: 'Server tim sementara tidak tersedia.', ja: "チームサーバーを一時的に利用できません。", es: "El servidor del equipo no está disponible temporalmente." },
  internal: { ko: '서버 오류가 발생했습니다.', en: 'Something went wrong on the server.', id: 'Terjadi kesalahan pada server.', ja: "サーバーでエラーが発生しました。", es: "Se produjo un error en el servidor." },
  storage_full: { ko: '저장 공간이 가득 찼습니다. 휴지통을 비우거나 파일을 정리해 주세요.', en: 'The storage is full. Empty the trash or clean up files.', id: 'Penyimpanan penuh. Kosongkan tempat sampah atau rapikan berkas.', ja: "ストレージがいっぱいです。ゴミ箱を空にするか、ファイルを整理してください。", es: "El almacenamiento está lleno. Vacíe la papelera o elimine archivos que no necesite." },
  plan_limit: { ko: '요금제 한도를 넘습니다. 요금제를 바꾸거나 쓰지 않는 계정을 꺼 주세요.', en: 'This goes over the plan. Change the plan, or disable an account that is no longer used.', id: 'Ini melebihi batas paket. Ubah paket, atau nonaktifkan akun yang tidak dipakai lagi.', ja: "プランの上限を超えます。プランを変更するか、使用していないアカウントを無効にしてください。", es: "Esto supera el límite del plan. Cambie de plan o deshabilite una cuenta que ya no se use." },
}

export function errorMessage(code: ErrorCode, locale: Locale): string {
  return ERROR_MESSAGES[code][locale] ?? ERROR_MESSAGES[code][DEFAULT_LOCALE]
}

/** Pick a supported locale from an Accept-Language header (default en). The team server no longer uses it (the team default
 * decides before sign-in, not the browser); kept for API clients and the relay pages. */
export function localeFromAcceptLanguage(h: string | null | undefined): Locale {
  for (const part of (h ?? '').split(',')) {
    const l = asLocale(part.split(';')[0])
    if (l) return l
  }
  return DEFAULT_LOCALE
}

/** Official chat failures, separate from generic API errors. Keep these phrases for exact matching of stored
 * errors from before params.reason; never infer a reason from a code alone or a fragment of arbitrary text. */
export const CHAT_ERROR_MESSAGES = {
  auth: { code: 'engine_unavailable', ko: 'AI 연결에 문제가 있습니다. 관리자에게 AI 연결을 확인해 달라고 해 주세요.', en: 'The AI connection has a problem. Ask your admin to check the AI connection.', id: 'Koneksi AI bermasalah. Minta admin memeriksa koneksi AI.', ja: "AI接続に問題があります。管理者にAI接続の確認を依頼してください。", es: "Hay un problema con la conexión de IA. Pida a su administrador que la revise." },
  rate_limit: { code: 'rate_limited', ko: 'AI 사용 한도에 잠시 도달했습니다. 조금 뒤 다시 시도해 주세요.', en: 'The AI usage limit was reached for now. Try again a bit later.', id: 'Batas penggunaan AI tercapai untuk sementara. Coba lagi nanti.', ja: "現在AIの使用量上限に達しています。しばらくしてから再試行してください。", es: "Se alcanzó el límite de uso de IA por ahora. Vuelva a intentarlo más tarde." },
  context: { code: 'payload_too_large', ko: '대화가 너무 길어졌습니다. 새 채팅에서 이어 가 주세요.', en: 'This conversation got too long. Please continue in a new chat.', id: 'Percakapan ini terlalu panjang. Lanjutkan di chat baru.', ja: "会話が長くなりすぎました。新しいチャットで続けてください。", es: "Esta conversación es demasiado larga. Continúe en un chat nuevo." },
  timeout: { code: 'busy', ko: '시간 제한을 넘겨 답변을 멈췄습니다.', en: 'The answer was stopped because it took too long.', id: 'Jawaban dihentikan karena terlalu lama.', ja: "時間がかかりすぎたため、回答を停止しました。", es: "La respuesta se detuvo porque tardó demasiado." },
  wall_timeout: { code: 'busy', ko: '확인 대기를 포함한 전체 실행 시간 제한을 넘겨 답변을 멈췄습니다.', en: 'The answer reached its total time limit, including time waiting for confirmation.', id: 'Jawaban mencapai batas waktu total, termasuk waktu menunggu konfirmasi.', ja: "確認待ちを含む回答全体の制限時間に達しました。", es: "La respuesta alcanzó su límite total de tiempo, incluida la espera de confirmación." },
  refused: { code: 'forbidden', ko: 'AI가 이 요청에 답하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.', en: 'The AI declined this request. Try rephrasing it.', id: 'AI menolak permintaan ini. Coba ubah kalimatnya.', ja: "AIがこのリクエストを拒否しました。表現を変えてお試しください。", es: "La IA rechazó esta solicitud. Intente reformularla." },
  crash: { code: 'internal', ko: 'AI 엔진이 예기치 않게 멈췄습니다. 다시 시도해 주세요.', en: 'The AI engine stopped unexpectedly. Please try again.', id: 'Mesin AI berhenti tiba-tiba. Coba lagi.', ja: "AIエンジンが予期せず停止しました。再試行してください。", es: "El motor de IA se detuvo inesperadamente. Vuelva a intentarlo." },
  interrupted: { code: 'unavailable', ko: '서버가 다시 시작되어 답변이 중단되었습니다.', en: 'The answer was interrupted because the server restarted.', id: 'Jawaban terputus karena server dimulai ulang.', ja: "サーバーが再起動したため、回答が中断されました。", es: "La respuesta se interrumpió porque se reinició el servidor." },
  engine_missing: { code: 'engine_unavailable', ko: '지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).', en: 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).', id: 'Mesin AI sedang tidak tersedia. Beri tahu pemilik tim (Admin > Sistem > Diagnostik menunjukkan penyebabnya).', ja: "現在AIエンジンを利用できません。チームオーナーに知らせてください（管理 > システム > 診断で理由を確認できます）。", es: "El motor de IA no está disponible ahora. Avise al propietario del equipo (Administración > Sistema > Diagnóstico muestra el motivo)." },
  proxy_down: { code: 'engine_unavailable', ko: 'AI 연결 통로(모델 프록시)가 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하고, 계속되면 팀장에게 알려 주세요.', en: 'The AI connection (model proxy) is not ready. Try again in a moment; if it keeps happening, let the team owner know.', id: 'Koneksi AI (proxy model) belum siap. Coba lagi sebentar lagi; jika terus terjadi, beri tahu pemilik tim.', ja: "AI接続（モデルプロキシ）の準備ができていません。しばらくしてから再試行し、続く場合はチームオーナーに知らせてください。", es: "La conexión de IA (proxy de modelos) no está lista. Reinténtelo en un momento; si persiste, avise al propietario del equipo." },
  user_disabled: { code: 'forbidden', ko: '계정을 사용할 수 없습니다.', en: 'This account is not active.', id: 'Akun ini tidak aktif.', ja: "このアカウントは有効ではありません。", es: "Esta cuenta no está activa." },
  no_credential: { code: 'engine_unavailable', ko: '이 엔진에 쓸 AI 연결이 없습니다. 관리자에게 알려 주세요.', en: 'There is no AI connection for this engine. Let your admin know.', id: 'Tidak ada koneksi AI untuk mesin ini. Beri tahu admin Anda.', ja: "このエンジン用のAI接続がありません。管理者に知らせてください。", es: "No hay una conexión de IA para este motor. Avise a su administrador." },
  credential_unusable: { code: 'engine_unavailable', ko: 'AI 연결을 쓸 수 없습니다(거절되었거나 다시 연결이 필요해요). 관리자에게 알려 주세요.', en: 'The AI connection cannot be used (refused, or it needs to be connected again). Let your admin know.', id: 'Koneksi AI tidak bisa dipakai (ditolak, atau perlu dihubungkan lagi). Beri tahu admin Anda.', ja: "AI接続を使用できません（拒否されたか、再接続が必要です）。管理者に知らせてください。", es: "La conexión de IA no se puede usar (se rechazó o debe volver a conectarse). Avise a su administrador." },
  // the engine started with, or asked the model for, a tool outside the lockdown (a Claude Code change, a planted agent
  // definition): the answer stops (server/src/chat/turn.ts lockdown check, the model proxy's tool-name check)
  lockdown: { code: 'engine_unavailable', ko: 'AI 엔진이 팀 서버가 허용하지 않는 도구를 쓰려고 해서 답변을 멈췄어요. 팀장에게 알려 주세요.', en: 'The answer was stopped because the AI engine tried to use tools the team server does not allow. Let the team owner know.', id: 'Jawaban dihentikan karena mesin AI mencoba memakai alat yang tidak diizinkan server tim. Beri tahu pemilik tim.', ja: "AIエンジンがチームサーバーで許可されていないツールを使おうとしたため、回答を停止しました。チームオーナーに知らせてください。", es: "Se detuvo la respuesta porque el motor de IA intentó usar herramientas que el servidor del equipo no permite. Avise al propietario del equipo." },
  // the API engine (server/src/engine/api-agent.ts): what the provider said, without its raw text
  model_not_found: { code: 'engine_unavailable', ko: 'AI 서비스에 설정한 모델이 없어요. 관리자에게 API 엔진의 모델 이름을 확인해 달라고 해 주세요.', en: 'The AI service does not know the model that is set. Ask your admin to check the model name of the API engine.', id: 'Layanan AI tidak mengenal model yang diatur. Minta admin memeriksa nama model mesin API.', ja: "設定されたモデルがAIサービスにありません。管理者にAPIエンジンのモデル名の確認を依頼してください。", es: "El servicio de IA no reconoce el modelo configurado. Pida a su administrador que revise el nombre del modelo del motor API." },
  endpoint_unreachable: { code: 'engine_unavailable', ko: 'AI 서비스 주소에 연결하지 못했어요. 잠시 뒤 다시 해 보고, 계속되면 관리자에게 API 주소를 확인해 달라고 해 주세요.', en: 'The AI service address could not be reached. Try again later. If it keeps happening, ask your admin to check the API address.', id: 'Alamat layanan AI tidak bisa dihubungi. Coba lagi nanti. Jika terus terjadi, minta admin memeriksa alamat API.', ja: "AIサービスのアドレスに接続できませんでした。後で再試行してください。続く場合は管理者にAPIアドレスの確認を依頼してください。", es: "No se pudo conectar con la dirección del servicio de IA. Reinténtelo más tarde. Si persiste, pida a su administrador que revise la dirección de la API." },
  provider_error: { code: 'engine_unavailable', ko: 'AI 서비스가 오류를 보냈어요. 다시 해 보고, 계속되면 관리자에게 알려 주세요.', en: 'The AI service sent back an error. Try again. If it keeps happening, let your admin know.', id: 'Layanan AI mengirim galat. Coba lagi. Jika terus terjadi, beri tahu admin Anda.', ja: "AIサービスからエラーが返されました。再試行してください。続く場合は管理者に知らせてください。", es: "El servicio de IA devolvió un error. Vuelva a intentarlo. Si persiste, avise a su administrador." },
} as const satisfies Record<string, { code: ErrorCode } & Record<Locale, string>>

export type ChatErrorReason = keyof typeof CHAT_ERROR_MESSAGES

/** Only called for assistant errors, never for user or assistant conversation content. */
export function chatErrorReason(error: ApiErrorBody): ChatErrorReason | null {
  const reason = error.params?.reason
  if (reason !== undefined) {
    if (typeof reason !== 'string' || !Object.hasOwn(CHAT_ERROR_MESSAGES, reason)) return null
    const known = reason as ChatErrorReason
    return CHAT_ERROR_MESSAGES[known].code === error.code ? known : null
  }
  for (const key of Object.keys(CHAT_ERROR_MESSAGES) as ChatErrorReason[]) {
    const text = CHAT_ERROR_MESSAGES[key]
    if (text.code === error.code && [text.ko, text.en, text.id, text.ja, text.es].some(message => message === error.message)) return key
  }
  return null
}
