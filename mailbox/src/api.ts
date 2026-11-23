// The mailbox's API for team servers (shared/src/cloud-protocol/mail-in.ts "Flows" and "Request"): status, key, sync,
// poll. Every call is POST with a strict JSON body, signed with the team server's relay team key (TrinaMailIn
// authorization): the signature over the exact body, the clock within ±MAIL_IN_MAX_SKEW_MS, a nonce used once, and the
// key one the hosting service serves now (deps.teams). Errors are JSON { error: { code, message } } with the status of
// MAIL_IN_ERRORS; a message never holds a mail, an address or a key.
import {
  MAIL_IN_ACK_MAX, MAIL_IN_ERRORS, MAIL_IN_ITEM_TTL_MS, MAIL_IN_LEASE_MS, MAIL_IN_MAX_BODY_BYTES, MAIL_IN_MAX_SKEW_MS,
  MAIL_IN_PATHS, MAIL_IN_POLL_MAX_BYTES, MAIL_IN_POLL_MAX_ITEMS, mailInSigningString, parseMailInAuthorization,
  parseMailInKey, parseMailInPoll, parseMailInStatus, parseMailInSync, type MailInErrorCode, type MailInPollAnswer,
} from '../../shared/src/cloud-protocol/mail-in.ts'
import type { MailboxDeps } from './deps.ts'
import { readAtMost } from './gateway.ts'

const MESSAGES: Record<MailInErrorCode, string> = {
  invalid_request: 'The request is not one this API takes.',
  unauthorized: 'The request is not signed correctly.',
  not_hosted: 'This server is not served by the mail service.',
  no_key: 'Send the seal key first.',
  rate_limited: 'Too many requests. Try again later.',
  not_configured: 'The mail service is not set up.',
}
/** Calls per team per minute, at most (a team server makes one poll at a time and a few other calls). */
export const API_CALLS_PER_MINUTE = 120

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
export const apiError = (code: MailInErrorCode) => json(MAIL_IN_ERRORS[code], { error: { code, message: MESSAGES[code] } })
const OPS = new Map<string, keyof typeof MAIL_IN_PATHS>(Object.entries(MAIL_IN_PATHS).map(([op, p]) => [p, op as keyof typeof MAIL_IN_PATHS]))

/** The calls of one team in the current minute (in memory: one process). */
class CallCounter {
  private m = new Map<string, { minute: number; n: number }>()
  take(teamId: string, now: number): boolean {
    const minute = Math.floor(now / 60_000)
    const c = this.m.get(teamId)
    if (!c || c.minute !== minute) { this.m.set(teamId, { minute, n: 1 }); return true }
    return ++c.n <= API_CALLS_PER_MINUTE
  }
}
const counters = new WeakMap<MailboxDeps, CallCounter>()
/** The poll a team holds now: a newer poll of the same team answers it at once (empty), so a restarted server is not
 * blocked by its own old poll. */
const holds = new WeakMap<MailboxDeps, Map<string, () => void>>()

export async function handleApi(deps: MailboxDeps, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const op = OPS.get(url.pathname)
  if (!op) return new Response('Not found', { status: 404 })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } })
  if (!deps.domain) return apiError('not_configured')
  // the body, bounded
  if (!req.body) return apiError('invalid_request')
  const bytes = await readAtMost(req.body, MAIL_IN_MAX_BODY_BYTES)
  if (!bytes) return apiError('invalid_request')
  // the signature over these exact bytes
  const auth = parseMailInAuthorization(req.headers.get('authorization'))
  if (!auth) return apiError('unauthorized')
  const now = deps.now()
  if (Math.abs(now - auth.ts) > MAIL_IN_MAX_SKEW_MS) return apiError('unauthorized')
  const signing = mailInSigningString(url.pathname, auth.ts, auth.nonce, await deps.crypto.sha256Hex(bytes))
  if (!(await deps.crypto.verify(auth.key, new TextEncoder().encode(signing), auth.sig))) return apiError('unauthorized')
  // a nonce once per key (kept as long as a timestamp is taken)
  if (!(await deps.store.freshNonce(auth.key, auth.nonce, now, 2 * MAIL_IN_MAX_SKEW_MS))) return apiError('unauthorized')
  const teamId = await deps.teams(auth.key)
  if (!teamId) return apiError('not_hosted')
  let counter = counters.get(deps)
  if (!counter) { counter = new CallCounter(); counters.set(deps, counter) }
  if (!counter.take(teamId, now)) return apiError('rate_limited')
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return apiError('invalid_request') }
  const store = deps.store
  switch (op) {
    case 'status': {
      if (!parseMailInStatus(body)) return apiError('invalid_request')
      const t = await store.team(teamId)
      return json(200, { ok: true, domain: deps.domain, sealKey: t.sealKey, addresses: t.hashes.length })
    }
    case 'key': {
      const b = parseMailInKey(body)
      if (!b) return apiError('invalid_request')
      await store.setSealKey(teamId, b.sealKey)
      return json(200, { ok: true })
    }
    case 'sync': {
      const b = parseMailInSync(body)
      if (!b) return apiError('invalid_request')
      const set = await store.syncHashes(teamId, b.hashes)
      deps.log?.('mail_sync', { addresses: set.length })
      return json(200, { ok: true, addresses: set.length })
    }
    case 'poll': {
      const b = parseMailInPoll(body)
      if (!b || b.ack.length > MAIL_IN_ACK_MAX) return apiError('invalid_request')
      if (!(await store.team(teamId)).sealKey) return apiError('no_key')
      await store.ack(teamId, b.ack)
      return json(200, await poll(deps, teamId, b.waitMs))
    }
  }
}

async function poll(deps: MailboxDeps, teamId: string, waitMs: number): Promise<MailInPollAnswer> {
  const store = deps.store
  const take = async () => {
    const now = deps.now()
    await store.expire(teamId, now, MAIL_IN_ITEM_TTL_MS)
    return store.take(teamId, now, MAIL_IN_LEASE_MS, MAIL_IN_POLL_MAX_ITEMS, MAIL_IN_POLL_MAX_BYTES)
  }
  let items = await take()
  if (!items.length && waitMs > 0) {
    let held = holds.get(deps)
    if (!held) { held = new Map(); holds.set(deps, held) }
    held.get(teamId)?.()
    // a leased item that comes free before the wait ends also answers it
    const leaseEnd = await store.nextLeaseEnd(teamId, deps.now())
    const ms = leaseEnd !== null ? Math.max(0, Math.min(waitMs, leaseEnd - deps.now())) : waitMs
    const w = deps.waiters.wait(teamId, ms)
    let superseded = false
    held.set(teamId, () => { superseded = true; w.cancel() })
    await w.done
    if (held.get(teamId) && !superseded) held.delete(teamId)
    if (!superseded) items = await take()
  }
  return { items, expired: await store.takeExpired(teamId) }
}
