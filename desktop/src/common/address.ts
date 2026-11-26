// What people put in the first-run screen's one box: an invite link, a team link, an address, a bare name ("acme") or
// a whole pasted message with the link in it. The reading itself is shared with the phone app (shared/src/team-link.ts);
// here it gets the desktop's rules: the hosted team domain, and plain http only for this machine (development).
// Pure: no Electron, unit-tested in tests/unit/e-desktop-common.test.ts and tests/unit/team-link.test.ts.
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { PRODUCT } from '@mycel/shared/product'
import { classifyHostStatic } from './netaddr'
import { GOOGLE_APP_RETURN_PATH } from '@mycel/shared/api/auth'
import { mayBeAsleep, parseTeamInput, readAppLink, relayAnswer, relayRename, wakeTeam, type RelayAnswer, type TeamInput, type TeamInputError, type TeamInputOptions, type WakeAnswer, type WakeSteps } from '@mycel/shared/team-link'

export { hostLineNow, hostLineShown, isLoopbackHost, isSignInPath } from '@mycel/shared/team-link'

/** Hosted team addresses are <team>.TEAM_DOMAIN (design tab 6). */
export const TEAM_DOMAIN: string = SERVICE_HOSTS.teamDomain
export const DESKTOP_INPUT: TeamInputOptions = { teamDomain: TEAM_DOMAIN, loopbackHttp: true }

export type AddressError = TeamInputError
export type ParsedAddress =
  | { ok: true; origin: string; host: string; dev: boolean; entryPath: string; name: string | null; hosted: boolean }
  | { ok: false; error: AddressError }

export function parseTeamAddress(raw: string): ParsedAddress {
  const p = parseTeamInput(raw, DESKTOP_INPUT)
  if (!p.ok) return p
  return { ok: true, origin: p.origin, host: p.host, dev: p.loopback, entryPath: p.entryPath, name: p.name, hosted: p.hosted }
}

/** The link scheme this app answers (`trina-ax://open?url=…`): PRODUCT.linkScheme, the phone app's scheme too. */
export const LINK_SCHEME: string = PRODUCT.linkScheme

/** A link that opened the app from outside: `<scheme>://open?url=<team link>` only (the desktop declares no web
 * domains), read with the box's rules but stricter: https only, and never this machine (a link from a web page must
 * not point the app, its team view and its bridge at a local port). Typed addresses keep http to this machine for
 * development. Only here, the team's one-time sign-in link (`/app-signin#c=<code>`, the web's "Continue in the Mac
 * app") is read too, and a new team's owner setup page (`/app-setup#c=<claim>`, docs/decisions/20261126-desktop-create-team.md);
 * the box and the phone refuse both (shared/src/team-link.ts appSignIn). null: not a link for this app. */
export function readDesktopLink(raw: string): TeamInput | null {
  const p = readAppLink(raw, { ...DESKTOP_INPUT, loopbackHttp: false, scheme: LINK_SCHEME, universal: false, appSignIn: true })
  return p?.ok && p.loopback ? { ok: false, error: 'insecure' } : p
}

/** The page a link opens, as the first-run box may be given it again (the "renamed" answer's next address goes back
 * through parseTeamAddress): a one-time sign-in or setup link's page is not one the box reads, so it is the team's start there.
 * The code is spent or dead by then anyway. */
