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
// link's fragment (app-return.ts), and the page opens that link by itself. A browser not signed in otherwise gets a way
// on: sign in and connect here, or go back to the app. A return to a sign-in that is already answered (a reload, a
// second request, another window) says it worked, or "Connected" once confirmed: never a failure page for a sign-in
// that worked (docs/decisions/20261121-google-return-already-answered.md).
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { appLink, heldLink } from './app-return'

export type AppClient = 'desktop' | 'mobile'

/** What the page says: the sign-in came back (confirm it in the app), or why it did not. */
export type GoogleReturn = 'ok' | 'connected' | 'done' | 'handed' | 'cancelled' | 'denied_service' | 'scope' | 'expired' | 'signed_out' | 'other_account' | 'failed'

/** How a sign-in ended, as the Drive and Google apps services report it: ok, or the flow's reason code. */
/** `app`: the app whose session started the sign-in; `code`: the one-time code for the desktop app that finishes a
 * sign-in Google answered in a browser without a session (app-return.ts). `done`: this return found the sign-in
 * already answered by an earlier one (a reload, a second request, another window): 'ready', the account waits to be
 * confirmed in the app; 'completed', it is connected. 'connected': this return finished it (a browser with the session
 * that started a personal sign-in). Never a failure page for a sign-in that worked (owner 2026-11-21). */
export type CallbackOutcome = { ok: true; app?: AppClient | null; code?: string; who?: { name: string; username: string }; google?: string; returnPort?: number | null; done?: 'ready' | 'completed' | 'connected' } | { ok: false; reason: string; app?: AppClient | null }

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

