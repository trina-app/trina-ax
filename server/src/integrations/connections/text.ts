// Words people see for external-service connections (docs/INTEGRATIONS.md): the server's confirmation card, API
// refusals and why a connection check failed (lastError, stored as a code and put into words for each reader).
import type { Locale } from '@mycel/shared/api'

type T = Record<Locale, string>
const t = (ko: string, en: string, id: string): T => ({ ko, en, id })

export const TEXT = {
  // the card before a call that changes something at the service
  confirm: t('AI가 {name}에서 이 작업을 하려고 해요: {what}', 'The AI wants to do this at {name}: {what}', 'AI ingin melakukan ini di {name}: {what}'),
  sends: t('보낼 내용:', 'What it sends:', 'Yang dikirim:'),
  nothing: t('(보낼 내용 없음)', '(nothing)', '(tidak ada)'),
  ask: t('보낼까요?', 'Send it?', 'Kirim?'),
  yes: t('보내기', 'Send', 'Kirim'),
  no: t('보내지 않기', 'Don’t send', 'Jangan kirim'),
  // API refusals
  personalOff: t('팀 설정에서 개인 연결 추가가 꺼져 있어요.', 'Your team turned off adding personal connections.', 'Tim Anda mematikan penambahan koneksi pribadi.'),
  tooMany: t('연결은 {n}개까지 만들 수 있어요.', 'You can have at most {n} connections.', 'Paling banyak {n} koneksi.'),
  slugTaken: t('이 짧은 이름은 이미 쓰고 있어요.', 'This short name is already in use.', 'Nama pendek ini sudah dipakai.'),
  keyNeedsKeyAuth: t('키는 API 키 방식에서만 넣을 수 있어요.', 'A key can only be set when the connection uses an API key.', 'Kunci hanya bisa diisi bila koneksi memakai kunci API.'),
  accessTeamOnly: t('사용할 사람은 공용 연결에서만 정할 수 있어요.', 'Who may use it is set on team connections only.', 'Siapa yang boleh memakai hanya diatur pada koneksi tim.'),
  badHeader: t('이 헤더 이름은 쓸 수 없어요.', 'This header name cannot be used.', 'Nama header ini tidak bisa dipakai.'),
  oauthMcpOnly: t('로그인 방식은 MCP 서버 연결에서만 쓸 수 있어요.', 'Sign-in is for MCP server connections only.', 'Login hanya untuk koneksi server MCP.'),
  notOauth: t('이 연결은 로그인 방식이 아니에요.', 'This connection does not use sign-in.', 'Koneksi ini tidak memakai login.'),
  keyLineBreak: t('키에는 줄바꿈을 넣을 수 없어요.', 'A key cannot contain line breaks.', 'Kunci tidak boleh berisi baris baru.'),
  unknownSubjects: t('없는 그룹이나 사람이에요: {list}', 'No such group or person: {list}', 'Grup atau orang tidak ada: {list}'),
  // the page the browser lands on after signing in at the service (the app watches the sign-in by itself)
  callbackTitle: t('로그인', 'Sign-in', 'Login'),
  callbackOk: t('로그인했어요. 이 창을 닫고 앱으로 돌아가세요.', 'Signed in. You can close this window and go back to the app.', 'Sudah login. Anda bisa menutup jendela ini dan kembali ke aplikasi.'),
  callbackFail: t('로그인을 마치지 못했어요. 이 창을 닫고, 이 브라우저에서 같은 계정으로 로그인한 뒤 앱에서 다시 시작해 주세요.', 'The sign-in could not be completed. Close this window, sign in to the same team account in this browser, then start again from the app.', 'Login tidak dapat diselesaikan. Tutup jendela ini, login ke akun tim yang sama di browser ini, lalu mulai lagi dari aplikasi.'),
  callbackLogin: t('팀 계정에 로그인', 'Sign in to the team account', 'Login ke akun tim'),
  // why a check failed (lastError)
  unreachable: t('서비스에 연결하지 못했어요. 주소를 확인해 주세요.', 'Could not reach the service. Check the address.', 'Tidak dapat menghubungi layanan. Periksa alamatnya.'),
  timeout: t('서비스가 30초 안에 답하지 않았어요.', 'The service did not answer within 30 seconds.', 'Layanan tidak menjawab dalam 30 detik.'),
  private_address: t('사내망이나 이 서버의 주소에는 연결할 수 없어요. 인터넷의 공개 주소를 넣어 주세요.', 'Addresses on the office network or of this server cannot be used. Use a public internet address.', 'Alamat di jaringan kantor atau server ini tidak bisa dipakai. Pakai alamat publik di internet.'),
  blocked_port: t('https 기본 포트(443)만 쓸 수 있어요.', 'Only the standard https port (443) can be used.', 'Hanya port https standar (443) yang bisa dipakai.'),
  tls: t('서비스의 보안 인증서를 확인하지 못했어요.', 'The service’s security certificate could not be verified.', 'Sertifikat keamanan layanan tidak dapat diverifikasi.'),
  refused: t('서비스가 키나 로그인을 받아 주지 않았어요(HTTP {status}). 키를 다시 넣거나 다시 로그인해 주세요.', 'The service did not accept the key or sign-in (HTTP {status}). Enter the key again or sign in again.', 'Layanan tidak menerima kunci atau login (HTTP {status}). Masukkan kunci lagi atau login ulang.'),
  no_secret: t('키가 아직 없어요. 키를 넣어 주세요.', 'There is no key yet. Enter the key.', 'Belum ada kunci. Masukkan kuncinya.'),
  sign_in: t('서비스에 로그인해 주세요.', 'Sign in at the service.', 'Silakan login di layanan.'),
  redirect: t('서비스가 다른 주소로 넘기려고 했어요(HTTP {status}). 넘어가는 주소를 직접 넣어 주세요.', 'The service tried to send us to another address (HTTP {status}). Enter that address instead.', 'Layanan mencoba mengalihkan ke alamat lain (HTTP {status}). Masukkan alamat itu langsung.'),
  http_status: t('서비스가 오류로 답했어요(HTTP {status}).', 'The service answered with an error (HTTP {status}).', 'Layanan menjawab dengan galat (HTTP {status}).'),
  not_mcp: t('이 주소는 MCP 서버처럼 답하지 않았어요.', 'This address did not answer like an MCP server.', 'Alamat ini tidak menjawab seperti server MCP.'),
  too_large: t('서비스의 답이 너무 커요(1MB 넘음).', 'The service’s answer is too large (over 1 MB).', 'Jawaban layanan terlalu besar (lebih dari 1 MB).'),
  oauth_unsupported: t('이 서비스는 이런 앱의 로그인을 받지 않아요. API 키로 연결해 보세요.', 'This service does not offer sign-in to apps like this one. Try an API key instead.', 'Layanan ini tidak menyediakan login untuk aplikasi seperti ini. Coba pakai kunci API.'),
  oauth_failed: t('로그인을 마치지 못했어요. 다시 시도해 주세요.', 'Signing in did not finish. Try again.', 'Login tidak selesai. Coba lagi.'),
  key_unsafe: t('서버의 키 보관 폴더를 쓸 수 없어요. 관리자에게 알려 주세요.', 'The server’s key folder cannot be used. Tell your admin.', 'Folder kunci server tidak bisa dipakai. Beri tahu admin Anda.'),
}
export type TextKey = keyof typeof TEXT
/** a reason a connection check failed (integrations.last_error holds "<reason>" or "<reason>:<status>") */
export type Reason = 'unreachable' | 'timeout' | 'private_address' | 'blocked_port' | 'tls' | 'refused' | 'no_secret' | 'sign_in' | 'redirect'
  | 'http_status' | 'not_mcp' | 'too_large' | 'oauth_unsupported' | 'oauth_failed' | 'key_unsafe'

export const say = (key: TextKey, locale: Locale, vars: Record<string, string | number> = {}) =>
  (TEXT[key][locale] ?? TEXT[key].en).replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all))

/** The stored code in words ("refused:401" -> "The service did not accept the key ... (HTTP 401)"). */
export function reasonText(code: string | null, locale: Locale): string | null {
  if (!code) return null
  const [reason, status] = code.split(':')
  if (!reason || !(reason in TEXT)) return say('unreachable', locale)
  return say(reason as TextKey, locale, { status: status ?? '?' })
}
