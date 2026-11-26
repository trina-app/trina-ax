// Making a free team from the desktop app (docs/decisions/20261126-desktop-create-team.md): what the screens show and
// the addresses the app opens, chosen here and never taken from a screen. Pure: unit-tested in
// tests/unit/e-desktop-common.test.ts. The flow itself is main/create-team.ts; the console contract is
// shared/src/cloud-protocol/owner-claim.ts.
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { OWNER_CLAIM_SETUP_PATH, parseAppError, readOwnerClaimFragment, type AppFreePlan } from '@mycel/shared/cloud-protocol/owner-claim'

/** "Just look around first": the demo team, the same in every build (also the Mac App Store build) */
export const DEMO_URL = 'https://demo.trina.app'
/** "See plans" after the free team was used */
export const PRICING_URL = 'https://ax.trina.app/pricing'

/**
 * The hosting console the app signs in to: the account host. A development run (not packaged) may name another one
 * for tests (`MYCEL_CONSOLE_ORIGIN`): http only on 127.0.0.1, else https; anything else is ignored.
 */
export function consoleOrigin(o: { packaged: boolean; env: Record<string, string | undefined> }): string {
  const fallback = `https://${SERVICE_HOSTS.accountHost}`
  const raw = o.packaged ? undefined : o.env.MYCEL_CONSOLE_ORIGIN
  if (!raw) return fallback
  try {
    const u = new URL(raw)
    if (u.username || u.password || raw.replace(/\/$/, '') !== u.origin) return fallback
    if (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')) return u.origin
  } catch {}
  return fallback
}

/** The links the first-run and create screens may open. The Mac App Store build names no plan and no price
 * (App Review 3.1.1): `pricing` is null there. */
export function createLinks(o: { macAppStore: boolean; console: string }): { demo: string; pricing: string | null; console: string } {
  return { demo: DEMO_URL, pricing: o.macAppStore ? null : PRICING_URL, console: o.console }
}

/** Whether the first-run screen offers "Create a team for free": the console's `GET /api/app/v1/me` without a token
 * answers 401 when it has this flow, 404 when it does not (an older hosting service). Anything else (no answer, a
 * 5xx) is not known yet. */
export type CreateOffer = 'yes' | 'no' | 'unknown'
export function offerFromProbe(status: number | null): CreateOffer {
  return status === 401 ? 'yes' : status === 404 ? 'no' : 'unknown'
}

/** The owner claim's address as the console gave it, checked before the app's window loads it: the team's own origin,
 * exactly `/app-setup#c=<claim>`, no query. Returns the page to open there, or null. */
export function claimPage(url: string, teamUrl: string): string | null {
  try {
    const u = new URL(url), t = new URL(teamUrl)
    if (u.origin !== t.origin || u.username || u.password || u.pathname !== OWNER_CLAIM_SETUP_PATH || u.search) return null
    const claim = readOwnerClaimFragment(u.hash)
    return claim ? `${OWNER_CLAIM_SETUP_PATH}#c=${claim}` : null
  } catch {
    return null
  }
}

/** An older team server's one-time setup link (`unsupported`'s `fields.setupUrl`): on the team's own origin only.
 * Returns the page to open there, or null. */
export function oldSetupPage(url: string | undefined, teamUrl: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url), t = new URL(teamUrl)
    if (u.origin !== t.origin || u.username || u.password || !u.pathname.startsWith('/') || u.pathname.startsWith('//')) return null
    const path = u.pathname + u.search + u.hash
    return path.length <= 2000 && /^[\x21-\x7e]+$/.test(path) ? path : null
  } catch {
    return null
  }
}

/** The address a new team gets, as the name screen shows it: `<slug>.<team domain>` */
export const teamHost = (slug: string): string => `${slug}.${SERVICE_HOSTS.teamDomain}`

/** 4 random a-z0-9 for a name with too few Latin letters (owner-claim.ts suggestTeamSlug) */
export function slugSuffix(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...random(4)].map((b) => abc[b % abc.length]).join('')
}

/** The Free plan's rules as the name screen lists them: each a string key and its numbers (the app words them). */
export function freePlanLines(p: AppFreePlan): { key: 'create.planMembers' | 'create.planMembersAny' | 'create.planAnswers' | 'create.planDisk' | 'create.planSleeps'; n?: string }[] {
  return [
    p.maxActiveMembers === null ? { key: 'create.planMembersAny' } : { key: 'create.planMembers', n: String(p.maxActiveMembers) },
    { key: 'create.planAnswers', n: String(p.maxConcurrency) },
    { key: 'create.planDisk', n: String(p.diskGB) },
    { key: 'create.planSleeps' },
  ]
}

