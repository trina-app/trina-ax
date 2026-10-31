// Code sandbox (docs/DECISIONS.md "Code sandbox", build phase D1; owner decision 2026-10-31): an owner or admin may let
// the AI run bash and python3 for chosen people (Admin > Team settings), after accepting a warning. Off by default.
// The code runs in a separate sandbox per run that the launcher starts (no network, only the chat's work folder; see
// native/cmd/mycel-launcher/code.go); its results reach team folders only through the normal file tools.
//
// The server decides per turn and again per call (chat/code-sandbox.ts): the scope says the person, the launcher says
// the installation can (Linux with the bwrap sandbox, a plan that includes it). Nothing of the client is trusted.
import { CODE_SANDBOX_WARNING_VERSION, CodeSandboxConsent, CodeSandboxScope, type CodeSandboxAvailability, type CodeSandboxResponse } from '@mycel/shared/api'
import type { LauncherStatus } from '@mycel/shared'
import type { AppContext } from '../context'
import { launcherStatus } from '../native'
import { getSetting, setSetting } from './settings'

export const CODE_SANDBOX_SCOPE_KEY = 'codeSandbox.scope'
export const CODE_SANDBOX_CONSENT_KEY = 'codeSandbox.consent'
const OFF: CodeSandboxScope = { mode: 'off', groupIds: [], userIds: [] }

/** Realtime notice: who gets the code sandbox changed. Open windows ask GET /api/me again (the composer badge). */
export const CODE_SANDBOX_CHANGED = { type: 'notice', data: { level: 'info', code: 'code_sandbox_changed', message: '' } } as const

type Db = Pick<AppContext, 'db'>

export function codeSandboxScope(ctx: Db): CodeSandboxScope {
  const v = CodeSandboxScope.safeParse(getSetting(ctx.db, CODE_SANDBOX_SCOPE_KEY))
  return v.success ? v.data : OFF
}

export function codeSandboxConsent(ctx: Db): CodeSandboxConsent | null {
  const v = CodeSandboxConsent.safeParse(getSetting(ctx.db, CODE_SANDBOX_CONSENT_KEY))
  return v.success ? v.data : null
}

/** The scope is in force only with a consent to the current warning (a newer warning turns it off until accepted). */
export function codeSandboxInForce(ctx: Db): boolean {
  return codeSandboxScope(ctx).mode !== 'off' && codeSandboxConsent(ctx)?.warningVersion === CODE_SANDBOX_WARNING_VERSION
}

export function setCodeSandbox(ctx: Db, scope: CodeSandboxScope, consent: CodeSandboxConsent | null) {
  ctx.db.transaction(() => {
    setSetting(ctx.db, CODE_SANDBOX_SCOPE_KEY, { mode: scope.mode, groupIds: [...new Set(scope.groupIds)], userIds: [...new Set(scope.userIds)] })
    if (consent) setSetting(ctx.db, CODE_SANDBOX_CONSENT_KEY, consent)
  })()
}

/** Does the scope name this person (their groups as they are now)? Disabled or deleted accounts never. */
export function codeSandboxFor(ctx: Db, userId: string): boolean {
  if (!codeSandboxInForce(ctx)) return false
  const u = ctx.db.query('SELECT status, deleted_at FROM users WHERE id = ?').get(userId) as { status: string; deleted_at: string | null } | null
  if (!u || u.deleted_at || u.status !== 'active') return false
  const s = codeSandboxScope(ctx)
  if (s.mode === 'everyone') return true
  if (s.userIds.includes(userId)) return true
  if (!s.groupIds.length) return false
  return !!ctx.db.query(`SELECT 1 FROM group_members WHERE user_id = ? AND group_id IN (${s.groupIds.map(() => '?').join(',')}) LIMIT 1`).get(userId, ...s.groupIds)
}

// ---------------- can this installation run code? (the launcher's answer, cached) ----------------
type Probe = (sock: string) => Promise<LauncherStatus | null>
const realProbe: Probe = (sock) => launcherStatus(sock, 2000)
let probe: Probe = realProbe
/** tests: answer for the launcher */
export function setCodeSandboxProbe(p: Probe | null) { probe = p ?? realProbe; cache = new WeakMap() }

let cache = new WeakMap<object, { at: number; v: CodeSandboxAvailability }>()
const CACHE_MS = 30_000

/** The socket of the launcher that runs this server's turns (the core's: a prod install's or the one dev started). */
async function launcherSock(ctx: AppContext): Promise<string | null> {
  const l = (await ctx.core()).launcher as { path?: unknown } | null
  return l && typeof l.path === 'string' ? l.path : null
}

/** What the launcher says about code runs; a launcher that cannot be reached or says nothing = not available. */
export async function codeSandboxAvailability(ctx: AppContext, fresh = false): Promise<CodeSandboxAvailability> {
  const hit = cache.get(ctx.db)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.v
  const sock = await launcherSock(ctx).catch(() => null)
  const st = sock ? await probe(sock).catch(() => null) : null
  const v = availabilityOf(st)
  cache.set(ctx.db, { at: Date.now(), v })
  return v
}

/** Synchronous answer for GET /api/me (the composer badge): the scope names the person and the last known launcher
 * answer did not say no. A stale answer is refreshed in the background. The turn itself always asks (chat/code-sandbox.ts). */
export function codeSandboxBadge(ctx: AppContext, userId: string): boolean {
  if (!codeSandboxFor(ctx, userId)) return false
  const hit = cache.get(ctx.db)
  if (!hit || Date.now() - hit.at >= CACHE_MS) void codeSandboxAvailability(ctx).catch(() => {})
  return hit?.v.available !== false
}

export function availabilityOf(st: LauncherStatus | null): CodeSandboxAvailability {
  if (!st) return { available: false, reason: 'launcher' }
  const cs = st.codeSandbox
  if (st.os !== 'linux' || st.sandbox !== 'bwrap' || !cs) return { available: false, reason: 'platform' }
  if (cs.available) return { available: true, ...(cs.runtimes ? { runtimes: cs.runtimes } : {}) }
  return { available: false, reason: /plan/.test(cs.reason ?? '') ? 'plan' : 'setup', ...(cs.runtimes ? { runtimes: cs.runtimes } : {}) }
}

export async function codeSandboxResponse(ctx: AppContext, fresh = false): Promise<CodeSandboxResponse> {
  return { scope: codeSandboxScope(ctx), consent: codeSandboxConsent(ctx), warningVersion: CODE_SANDBOX_WARNING_VERSION, availability: await codeSandboxAvailability(ctx, fresh) }
}
