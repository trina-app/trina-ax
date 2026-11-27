// Sign up with Google (docs/AGENTS/plan/20261122-0756-google-signup.md, docs/decisions/20261122-google-signup.md): the
// first owner on the setup page, and invited people on the invite and team link pages, make their account with Google
// instead of a password. The account has no password (users.password_hash NULL): a password sign-in answers it like a
// wrong password (passwords.ts verifyPassword), and its connected Google account is how it signs in.
//
// Each start checks what its password form checks, at once, so nothing fails only after Google over something the page
// could have said: the setup token (accounts.ts checkSetupToken: never from the office internet or Tailscale address,
// the relay's order, wrong tokens counted per address), the hosted team name, the invite (accounts.ts inviteForGoogle:
// works now, not a guest invite, a free username and seat) or the team link (team-links.ts linkForGoogle: its limit,
// works now, a free username). What the person typed travels sealed in the flow with the verifier and the nonce
// (google-login.ts begin `extra`): the team name, language, time zone and website, or the language (a username and name only from older clients) with
// the invite's or link's id. Never a token: the setup token only as its hash; an invite or link token stays in the
// page's tab, and Google's return comes back to the page without it (google-login.ts backTo).
//
// Google's return (google-login.ts settle, after the browser binding, the one use and the id_token checks) runs the
// same write as the password forms: accounts.ts bootstrapOwner (only while no user exists, the setup token still the
// one the start had), accounts.ts joinWithInvite or team-links.ts joinWithLink, then what follows a join, after the
// commit. A Google account that already signs someone in here signs that person in instead (google-login.ts
// signInWith, its refusals included), with nothing made or used up. Refusals come back to the page with
// ?google=<result>: username_taken (pick another and try again), gone, full, cancelled, expired, failed.
//
// Limits: a sign-up start does not count on the per-address Google start limit (an office joining from one address
// would stop at it); an invite's or link's starts count on its own limit (linkKey, as the team link's joins do), given
// back when the account was made. The open-flow cap (google-login.ts GOOGLE_OPEN_FLOWS_MAX) holds for all.
//
// Browsers only: the pages offer it when GET /api/setup, the invite's or the link's info says googleSignUp (this page
// can sign in with Google, googleLoginAvailable). The desktop and phone apps join with a password for now.
import type { Context } from 'hono'
import type { z } from 'zod'
import { PersonName, normalizeWebsite, type GoogleJoinBody, type GoogleSetupBody, type InviteInfo, type Locale, type TeamLinkInfo } from '@mycel/shared/api'
import { NAME_FORBIDDEN } from '@mycel/shared'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail, HttpError } from '../http/errors'
import { fromOutside } from '../http/tunnel'
import { isValidTimeZone } from '../system/time-zone'
import { startWelcomeAtSetup } from '../onboarding/welcome'
import { afterInviteJoin, bootstrapOwner, checkSetupToken, inviteForGoogle, joinWithInvite, ownerTeamName, userCount, type Joiner, type NewCredential } from './accounts'
import { begin, googleLoginAvailable, safeNextPath, type GoogleClaims, type GoogleResult } from './google-login'
import { msg } from './messages'
import { hashToken, safeEqual } from './passwords'
import { linkKey } from './rate-limit'
import { authOf } from './service'
import { afterLinkJoin, joinWithLink, linkForGoogle } from './team-links'
import { usernameFromEmail } from './users'

/** What a sign-up carries sealed to Google's return (google-login.ts begin). */
export type SignUpExtra =
  | { setup: { tokenHash: string; teamName: string; locale: Locale; timeZone: string | null; site: string | null } }
  // username and name null: a join started without them, picked on the way back from Google's address and name
  | { join: { kind: 'invite' | 'link'; id: string; username: string | null; name: string | null; locale: Locale | null } }

/** How a sign-up's return ended: a refusal for its page, the page to open signed in, or `existing`: this Google account
 * already signs someone in here, who signs in instead (google-login.ts signInWith). */
export type SignUpEnd = { result: GoogleResult } | { next: string } | { existing: true }

