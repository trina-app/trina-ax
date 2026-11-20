// The page Google (or the hosting service) sends the browser back to after a Google sign-in, for Google Drive
// (routes/drive.ts) and Gmail, Calendar, Docs and Sheets (routes/google-apps.ts): in the person's language (the request's
// locale, as the other connections' return page, routes/integrations.ts), with why it did not work and one next step
// (QA TC-2956, TC-2978, TC-2979). A sign-in that worked is not done yet: the person confirms the account in the app, so
// the page says so, never "received" or "connected". Static words and one same-origin link only: the code and the
// state never go anywhere else.
//
// A sign-in started in the desktop or phone app ends here in the system browser, not in the app: the page never sends
// that browser on to the web app. It says to go back to the app (where the account is confirmed), with a button that
// opens the desktop app (`<linkScheme>://open?url=<this team>/`), and the tab may be closed. Google's answer in a
// browser without a session, for a desktop flow, waits for the app: the button carries the one-time code in the
// link's fragment (app-return.ts). A browser not signed in otherwise gets a way on: sign in and connect here, or go
// back to the app.
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { appLink } from './app-return'

export type AppClient = 'desktop' | 'mobile'

/** What the page says: the sign-in came back (confirm it in the app), or why it did not. */
export type GoogleReturn = 'ok' | 'cancelled' | 'denied_service' | 'scope' | 'expired' | 'signed_out' | 'other_account' | 'failed'

/** How a sign-in ended, as the Drive and Google apps services report it: ok, or the flow's reason code. */
/** `app`: the app whose session started the sign-in; `code`: the one-time code for the desktop app that finishes a
 * sign-in Google answered in a browser without a session (app-return.ts). */
export type CallbackOutcome = { ok: true; app?: AppClient | null; code?: string } | { ok: false; reason: string; app?: AppClient | null }

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