export function retypablePath(entryPath: string): string {
  return /^\/app-(?:signin|setup)(?:[/?#]|$)/i.test(entryPath) ? '/' : entryPath
}

/** An id in a page address: the server's ids (uuidv7) and nothing that could move the path (no `.`, `%`, `/`, `\`). */
const PAGE_ID = '[A-Za-z0-9_-]{1,64}'
/** A file's link id (shared/src/api/file-shares.ts FileLinkId: 16 random bytes, base64url). */
const FILE_LINK_ID = '[A-Za-z0-9_-]{22}'
/** The team pages a link from outside may open in the app (web/src/App.tsx routes): a chat, a room, a room's thread,
 * a project, a file's link (/f/<id>, QA TC-3093). Nothing else (settings, admin, files, sign-in pages). */
const PAGE_PATH = new RegExp(`^/(?:c/${PAGE_ID}|rooms/${PAGE_ID}(?:/t/${PAGE_ID})?|projects/${PAGE_ID}|f/${FILE_LINK_ID})$`)
const ROOM_PATH = /^\/rooms\//
const MESSAGE_ID = new RegExp(`^${PAGE_ID}$`)

/**
 * The team page inside a link from outside (`trina-ax://open?url=https://acme.trina.app/c/<id>`, the web's "Open in
 * the app" on a chat; docs/DECISIONS.md "A chat link opens the desktop app on that chat"). The link must pass
 * readDesktopLink first (https, no user:password, no loopback host, nothing around the address). Then the page:
 * - only `/c/<id>`, `/rooms/<id>`, `/rooms/<id>/t/<id>` and `/projects/<id>`, ids `[A-Za-z0-9_-]{1,64}`, one optional
 *   trailing slash dropped;
 * - written exactly as the URL parser reads it (no `..`, `.`, `\`, `%`-escapes, tabs or other control characters,
 *   `//`, which the parser would change or which an id never has);
 * - a room's page keeps one `?m=<id>` (the message to show) and nothing else; any other query and the fragment are
 *   dropped.
 * Returns the team origin and the page, or null (the link opens as before: screen ④, the team's start). The caller
 * opens it only on a team this app already has, by exact origin (AppWindow.offerLink).
 */
export function desktopPagePath(raw: string): { origin: string; path: string } | null {
  const p = readDesktopLink(raw)
  if (!p?.ok || p.entryPath !== '/') return null
  let inner: URL
  let text: string
  try {
    text = new URL(raw).searchParams.get('url') ?? ''
    inner = new URL(text)
  } catch {
    return null
  }
  if (inner.origin !== p.origin) return null
  // the path as it was written: from the first '/' after the authority up to '?' or '#'
  const written = /^https:\/\/[^/?#\\]+(\/[^?#]*)?/i.exec(text)?.[1] ?? ''
  if (/[^\x21-\x7e]/.test(written) || written !== inner.pathname) return null
  const path = inner.pathname.length > 1 && inner.pathname.endsWith('/') ? inner.pathname.slice(0, -1) : inner.pathname
  if (!PAGE_PATH.test(path)) return null
  const m = inner.searchParams.get('m')
  const query = ROOM_PATH.test(path) && m && MESSAGE_ID.test(m) && [...inner.searchParams.keys()].length === 1 ? `?m=${m}` : ''
  return { origin: p.origin, path: path + query }
}

/**
 * A link to the start of the team the window shows (`trina-ax://open?url=https://acme.trina.app/`, exact origin): the
 * "Back to the app" button of a Google sign-in's last page in the system browser (server google-drive/callback-page.ts).
 * The app only comes forward (main.ts onLink); screen ④ does not ask to connect a team it shows already.
 */
export function isShownTeamStart(raw: string, shownOrigin: string | null | undefined): boolean {
  const p = readDesktopLink(raw)
  if (!shownOrigin || !p?.ok || p.entryPath !== '/' || p.origin !== shownOrigin) return false
  try {
    const inner = new URL(new URL(raw).searchParams.get('url') ?? '')
    return inner.pathname === '/' && !inner.search && !inner.hash
  } catch {
    return false
  }
}

/**
 * The one-time code in the "Back to the app" link of a Google Drive sign-in that Google answered in a browser without a
 * session (server google-drive/app-return.ts): `trina-ax://open?url=<the team on screen>/#code=<code>`. The code is
 * only in the fragment; the link must otherwise be exactly the start of the team the window shows. null otherwise.
 */
export function signInCode(raw: string, shownOrigin: string | null | undefined): string | null {
  const i = typeof raw === 'string' ? raw.indexOf('#') : -1
  if (i < 0) return null
  const m = /^code=([A-Za-z0-9_-]{43})$/.exec(raw.slice(i + 1))
  return m && isShownTeamStart(raw.slice(0, i), shownOrigin) ? m[1]! : null
}

/**
 * The one-time code of a Google sign-in that the system browser hands back (server auth/google-login-apps.ts):
 * `trina-ax://open?url=<team>/login/google#code=<code>`, the code only in the fragment, the page exactly
 * `/login/google` (no query, nothing else). Only for the team on screen: `shown` is its address and the address the
 * window shows (an office LAN address); the link names the team address Google returned to. null otherwise (the link
 * then goes the usual way and never loads a team).
 */
export function googleSignInCode(raw: string, shown: readonly (string | null | undefined)[]): string | null {
  const i = typeof raw === 'string' ? raw.indexOf('#') : -1
  if (i < 0) return null
  const m = /^code=([A-Za-z0-9_-]{43})$/.exec(raw.slice(i + 1))
  const p = m ? readDesktopLink(raw.slice(0, i)) : null
  if (!m || !p?.ok || !shown.some((o) => !!o && o === p.origin)) return null
  try {
    const text = new URL(raw.slice(0, i)).searchParams.get('url') ?? ''
    const inner = new URL(text)
    return inner.origin === p.origin && text === `${p.origin}${GOOGLE_APP_RETURN_PATH}` ? m[1]! : null
  } catch {
    return null
  }
}

/**
 * A link that started the app (the app was closed): when it is a chat, room or project page of a team the app already
 * has (exact origin, desktopPagePath), the team and the page to open at the first load. null: the app starts as usual
 * and the link goes to screen ④ (AppWindow.offerLink).
 */
export function startupLinkTarget(raw: string | null, teams: readonly { id: string; origin: string }[]): { id: string; path: string } | null {
  const page = raw ? desktopPagePath(raw) : null
  const known = page ? teams.find((x) => x.origin === page.origin) : undefined
  return page && known ? { id: known.id, path: page.path } : null
}

/** The link in a command line: Windows and Linux start the app (or its second instance) with the link as an argument.
 * Anything else on the command line (Chromium switches, the app's path) is ignored. */
export function linkFromArgv(argv: readonly string[], scheme = LINK_SCHEME): string | null {
  const prefix = `${scheme.toLowerCase()}:`
  return argv.find((a) => typeof a === 'string' && a.length <= 4096 && a.toLowerCase().startsWith(prefix)) ?? null
}

/** One answer of GET /api/health, read without following redirects (main/app-window.ts fetchHealth). */
export interface HealthAnswer { status: number; location: string | null; relayError: string | null; bodyOk: boolean }
/** What the app does with it: connect, follow a relay rename once (to `rename`), or say why not. */
export type HealthVerdict =
  | { ok: true }
  | { ok: false; rename: string }
  | { ok: false; error: 'unreachable' | 'notTeamServer' | 'teamUnknown' | 'suspended' | 'asleep' }

/**
 * A team renamed at its relay answers 308 with its new address: the app follows it once, only to another
 * <name>.<team domain> with the same scheme and port (shared relayRename), and asks before it remembers the new
 * address. Any other redirect is not a team server: no hop to another host, plain http or an office address.
 * `relayError`: the relay's x-relay-error header (unknown name 404, suspended 403).
 */
export function healthVerdict(origin: string, r: HealthAnswer): HealthVerdict {
  if (r.status >= 300 && r.status < 400) {
    const rename = relayRename(origin, r.location, DESKTOP_INPUT)
    return rename ? { ok: false, rename } : { ok: false, error: 'notTeamServer' }
  }
  const answer: RelayAnswer = relayAnswer(r.status, r.relayError)
  if (answer === 'unknown') return { ok: false, error: 'teamUnknown' }
  if (answer === 'suspended') return { ok: false, error: 'suspended' }
  // a free trial's server turned off for no use: the check does not wake it, a person's page load does (checkTeam)
  if (mayBeAsleep(r.status, r.relayError)) return { ok: false, error: 'asleep' }
  // a tunnel / relay error page (e.g. Cloudflare 530 while the office's Mac is off) is "cannot reach", not "not a team server"
  if (answer === 'offline' || isGatewayDown(r.status)) return { ok: false, error: 'unreachable' }
  if (r.status < 200 || r.status > 299 || !r.bodyOk) return { ok: false, error: 'notTeamServer' }
  return { ok: true }
}

/** What the add-team check found: the team's origin (after a relay rename) and how it answered. */
export type TeamCheck =
  | { ok: true; origin: string }
  | { ok: false; error: 'unreachable' | 'notTeamServer' | 'teamUnknown' | 'suspended' | 'wakeTimeout' }
export interface TeamCheckIo extends Omit<WakeSteps, 'wake'> {
  health: (origin: string) => Promise<HealthAnswer>
  /** GET <origin>/ as a page load (main/app-window.ts fetchWake) */
  wake: (origin: string) => Promise<WakeAnswer>
}
/**
 * The add-team check (main/app-window.ts addTeam): GET /api/health, one relay rename hop, and a sleeping trial team
 * woken and waited for ("Resuming your team…", about a minute) instead of "cannot reach" (QA wake gap 1). Throws
 * when the address cannot be fetched at all.
 */
export async function checkTeam(origin: string, io: TeamCheckIo): Promise<TeamCheck> {
  let v = healthVerdict(origin, await io.health(origin))
  // a team renamed at its relay: one hop to its new <name>.<team domain>, and no further
  if (!v.ok && 'rename' in v) {
    origin = v.rename
    v = healthVerdict(origin, await io.health(origin))
    if (!v.ok && 'rename' in v) return { ok: false, error: 'notTeamServer' }
  }
  if (!v.ok && 'error' in v && v.error === 'asleep') {
    const at = origin
    const w = await wakeTeam({ ...io, wake: () => io.wake(at) })
    // (cancelled: the caller sees its own stop and adds nothing)
    if (w === 'timeout') return { ok: false, error: 'wakeTimeout' }
    if (w === 'notAsleep' || w === 'cancelled') return { ok: false, error: 'unreachable' }
    v = healthVerdict(origin, await io.health(origin))
    // still not answering right after it answered the page: say so as before
    if (!v.ok && ('rename' in v || v.error === 'asleep')) return { ok: false, error: 'unreachable' }
  }
  if (!v.ok) return { ok: false, error: 'error' in v && v.error !== 'asleep' ? v.error : 'notTeamServer' }
  return { ok: true, origin }
}

/**
 * The add-team check could not be made because of the server's certificate (QA TC-3452: an office address whose
 * certificate is not installed on this computer said "check your internet connection"). Read from the error Electron's
 * net.request gives ("net::ERR_CERT_AUTHORITY_INVALID"): 'untrusted' = no certificate authority this computer trusts
 * signed it (the office certificate is not installed yet); 'invalid' = any other certificate error (expired, another
 * name, revoked). null: not a certificate error. The app only says so: it never connects past a certificate error.
 */
export type CertTrouble = 'untrusted' | 'invalid'
export function certTrouble(err: unknown): CertTrouble | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const code = /(?:^|[^A-Z0-9_])(ERR_CERT_[A-Z0-9_]+)/.exec(text)?.[1]
  if (!code) return null
  return code === 'ERR_CERT_AUTHORITY_INVALID' ? 'untrusted' : 'invalid'
}

/**
 * Where an office server hands out its certificate: plain http on the port below its https port (the office
 * installer's default, server/src/office/settings.ts helperDefault: 8443 → 8442), for an address on the office network
 * with a port in it (an IP address or a local name). null: an address that is not an office one, so no page is named.
 * Only shown as text for the person to open in a browser and compare with the desk card; the app never opens it.
 */
export function officeCertPage(origin: string): string | null {
  let u: URL
  try { u = new URL(origin) } catch { return null }
  const port = Number(u.port)
  if (u.protocol !== 'https:' || !u.port || port < 2 || classifyHostStatic(u.hostname) !== 'private') return null
  return `http://${u.hostname}:${port - 1}`
}

/** How long the full-page "cannot reach the team server" card waits before it looks again by itself, per try: 5, 10,
 * 20 s, then every 30 s (QA TC-3453). One small GET /api/health each time. */
export const OFFLINE_RETRY_MS = [5_000, 10_000, 20_000, 30_000] as const
export function offlineRetryDelay(tries: number): number {
  const i = Number.isFinite(tries) ? Math.min(Math.max(0, Math.floor(tries)), OFFLINE_RETRY_MS.length - 1) : OFFLINE_RETRY_MS.length - 1
  return OFFLINE_RETRY_MS[i]!
}
/** The team server answers again: its own health answer, nothing else. A tunnel's or relay's error page, a Wi-Fi
 * sign-in page, another kind of server, a renamed or paused team are not "back" (a reload would fail or show nothing
 * new), and a sleeping trial team is not woken by the app looking: only a person's Try again loads the page. */
export function answersAgain(origin: string, r: HealthAnswer): boolean {
  return healthVerdict(origin, r).ok
}

/** Origin of a URL, or '' (about:blank, garbage). */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : ''
  } catch {
    return ''
  }
}

