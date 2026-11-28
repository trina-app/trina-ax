// A hosted team made from the desktop app (docs/decisions/20261126-desktop-create-team.md, contract
// shared/src/cloud-protocol/owner-claim.ts): the hosting console made the team, and the app opens
// `https://<team>/app-setup#c=<claim>` in its window. The page sends the claim here; this server asks the console who
// the owner is and makes the owner account, then spends the claim. Two-phase, so a failure in between leaves the claim
// usable again:
//   1. reserve: POST <console>/api/hosted-team/v1/owner/reserve {v:1, claim}, signed with the relay team key (exactly as
//      system/cloud-team-name.ts), answers the team name and the owner (e-mail, name, language, zone, Google or not).
//      Repeatable; the preview (`POST /api/setup/console/preview`) stops here.
//   2. bootstrapOwner (accounts.ts): only while no user exists; the username from the e-mail; with Google that Google
//      account and no password, else the password the person chose on the page (checked like every new password, before
//      anything is made: a weak one leaves the claim unspent).
//   3. confirm: POST .../owner/confirm {v:1, claim} spends the claim. A failed confirm is tried again in the background
//      (the console also closes it when the team reports that it is set up).
// Then a desktop session with a cookie, like the app's one-time sign-in (auth/app-signin.ts); audit `setup`
// `method: 'console'`.
//
// Before any call to the console: only a hosted server, the per-address token guard (accounts.ts tokenGuard, the same
// counter as setup tokens and app sign-in codes) and the claim's shape (43 base64url characters). A bad shape and a claim
// the console does not know count against the caller's address. The claim is never logged or stored.
import crypto from 'node:crypto'
import type { Context } from 'hono'
import type { z } from 'zod'
import { DEFAULT_LOCALE, Locale, PersonName, type ConsoleSetupBody, type ConsoleSetupPreview, type ConsoleSetupPreviewBody, type LoginResponse } from '@mycel/shared/api'
import {
  isOwnerClaim, OWNER_CLAIM_CONFIRM_PATH, OWNER_CLAIM_MAX_BODY_BYTES, OWNER_CLAIM_RESERVE_PATH, ownerClaimSigningString,
  parseOwnerClaimConfirmAnswer, parseOwnerClaimOwner, type OwnerClaimOwner, type OwnerClaimPath,
} from '@mycel/shared/cloud-protocol/owner-claim'
import { driveBrokerAuthorization } from '@mycel/shared/cloud-protocol/drive-broker'
import type { AppContext } from '../context'
import type { AppEnv } from '../http/env'
import { fail } from '../http/errors'
import { isHosted } from '../system/deployment'
import { brokerOrigin, type BrokerIdentity } from '../integrations/google-drive/broker'
import { loadOrCreateKey } from '../relay-client/registration'
import { startWelcomeAtSetup } from '../onboarding/welcome'
import { bootstrapOwner, checkNewPassword, tokenGuard, userCount } from './accounts'
import { msg } from './messages'
import { authOf } from './service'
import { usernameFromEmail } from './users'

export interface OwnerClaimClient {
  origin: string
  identity: () => BrokerIdentity
  fetch?: typeof fetch
  now?: () => number
  /** waits before the 2nd, 3rd, ... confirm (ms) */
  retryMs?: number[]
}

const RETRY_MS = [10_000, 60_000, 5 * 60_000]

/** Where and how this server asks the console, or null: not hosted, or no console origin (a test app never calls the
 * real hosting service: brokerOrigin under NODE_ENV=test). */
export function ownerClaimClientFor(ctx: AppContext, env: Record<string, string | undefined> = process.env): OwnerClaimClient | null {
  if (!isHosted(ctx.config)) return null
  const origin = brokerOrigin(env, true)
  if (!origin) return null
  return { origin, identity: () => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } } }
}

const clients = new WeakMap<AppContext, OwnerClaimClient | null>()
/** tests: ask this console (a fake) instead of the environment's */
export function setOwnerClaimClient(ctx: AppContext, client: OwnerClaimClient | null): void { clients.set(ctx, client) }
const clientOf = (ctx: AppContext) => clients.has(ctx) ? clients.get(ctx)! : ownerClaimClientFor(ctx)

type Answer = { ok: true; json: unknown } | { ok: false; status: number | null; code: string | null }