type Extra = 'title' | 'login' | 'okApp' | 'okCode' | 'heldWho' | 'heldGoogle' | 'heldOwnApp' | 'signedOutApp' | 'backToApp' | 'openApp' | 'loginAgain' | 'hOk' | 'hOkApp' | 'hNot' | 'hSignedOut' | 'hBack'
const TEXT: Record<GoogleReturn | Extra, T> = {
  title: t('Google 로그인', 'Google sign-in', 'Login Google', 'Google ログイン', 'Inicio de sesión de Google', 'Google 登录'),
  hOk: t('거의 다 됐어요', 'Almost done', 'Hampir selesai', 'あと少しです', 'Casi listo', '快完成了'),
  hOkApp: t('연결됐어요', 'Connected', 'Terhubung', '接続しました', 'Conectado', '已连接'),
  hBack: t('{product} 앱으로 돌아가서 마치세요', 'Go back to {product} to finish', 'Kembali ke {product} untuk menyelesaikan', '{product} に戻って完了してください', 'Vuelva a {product} para terminar', '回到 {product} 完成连接'),
  connected: t(
    '{product}에 연결됐어요. 이 탭은 닫고 원래 탭으로 돌아가면 돼요.',
    'It is connected in {product}. You can close this tab and go back to the first one.',
    'Sudah terhubung di {product}. Tab ini boleh ditutup; kembali ke tab sebelumnya.',
    '{product} に接続しました。このタブを閉じて、元のタブに戻ってください。',
    'Ya está conectado en {product}. Puede cerrar esta pestaña y volver a la primera.',
    '已经在 {product} 中连接好了。可以关闭这个标签页，回到原来的标签页。'),
  done: t(
    '{product}에 이미 연결됐어요. 이 창은 닫아도 돼요.',
    'It is already connected in {product}. You can close this window.',
    'Sudah terhubung di {product}. Jendela ini boleh ditutup.',
    '{product} ですでに接続されています。このウィンドウは閉じてかまいません。',
    'Ya está conectado en {product}. Puede cerrar esta ventana.',
    '已经在 {product} 中连接好了。这个窗口可以关闭。'),
  handed: t(
    '이 로그인은 {product} 앱이 마치기를 기다리고 있어요. Google이 처음 연 페이지에서 ‘앱으로 돌아가기’를 누르거나, 앱으로 돌아가서 다시 시도를 누르세요.',
    'This sign-in is waiting for the {product} app. Press “Back to the app” on the first page Google opened, or go back to the app and press Try again.',
    'Login ini menunggu aplikasi {product}. Tekan “Kembali ke aplikasi” di halaman pertama yang dibuka Google, atau kembali ke aplikasi lalu tekan Coba lagi.',
    'このログインは {product} アプリでの完了を待っています。Google が最初に開いたページで「アプリに戻る」を押すか、アプリに戻って「再試行」を押してください。',
    'Este inicio de sesión espera a la aplicación {product}. Pulse «Volver a la aplicación» en la primera página que abrió Google, o vuelva a la aplicación y pulse Reintentar.',
    '这次登录正在等待 {product} 应用完成。请在 Google 最先打开的页面上按“返回应用”，或者回到应用按“重试”。'),
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
  heldWho: t(
    '연결할 {product} 계정: {name} (@{username})',
    '{product} account it joins: {name} (@{username})',
    'Akun {product} tujuan: {name} (@{username})',
    '接続先の {product} アカウント：{name}（@{username}）',
    'Cuenta de {product} a la que se une: {name} (@{username})',
    '要连接的 {product} 账号：{name}（@{username}）'),
  heldGoogle: t(
    'Google 계정: {google}',
    'Google account: {google}',
    'Akun Google: {google}',
    'Google アカウント：{google}',
    'Cuenta de Google: {google}',
    'Google 账号：{google}'),
  heldOwnApp: t(
    '이 링크는 내 {product} 앱에서만 여세요. 다른 사람에게 보내지 마세요.',
    'Open this link only in your own {product} app. Don’t send it to anyone.',
    'Buka tautan ini hanya di aplikasi {product} milik Anda sendiri. Jangan kirim ke siapa pun.',
    'このリンクは自分の {product} アプリでだけ開いてください。他の人に送らないでください。',
    'Abra este enlace solo en su propia aplicación {product}. No se lo envíe a nadie.',
    '只在你自己的 {product} 应用里打开这个链接，不要发给任何人。'),
  signedOutApp: t(
    '이 창에서는 연결을 마치지 못했어요. {product} 앱으로 돌아가서 다시 시도를 누르세요.',
    'This window could not finish connecting. Go back to the {product} app and press Try again.',
    'Jendela ini tidak bisa menyelesaikan koneksi. Kembali ke aplikasi {product} lalu tekan Coba lagi.',
    'このウィンドウでは接続を完了できませんでした。{product} アプリに戻って「再試行」を押してください。',
    'Esta ventana no pudo terminar la conexión. Vuelva a la aplicación {product} y pulse Reintentar.',
    '这个窗口无法完成连接。请回到 {product} 应用，按“重试”。'),
  backToApp: t('앱으로 돌아가기', 'Back to the app', 'Kembali ke aplikasi', 'アプリに戻る', 'Volver a la aplicación', '返回应用'),
  // the app link beside the app's address on 127.0.0.1: opens (or starts) the app when that address does not answer
  openApp: t('앱이 열리지 않으면 여기를 누르세요', 'If the app does not open, press here', 'Jika aplikasi tidak terbuka, tekan di sini', 'アプリが開かない場合はここを押してください', 'Si la aplicación no se abre, pulse aquí', '如果应用没有打开，请点这里'),
  loginAgain: t('로그인하고 여기서 연결하기', 'Sign in and connect here', 'Login dan hubungkan di sini', 'ログインしてここで接続', 'Iniciar sesión y conectar aquí', '登录并在这里连接'),
  // a browser's sign-in that still needs its confirm (a Drive share, the team account): the first tab, never "the app"
  ok: t(
    '거의 다 됐어요. 원래 탭으로 돌아가 ‘이 계정 연결’을 누르세요. 이 탭은 닫아도 돼요.',
    'Almost done. Go back to the first tab and press “Connect this account”. You can close this tab.',
    'Hampir selesai. Kembali ke tab sebelumnya lalu tekan “Hubungkan akun ini”. Tab ini boleh ditutup.',
    'あと少しです。元のタブに戻って「このアカウントを接続」を押してください。このタブは閉じてかまいません。',
    'Casi listo. Vuelva a la primera pestaña y pulse «Conectar esta cuenta». Puede cerrar esta pestaña.',
    '快完成了。请回到原来的标签页，按“连接此账号”。这个标签页可以关闭。'),
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
  if (outcome.ok) return outcome.done === 'completed' ? 'done' : outcome.done === 'connected' ? 'connected' : 'ok'
  switch (outcome.reason) {
    case 'consent_denied': case 'cancelled': return 'cancelled'
    case 'consent_denied_service': return 'denied_service'
    case 'scope_denied': return 'scope'
    case 'held': return 'handed'
    // another return of this sign-in is finishing it right now: the "almost done" page (the app shows how it ends)
    case 'in_progress': return 'ok'
    case 'invalid_flow': case 'expired': case 'superseded': case 'flow_not_ready': return 'expired'
    case 'browser_session_required': return browserSignedIn ? 'other_account' : 'signed_out'
    default: return 'failed'
  }
}

/** The page's look: one card, light or dark as the system is. Inline, allowed by its hash (GOOGLE_RETURN_CSP). */
export const RETURN_STYLE = ':root{color-scheme:light dark;--bg:#fcfbf8;--card:#fff;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--cta:#ea580c;--cta-fg:#fff}'
  + '@media (prefers-color-scheme:dark){:root{--bg:#0e0c0b;--card:#181513;--fg:#f5f5f4;--muted:#a8a29e;--line:#2e2a27;--cta:#f97316;--cta-fg:#1c1917}}'
  + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:start center;background:var(--bg);color:var(--fg);'
  + 'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;padding:72px 16px}'
  + 'main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px}'
  + 'h1{font-size:22px;line-height:1.3;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 20px;color:var(--muted)}'
  + '.cta{display:block;text-align:center;background:var(--cta);color:var(--cta-fg);font-weight:600;text-decoration:none;border-radius:10px;padding:12px 16px}'
  + '.alt{display:inline-block;margin-top:16px;color:var(--fg);text-underline-offset:4px}:lang(ko) h1,:lang(ko) p,:lang(ko) li{word-break:keep-all}'
  + '.facts{list-style:none;margin:0 0 20px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;color:var(--fg);font-size:15px}.facts li+li{margin-top:4px}'
  + '.note{margin:16px 0 0;font-size:14px}.logo{display:block;width:40px;height:40px;margin:0 0 20px}'
