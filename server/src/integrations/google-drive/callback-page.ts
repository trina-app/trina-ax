// The page Google (or the hosting service) sends the browser back to after a Google sign-in, for Google Drive
// (routes/drive.ts) and Gmail, Calendar, Docs and Sheets (routes/google-apps.ts): in the person's language (the request's
// locale, as the other connections' return page, routes/integrations.ts), with why it did not work and one next step
// (QA TC-2956, TC-2978, TC-2979). A sign-in that worked is not done yet: the person confirms the account in the app, so
// the page says so, never "received" or "connected". Static words and one same-origin link only: the code and the
// state never go anywhere else.
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'

/** What the page says: the sign-in came back (confirm it in the app), or why it did not. */
export type GoogleReturn = 'ok' | 'cancelled' | 'denied_service' | 'scope' | 'expired' | 'signed_out' | 'other_account' | 'failed'

/** How a sign-in ended, as the Drive and Google apps services report it: ok, or the flow's reason code. */
export type CallbackOutcome = { ok: true } | { ok: false; reason: string }

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string, ja: string, es: string, zh: string): T => ({ ko, en, id, ja, es, zh })

const TEXT: Record<GoogleReturn | 'title' | 'login', T> = {
  title: t('Google 로그인', 'Google sign-in', 'Login Google', 'Google ログイン', 'Inicio de sesión de Google', 'Google 登录'),
  ok: t(
    '거의 다 됐어요. {product} 앱으로 돌아가서 계정을 확인하면 연결이 끝나요.',
    'Almost done. Go back to {product} and confirm the account to finish connecting.',
    'Hampir selesai. Kembali ke {product} dan konfirmasi akunnya untuk menyelesaikan koneksi.',
    'あと少しです。{product} に戻ってアカウントを確認すると接続が完了します。',
    'Casi listo. Vuelve a {product} y confirma la cuenta para terminar de conectar.',
    '快完成了。回到 {product} 确认账号即可完成连接。'),
  cancelled: t(
    'Google 로그인을 취소해서 연결하지 않았어요. 연결하려면 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'Google sign-in was cancelled, so nothing was connected. To connect, close this window and press Connect again in {product}.',
    'Login Google dibatalkan, jadi tidak ada yang terhubung. Untuk menghubungkan, tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'Google ログインがキャンセルされたため、接続していません。接続するには、このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'Se canceló el inicio de sesión de Google, así que no se conectó nada. Para conectar, cierra esta ventana y vuelve a pulsar Conectar en {product}.',
    'Google 登录已取消，所以没有连接任何内容。要连接的话，请关闭这个窗口，在 {product} 中再按一次“连接”。'),
  denied_service: t(
    'Google에서 로그인을 허용하지 않았어요. 취소를 눌렀거나, 지금은 Google이 일부 계정만 허용하고 있을 수 있어요. 이 창을 닫고 {product}에서 다시 연결해 보고, 또 안 되면 관리자에게 알려 주세요.',
    "Google did not allow this sign-in. You may have pressed Cancel, or Google allows only some accounts for now. Close this window and press Connect again in {product}; if it happens again, tell your admin.",
    'Google tidak mengizinkan login ini. Mungkin Anda menekan Batal, atau untuk saat ini Google hanya mengizinkan sebagian akun. Tutup jendela ini lalu tekan Hubungkan lagi di {product}; jika terjadi lagi, beri tahu admin Anda.',
    'Google でこのログインが許可されませんでした。キャンセルを押したか、今は Google が一部のアカウントしか許可していない可能性があります。このウィンドウを閉じて {product} でもう一度「接続」を押し、それでもだめなら管理者に伝えてください。',
    'Google no permitió este inicio de sesión. Puede que pulsaras Cancelar, o que por ahora Google solo permita algunas cuentas. Cierra esta ventana y vuelve a pulsar Conectar en {product}; si vuelve a pasar, avisa a tu administrador.',
    'Google 没有允许这次登录。你可能按了“取消”，或者 Google 目前只允许部分账号。请关闭这个窗口，在 {product} 中再按一次“连接”；如果再次出现，请告诉管理员。'),
  scope: t(
    '일부 권한에 체크하지 않아서 연결하지 않았어요. 이 창을 닫고 {product}에서 다시 연결을 누른 뒤, Google 화면에서 모든 항목에 체크한 채로 두세요.',
    'Some permissions were not ticked, so nothing was connected. Close this window, press Connect again in {product}, and keep every box ticked on Google’s page.',
    'Beberapa izin tidak dicentang, jadi tidak ada yang terhubung. Tutup jendela ini, tekan Hubungkan lagi di {product}, dan biarkan semua kotak tercentang di halaman Google.',
    '一部の権限にチェックが入っていなかったため、接続していません。このウィンドウを閉じて {product} でもう一度「接続」を押し、Google の画面ですべての項目にチェックを入れたままにしてください。',
    'Algunos permisos no estaban marcados, así que no se conectó nada. Cierra esta ventana, vuelve a pulsar Conectar en {product} y deja todas las casillas marcadas en la página de Google.',
    '有些权限没有勾选，所以没有连接任何内容。请关闭这个窗口，在 {product} 中再按一次“连接”，并在 Google 页面上保持所有选项都勾选。'),
  expired: t(
    '이 로그인은 시간이 지났거나 이미 사용됐어요. 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'This sign-in has expired or was already used. Close this window and press Connect again in {product}.',
    'Login ini sudah kedaluwarsa atau sudah dipakai. Tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'このログインは期限が切れたか、すでに使われています。このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'Este inicio de sesión caducó o ya se usó. Cierra esta ventana y vuelve a pulsar Conectar en {product}.',
    '这次登录已过期或已被使用。请关闭这个窗口，在 {product} 中再按一次“连接”。'),
  signed_out: t(
    '이 브라우저는 {product}에 로그인되어 있지 않아요. 아래에서 앱과 같은 계정으로 로그인한 뒤, {product}에서 다시 연결을 누르세요.',
    'This browser is not signed in to {product}. Sign in below with the same account as in the app, then press Connect again in {product}.',
    'Browser ini belum login ke {product}. Login di bawah dengan akun yang sama seperti di aplikasi, lalu tekan Hubungkan lagi di {product}.',
    'このブラウザーは {product} にログインしていません。下からアプリと同じアカウントでログインし、{product} でもう一度「接続」を押してください。',
    'Este navegador no ha iniciado sesión en {product}. Inicia sesión abajo con la misma cuenta que en la aplicación y vuelve a pulsar Conectar en {product}.',
    '这个浏览器没有登录 {product}。请在下方用和应用里相同的账号登录，然后在 {product} 中再按一次“连接”。'),
  other_account: t(
    '이 브라우저는 다른 사람의 계정으로 {product}에 로그인되어 있어요. 앱과 같은 계정으로 다시 로그인한 뒤, {product}에서 다시 연결을 누르세요.',
    'This browser is signed in to {product} as someone else. Sign in with the same account as in the app, then press Connect again in {product}.',
    'Browser ini login ke {product} sebagai orang lain. Login dengan akun yang sama seperti di aplikasi, lalu tekan Hubungkan lagi di {product}.',
    'このブラウザーは別の人のアカウントで {product} にログインしています。アプリと同じアカウントでログインし直し、{product} でもう一度「接続」を押してください。',
    'Este navegador tiene iniciada la sesión en {product} con otra persona. Inicia sesión con la misma cuenta que en la aplicación y vuelve a pulsar Conectar en {product}.',
    '这个浏览器以其他人的账号登录了 {product}。请用和应用里相同的账号登录，然后在 {product} 中再按一次“连接”。'),
  failed: t(
    'Google 로그인을 마치지 못했어요. 이 창을 닫고 {product}에서 다시 연결을 누르세요.',
    'The Google sign-in did not finish. Close this window and press Connect again in {product}.',
    'Login Google tidak selesai. Tutup jendela ini lalu tekan Hubungkan lagi di {product}.',
    'Google ログインを完了できませんでした。このウィンドウを閉じて {product} でもう一度「接続」を押してください。',
    'El inicio de sesión de Google no terminó. Cierra esta ventana y vuelve a pulsar Conectar en {product}.',
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

/** The return page's HTML and status. */
export function googleReturnPage(r: GoogleReturn, locale: Locale): { html: string; status: 200 | 400 } {
  const body = `<p>${esc(say(r, locale))}</p>`
    + (r === 'signed_out' || r === 'other_account' ? `<p><a href="/login" rel="noreferrer">${esc(say('login', locale))}</a></p>` : '')
  return {
    html: `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(say('title', locale))}</title>${body}`,
    status: r === 'ok' ? 200 : 400,
  }
}
