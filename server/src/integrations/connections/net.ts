// Requests to external services (docs/INTEGRATIONS.md): https only, the web_fetch address rules (tools/web-fetch.ts
// resolveTarget: public internet addresses only, never the office network, this server or the office's own exit
// address), one DNS answer pinned for the connection, no proxy from the environment, no redirects followed, 30 s and
// 1 MiB (counted while reading, also without Content-Length; the requests of a check end by its deadline, and an MCP
// tools/list page may take until then while it keeps coming, NetRequest.long). Errors carry a reason code, never the
// remote body.
import { PRODUCT } from '@mycel/shared'
import { ToolError } from '../../policy/errors'
import { decode, pinnedRequest, resolveTarget, type ResolveOptions } from '../../tools/web-fetch'
import type { Reason } from './text'

export const TIMEOUT_MS = 30_000
export const MAX_BODY = 1024 * 1024
export const USER_AGENT = `${PRODUCT.artifactBase}-integrations/1.0`

/** Test hooks (offline tests only, never from HTTP or model input) plus the office's exit addresses. */
export interface NetOptions extends Pick<ResolveOptions, 'lookup' | 'testAllow' | 'blockedIps'> {
  insecureTlsForTests?: boolean
  timeoutMs?: number
  /** tests: mcp.ts MCP_LIST_IDLE_MS and MCP_LIST_TIMEOUT_MS */
  listIdleMs?: number
  listTimeoutMs?: number
}

export class NetError extends Error {
  name = 'NetError'
  constructor(readonly reason: Reason, readonly status?: number) { super(status ? `${reason}:${status}` : reason) }
}

export interface NetResponse { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean }

export interface NetRequest {
  method: string
  headers: [string, string][]
  body?: Buffer | null
  maxBytes?: number
  signal?: AbortSignal
  until?: (body: Buffer, head: { status: number; headers: Record<string, string> }) => boolean
  /** a check's own deadline (mcp.ts listTools): the request ends by `deadline` (epoch ms) at the latest, failing with
   * `reason` when that is what ends it. With `idleMs` (a tools/list page, which may keep coming for longer than the
   * 30 s) the answer is read until the deadline, failing with 'timeout' sooner only when no bytes arrive for that long. */
  long?: { deadline: number; reason: Reason; idleMs?: number }
}

function reasonOf(e: unknown): Reason {
  const m = e instanceof Error ? e.message : ''
  if (/in time|stopped sending/.test(m)) return 'timeout'
  if (/ports 80 and 443/.test(m)) return 'blocked_port'
  if (/private|local network|single-label|office's own/.test(m)) return 'private_address'
  if (/TLS|certificate/i.test(m)) return 'tls'
  return 'unreachable'
}

/** One request to an https address of a connection. Throws NetError. */
export async function serviceRequest(url: string, r: NetRequest, o: NetOptions = {}): Promise<NetResponse> {
  let u: URL
  try { u = new URL(url) } catch { throw new NetError('unreachable') }
  if (u.protocol !== 'https:' || u.username || u.password) throw new NetError('unreachable')
  const short = Date.now() + (o.timeoutMs ?? TIMEOUT_MS)
  const max = r.maxBytes ?? MAX_BODY
  const long = r.long
  if (long && Date.now() >= long.deadline) throw new NetError(long.reason)
  // the name lookup has the 30 s and the check's deadline; the answer too, unless it may take until the deadline
  const lookupBy = long ? Math.min(short, long.deadline) : short
  const readBy = long?.idleMs ? long.deadline : lookupBy
  let by = lookupBy
  let res
  try {
    const target = await resolveTarget(u.href, { lookup: o.lookup, testAllow: o.testAllow, blockedIps: o.blockedIps, deadline: lookupBy })
    if (r.signal?.aborted) throw new ToolError('stopped')
    by = readBy
    res = await pinnedRequest(target, {
      method: r.method, body: r.body ?? null, deadline: readBy, idleMs: long?.idleMs, maxBytes: max, insecureTlsForTests: o.insecureTlsForTests, signal: r.signal, until: r.until,
      headers: [['User-Agent', USER_AGENT], ['Accept-Encoding', 'identity'], ...r.headers],
    })
  } catch (e) {
    if (e instanceof NetError) throw e
    if (r.signal?.aborted) throw new NetError('timeout')
    // ended by the check's deadline: not by the 30 s, nor by a pause in a long answer ("stopped sending")
    if (long && by === long.deadline && e instanceof Error && /did not answer in time/.test(e.message)) throw new NetError(long.reason)
    throw new NetError(reasonOf(e))
  }
  let body = res.body
  let truncated = res.truncated || body.length > max
  if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
    try { const d = await decode(body, res.headers['content-encoding'], max); body = d.data; truncated ||= d.truncated } catch { throw new NetError('unreachable') }
  }
  if (body.length > max) body = body.subarray(0, max)
  return { status: res.status, headers: res.headers, body, truncated }
}

/** A JSON object answer (metadata, tokens): 2xx, not cut, an object. */
export async function jsonRequest(url: string, r: NetRequest, o: NetOptions = {}): Promise<{ status: number; json: Record<string, any> | null; headers: Record<string, string> }> {
  const res = await serviceRequest(url, { maxBytes: 256 * 1024, ...r }, o)
  if (res.status >= 300 && res.status < 400) throw new NetError('redirect', res.status)
  if (res.truncated) throw new NetError('too_large')
  let json: Record<string, any> | null = null
  try { const v = JSON.parse(res.body.toString('utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) json = v } catch {}
  return { status: res.status, json, headers: res.headers }
}