const INVITE_PAGE = '/invite'
const JOIN_PAGE = '/join'

/** The page a sign-up comes back to with ?google=<result> (google-login.ts backTo). A join keeps its page in the flow's
 * `next` (the address of the page, never its token); where a join goes signed in is always Home. */
export function signUpPage(intent: 'setup' | 'join', next: string | null): string {
  if (intent === 'setup') return '/setup'
  return next === INVITE_PAGE ? INVITE_PAGE : JOIN_PAGE
}

/** POST /api/setup/google: the setup token and the team as POST /api/setup checks them, then Google. */
export function startGoogleSetup(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof GoogleSetupBody>): Promise<{ url: string }> {
  checkSetupToken(c, ctx, b.setupToken)
  ownerTeamName(ctx, b.teamName, c.get('locale'))
  // what a setup would drop quietly is dropped here already: an unknown zone (the server's default), a website that is
  // not one (the profile step starts empty)
  const timeZone = isValidTimeZone(b.timeZone) ? b.timeZone : null
  const site = b.site ? normalizeWebsite(b.site) : null
  return begin(c, ctx, 'setup', null, safeNextPath(b.next), { client: 'web' }, { setup: { tokenHash: hashToken(b.setupToken), teamName: b.teamName, locale: b.locale, timeZone, site } })
}

/** POST /api/invites/google: the invite as an accept checks it (not a guest invite), then Google. */
export async function startGoogleInvite(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof GoogleJoinBody>): Promise<{ url: string }> {
  const { id } = inviteForGoogle(c, ctx, b.token, b.username)
  // one invite's starts count on its own limit (the link's): one token cannot fill the open flows
  const hold = authOf(ctx).limiter.hold([linkKey(id)])
  if (hold.wait > 0) fail('rate_limited', msg('tooManyAttempts', c.get('locale')), { retryAfter: hold.wait })
  return startJoin(c, ctx, hold, { kind: 'invite', id, username: b.username ?? null, name: b.name ?? null, locale: b.locale ?? null })
}

/** POST /api/team-link/google: the link as a join checks it (its limit counts this start), then Google. */
export function startGoogleJoin(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof GoogleJoinBody>): Promise<{ url: string }> {
  const { id, hold } = linkForGoogle(c, ctx, b.token, b.username)
  return startJoin(c, ctx, hold, { kind: 'link', id, username: b.username ?? null, name: b.name ?? null, locale: b.locale ?? null })
}

async function startJoin(c: Context<AppEnv>, ctx: AppContext, hold: { release(): void }, join: Extract<SignUpExtra, { join: unknown }>['join']): Promise<{ url: string }> {
  // a start that does not reach Google (no client here, too many open flows) is not an attempt
  try { return await begin(c, ctx, 'join', null, join.kind === 'invite' ? INVITE_PAGE : JOIN_PAGE, { client: 'web' }, { join }) } catch (e) { hold.release(); throw e }
}

/** Google's return of a sign-up (google-login.ts settle): the account made and signed in, or why not. */
export async function signUpReturn(c: Context<AppEnv>, ctx: AppContext, row: { intent: string; next: string | null }, g: GoogleClaims, extra: SignUpExtra | undefined): Promise<SignUpEnd> {
  const google: NewCredential = { google: { sub: g.sub, email: g.email, hd: g.hd } }
  if (row.intent === 'setup' && extra && 'setup' in extra) return setupReturn(c, ctx, row.next, g, extra.setup)
  if (row.intent === 'join' && extra && 'join' in extra) return joinReturn(c, ctx, google, g, extra.join)
  return { result: 'failed' }
}

