// What a service's 401 or 403 says, for a connection's check and its calls (mcp.ts, service.ts). A 403 is not always a
// bad key: a service may take the sign-in and still not let that account use it (GitLab's MCP server answers 403 "MCP
// server not enabled for any of your groups" to an account without a top-level group), and signing in again cannot fix
// that. So the answer's OAuth error code (RFC 6750 3.1: WWW-Authenticate `error=`, or an `error` in a JSON body) picks
// the reason, and a short excerpt of the service's own words is kept to show people:
// - 401, or 403 `invalid_token`: `refused` (the key or sign-in is not accepted: sign in again);
// - 403 `insufficient_scope`: `scope` (sign in again and allow the access it asks for);
// - any other 403: `no_access` (signed in, but this account may not use the service: its owner turns it on).
// The excerpt is plain text: the connection's stored secrets and anything that looks like a token hidden, tags and
// control characters taken out, at most REFUSAL_SAID_MAX characters. Never the body as it came.
// leaf modules only (no mcp.ts, service.ts or chat code): mcp.ts imports this file
import { scrubSecrets } from '../../secret-scrub'

/** the most characters of the service's words kept */
export const REFUSAL_SAID_MAX = 200
/** the most of a body read for them (a JSON error is small; an HTML page is not read at all) */
const BODY_MAX = 16 * 1024

export type RefusalReason = 'refused' | 'scope' | 'no_access'
export interface Refusal {
  /** the OAuth error code the service gave ("invalid_token", "insufficient_scope"…), lower case; '' when none */
  error: string
  /** a short excerpt of what the service said, sanitized; '' when nothing usable */
  said: string
}

/** One auth-param of a WWW-Authenticate header (`name="quoted"` or `name=token`), or ''. */
export function authParam(header: string, name: string): string {
  const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, 'i').exec(header)
  return m ? (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? '') : ''
}

/** The service's words in plain text, safe to show and log. Its form first (tags, control characters; zero-width and
 * direction marks taken out without a trace, so a token split by them is whole again), then what it holds: `hide` (the
 * connection's stored secrets), then anything that looks like a token or a password field; runs of space; cut. */
export function cleanSaid(text: string, hide: (s: string) => string = (s) => s): string {
  const bare = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    // zero-width and bidirectional marks (they can split a token or reorder what people read): removed
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    // C0/C1 controls and line or paragraph separators: a space
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
  const plain = scrubSecrets(hide(bare)).replace(/\s+/g, ' ').trim()
  return plain.length > REFUSAL_SAID_MAX ? `${plain.slice(0, REFUSAL_SAID_MAX - 1).trimEnd()}…` : plain
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** an OAuth-style error code ("invalid_token"): one word of letters, digits, _ . - */
const CODE = /^[a-z][a-z0-9_.-]{1,63}$/i

/** The error code and the words of a JSON error body: OAuth (`error`, `error_description`), common APIs (`message`,
 * `detail`, `error.message`), JSON-RPC (`error.message`, `error.data`), and a `denial_reason` where the words are missing. */
function fromJson(v: unknown): Refusal {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: '', said: '' }
  const o = v as Record<string, unknown>
  const err = o.error && typeof o.error === 'object' && !Array.isArray(o.error) ? o.error as Record<string, unknown> : null
  const data = err?.data && typeof err.data === 'object' && !Array.isArray(err.data) ? err.data as Record<string, unknown> : null
  const code = str(o.error)
  const error = CODE.test(code) ? code.toLowerCase() : ''
  const said = str(o.error_description) || str(o.message) || str(err?.message) || str(o.detail) || str(err?.detail)
    || (code && !CODE.test(code) ? code : '') || str(o.denial_reason) || str(data?.denial_reason) || str(data?.message) || code
  return { error, said }
}

/** What a 401/403 answer says: its OAuth error code and an excerpt of its words (headers in lower case, as net.ts gives
 * them). `hide`: the connection's stored secrets (service.ts hider). */
export function refusalOf(res: { headers: Record<string, string>; body: Buffer }, hide?: (s: string) => string): Refusal {
  const header = res.headers['www-authenticate'] ?? ''
  const headerError = authParam(header, 'error').toLowerCase()
  const type = (res.headers['content-type'] ?? '').toLowerCase()
  const text = res.body.subarray(0, BODY_MAX).toString('utf8')
  let body: Refusal = { error: '', said: '' }
  if (/json/.test(type) || /^\s*[{[]/.test(text)) {
    try { body = fromJson(JSON.parse(text)) } catch { /* not JSON after all */ }
    // an MCP server may answer in an event stream: its first data line
  } else if (/text\/event-stream/.test(type)) {
    const data = /^data:\s?(.*)$/m.exec(text)?.[1]
    if (data) try { body = fromJson(JSON.parse(data)) } catch { /* not JSON */ }
  }
  const error = CODE.test(headerError) ? headerError : body.error
  let said = body.said || authParam(header, 'error_description')
  // a short plain-text answer is its own words; an HTML page is not read (a login page, a proxy's error page)
  if (!said && /^text\/plain/.test(type)) said = text.slice(0, 1000)
  return { error, said: said ? cleanSaid(said, hide) : '' }
}

/** An answer that refuses the token itself (401, or 403 invalid_token): worth the one token refresh a 401 gets
 * (service.ts send for an HTTP API, withMcp for an MCP server). */
export const refusesToken = (res: { status: number; headers: Record<string, string>; body: Buffer }): boolean =>
  res.status === 401 || (res.status === 403 && refusalOf(res).error === 'invalid_token')

/** The reason a refused answer is stored under (see the top of this file). */
export function refusalReason(status: number, error: string): RefusalReason {
  if (status !== 403 || error === 'invalid_token') return 'refused'
  return error === 'insufficient_scope' ? 'scope' : 'no_access'
}

/** The stored code (integrations.last_error) for a refused answer: "refused:401", "scope:403", "no_access:403:<said>". */
export function refusalCode(status: number, r: Refusal): string {
  const reason = refusalReason(status, r.error)
  return reason === 'no_access' && r.said ? `${reason}:${status}:${r.said}` : `${reason}:${status}`
}

/** A stored code in its parts: "no_access:403:words: with colons" -> no_access, 403, "words: with colons". */
export function codeParts(code: string): { reason: string; status: string; said: string } {
  const [reason = '', status = '', ...rest] = code.split(':')
  return { reason, status, said: rest.join(':') }
}

/** The code without the service's words: what the AI and the logs of other places get ("no_access:403"). */
export const codeOnly = (code: string): string => { const p = codeParts(code); return p.status ? `${p.reason}:${p.status}` : p.reason }
