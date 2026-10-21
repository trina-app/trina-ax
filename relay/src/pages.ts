// What a visitor sees when the relay itself answers: the team server is offline, the address is not registered, or
// the address is suspended. HTML for browsers, the usual { error: { code, message } } JSON for API calls.
// Languages ko / en / id: the language the team's page last showed in this browser (the web app keeps it in the
// mycel_locale cookie of the team address; API calls carry it in X-Mycel-Locale), else English. The browser's own
// language does not decide, as on the team server (docs/DECISIONS.md "언어"); the relay cannot ask an offline team
// server for its default language.

export type PageKind =
  | 'team_offline' | 'team_unknown' | 'team_suspended' | 'team_busy' | 'team_timeout' | 'team_connection_lost' | 'bad_gateway'
  | 'not_found' | 'bad_request' | 'request_timeout'
type Lang = 'ko' | 'en' | 'id'

/** Name of the cookie the web app writes with the language on screen (web/src/i18n/index.ts). */
export const LOCALE_COOKIE = 'mycel_locale'

const asLang = (v: string | undefined | null): Lang | null => (v === 'ko' || v === 'en' || v === 'id' ? v : null)

export function pickLang(headers: { cookie?: string; 'x-mycel-locale'?: string | string[] }): Lang {
  const header = headers['x-mycel-locale']
  const fromHeader = asLang(Array.isArray(header) ? header[0] : header)
  if (fromHeader) return fromHeader
  for (const part of (headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === LOCALE_COOKIE) { const l = asLang(v?.trim()); if (l) return l }
  }
  return 'en'
}

function minutesText(lang: Lang, ms: number | null): string {
  if (ms === null) return ''
  const m = Math.max(1, Math.round(ms / 60_000))
  if (lang === 'ko') return ms < 60_000 ? ' (방금 끊김)' : ` (${m}분째)`
  if (lang === 'id') return ms < 60_000 ? ' (baru saja terputus)' : ` (sudah ${m} menit)`
  return ms < 60_000 ? ' (just now)' : ` (for ${m} min)`
}

const TEXT: Record<PageKind, Record<Lang, { title: string; body: string }>> = {
  team_offline: {
    ko: { title: '팀 서버가 연결되어 있지 않습니다', body: '팀 서버가 켜져 있는지 확인해 주세요: 서버 맥의 전원, 네트워크 연결, 잠자기 설정. 다시 연결되면 이 페이지를 새로 고치면 됩니다.' },
    en: { title: 'The team server is not connected', body: 'Check that the team server is running: the server Mac\'s power, network connection and sleep settings. Reload this page once it is back.' },
    id: { title: 'Server tim tidak terhubung', body: 'Periksa apakah server tim menyala: daya Mac server, koneksi jaringan, dan pengaturan tidur. Muat ulang halaman ini setelah tersambung kembali.' },
  },
  team_unknown: {
    ko: { title: '등록되지 않은 팀 주소입니다', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'This team address is not registered', body: 'Please check the address.' },
    id: { title: 'Alamat tim ini tidak terdaftar', body: 'Silakan periksa alamatnya.' },
  },
  team_suspended: {
    ko: { title: '이 팀 주소는 사용이 중지되었습니다', body: '팀 관리자에게 문의해 주세요.' },
    en: { title: 'This team address has been suspended', body: 'Please contact your team administrator.' },
    id: { title: 'Alamat tim ini ditangguhkan', body: 'Silakan hubungi administrator tim Anda.' },
  },
  team_busy: {
    ko: { title: '팀 서버가 바쁩니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server is busy', body: 'Please try again shortly.' },
    id: { title: 'Server tim sedang sibuk', body: 'Silakan coba lagi sebentar lagi.' },
  },
  team_timeout: {
    ko: { title: '팀 서버가 제때 응답하지 않았습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server did not answer in time', body: 'Please try again shortly.' },
    id: { title: 'Server tim tidak menjawab tepat waktu', body: 'Silakan coba lagi sebentar lagi.' },
  },
  team_connection_lost: {
    ko: { title: '팀 서버와의 연결이 끊겼습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The connection to the team server was lost', body: 'Please try again shortly.' },
    id: { title: 'Koneksi ke server tim terputus', body: 'Silakan coba lagi sebentar lagi.' },
  },
  bad_gateway: {
    ko: { title: '요청을 처리하지 못했습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The request could not be completed', body: 'Please try again shortly.' },
    id: { title: 'Permintaan tidak dapat diselesaikan', body: 'Silakan coba lagi sebentar lagi.' },
  },
  bad_request: {
    ko: { title: '잘못된 요청입니다', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'Bad request', body: 'Please check the address.' },
    id: { title: 'Permintaan tidak valid', body: 'Silakan periksa alamatnya.' },
  },
  request_timeout: {
    ko: { title: '요청을 보내는 중에 연결이 멈췄습니다', body: '네트워크 연결을 확인하고 다시 시도해 주세요.' },
    en: { title: 'The request stopped arriving', body: 'Check your network connection and try again.' },
    id: { title: 'Pengiriman permintaan terhenti', body: 'Periksa koneksi jaringan Anda lalu coba lagi.' },
  },
  not_found: {
    ko: { title: '찾을 수 없습니다', body: '' },
    en: { title: 'Not found', body: '' },
    id: { title: 'Tidak ditemukan', body: '' },
  },
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function pageMessage(kind: PageKind, lang: Lang, offlineForMs: number | null = null): string {
  const t = TEXT[kind][lang]
  return kind === 'team_offline' ? t.title + minutesText(lang, offlineForMs) : t.title
}

export function htmlPage(kind: PageKind, lang: Lang, offlineForMs: number | null = null): string {
  const t = TEXT[kind][lang]
  const title = pageMessage(kind, lang, offlineForMs)
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;background:#f6f7f6;color:#1d2420;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}main{max-width:520px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4a554f;margin:0}@media (prefers-color-scheme:dark){body{background:#151816;color:#e8ece9}p{color:#a9b3ad}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(t.body)}</p></main></body></html>`
}

export const PAGE_STATUS: Record<PageKind, number> = {
  team_offline: 503, team_unknown: 404, team_suspended: 403, team_busy: 503, team_timeout: 504, team_connection_lost: 502, bad_gateway: 502, not_found: 404,
  bad_request: 400, request_timeout: 408,
}
