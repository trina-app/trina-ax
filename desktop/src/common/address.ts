// What people put in the first-run screen's one box: an invite link, a team link, an address, a bare name ("acme") or
// a whole pasted message with the link in it. The reading itself is shared with the phone app (shared/src/team-link.ts);
// here it gets the desktop's rules: the hosted team domain, and plain http only for this machine (development).
// Pure: no Electron, unit-tested in tests/unit/e-desktop-common.test.ts and tests/unit/team-link.test.ts.
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { PRODUCT, SOURCE_CODE } from '@mycel/shared'
import { parseTeamInput, readAppLink, relayAnswer, relayRename, type RelayAnswer, type TeamInput, type TeamInputError, type TeamInputOptions } from '@mycel/shared/team-link'

export { hostLineShown, isLoopbackHost, isSignInPath } from '@mycel/shared/team-link'

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
 * domains), read with the box's rules (https; http only to this machine). null: not a link for this app. */
export function readDesktopLink(raw: string): TeamInput | null {
  return readAppLink(raw, { ...DESKTOP_INPUT, scheme: LINK_SCHEME, universal: false })
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
  | { ok: false; error: 'unreachable' | 'notTeamServer' | 'teamUnknown' | 'suspended' }

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
  // a tunnel / relay error page (e.g. Cloudflare 530 while the office's Mac is off) is "cannot reach", not "not a team server"
  if (answer === 'offline' || isGatewayDown(r.status)) return { ok: false, error: 'unreachable' }
  if (r.status < 200 || r.status > 299 || !r.bodyOk) return { ok: false, error: 'notTeamServer' }
  return { ok: true }
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


/**
 * Where the "no team yet" screen's buttons go, chosen here and opened by the main process (never an address from the
 * screen). `signup`: the hosted service's account site, null in the Mac App Store build (App Review 3.1.1: no call to
 * action for a purchase outside the app; the signup leads to a paid plan). `docs`: how to install a team server: the
 * docs site's install page, or in the Mac App Store build the repository's install guide, which has no signup or
 * pricing link (the docs site's install page links the plans).
 */
export function firstRunLinks(o: { macAppStore: boolean; korean: boolean }): { signup: string | null; docs: string } {
  const guide = `${SOURCE_CODE.repository}/blob/main/docs/INSTALL-LINUX${o.korean ? '' : '.en'}.md`
  if (o.macAppStore) return { signup: null, docs: guide }
  return { signup: `https://${SERVICE_HOSTS.accountHost}/`, docs: INSTALL_DOCS }
}

/** The docs site's install page (docs/site/operate/install.md; scripts/docs/build.ts publishes the site there). */
export const INSTALL_DOCS = 'https://ax.trina.app/docs/operate/install'