/** One signed call; a 401 (a clock step, a nonce seen) is tried once more at once with a new time and nonce. */
async function signedPost(cl: OwnerClaimClient, path: OwnerClaimPath, claim: string): Promise<Answer> {
  const text = JSON.stringify({ v: 1, claim })
  if (Buffer.byteLength(text) > OWNER_CLAIM_MAX_BODY_BYTES) return { ok: false, status: null, code: 'too_large' }
  let id: BrokerIdentity
  try { id = cl.identity() } catch { return { ok: false, status: null, code: 'no_key' } }
  const bodyHash = crypto.createHash('sha256').update(text).digest('hex')
  for (let attempt = 0; ; attempt++) {
    const ts = (cl.now ?? Date.now)(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(ownerClaimSigningString(path, ts, nonce, bodyHash), 'utf8'), id.key).toString('base64')
    let r: Response
    try {
      r = await (cl.fetch ?? fetch)(cl.origin + path, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: driveBrokerAuthorization(id.publicKey, ts, nonce, sig) }, body: text,
      })
    } catch { return { ok: false, status: null, code: 'unreachable' } }
    let json: any = null
    try { const raw = await r.text(); json = raw.length <= 65_536 ? JSON.parse(raw) : null } catch { json = null }
    if (r.ok) return { ok: true, json }
    if (r.status === 401 && attempt === 0) continue
    const raw = json?.error?.code
    return { ok: false, status: r.status, code: typeof raw === 'string' && /^[a-z0-9_]{1,40}$/.test(raw) ? raw : null }
  }
}

export type ReserveResult = { owner: OwnerClaimOwner } | { why: 'invalid' | 'set_up' | 'unavailable' }

/** Phase 1: who the owner is. `invalid`: the console does not know the claim (unknown, used, expired, another team's);
 * `set_up`: the console knows the team as set up; `unavailable`: no answer, a refusal of this server, or a console
 * without these paths (404). */
export async function reserveOwner(cl: OwnerClaimClient, claim: string): Promise<ReserveResult> {
  const r = await signedPost(cl, OWNER_CLAIM_RESERVE_PATH, claim)
  if (r.ok) {
    const owner = parseOwnerClaimOwner(r.json)
    return owner ? { owner } : { why: 'unavailable' }
  }
  if (r.status === 410 || r.code === 'invalid_claim') return { why: 'invalid' }
  if (r.status === 409 && r.code === 'already_set_up') return { why: 'set_up' }
  return { why: 'unavailable' }
}

/** Phase 3: spend the claim. true: spent now or before (a repeat answers spent: false), or the console no longer knows
 * it (nothing left to spend). */
export async function confirmOwner(cl: OwnerClaimClient, claim: string): Promise<boolean> {
  const r = await signedPost(cl, OWNER_CLAIM_CONFIRM_PATH, claim)
  if (r.ok) return parseOwnerClaimConfirmAnswer(r.json) !== null
  return r.status === 410 || r.code === 'invalid_claim'
}

/** Confirm now; when that fails, again in the background a few times (the server stopping ends it). Resolves when the
 * first try is over; `done` (tests) when every try is. */
export function confirmInBackground(ctx: AppContext, cl: OwnerClaimClient, claim: string): { first: Promise<boolean>; done: Promise<boolean> } {
  let closed = false
  ctx.onClose(() => { closed = true })
  const first = confirmOwner(cl, claim)
  const done = (async () => {
    if (await first) return true
    for (const ms of cl.retryMs ?? RETRY_MS) {
      await new Promise<void>((res) => { const t = setTimeout(res, ms); (t as { unref?: () => void }).unref?.() })
      if (closed) return false
      if (await confirmOwner(cl, claim)) return true
    }
    ctx.log.warn('the owner claim was not confirmed with the hosting service; its setup report closes it')
    return false
  })()
  return { first, done }
}

/** The checks before any call to the console, then the reserve. Every refusal before the console is the same for a
 * team that is set up and one that is not, except `conflict` after a well-formed claim. */
async function reserveFor(c: Context<AppEnv>, ctx: AppContext, claim: string): Promise<{ cl: OwnerClaimClient; owner: OwnerClaimOwner; guard: { fail(): void } }> {
  const locale = c.get('locale')
  if (!isHosted(ctx.config)) fail('not_found')
  const guard = tokenGuard(ctx, c.get('info').ip)
  if (!isOwnerClaim(claim)) { guard.fail(); fail('gone', msg('consoleClaimGone', locale)) }
  if (userCount(ctx.db) > 0) fail('conflict', msg('setupDone', locale))
  const cl = clientOf(ctx)
  if (!cl) fail('unavailable', msg('consoleUnavailable', locale))
  const r = await reserveOwner(cl!, claim)
  if ('owner' in r) return { cl: cl!, owner: r.owner, guard }
  if (r.why === 'invalid') { guard.fail(); fail('gone', msg('consoleClaimGone', locale)) }
  if (r.why === 'set_up') fail('conflict', msg('setupDone', locale))
  return fail('unavailable', msg('consoleUnavailable', locale))
}

