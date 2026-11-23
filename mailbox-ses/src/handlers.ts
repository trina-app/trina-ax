// The mailbox on AWS (mailbox-ses), without the Lambda runtime: what the two functions do, so tests can run it.
//
//   gateway: Amazon SES receives a mail for in.trina.app, stores it raw in S3 (rule action 1) and calls this function
//            (rule action 2, asynchronous). For each SMTP recipient it runs the mailbox gateway (mailbox/src/gateway.ts
//            receiveMail: address, size, queue room, limits, auth headers, seal, queue), then deletes the S3 object.
//   api:     the team servers' API (mailbox/src/api.ts handleApi, contract shared/src/cloud-protocol/mail-in.ts) on a
//            Lambda function URL. A held poll cannot be woken by the gateway (another function): PollingWaiters looks
//            at the store every few seconds instead.
//
// What differs from the Cloudflare reference (mailbox/src/worker.ts), and why:
//   - No refusal at SMTP time. SES has accepted the mail when the gateway runs. An unknown, removed or replaced address,
//     a mail over MAIL_IN_RAW_MAX, a full queue and a limit all DROP the mail (log `mail_refused` with the reason).
//     No bounce is sent: a bounce goes to the envelope sender, which spam forges (backscatter).
//   - One stored mail can have several recipients (one SMTP transaction): each is handled, once (a `d:` mark per
//     message and recipient, so a retried invocation does not queue a copy).
//   - The receiving service's own verdict comes from SES's Authentication-Results header (authserv-id amazonses.com).
//   - A mail SES marks as a virus (virusVerdict FAIL) is dropped before the gateway.
import { MAIL_IN_RAW_MAX } from '../../shared/src/cloud-protocol/mail-in.ts'
import { handleApi } from '../../mailbox/src/api.ts'
import type { MailboxDeps, WaitersLike } from '../../mailbox/src/deps.ts'
import { receiveMail } from '../../mailbox/src/gateway.ts'
import type { KvLike } from '../../mailbox/src/store.ts'

export const SES_AUTHSERV_ID = 'amazonses.com'

/** Waits by looking at the store: `ready(team)` true (an item a poll would hand out) ends the wait early. */
export class PollingWaiters implements WaitersLike {
  constructor(private ready: (teamId: string) => Promise<boolean>, private everyMs = 2000) {}
  wait(_teamId: string, ms: number): { done: Promise<void>; cancel: () => void } {
    let stop = false
    let wake!: () => void
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<void>((resolve) => { wake = resolve })
    const end = Date.now() + ms
    const finish = () => { stop = true; if (timer) clearTimeout(timer); wake() }
    const tick = async () => {
      if (stop) return
      const left = end - Date.now()
      if (left <= 0) return finish()
      timer = setTimeout(async () => {
        if (stop) return
        try { if (await this.ready(_teamId)) return finish() } catch { return finish() }
        void tick()
      }, Math.min(this.everyMs, left))
    }
    void tick()
    return { done, cancel: finish }
  }
  /** the gateway runs in another function: nothing to wake here */
  wake(_teamId: string) {}
}

/** The part of the SES Lambda event this uses (SES "Lambda action" event, one record). */
export interface SesEvent {
  Records: { ses: { mail: { messageId: string; source: string }; receipt: { recipients: string[]; virusVerdict?: { status?: string } } } }[]
}

export interface GatewayOptions {
  deps: MailboxDeps
  /** the store's key-value interface, for the receipt marks (`d:`) */
  kv: KvLike
  s3: { get(key: string, max: number): Promise<{ size: number; bytes: Uint8Array | null } | null>; delete(key: string): Promise<void> }
  /** the S3 key prefix of the rule's S3 action, e.g. "raw/" */
  prefix: string
}

const MESSAGE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** One SES invocation. Throws only on a fault of the store or S3 (Lambda then tries again; the marks keep it once). */
export async function handleSesEvent(o: GatewayOptions, event: SesEvent): Promise<void> {
  const log = (e: string, f: Record<string, string | number>) => { try { o.deps.log?.(e, f) } catch { /* logging only */ } }
  for (const rec of event.Records ?? []) {
    const { mail, receipt } = rec.ses
    if (!MESSAGE_ID_RE.test(mail.messageId)) { log('mail_refused', { reason: 'bad_message_id' }); continue }
    const key = `${o.prefix}${mail.messageId}`
    if (receipt.virusVerdict?.status === 'FAIL') { log('mail_refused', { reason: 'virus' }); await o.s3.delete(key); continue }
    const obj = await o.s3.get(key, MAIL_IN_RAW_MAX)
    if (!obj) { log('mail_refused', { reason: 'no_object' }); continue }
    for (const to of receipt.recipients ?? []) {
      const mark = `d:${mail.messageId}:${await o.deps.crypto.sha256Hex(to.toLowerCase())}`
      if (await o.kv.get(mark)) continue
      // too big: no bytes were read; receiveMail answers the address check first, then the size (from rawSize)
      await receiveMail(o.deps, { to, from: mail.source ?? '', raw: obj.bytes ?? new Uint8Array(0), rawSize: obj.size })
      await o.kv.put(mark, 1)
    }
    // the mail in clear: gone as soon as it is sealed (the bucket's 1-day lifecycle is a backstop only)
    await o.s3.delete(key)
  }
}

/** The part of a Lambda function URL event this uses (payload format 2.0). */
export interface UrlEvent {
  rawPath: string
  headers?: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
  requestContext: { http: { method: string } }
}

/** One API call from a function URL event. */
export async function handleUrlEvent(deps: MailboxDeps, event: UrlEvent): Promise<Response> {
  const method = event.requestContext.http.method.toUpperCase()
  const headers = new Headers()
  for (const [k, v] of Object.entries(event.headers ?? {})) if (typeof v === 'string') headers.set(k, v)
  const body = method === 'POST' && event.body !== undefined ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined
  return handleApi(deps, new Request(`https://mailbox.internal${event.rawPath}`, { method, headers, body }))
}

/** The hosting service's registry (trina-cloud POST /internal/mail-in/team), cached: served 5 minutes, not served 1
 * minute. A fault (CP down) throws: the API then answers 502 and the team server tries again (not "not hosted"). */
export function cpTeams(o: { url: string; token: () => Promise<string>; fetch?: (u: string, i: RequestInit) => Promise<Response>; now?: () => number }) {
  const f = o.fetch ?? ((u, i) => fetch(u, i))
  const now = o.now ?? (() => Date.now())
  const cache = new Map<string, { teamId: string | null; until: number }>()
  return async (key: string): Promise<string | null> => {
    const hit = cache.get(key)
    if (hit && hit.until > now()) return hit.teamId
    const r = await f(o.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await o.token()}` }, body: JSON.stringify({ key }), signal: AbortSignal.timeout(5000) })
    let teamId: string | null = null
    if (r.status === 200) {
      const j = await r.json().catch(() => null) as { teamId?: unknown } | null
      if (typeof j?.teamId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(j.teamId)) throw new Error('registry: bad answer')
      teamId = j.teamId
    } else if (r.status === 404) {
      await r.body?.cancel()
    } else {
      await r.body?.cancel()
      throw new Error(`registry: ${r.status}`)
    }
    if (cache.size > 10_000) cache.clear()
    cache.set(key, { teamId, until: now() + (teamId ? 300_000 : 60_000) })
    return teamId
  }
}
