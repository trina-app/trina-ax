// User-facing error messages per code and language (tab 4: `message` is in the user's language).
// Handlers may pass their own, more specific message; these are the defaults.
import { DEFAULT_LOCALE, asLocale, type ErrorCode, type Locale } from './common'

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
