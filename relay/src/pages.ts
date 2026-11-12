// What a visitor sees when the relay itself answers: the team server is offline, the address is not registered, or
// the address is suspended. HTML for browsers, the usual { error: { code, message } } JSON for API calls.
// Languages ko / en / id: the language the team's page last showed in this browser (the web app keeps it in the
// mycel_locale cookie of the team address; API calls carry it in X-Mycel-Locale), else English. The browser's own
// language does not decide, as on the team server (docs/DECISIONS.md "언어"); the relay cannot ask an offline team
// server for its default language.

import { createHash } from 'node:crypto'
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
    ko: { title: '팀 서버가 연결되어 있지 않아요', body: '팀 서버가 켜져 있는지 확인해 주세요: 서버 맥의 전원, 네트워크 연결, 잠자기 설정. 다시 연결되면 이 페이지를 새로 고치면 돼요.' },
    en: { title: 'The team server is not connected', body: 'Check that the team server is running: the server Mac\'s power, network connection and sleep settings. Reload this page once it is back.' },
    id: { title: 'Server tim tidak terhubung', body: 'Periksa apakah server tim menyala: daya Mac server, koneksi jaringan, dan pengaturan tidur. Muat ulang halaman ini setelah tersambung kembali.' }, ja: { title: "チームサーバーが接続されていません", body: "チームサーバーが起動しているか、サーバーのMacの電源、ネットワーク接続、スリープ設定を確認してください。復旧したらこのページを再読み込みしてください。" }, es: { title: "El servidor del equipo no está conectado", body: "Compruebe que el servidor esté funcionando: alimentación de la Mac, conexión de red y ajustes de reposo. Recargue esta página cuando se restablezca." },
  },
  team_unknown: {
    ko: { title: '등록되지 않은 팀 주소예요', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'This team address is not registered', body: 'Please check the address.' },
    id: { title: 'Alamat tim ini tidak terdaftar', body: 'Silakan periksa alamatnya.' }, ja: { title: "このチームアドレスは登録されていません", body: "アドレスを確認してください。" }, es: { title: "Esta dirección de equipo no está registrada", body: "Revise la dirección." },
  },
  team_suspended: {
    ko: { title: '이 팀 주소는 사용이 중지됐어요', body: '팀 관리자에게 문의해 주세요.' },
    en: { title: 'This team address has been suspended', body: 'Please contact your team administrator.' },
    id: { title: 'Alamat tim ini ditangguhkan', body: 'Silakan hubungi administrator tim Anda.' }, ja: { title: "このチームアドレスは停止されています", body: "チーム管理者にお問い合わせください。" }, es: { title: "Esta dirección de equipo está suspendida", body: "Contacte con el administrador de su equipo." },
  },
  team_busy: {
    ko: { title: '팀 서버가 바빠요', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server is busy', body: 'Please try again shortly.' },
    id: { title: 'Server tim sedang sibuk', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーは処理中です", body: "しばらくしてから再試行してください。" }, es: { title: "El servidor del equipo está ocupado", body: "Vuelva a intentarlo en un momento." },
  },
  team_timeout: {
    ko: { title: '팀 서버가 제때 응답하지 않았어요', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The team server did not answer in time', body: 'Please try again shortly.' },
    id: { title: 'Server tim tidak menjawab tepat waktu', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーが時間内に応答しませんでした", body: "しばらくしてから再試行してください。" }, es: { title: "El servidor del equipo no respondió a tiempo", body: "Vuelva a intentarlo en un momento." },
  },
  team_connection_lost: {
    ko: { title: '팀 서버와의 연결이 끊겼어요', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The connection to the team server was lost', body: 'Please try again shortly.' },
    id: { title: 'Koneksi ke server tim terputus', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "チームサーバーとの接続が切れました", body: "しばらくしてから再試行してください。" }, es: { title: "Se perdió la conexión con el servidor del equipo", body: "Vuelva a intentarlo en un momento." },
  },
  bad_gateway: {
    ko: { title: '요청을 처리하지 못했어요', body: '잠시 뒤 다시 시도해 주세요.' },
    en: { title: 'The request could not be completed', body: 'Please try again shortly.' },
    id: { title: 'Permintaan tidak dapat diselesaikan', body: 'Silakan coba lagi sebentar lagi.' }, ja: { title: "リクエストを完了できませんでした", body: "しばらくしてから再試行してください。" }, es: { title: "No se pudo completar la solicitud", body: "Vuelva a intentarlo en un momento." },
  },
  bad_request: {
    ko: { title: '잘못된 요청이에요', body: '주소를 다시 확인해 주세요.' },
    en: { title: 'Bad request', body: 'Please check the address.' },
    id: { title: 'Permintaan tidak valid', body: 'Silakan periksa alamatnya.' }, ja: { title: "リクエストが正しくありません", body: "アドレスを確認してください。" }, es: { title: "Solicitud incorrecta", body: "Revise la dirección." },
  },
  request_timeout: {
    ko: { title: '요청을 보내는 중에 연결이 멈췄어요', body: '네트워크 연결을 확인하고 다시 시도해 주세요.' },
    en: { title: 'The request stopped arriving', body: 'Check your network connection and try again.' },
    id: { title: 'Pengiriman permintaan terhenti', body: 'Periksa koneksi jaringan Anda lalu coba lagi.' }, ja: { title: "リクエストの受信が途絶えました", body: "ネットワーク接続を確認して再試行してください。" }, es: { title: "Se interrumpió la recepción de la solicitud", body: "Revise su conexión de red y vuelva a intentarlo." },
  },
  not_found: {
    ko: { title: '찾을 수 없어요', body: '' },
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

// ---------------------------------------------------------------- request head too big

/**
 * The browser sent more cookies than the relay reads (MAX_REQUEST_HEAD): usually cookies some page under the shared
 * parent domain left there (QA TC-346). The relay could not read the head, so it knows neither the address nor the
 * language; the page picks the language from the mycel_locale cookie in the browser and offers a button that removes
 * the cookies of the parent domain(s) only. The team's own sign-in (__Host-sid: host-only, HttpOnly) stays. No
 * Clear-Site-Data: "cookies" clears the whole registrable domain, so it would sign the person out of every team and
 * the account console, and whoever planted the cookies decides when this page shows.
 */
const HEAD_TOO_BIG: Record<Lang, { title: string; body: string; button: string; after: string }> = {
  en: {
    title: 'This page cannot open: your browser is sending too many cookies',
    body: 'A website under the same main address left a large number of cookies in this browser. Press the button below to remove them. You stay signed in.',
    button: 'Remove the extra cookies and reload',
    after: 'If this page comes back, open your browser settings, delete the cookies (site data) for %SITE%, and sign in again. A private window also works.',
  },
  ko: {
    title: '브라우저가 쿠키를 너무 많이 보내서 페이지를 열 수 없어요',
    body: '같은 기본 주소를 쓰는 다른 사이트가 이 브라우저에 쿠키를 잔뜩 남겼어요. 아래 버튼을 누르면 지워져요. 로그인은 그대로 유지돼요.',
    button: '불필요한 쿠키 지우고 다시 열기',
    after: '이 페이지가 또 나오면 브라우저 설정에서 %SITE%의 쿠키(사이트 데이터)를 삭제한 뒤 다시 로그인해 주세요. 시크릿 창에서 열어도 돼요.',
  },
  id: {
    title: 'Halaman ini tidak bisa dibuka: browser Anda mengirim terlalu banyak cookie',
    body: 'Sebuah situs di bawah alamat utama yang sama meninggalkan banyak cookie di browser ini. Tekan tombol di bawah untuk menghapusnya. Anda tetap masuk.',
    button: 'Hapus cookie berlebih dan muat ulang',
    after: 'Jika halaman ini muncul lagi, buka pengaturan browser, hapus cookie (data situs) untuk %SITE%, lalu masuk lagi. Jendela pribadi juga bisa dipakai.',
  },
  ja: {
    title: 'ブラウザーが送るCookieが多すぎるため、このページを開けません',
    body: '同じメインアドレスの別のサイトが、このブラウザーに大量のCookieを残しました。下のボタンを押すと削除されます。ログインはそのままです。',
    button: '余分なCookieを削除して再読み込み',
    after: 'このページがまた表示される場合は、ブラウザーの設定で%SITE%のCookie（サイトデータ）を削除し、もう一度ログインしてください。プライベートウィンドウでも開けます。',
  },
  es: {
    title: 'Esta página no se puede abrir: su navegador envía demasiadas cookies',
    body: 'Un sitio bajo la misma dirección principal dejó muchas cookies en este navegador. Pulse el botón de abajo para borrarlas. Seguirá con la sesión iniciada.',
    button: 'Borrar las cookies sobrantes y recargar',
    after: 'Si esta página vuelve a aparecer, abra la configuración del navegador, borre las cookies (datos del sitio) de %SITE% e inicie sesión de nuevo. Una ventana privada también sirve.',
  },
}

// Runs in the visitor's browser. Removes every cookie it can see from each parent domain of this address and each
// path up to this page, with and without a trailing slash (the ones a page elsewhere can have set; host-only cookies
// are left alone), then reloads. On https each one is also removed as a Partitioned cookie (a partitioned cookie on
// the parent is a separate cookie). A nameless cookie shows as its value only and is removed by writing that value.
const HEAD_TOO_BIG_SCRIPT = `(function(){var T=${JSON.stringify(HEAD_TOO_BIG).replace(/</g, '\\u003c')};
var m=/(?:^|;\\s*)${LOCALE_COOKIE}=(ko|en|id|ja|es)(?:;|$)/.exec(document.cookie);var l=m?m[1]:'en',t=T[l];
var h=location.hostname.split('.'),ds=[];for(var i=1;i<h.length-1;i++)ds.push(h.slice(i).join('.'));
var site=ds.length?ds[ds.length-1]:location.hostname;
document.documentElement.lang=l;document.title=t.title;
document.getElementById('t').textContent=t.title;document.getElementById('b').textContent=t.body;
document.getElementById('a').textContent=t.after.replace('%SITE%',site);
var btn=document.getElementById('x');btn.textContent=t.button;btn.hidden=!ds.length;
btn.onclick=function(){var ps=['/'],p='';location.pathname.split('/').slice(1).forEach(function(s){if(!s)return;p+='/'+s;ps.push(p,p+'/')});
var https=location.protocol==='https:',ends=https?['; Secure','; Secure; Partitioned']:[''];
document.cookie.split(';').forEach(function(c){c=c.trim();if(!c||c.indexOf('__Host-')===0)return;var i=c.indexOf('='),k=i<0?c:c.slice(0,i)+'=';
ds.forEach(function(d){ps.forEach(function(q){ends.forEach(function(e){document.cookie=k+'; Domain='+d+'; Path='+q+'; Max-Age=0'+e})})})});
location.reload()}})()`

/** before the script runs (or without scripts): the first sentence only, there is no button yet */
const NO_SCRIPT_WHY = 'A website under the same main address left a large number of cookies in this browser.'

function headTooBigHtml(): string {
  const t = HEAD_TOO_BIG.en
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",sans-serif;background:#f6f7f6;color:#1d2420;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}main{max-width:520px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4a554f;margin:0 0 16px}button{font:inherit;font-weight:600;padding:10px 16px;border-radius:8px;border:0;background:#1d2420;color:#fff;cursor:pointer;margin:0 0 16px}@media (prefers-color-scheme:dark){body{background:#151816;color:#e8ece9}p{color:#a9b3ad}button{background:#e8ece9;color:#151816}}</style></head>
<body><main><h1 id="t">${esc(t.title)}</h1><p id="b">${esc(NO_SCRIPT_WHY)}</p><button id="x" type="button" hidden></button><p id="a">${esc(t.after.replace('%SITE%', 'this website'))}</p></main>
<script>${HEAD_TOO_BIG_SCRIPT}</script></body></html>`
}

/** The whole raw HTTP/1.1 answer (written on the socket: the request was never parsed). 431, closes the connection. */
export function headTooBigResponse(hsts: string | null = null): string {
  const body = headTooBigHtml()
  const hash = createHash('sha256').update(HEAD_TOO_BIG_SCRIPT).digest('base64')
  return 'HTTP/1.1 431 Request Header Fields Too Large\r\n'
    + 'content-type: text/html; charset=utf-8\r\n'
    + `content-length: ${Buffer.byteLength(body)}\r\n`
    + 'cache-control: no-store\r\n'
    + 'x-relay-error: request_too_big\r\n'
    + 'x-content-type-options: nosniff\r\n'
    + (hsts ? `strict-transport-security: ${hsts}\r\n` : '')
    + `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n`
    + 'connection: close\r\n\r\n'
    + body
}
