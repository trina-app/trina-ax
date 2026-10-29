// What a visitor sees when the relay itself answers: the team server is offline, the address is not registered, or
// the address is suspended. HTML for browsers, the usual { error: { code, message } } JSON for API calls.
// Languages ko / en / id: the language the team's page last showed in this browser (the web app keeps it in the
// mycel_locale cookie of the team address; API calls carry it in X-Mycel-Locale), else English. The browser's own
// language does not decide, as on the team server (docs/DECISIONS.md "언어"); the relay cannot ask an offline team
// server for its default language.

import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'

export type PageKind =
  | 'team_offline' | 'team_unknown' | 'team_suspended' | 'team_busy' | 'team_timeout' | 'team_connection_lost' | 'bad_gateway'
  | 'not_found' | 'bad_request' | 'request_timeout'
  /** suspended for billing / canceled (control-plane 3.6.4): the owner sorts it out in the account console */
  | 'team_suspended_billing'
  /** the control plane is updating the team server (relay maintenance window) and it is offline meanwhile */
  | 'team_maintenance'
  /** a hosted (cloud) team (origin cloud) is offline: no "check the server Mac" advice */
  | 'team_offline_cloud'
type Lang = 'ko' | 'en' | 'id' | 'ja' | 'es'

/** Name of the cookie the web app writes with the language on screen (web/src/i18n/index.ts). */
export const LOCALE_COOKIE = 'mycel_locale'

const asLang = (v: string | undefined | null): Lang | null => (v === 'ko' || v === 'en' || v === 'id' || v === 'ja' || v === 'es' ? v : null)

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
  if (lang === 'ja') return ms < 60_000 ? '（たった今）' : `（${m}分間）`
  if (lang === 'es') return ms < 60_000 ? ' (ahora mismo)' : ` (desde hace ${m} min)`
  return ms < 60_000 ? ' (just now)' : ` (for ${m} min)`
}