type Extra = 'title' | 'login' | 'okApp' | 'okCode' | 'signedOutApp' | 'backToApp' | 'loginAgain' | 'hOk' | 'hOkApp' | 'hNot' | 'hSignedOut'
const TEXT: Record<GoogleReturn | Extra, T> = {
  title: t('Google 로그인', 'Google sign-in', 'Login Google', 'Google ログイン', 'Inicio de sesión de Google', 'Google 登录'),
  hOk: t('거의 다 됐어요', 'Almost done', 'Hampir selesai', 'あと少しです', 'Casi listo', '快完成了'),
  hOkApp: t('연결됐어요', 'Connected', 'Terhubung', '接続しました', 'Conectado', '已连接'),
  hNot: t('연결하지 못했어요', 'Not connected', 'Tidak terhubung', '接続できませんでした', 'No se conectó', '未连接'),
  hSignedOut: t('이 브라우저에서는 마칠 수 없어요', 'This browser can’t finish it', 'Browser ini tidak bisa menyelesaikannya', 'このブラウザーでは完了できません', 'Este navegador no puede terminarlo', '这个浏览器无法完成'),
  okApp: t(
    '{product} 앱으로 돌아가세요. 앱에서 계정을 확인하면 끝나요. 이 탭은 닫아도 돼요.',
    'Go back to the {product} app and confirm the account there to finish. You can close this tab.',
    'Kembali ke aplikasi {product} dan konfirmasi akunnya di sana untuk menyelesaikan. Tab ini boleh ditutup.',
    '{product} アプリに戻り、アカウントを確認すると完了です。このタブは閉じてかまいません。',
    'Vuelva a la aplicación {product} y confirme la cuenta allí para terminar. Puede cerrar esta pestaña.',
    '回到 {product} 应用，在那里确认账号即可完成。这个标签页可以关闭。'),
  okCode: t(
    '아래 버튼을 눌러 {product} 앱으로 돌아가면 연결이 끝나요. 앱에서 계정을 확인해 주세요. 그다음 이 탭은 닫아도 돼요.',
    'Press the button below to go back to the {product} app and finish connecting. Confirm the account there; then you can close this tab.',
    'Tekan tombol di bawah untuk kembali ke aplikasi {product} dan menyelesaikan koneksi. Konfirmasi akunnya di sana; setelah itu tab ini boleh ditutup.',
    '下のボタンで {product} アプリに戻ると接続が完了します。アプリでアカウントを確認してください。その後、このタブは閉じてかまいません。',
    'Pulse el botón de abajo para volver a la aplicación {product} y terminar de conectar. Confirme la cuenta allí; después puede cerrar esta pestaña.',
    '按下面的按钮回到 {product} 应用即可完成连接。请在应用里确认账号，之后这个标签页可以关闭。'),
  signedOutApp: t(
    '이 창에서는 연결을 마치지 못했어요. {product} 앱으로 돌아가서 다시 시도를 누르세요.',
    'This window could not finish connecting. Go back to the {product} app and press Try again.',
    'Jendela ini tidak bisa menyelesaikan koneksi. Kembali ke aplikasi {product} lalu tekan Coba lagi.',
    'このウィンドウでは接続を完了できませんでした。{product} アプリに戻って「再試行」を押してください。',
    'Esta ventana no pudo terminar la conexión. Vuelva a la aplicación {product} y pulse Reintentar.',
    '这个窗口无法完成连接。请回到 {product} 应用，按“重试”。'),
  backToApp: t('앱으로 돌아가기', 'Back to the app', 'Kembali ke aplikasi', 'アプリに戻る', 'Volver a la aplicación', '返回应用'),
  loginAgain: t('로그인하고 여기서 연결하기', 'Sign in and connect here', 'Login dan hubungkan di sini', 'ログインしてここで接続', 'Iniciar sesión y conectar aquí', '登录并在这里连接'),
  ok: t(
    '거의 다 됐어요. {product} 앱으로 돌아가서 계정을 확인하면 연결이 끝나요.',
    'Almost done. Go back to {product} and confirm the account to finish connecting.',
    'Hampir selesai. Kembali ke {product} dan konfirmasi akunnya untuk menyelesaikan koneksi.',
    'あと少しです。{product} に戻ってアカウントを確認すると接続が完了します。',
    'Casi listo. Vuelva a {product} y confirme la cuenta para terminar de conectar.',
    '快完成了。回到 {product} 确认账号即可完成连接。'),
  cancelled: t(
    'Google 로그인을 취소해서 연결하지 않았어요. 연결하려면 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'Google sign-in was cancelled, so nothing was connected. To connect, close this window and press Connect again in {product}.',
    'Login Google dibatalkan, jadi tidak ada yang terhubung. Untuk menghubungkan, tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'Google ログインがキャンセルされたため、接続していません。接続するには、このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'Se canceló el inicio de sesión de Google, así que no se conectó nada. Para conectar, cierre esta ventana y vuelva a pulsar Conectar en {product}.',
    'Google 登录已取消，所以没有连接任何内容。要连接的话，请关闭这个窗口，在 {product} 中再按一次“连接”。'),
  denied_service: t(
    'Google에서 로그인을 허용하지 않았어요. 취소를 눌렀거나, 지금은 Google이 일부 계정만 허용하고 있을 수 있어요. 이 창을 닫고 {product}에서 다시 연결해 보고, 또 안 되면 관리자에게 알려 주세요.',
    "Google did not allow this sign-in. You may have pressed Cancel, or Google allows only some accounts for now. Close this window and press Connect again in {product}; if it happens again, tell your admin.",
    'Google tidak mengizinkan login ini. Mungkin Anda menekan Batal, atau untuk saat ini Google hanya mengizinkan sebagian akun. Tutup jendela ini lalu tekan Hubungkan lagi di {product}; jika terjadi lagi, beri tahu admin Anda.',
    'Google でこのログインが許可されませんでした。キャンセルを押したか、今は Google が一部のアカウントしか許可していない可能性があります。このウィンドウを閉じて {product} でもう一度「接続」を押し、それでもだめなら管理者に伝えてください。',
    'Google no permitió este inicio de sesión. Puede que pulsara Cancelar, o que por ahora Google solo permita algunas cuentas. Cierre esta ventana y vuelva a pulsar Conectar en {product}; si vuelve a pasar, avise a su administrador.',
    'Google 没有允许这次登录。你可能按了“取消”，或者 Google 目前只允许部分账号。请关闭这个窗口，在 {product} 中再按一次“连接”；如果再次出现，请告诉管理员。'),
  scope: t(
    '일부 권한에 체크하지 않아서 연결하지 않았어요. 이 창을 닫고 {product}에서 다시 연결을 누른 뒤, Google 화면에서 모든 항목에 체크한 채로 두세요.',
    'Some permissions were not ticked, so nothing was connected. Close this window, press Connect again in {product}, and keep every box ticked on Google’s page.',
    'Beberapa izin tidak dicentang, jadi tidak ada yang terhubung. Tutup jendela ini, tekan Hubungkan lagi di {product}, dan biarkan semua kotak tercentang di halaman Google.',
    '一部の権限にチェックが入っていなかったため、接続していません。このウィンドウを閉じて {product} でもう一度「接続」を押し、Google の画面ですべての項目にチェックを入れたままにしてください。',
    'Algunos permisos no estaban marcados, así que no se conectó nada. Cierre esta ventana, vuelva a pulsar Conectar en {product} y deje todas las casillas marcadas en la página de Google.',
    '有些权限没有勾选，所以没有连接任何内容。请关闭这个窗口，在 {product} 中再按一次“连接”，并在 Google 页面上保持所有选项都勾选。'),
  expired: t(
    '이 로그인은 시간이 지났거나 이미 사용됐어요. 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'This sign-in has expired or was already used. Close this window and press Connect again in {product}.',
    'Login ini sudah kedaluwarsa atau sudah dipakai. Tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'このログインは期限が切れたか、すでに使われています。このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'Este inicio de sesión caducó o ya se usó. Cierre esta ventana y vuelva a pulsar Conectar en {product}.',
    '这次登录已过期或已被使用。请关闭这个窗口，在 {product} 中再按一次“连接”。'),
  signed_out: t(
    '이 브라우저는 {product}에 로그인되어 있지 않아요. 로그인하면 이 브라우저에서 바로 연결할 수 있어요. 앱에서 연결하던 중이었다면 앱으로 돌아가서 다시 시도를 누르세요.',
    'This browser is not signed in to {product}. Sign in to connect right here, or, if you started in the app, go back to it and press Try again.',
    'Browser ini belum login ke {product}. Login untuk menghubungkan langsung di sini, atau jika Anda memulai dari aplikasi, kembali ke sana lalu tekan Coba lagi.',
    'このブラウザーは {product} にログインしていません。ログインするとここで接続できます。アプリで接続していた場合は、アプリに戻って「再試行」を押してください。',
    'Este navegador no ha iniciado sesión en {product}. Inicie sesión para conectar aquí mismo o, si empezó en la aplicación, vuelva a ella y pulse Reintentar.',
    '这个浏览器没有登录 {product}。登录后可以直接在这里连接；如果你是在应用里开始的，请回到应用，按“重试”。'),
  other_account: t(
    '이 브라우저는 다른 사람의 계정으로 {product}에 로그인되어 있어요. 앱과 같은 계정으로 다시 로그인한 뒤, {product}에서 다시 연결을 누르세요.',
    'This browser is signed in to {product} as someone else. Sign in with the same account as in the app, then press Connect again in {product}.',
    'Browser ini login ke {product} sebagai orang lain. Login dengan akun yang sama seperti di aplikasi, lalu tekan Hubungkan lagi di {product}.',
    'このブラウザーは別の人のアカウントで {product} にログインしています。アプリと同じアカウントでログインし直し、{product} でもう一度「接続」を押してください。',
    'Este navegador tiene iniciada la sesión en {product} con otra persona. Inicie sesión con la misma cuenta que en la aplicación y vuelva a pulsar Conectar en {product}.',
    '这个浏览器以其他人的账号登录了 {product}。请用和应用里相同的账号登录，然后在 {product} 中再按一次“连接”。'),
  failed: t(
    'Google 로그인을 마치지 못했어요. 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'The Google sign-in did not finish. Close this window and press Connect again in {product}.',
    'Login Google tidak selesai. Tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'Google ログインを完了できませんでした。このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'El inicio de sesión de Google no terminó. Cierre esta ventana y vuelva a pulsar Conectar en {product}.',
    'Google 登录没有完成。请关闭这个窗口，在 {product} 中再按一次“连接”。'),
  login: t('{product}에 로그인', 'Sign in to {product}', 'Login ke {product}', '{product} にログイン', 'Iniciar sesión en {product}', '登录 {product}'),
}