/** The first owner's name when the console has none usable: "Admin" in the team's language (English when it is not one
 * of ours), never a fixed word of one language. */
export const FIRST_ADMIN_NAME: Record<Locale, string> = { ko: '관리자', en: 'Admin', id: 'Admin', ja: '管理者', es: 'Administrador', zh: '管理员' }
/** The e-mail's part before @ without a "+tag" (`kim+create1127@…` → `kim`), as a name to start from. */
export const nameFromEmail = (email: string): string => email.split('@')[0]!.split('+')[0]!
/** The owner's name as an account name: the console's (a console that sent the e-mail's part before @ as the name
 * gets it without its +tag), else the e-mail's part before @ without the tag, else "Admin" in the team's language. */
export function ownerName(o: Pick<OwnerClaimOwner, 'name' | 'email'> & Partial<Pick<OwnerClaimOwner, 'locale'>>): string {
  const local = o.email.split('@')[0]!
  const given = o.name === local || /^[^\s@+]+\+[^\s@]*$/.test(o.name) ? o.name.split('+')[0]! : o.name
  for (const n of [given, nameFromEmail(o.email)]) { const p = PersonName.safeParse(n); if (p.success && p.data) return p.data }
  return FIRST_ADMIN_NAME[ownerLocale(o)] ?? FIRST_ADMIN_NAME.en
}
/** the name the person wrote on the page, when it is one (PersonName's rule) */
function typedName(n: string | undefined): string | null {
  const p = n === undefined ? null : PersonName.safeParse(n)
  return p?.success && p.data ? p.data : null
}
function ownerLocale(o: Partial<Pick<OwnerClaimOwner, 'locale'>>): Locale {
  if (!o.locale) return DEFAULT_LOCALE
  const p = Locale.safeParse(o.locale.split('-')[0]!.toLowerCase())
  return p.success ? p.data : DEFAULT_LOCALE
}

/** POST /api/setup/console/preview: the team and the owner, for the page's "Welcome to {team}, {name}". Spends nothing. */
export async function previewConsoleSetup(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof ConsoleSetupPreviewBody>): Promise<ConsoleSetupPreview> {
  const { owner } = await reserveFor(c, ctx, b.claim)
  // no user exists yet (reserveFor): the username setup will make is this one
  return { teamName: owner.teamName, name: ownerName(owner), email: owner.email, google: owner.google !== null, username: usernameFromEmail(ctx.db, owner.email) }
}

/** POST /api/setup/console: make the owner, spend the claim, sign the app in. */
export async function consoleSetup(c: Context<AppEnv>, ctx: AppContext, b: z.output<typeof ConsoleSetupBody>): Promise<LoginResponse> {
  const locale = c.get('locale')
  const { cl, owner } = await reserveFor(c, ctx, b.claim)
  const username = usernameFromEmail(ctx.db, owner.email)
  let credential: { password: string } | { google: { sub: string; email: string | null; hd: string | null } }
  if (owner.google) {
    // made with the Google account the console proved: no password (the person never chose one)
    if (b.password !== undefined) fail('bad_request')
    credential = { google: { sub: owner.google.sub, email: owner.google.email, hd: owner.google.hd } }
  } else {
    if (!b.password) fail('validation', msg('consolePasswordNeeded', locale), { fields: { 'body.password': 'required' } })
    // before anything is made: a weak password leaves the claim unspent
    checkNewPassword(b.password!, username, locale, 'body.password')
    credential = { password: b.password! }
  }
  const id = await bootstrapOwner(ctx, {
    username, email: owner.email, name: typedName(b.name) ?? ownerName(owner), teamName: owner.teamName, locale: b.locale ?? ownerLocale(owner),
    timeZone: owner.timeZone, credential, method: 'console',
  })
  // the claim is spent only now; a failed confirm is tried again without holding up the sign-in
  await confirmInBackground(ctx, cl, b.claim).first
  // the owner's welcome steps start now, as after the setup page
  startWelcomeAtSetup(ctx, null)
  return authOf(ctx).signIn(c, id, b.client, b.tokenMode)
}