/** The steps of a team being made (`provisioning.step` 1-3), as the starting screen lists them: done, now, later. */
export function startSteps(step: number): ('done' | 'now' | 'later')[] {
  return [1, 2, 3].map((n) => (step > n ? 'done' : step === n ? 'now' : 'later'))
}

/** The state lines of the create flow (each its own words on the screen; main/create-team.ts picks one). */
export const CREATE_NOTICES = [
  'hasTeam', 'freeUsed', 'comeback', 'paused', 'awakeLimit', 'onHold', 'capacityFull', 'waitlist', 'waitlistDone',
  'networkLimit', 'emailUnverified', 'noFreeRegion', 'provisionFailed', 'noFree', 'noTeam', 'offline', 'failed',
] as const
export type CreateNotice = (typeof CREATE_NOTICES)[number]

/** A console error code on create, resume or retry, as the line the app shows; null: not a line (handled by the flow:
 * unauthorized, slug_unavailable, team_exists). */
export function noticeForError(code: string): CreateNotice | null {
  switch (code) {
    case 'free_not_allowed': return 'freeUsed'
    case 'capacity_full': return 'capacityFull'
    case 'free_awake_limit': return 'awakeLimit'
    case 'waitlist': return 'waitlist'
    case 'network_limit': return 'networkLimit'
    case 'email_unverified': return 'emailUnverified'
    case 'no_free_region': return 'noFreeRegion'
    case 'unauthorized': case 'slug_unavailable': case 'team_exists': return null
    default: return 'failed'
  }
}

/** What a notice offers besides Back. The store build offers nothing that makes, starts or buys a team. */
export type NoticeAction = 'open' | 'plans' | 'console' | 'resume' | 'waitlist' | 'retry' | 'again'
export function noticeAction(n: CreateNotice, store: boolean): NoticeAction | null {
  const a: Partial<Record<CreateNotice, NoticeAction>> = {
    hasTeam: 'open', freeUsed: 'plans', comeback: 'console', paused: 'resume', onHold: 'console', waitlist: 'waitlist',
    provisionFailed: 'retry', awakeLimit: 'again', offline: 'again', failed: 'again',
  }
  const act = a[n] ?? null
  if (store && (act === 'plans' || act === 'console' || act === 'resume' || act === 'waitlist' || act === 'retry')) return null
  return act
}

/** why the e-mail sign-in (an e-mail and a 6-digit code typed in the app, `APP_PATHS.emailStart`/`emailVerify`)
 * stopped, as S2 says it */
export type EmailSignInError = 'emailInvalid' | 'codeInvalid' | 'codeExpired' | 'tooMany' | 'offline' | 'failed'
export function emailSignInError(status: number, body: unknown): EmailSignInError {
  const code = parseAppError(body)?.code
  if (code === 'code_invalid') return 'codeInvalid'
  if (code === 'code_expired') return 'codeExpired'
  if (code === 'code_exhausted' || code === 'rate_limited' || status === 429) return 'tooMany'
  if (code === 'invalid_request') return 'emailInvalid'
  return 'failed'
}

/** What the create screens show now (main/create-team.ts → ui/welcome.ts). `off`: the first-run screen itself. */
export type CreateView =
  | { screen: 'off' }
  /** S2: `choose` the two ways ([Continue with Google] in the browser, or an e-mail and [Send code]); `browser` the
   * browser is open; `code` the 6-digit code field. `error` once something failed; `again`: the team waiting for the
   * sign-in ("Sign in again to finish") */
  | { screen: 'signin'; step: 'choose' | 'browser' | 'code'; email: string | null; error: 'cancelled' | 'expired' | EmailSignInError | null; again: string | null; busy: boolean }
  /** S3: name the team */
  | { screen: 'name'; email: string; plan: AppFreePlan; busy: boolean; slugError: boolean; name?: string
      /** a retry over the address (slug_conflict): the name is the team's and cannot change here */
      nameLocked?: boolean }
  /** S4: the team is being made */
  | { screen: 'starting'; team: string; step: number; waitingCapacity: boolean }
  /** a state line (CREATE_NOTICES); `action`: its one button besides Back */
  | { screen: 'notice'; notice: CreateNotice; action: NoticeAction | null; team: string | null; email: string | null; busy: boolean }