/**
 * A remembered team at a development address on this computer: `localhost` or `*.localhost` (`bun run dev`,
 * http://localhost:19100, often not running). When the app opens it by itself at start and it does not answer, the
 * first-run screen with the team list comes instead of the "cannot reach the team server" card (main/app-window.ts
 * openLast). Loopback IPs are left out: the Office Mac's own server is http://127.0.0.1:47820 (scripts/install-macos.sh),
 * a real team that may still be starting after a restart, so it keeps the card and its [다시 시도]. A team the person
 * opens keeps the card too.
 */
export function onThisComputer(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase().replace(/\.$/, '')
    return h === 'localhost' || h.endsWith('.localhost')
  } catch {
    return false
  }
}

/** The host to show for a team address: punycode, with its port (what the app connected to, never Unicode). */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** A short label for a team address: the team name part of acme.trina.app, else the host. */
export function teamLabel(origin: string): string {
  try {
    const u = new URL(origin)
    const h = u.hostname
    if (h.endsWith(`.${TEAM_DOMAIN}`)) return h.slice(0, -TEAM_DOMAIN.length - 1)
    if (h.endsWith('.localhost')) return h.slice(0, -'.localhost'.length)
    return u.host
  } catch {
    return origin
  }
}

/** A gateway in front of the team server answered instead of it (a relay or a Cloudflare Tunnel with the server Mac
 * off or asleep: 502-504, Cloudflare's 520-530). The address is right; the server is not reachable just now. */
export function isGatewayDown(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)
}

/** The first connect to an address the hosted service does not run (not this machine, not remembered yet) asks once:
 * "트리나가 운영하는 주소가 아니에요. 회사에서 직접 설치한 서버인지 확인하세요." */
export function asksOutside(o: { hosted: boolean; dev: boolean; known: boolean; confirmed: boolean }): boolean {
  return !o.hosted && !o.dev && !o.known && !o.confirmed
}