const TEXT: Record<PageKind, Record<Lang, { title: string; body: string }>> = {
  team_offline: {
    ko: { title: '팀 서버가 연결되어 있지 않습니다', body: '팀 서버가 켜져 있는지 확인해 주세요: 서버 맥의 전원, 네트워크 연결, 잠자기 설정. 다시 연결되면 이 페이지를 새로 고치면 됩니다.' },
    en: { title: 'The team server is not connected', body: 'Check that the team server is running: the server Mac\'s power, network connection and sleep settings. Reload this page once it is back.' },
    id: { title: 'Server tim tidak terhubung', body: 'Periksa apakah server tim menyala: daya Mac server, koneksi jaringan, dan pengaturan tidur. Muat ulang halaman ini setelah tersambung kembali.' }, ja: { title: "チームサーバーが接続されていません", body: "チームサーバーが起動しているか、サーバーのMacの電源、ネットワーク接続、スリープ設定を確認してください。復旧したらこのページを再読み込みしてください。" }, es: { title: "El servidor del equipo no está conectado", body: "Compruebe que el servidor esté funcionando: alimentación de la Mac, conexión de red y ajustes de reposo. Recargue esta página cuando se restablezca." },
  },
  team_unknown: {
    ko: { title: '등록되지 않은 팀 주소입니다', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'This team address is not registered', body: 'Please check the address.' },
    id: { title: 'Alamat tim ini tidak terdaftar', body: 'Silakan periksa alamatnya.' }, ja: { title: "このチームアドレスは登録されていません", body: "アドレスを確認してください。" }, es: { title: "Esta dirección de equipo no está registrada", body: "Revise la dirección." },
  },
  team_suspended: {
    ko: { title: '이 팀 주소는 사용이 중지되었습니다', body: '팀 관리자에게 문의해 주세요.' },
    en: { title: 'This team address has been suspended', body: 'Please contact your team administrator.' },
    id: { title: 'Alamat tim ini ditangguhkan', body: 'Silakan hubungi administrator tim Anda.' }, ja: { title: "このチームアドレスは停止されています", body: "チーム管理者にお問い合わせください。" }, es: { title: "Esta dirección de equipo está suspendida", body: "Contacte con el administrador de su equipo." },
  },
  team_busy: {
    ko: { title: '팀 서버가 바쁩니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server is busy', body: 'Please try again shortly.' },
    id: { title: 'Server tim sedang sibuk', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーは処理中です", body: "しばらくしてから再試行してください。" }, es: { title: "El servidor del equipo está ocupado", body: "Vuelva a intentarlo en un momento." },
  },
  team_timeout: {
    ko: { title: '팀 서버가 제때 응답하지 않았습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server did not answer in time', body: 'Please try again shortly.' },
    id: { title: 'Server tim tidak menjawab tepat waktu', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーが時間内に応答しませんでした", body: "しばらくしてから再試行してください。" }, es: { title: "El servidor del equipo no respondió a tiempo", body: "Vuelva a intentarlo en un momento." },
  },
  team_connection_lost: {
    ko: { title: '팀 서버와의 연결이 끊겼습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The connection to the team server was lost', body: 'Please try again shortly.' },
    id: { title: 'Koneksi ke server tim terputus', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーとの接続が切れました", body: "しばらくしてから再試行してください。" }, es: { title: "Se perdió la conexión con el servidor del equipo", body: "Vuelva a intentarlo en un momento." },
  },
  bad_gateway: {
    ko: { title: '요청을 처리하지 못했습니다', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The request could not be completed', body: 'Please try again shortly.' },
    id: { title: 'Permintaan tidak dapat diselesaikan', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "リクエストを完了できませんでした", body: "しばらくしてから再試行してください。" }, es: { title: "No se pudo completar la solicitud", body: "Vuelva a intentarlo en un momento." },
  },
  bad_request: {
    ko: { title: '잘못된 요청입니다', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'Bad request', body: 'Please check the address.' },
    id: { title: 'Permintaan tidak valid', body: 'Silakan periksa alamatnya.' }, ja: { title: "リクエストが正しくありません", body: "アドレスを確認してください。" }, es: { title: "Solicitud incorrecta", body: "Revise la dirección." },
  },
  request_timeout: {
    ko: { title: '요청을 보내는 중에 연결이 멈췄습니다', body: '네트워크 연결을 확인하고 다시 시도해 주세요.' },
    en: { title: 'The request stopped arriving', body: 'Check your network connection and try again.' },
    id: { title: 'Pengiriman permintaan terhenti', body: 'Periksa koneksi jaringan Anda lalu coba lagi.' }, ja: { title: "リクエストの受信が途絶えました", body: "ネットワーク接続を確認して再試行してください。" }, es: { title: "Se interrumpió la recepción de la solicitud", body: "Revise su conexión de red y vuelva a intentarlo." },
  },
  not_found: {
    ko: { title: '찾을 수 없습니다', body: '' },
    en: { title: 'Not found', body: '' },
    id: { title: 'Tidak ditemukan', body: '' }, ja: { title: "見つかりません", body: "" }, es: { title: "No se encontró", body: "" },
  },
  team_suspended_billing: {
    ko: { title: '이 팀의 이용이 잠시 멈췄어요', body: '팀 대표는 %ACCOUNT%에서 결제 정보를 확인해 주세요.' },
    en: { title: "This team's service is paused", body: 'The team owner can check the payment details at %ACCOUNT%.' },
    id: { title: 'Layanan tim ini sedang dijeda', body: 'Pemilik tim dapat memeriksa informasi pembayaran di %ACCOUNT%.' }, ja: { title: "このチームのサービスは一時停止中です", body: "チームオーナーは%ACCOUNT%で支払いの詳細を確認できます。" }, es: { title: "El servicio de este equipo está en pausa", body: "El propietario del equipo puede consultar los detalles de pago en %ACCOUNT%." },
  },
  team_maintenance: {
    ko: { title: '팀 서버를 업데이트하고 있어요', body: '보통 1–2분이면 끝나요. 잠시 뒤 새로 고쳐 주세요.' },
    en: { title: 'The team server is being updated', body: 'This usually takes a minute or two. Reload this page shortly.' },
    id: { title: 'Server tim sedang diperbarui', body: 'Biasanya selesai dalam satu atau dua menit. Muat ulang halaman ini sebentar lagi.' }, ja: { title: "チームサーバーを更新中です", body: "通常1～2分かかります。しばらくしてからこのページを再読み込みしてください。" }, es: { title: "El servidor del equipo se está actualizando", body: "Suele tardar uno o dos minutos. Recargue esta página en breve." },
  },
  team_offline_cloud: {
    ko: { title: '팀 서버에 잠깐 연결되지 않아요', body: '잠시 뒤 새로 고쳐 주세요. 서비스 상태: %STATUS%' },
    en: { title: "The team server can't be reached right now", body: 'Reload this page in a moment. Service status: %STATUS%' },
    id: { title: 'Server tim sedang tidak dapat dijangkau', body: 'Muat ulang halaman ini sebentar lagi. Status layanan: %STATUS%' }, ja: { title: "現在チームサーバーに接続できません", body: "しばらくしてからこのページを再読み込みしてください。サービス稼働状況：%STATUS%" }, es: { title: "No se puede conectar con el servidor del equipo ahora", body: "Recargue esta página en un momento. Estado del servicio: %STATUS%" },
  },
}

/** Hosts the cloud pages point to (RELAY_ACCOUNT_HOST / RELAY_STATUS_HOST). */
export interface PageLinks { account: string; status: string }
export const DEFAULT_PAGE_LINKS: PageLinks = { account: SERVICE_HOSTS.accountHost, status: SERVICE_HOSTS.statusHost }
const fill = (s: string, links: PageLinks) => s.replace('%ACCOUNT%', links.account).replace('%STATUS%', links.status)

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function pageMessage(kind: PageKind, lang: Lang, offlineForMs: number | null = null): string {
  const t = TEXT[kind][lang]
  return kind === 'team_offline' ? t.title + minutesText(lang, offlineForMs) : t.title
}

export function pageBody(kind: PageKind, lang: Lang, links: PageLinks = DEFAULT_PAGE_LINKS): string {
  return fill(TEXT[kind][lang].body, links)
}

export function htmlPage(kind: PageKind, lang: Lang, offlineForMs: number | null = null, links: PageLinks = DEFAULT_PAGE_LINKS): string {
  const t = { title: TEXT[kind][lang].title, body: pageBody(kind, lang, links) }
  const title = pageMessage(kind, lang, offlineForMs)
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;background:#f6f7f6;color:#1d2420;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}main{max-width:520px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4a554f;margin:0}@media (prefers-color-scheme:dark){body{background:#151816;color:#e8ece9}p{color:#a9b3ad}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(t.body)}</p></main></body></html>`
}

export const PAGE_STATUS: Record<PageKind, number> = {
  team_offline: 503, team_unknown: 404, team_suspended: 403, team_busy: 503, team_timeout: 504, team_connection_lost: 502, bad_gateway: 502, not_found: 404,
  bad_request: 400, request_timeout: 408, team_suspended_billing: 403, team_maintenance: 503, team_offline_cloud: 503,
}
/** Retry-After of the 503 pages: an update takes a minute or two */
export const PAGE_RETRY_AFTER: Partial<Record<PageKind, number>> = { team_offline: 5, team_busy: 5, team_offline_cloud: 5, team_maintenance: 30 }