/** Google's name as a person's name (PersonName: one line, nothing invisible, 1–100 characters), or null. */
function nameOf(v: string | undefined): string | null {
  const s = (v ?? '').replace(new RegExp(NAME_FORBIDDEN.source, 'gu'), ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  const ok = PersonName.safeParse(s)
  return ok.success ? ok.data : null
}

async function setupReturn(c: Context<AppEnv>, ctx: AppContext, next: string | null, g: GoogleClaims, s: Extract<SignUpExtra, { setup: unknown }>['setup']): Promise<SignUpEnd> {
  // the start's rules hold on the way back: never from the office internet or Tailscale address, and only with the setup
  // token the start was given (spent by a setup meanwhile, or replaced: no)
  if (fromOutside(c.get('info'))) return { result: 'failed' }
  const token = ctx.config.setupToken
  if (!token || !safeEqual(hashToken(token), s.tokenHash) || userCount(ctx.db) > 0) return { result: 'gone' }
  // the username from the Google address (the person can change it later), the name from Google
  const username = usernameFromEmail(ctx.db, g.email)
  let id: string
  try {
    id = await bootstrapOwner(ctx, { username, name: nameOf(g.name) ?? username, email: g.email, teamName: s.teamName, locale: s.locale, timeZone: s.timeZone, credential: { google: { sub: g.sub, email: g.email, hd: g.hd } } })
  } catch (e) {
    // someone set the team up meanwhile (bootstrapOwner's own check, in its write)
    return { result: e instanceof HttpError && e.code === 'conflict' ? 'gone' : 'failed' }
  }
  // as POST /api/setup: the owner's welcome steps start now, with the link's website
  startWelcomeAtSetup(ctx, s.site)
  authOf(ctx).signIn(c, id, 'web', 'cookie')
  return { next: next ?? '/' }
}

async function joinReturn(c: Context<AppEnv>, ctx: AppContext, google: NewCredential, g: GoogleClaims, j: Extract<SignUpExtra, { join: unknown }>['join']): Promise<SignUpEnd> {
  const a = authOf(ctx)
  // a join started without a username: one from the Google address, as setup (still free at the join's write below: it
  // runs in the same turn, nothing awaited between), the name from Google; the person can change both in Profile
  const username = j.username ?? usernameFromEmail(ctx.db, g.email, 'member')
  const who: Joiner = { username, name: j.name ?? nameOf(g.name) ?? username, locale: j.locale }
  const done = j.kind === 'invite' ? joinWithInvite(ctx, j.id, who, google) : joinWithLink(ctx, j.id, who, google, c.get('info'))
  // the start's count on the invite's or link's limit: given back unless the return was refused (a join that worked,
  // or a person who already has an account here, is no failed attempt)
  if (done.ok || done.why === 'connected') a.limiter.forgive(linkKey(j.id))
  if (!done.ok) {
    if (done.why === 'connected') return { existing: true }
    return { result: done.why === 'taken' ? 'username_taken' : done.why === 'full' ? 'full' : 'gone' }
  }
  if ('invite' in done) afterInviteJoin(ctx, done.invite, done.id, done.groups)
  else afterLinkJoin(ctx, done.createdBy, done.id, done.groups)
  a.signIn(c, done.id, 'web', 'cookie')
  // a new member lands on Home and its welcome card, as after a password join
  return { next: '/' }
}

/** GET /api/setup: googleSignUp only while this visitor is told setup is needed (accounts.ts setupStatusFor: never to the
 * office internet address or to a relay visitor without the setup token) and this page can sign in with Google. */
export function withSetupGoogle<T extends { needed: boolean }>(c: Context<AppEnv>, ctx: AppContext, s: T): T & { googleSignUp?: true } {
  return s.needed && googleLoginAvailable(ctx, c.req.url) ? { ...s, googleSignUp: true as const } : s
}

/** The invite's info: googleSignUp while it works, it is not a guest invite and a seat is free, and this page can sign
 * in with Google. */
export function withInviteGoogle(c: Context<AppEnv>, ctx: AppContext, i: InviteInfo): InviteInfo {
  return i.valid && !i.full && i.role !== 'guest' && googleLoginAvailable(ctx, c.req.url) ? { ...i, googleSignUp: true } : i
}

/** The team link's info: googleSignUp while it lets people in and this page can sign in with Google. */
export function withTeamLinkGoogle(c: Context<AppEnv>, ctx: AppContext, i: TeamLinkInfo): TeamLinkInfo {
  return i.valid && googleLoginAvailable(ctx, c.req.url) ? { ...i, googleSignUp: true } : i
}
