// User-facing error messages per code and language (tab 4: `message` is in the user's language).
// Handlers may pass their own, more specific message; these are the defaults.
import { DEFAULT_LOCALE, asLocale, type ApiErrorBody, type ErrorCode, type Locale } from './common'

export const ERROR_MESSAGES: Record<ErrorCode, Record<Locale, string>> = {
  bad_request: { ko: '요청 형식이 올바르지 않습니다.', en: 'The request is malformed.', id: 'Format permintaan tidak valid.' },
  validation: { ko: '입력값을 확인해 주세요.', en: 'Please check the input.', id: 'Periksa kembali isian Anda.' },
  unauthorized: { ko: '로그인이 필요합니다.', en: 'Please sign in.', id: 'Silakan masuk terlebih dahulu.' },
  password_change_required: { ko: '비밀번호를 먼저 바꿔 주세요.', en: 'Please change your password first.', id: 'Silakan ganti kata sandi Anda terlebih dahulu.' },
  forbidden: { ko: '권한이 없습니다.', en: 'You do not have permission to do this.', id: 'Anda tidak memiliki izin.' },
  csrf: { ko: '보안 확인에 실패했습니다. 페이지를 새로 고쳐 주세요.', en: 'Security check failed. Please reload the page.', id: 'Pemeriksaan keamanan gagal. Muat ulang halaman.' },
  not_found: { ko: '찾을 수 없거나 접근 권한이 없습니다.', en: 'Not found or no access.', id: 'Tidak ditemukan atau tidak ada akses.' },
  conflict: { ko: '다른 변경과 충돌했습니다. 새로 고친 뒤 다시 시도해 주세요.', en: 'This conflicts with another change. Reload and try again.', id: 'Bertabrakan dengan perubahan lain. Muat ulang lalu coba lagi.' },
  gone: { ko: '만료되었거나 더 이상 사용할 수 없습니다.', en: 'This has expired or is no longer available.', id: 'Sudah kedaluwarsa atau tidak tersedia lagi.' },
  payload_too_large: { ko: '파일이 너무 큽니다.', en: 'The file is too large.', id: 'Berkas terlalu besar.' },
  range_not_satisfiable: { ko: '요청한 범위를 보낼 수 없습니다.', en: 'The requested range is not available.', id: 'Rentang yang diminta tidak tersedia.' },
  rate_limited: { ko: '요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.', en: 'Too many requests. Please try again shortly.', id: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' },
  budget_exceeded: { ko: 'AI 사용 한도에 도달했습니다. 관리자에게 문의해 주세요.', en: 'The AI usage limit has been reached. Please contact your admin.', id: 'Batas penggunaan AI tercapai. Hubungi admin Anda.' },
  engine_unavailable: { ko: '지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).', en: 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).', id: 'Mesin AI sedang tidak tersedia. Beri tahu pemilik tim (Admin > Sistem > Diagnostik menunjukkan penyebabnya).' },
  busy: { ko: '지금은 처리할 수 없습니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.', en: 'Busy right now. Try again when the running work is done.', id: 'Sedang sibuk. Coba lagi setelah pekerjaan yang berjalan selesai.' },
  unavailable: { ko: '팀 서버가 잠시 사용할 수 없습니다.', en: 'The team server is temporarily unavailable.', id: 'Server tim sementara tidak tersedia.' },
  internal: { ko: '서버 오류가 발생했습니다.', en: 'Something went wrong on the server.', id: 'Terjadi kesalahan pada server.' },
  storage_full: { ko: '저장 공간이 가득 찼습니다. 휴지통을 비우거나 파일을 정리해 주세요.', en: 'The storage is full. Empty the trash or clean up files.', id: 'Penyimpanan penuh. Kosongkan tempat sampah atau rapikan berkas.' },
  plan_limit: { ko: '요금제 한도를 넘습니다. 요금제를 바꾸거나 쓰지 않는 계정을 꺼 주세요.', en: 'This goes over the plan. Change the plan, or disable an account that is no longer used.', id: 'Ini melebihi batas paket. Ubah paket, atau nonaktifkan akun yang tidak dipakai lagi.' },
}

export function errorMessage(code: ErrorCode, locale: Locale): string {
  return ERROR_MESSAGES[code][locale] ?? ERROR_MESSAGES[code][DEFAULT_LOCALE]
}

/** Pick ko/en/id from an Accept-Language header (default en). The team server no longer uses it (the team default
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
  auth: { code: 'engine_unavailable', ko: 'AI 연결에 문제가 있습니다. 관리자에게 AI 연결을 확인해 달라고 해 주세요.', en: 'The AI connection has a problem. Ask your admin to check the AI connection.', id: 'Koneksi AI bermasalah. Minta admin memeriksa koneksi AI.' },
  rate_limit: { code: 'rate_limited', ko: 'AI 사용 한도에 잠시 도달했습니다. 조금 뒤 다시 시도해 주세요.', en: 'The AI usage limit was reached for now. Try again a bit later.', id: 'Batas penggunaan AI tercapai untuk sementara. Coba lagi nanti.' },
  context: { code: 'payload_too_large', ko: '대화가 너무 길어졌습니다. 새 채팅에서 이어 가 주세요.', en: 'This conversation got too long. Please continue in a new chat.', id: 'Percakapan ini terlalu panjang. Lanjutkan di chat baru.' },
  timeout: { code: 'busy', ko: '시간 제한을 넘겨 답변을 멈췄습니다.', en: 'The answer was stopped because it took too long.', id: 'Jawaban dihentikan karena terlalu lama.' },
  wall_timeout: { code: 'busy', ko: '확인 대기를 포함한 전체 실행 시간 제한을 넘겨 답변을 멈췄습니다.', en: 'The answer reached its total time limit, including time waiting for confirmation.', id: 'Jawaban mencapai batas waktu total, termasuk waktu menunggu konfirmasi.' },
  refused: { code: 'forbidden', ko: 'AI가 이 요청에 답하지 않았습니다. 표현을 바꿔 다시 시도해 주세요.', en: 'The AI declined this request. Try rephrasing it.', id: 'AI menolak permintaan ini. Coba ubah kalimatnya.' },
  crash: { code: 'internal', ko: 'AI 엔진이 예기치 않게 멈췄습니다. 다시 시도해 주세요.', en: 'The AI engine stopped unexpectedly. Please try again.', id: 'Mesin AI berhenti tiba-tiba. Coba lagi.' },
  interrupted: { code: 'unavailable', ko: '서버가 다시 시작되어 답변이 중단되었습니다.', en: 'The answer was interrupted because the server restarted.', id: 'Jawaban terputus karena server dimulai ulang.' },
  engine_missing: { code: 'engine_unavailable', ko: '지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요(관리자 > 시스템 > 진단에서 원인을 볼 수 있어요).', en: 'The AI engine is not available right now. Let the team owner know (Admin > System > Diagnostics shows why).', id: 'Mesin AI sedang tidak tersedia. Beri tahu pemilik tim (Admin > Sistem > Diagnostik menunjukkan penyebabnya).' },
  proxy_down: { code: 'engine_unavailable', ko: 'AI 연결 통로(모델 프록시)가 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하고, 계속되면 팀장에게 알려 주세요.', en: 'The AI connection (model proxy) is not ready. Try again in a moment; if it keeps happening, let the team owner know.', id: 'Koneksi AI (proxy model) belum siap. Coba lagi sebentar lagi; jika terus terjadi, beri tahu pemilik tim.' },
  user_disabled: { code: 'forbidden', ko: '계정을 사용할 수 없습니다.', en: 'This account is not active.', id: 'Akun ini tidak aktif.' },
  no_credential: { code: 'engine_unavailable', ko: '이 엔진에 쓸 AI 연결이 없습니다. 관리자에게 알려 주세요.', en: 'There is no AI connection for this engine. Let your admin know.', id: 'Tidak ada koneksi AI untuk mesin ini. Beri tahu admin Anda.' },
  credential_unusable: { code: 'engine_unavailable', ko: 'AI 연결을 쓸 수 없습니다(거절되었거나 다시 연결이 필요해요). 관리자에게 알려 주세요.', en: 'The AI connection cannot be used (refused, or it needs to be connected again). Let your admin know.', id: 'Koneksi AI tidak bisa dipakai (ditolak, atau perlu dihubungkan lagi). Beri tahu admin Anda.' },
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
    if (text.code === error.code && [text.ko, text.en, text.id].some(message => message === error.message)) return key
  }
  return null
}