const say = (key: keyof typeof TEXT, locale: Locale) => (TEXT[key][locale] ?? TEXT[key].en).replace(/\{product\}/g, PRODUCT.displayName)
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** The page for a reason code. `browserSignedIn`: this browser has a session (of someone else when the reason says the
 * browser must be the person's own). */
export function googleReturnOf(outcome: CallbackOutcome, browserSignedIn: boolean): GoogleReturn {
  if (outcome.ok) return 'ok'
  switch (outcome.reason) {
    case 'consent_denied': case 'cancelled': return 'cancelled'
    case 'consent_denied_service': return 'denied_service'
    case 'scope_denied': return 'scope'
    case 'invalid_flow': case 'expired': case 'superseded': case 'flow_not_ready': return 'expired'
    case 'browser_session_required': return browserSignedIn ? 'other_account' : 'signed_out'
    default: return 'failed'
  }
}

/** The page's look: one card, light or dark as the system is. Inline, allowed by its hash (GOOGLE_RETURN_CSP). */
const STYLE = ':root{color-scheme:light dark;--bg:#fcfbf8;--card:#fff;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--cta:#ea580c;--cta-fg:#fff}'
  + '@media (prefers-color-scheme:dark){:root{--bg:#0e0c0b;--card:#181513;--fg:#f5f5f4;--muted:#a8a29e;--line:#2e2a27;--cta:#f97316;--cta-fg:#1c1917}}'
  + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:start center;background:var(--bg);color:var(--fg);'
  + 'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;padding:72px 16px}'
  + 'main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px}'
  + 'h1{font-size:22px;line-height:1.3;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 20px;color:var(--muted)}'
  + '.cta{display:block;text-align:center;background:var(--cta);color:var(--cta-fg);font-weight:600;text-decoration:none;border-radius:10px;padding:12px 16px}'
  + '.alt{display:inline-block;margin-top:16px;color:var(--fg);text-underline-offset:4px}:lang(ko) h1,:lang(ko) p{word-break:keep-all}'
/** The Content-Security-Policy of the return page: nothing loads, only its own style runs (routes/drive.ts, google-apps.ts) */
export const GOOGLE_RETURN_CSP = `default-src 'none'; style-src 'sha256-${crypto.createHash('sha256').update(STYLE).digest('base64')}'; frame-ancestors 'none'`

/** Where the page may send the person: `origin`, this team's address (the desktop app's button opens it in the app);
 * `connector`, the page of this connector in Settings (sign in here, then connect in this browser). */
export interface ReturnPageOptions { app?: AppClient | null; origin?: string; connector?: string; code?: string }

/** The return page's HTML and status. */
export function googleReturnPage(r: GoogleReturn, locale: Locale, o: ReturnPageOptions = {}): { html: string; status: 200 | 400 } {
  const inApp = !!o.app
  const origin = o.origin && /^https?:\/\/[^/?#\s]+$/.test(o.origin) ? o.origin : null
  const appButton = o.app === 'desktop' && origin ? `<a class="cta" href="${esc(appLink(origin))}">${esc(say('backToApp', locale))}</a>` : ''
  const login = `/login?${new URLSearchParams({ next: o.connector ?? '/settings/connectors' })}`
  let title: string, text: string, actions = ''
  if (r === 'ok' && o.code && origin) {
    // the app on this computer finishes it with its own session: the code only in the link's fragment
    title = say('hOk', locale); text = say('okCode', locale)
    actions = `<a class="cta" href="${esc(appLink(origin, o.code))}">${esc(say('backToApp', locale))}</a>`
  } else if (r === 'ok' && inApp) {
    title = say('hOkApp', locale); text = say('okApp', locale); actions = appButton
  } else if (r === 'ok') {
    title = say('hOk', locale); text = say('ok', locale)
  } else if (r === 'signed_out' && inApp) {
    title = say('hSignedOut', locale); text = say('signedOutApp', locale)
    actions = appButton + `<a class="alt" href="${esc(login)}" rel="noreferrer">${esc(say('loginAgain', locale))}</a>`
  } else if (r === 'signed_out') {
    title = say('hSignedOut', locale); text = say('signed_out', locale)
    actions = `<a class="cta" href="${esc(login)}" rel="noreferrer">${esc(say('loginAgain', locale))}</a>`
  } else if (r === 'other_account') {
    title = say('hSignedOut', locale); text = say('other_account', locale)
    actions = `<a class="cta" href="/login" rel="noreferrer">${esc(say('login', locale))}</a>`
  } else {
    title = say('hNot', locale); text = say(r, locale); actions = inApp ? appButton : ''
  }
  return {
    html: `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(say('title', locale))}</title><style>${STYLE}</style>`
      + `<main><h1>${esc(title)}</h1><p role="status">${esc(text)}</p>${actions}</main>`,
    status: r === 'ok' ? 200 : 400,
  }
}

const GO: Record<'title' | 'lead' | 'notYou' | 'next', T> = {
  title: t('Google Drive 연결', 'Connect Google Drive', 'Hubungkan Google Drive', 'Google Drive を接続', 'Conectar Google Drive', '连接 Google Drive'),
  lead: t(
    'Google Drive를 {name}({username}) 님의 {product} 계정에 연결해요.',
    'You are connecting Google Drive to the {product} account of {name} ({username}).',
    'Anda menghubungkan Google Drive ke akun {product} milik {name} ({username}).',
    'Google Drive を {name}（{username}）さんの {product} アカウントに接続します。',
    'Va a conectar Google Drive a la cuenta de {product} de {name} ({username}).',
    '你正在把 Google Drive 连接到 {name}（{username}）的 {product} 账号。'),
  notYou: t(
    '본인이 아니라면 이 창을 닫으세요. 남이 보낸 링크로는 연결하지 마세요.',
    'If that is not you, close this window. Never connect through a link someone sent you.',
    'Jika itu bukan Anda, tutup jendela ini. Jangan pernah menghubungkan lewat tautan yang dikirim orang lain.',
    'ご本人でなければ、このウィンドウを閉じてください。他の人から送られたリンクで接続しないでください。',
    'Si no es usted, cierre esta ventana. No conecte nunca desde un enlace que le haya enviado otra persona.',
    '如果这不是你，请关闭这个窗口。不要通过别人发来的链接进行连接。'),
  next: t('계속', 'Continue', 'Lanjutkan', '続ける', 'Continuar', '继续'),
}

/** The desktop app's page before Google (app-return.ts GO_PATH): whose Trina gets the Drive, then on to the sign-in. */
export function drivePreGooglePage(locale: Locale, o: { name: string; username: string; url: string }): string {
  const g = (k: keyof typeof GO) => (GO[k][locale] ?? GO[k].en).replace(/\{product\}/g, PRODUCT.displayName)
  const lead = g('lead').replace('{name}', o.name).replace('{username}', o.username)
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(g('title'))}</title><style>${STYLE}</style>`
    + `<main><h1>${esc(g('title'))}</h1><p data-testid="drive-go-person">${esc(lead)}</p><p>${esc(g('notYou'))}</p><a class="cta" href="${esc(o.url)}" rel="noopener noreferrer">${esc(g('next'))}</a></main>`
}