/** the style's CSP source (also the app connections' return page, routes/integrations.ts) */
export const RETURN_STYLE_SRC = `'sha256-${crypto.createHash('sha256').update(RETURN_STYLE).digest('base64')}'`
/** The Content-Security-Policy of the return page: nothing loads, only its own style runs (routes/drive.ts, google-apps.ts) */
export const GOOGLE_RETURN_CSP = `default-src 'none'; style-src 'sha256-${crypto.createHash('sha256').update(RETURN_STYLE).digest('base64')}'; frame-ancestors 'none'`

/** Where the page may send the person: `origin`, this team's address (the desktop app's button opens it in the app);
 * `connector`, the page of this connector in Settings (sign in here, then connect in this browser). */
/** `who`, `google`: whose Trina account and which Google account a result waiting for the app's code joins */
export interface ReturnPageOptions { app?: AppClient | null; origin?: string; connector?: string; code?: string; who?: { name: string; username: string }; google?: string; returnPort?: number | null }

/** The return page's HTML and status. */
export function googleReturnPage(r: GoogleReturn, locale: Locale, o: ReturnPageOptions = {}): { html: string; status: 200 | 400 } {
  const inApp = !!o.app
  const origin = o.origin && /^https?:\/\/[^/?#\s]+$/.test(o.origin) ? o.origin : null
  const appButton = o.app === 'desktop' && origin ? `<a class="cta" href="${esc(appLink(origin))}">${esc(say('backToApp', locale))}</a>` : ''
  const login = `/login?${new URLSearchParams({ next: o.connector ?? '/settings/connectors' })}`
  let title: string, text: string, actions = '', head = ''
  if (r === 'ok' && o.code && origin) {
    // the app on this computer finishes it with its own session: the code only in the link's fragment. The page opens
    // that link by itself too (the browser asks first): people go back to the app without the button and the result
    // waited unclaimed until Try again ended it (qa.trina.app 2026-11-21, drive flows of 04:10 and 04:11)
    title = say('hBack', locale); text = say('okCode', locale)
    // the app's return address on 127.0.0.1 when the app said one (any browser goes there), else the app link
    const link = heldLink(origin, o.code, o.returnPort)
    head = `<meta http-equiv="refresh" content="0;url=${esc(link)}">`
    // whose Trina account and which Google account, so a person who did not start it sees it is not theirs
    const facts = [
      o.who?.username ? say('heldWho', locale).replace('{name}', () => o.who!.name).replace('{username}', () => o.who!.username) : '',
      o.google ? say('heldGoogle', locale).replace('{google}', () => o.google!) : '',
    ].filter(Boolean)
    actions = (facts.length ? `<ul class="facts" data-testid="held-facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '')
      + `<a class="cta" href="${esc(link)}">${esc(say('backToApp', locale))}</a>`
      + (o.returnPort ? `<a class="alt" href="${esc(appLink(origin, o.code))}" data-testid="held-app-link">${esc(say('openApp', locale))}</a>` : '')
      + `<p class="note" data-testid="held-own-app">${esc(say('heldOwnApp', locale))}</p>`
  } else if (r === 'handed') {
    // the result waits for the first page's code (app-return.ts): this one never gets a code
    title = say('hBack', locale); text = say('handed', locale); actions = appButton
  } else if (r === 'done') {
    title = say('hOkApp', locale); text = say('done', locale); actions = inApp ? appButton : ''
  } else if (r === 'connected') {
    title = say('hOkApp', locale); text = say('connected', locale)
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
    html: `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(say('title', locale))}</title>${head}<style>${RETURN_STYLE}</style>`
      + `<main><h1>${esc(title)}</h1><p role="status">${esc(text)}</p>${actions}</main>`,
    status: r === 'ok' || r === 'done' || r === 'connected' ? 200 : 400,
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
  const lead = g('lead').replace('{name}', () => o.name).replace('{username}', () => o.username)
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(g('title'))}</title><style>${RETURN_STYLE}</style>`
    + `<main><h1>${esc(g('title'))}</h1><p data-testid="drive-go-person">${esc(lead)}</p><p>${esc(g('notYou'))}</p><a class="cta" href="${esc(o.url)}" rel="noopener noreferrer">${esc(g('next'))}</a></main>`
}
