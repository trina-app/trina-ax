// Microsoft Graph requests for the Microsoft 365 connection's tools (mcp-server.ts). Every request goes through
// connections/net.ts (public https only, no redirects followed, size and time limits) to https://graph.microsoft.com
// with the person's access token; a file's bytes come from the pre-signed download address Graph names, without the
// token. Errors: Graph's 401 is GraphUnauthorized (the MCP answer becomes a 401, so the connection code refreshes the
// token once and otherwise asks to sign in again); any other refusal is GraphError with Microsoft's own words, cleaned
// (connections/refusal.ts cleanSaid: no token, at most 200 characters).
import { cleanSaid } from '../connections/refusal'
import { NetError, serviceRequest, type NetOptions, type NetResponse } from '../connections/net'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
/** the most one Graph answer may be (a page of mail with bodies) */
const JSON_MAX = 4 * 1024 * 1024

/** Graph refused the token itself: sign in again (after one refresh) */
export class GraphUnauthorized extends Error {
  name = 'GraphUnauthorized'
  constructor(readonly body: Buffer, readonly wwwAuthenticate: string) { super('unauthorized') }
}
/** any other refusal or failure, with words the AI may read */
export class GraphError extends Error {
  name = 'GraphError'
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

/** Graph's own error words: `{ error: { code, message } }`, cleaned */
export function graphErrorOf(res: Pick<NetResponse, 'status' | 'body'>): GraphError {
  let code = '', message = ''
  try {
    const j = JSON.parse(res.body.subarray(0, 16 * 1024).toString('utf8')) as { error?: { code?: unknown; message?: unknown } }
    if (typeof j?.error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(j.error.code)) code = j.error.code
    if (typeof j?.error?.message === 'string') message = cleanSaid(j.error.message)
  } catch {}
  return new GraphError(res.status, code, message)
}

/** What the AI is told about a Graph error: the status, Microsoft's code and words, and what usually helps. */
export function graphErrorText(e: GraphError): string {
  const said = [e.code, e.message].filter(Boolean).join(': ')
  const hint = e.status === 403 ? ' The signed-in account may not do this (its organization or the item\'s owner decides); tell the user.'
    : e.status === 404 ? (/MailboxNotEnabled|ResourceNotFound/i.test(e.code) && /mailbox/i.test(e.message) ? ' This account has no Exchange Online mailbox (no licence for mail).' : ' Check the id: use an id from a search or list result.')
      : e.status === 429 || e.status === 503 ? ' Microsoft is busy: try again in a minute.' : ''
  return `Microsoft 365 answered ${e.status}${said ? ` (${said})` : ''}.${hint}`
}

/** OData system query options, written in a call's query without their `$` (it is added here) */
const ODATA = new Set(['select', 'top', 'orderby', 'expand', 'search', 'filter', 'skip', 'count'])

export interface GraphCall {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  /** a path under /v1.0 ("/me/messages") or a full https address Graph gave (a next page) */
  path: string
  /** query parameters; OData's system options are written without their `$` (`select`, `top`: ODATA) */
  query?: Record<string, string | number | undefined>
  json?: unknown
  /** raw bytes (an upload) with their type */
  bytes?: { data: Buffer; type: string }
  headers?: [string, string][]
  maxBytes?: number
}

export class Graph {
  constructor(private token: string, private net: NetOptions, private signal?: AbortSignal) {}

  private url(c: GraphCall): string {
    // a path this code built: no "." or ".." segment (an id like ".." would move the request to another Graph path) and
    // no query or fragment of its own
    if (!c.path.startsWith('https://') && (/[?#]/.test(c.path) || c.path.split('/').some((x) => x === '.' || x === '..' || /^%2e(%2e)?$/i.test(x)))) throw new GraphError(400, 'invalidAddress', 'not a Microsoft Graph address')
    const u = new URL(c.path.startsWith('https://') ? c.path : GRAPH + c.path)
    if (u.origin !== 'https://graph.microsoft.com') throw new GraphError(400, 'invalidAddress', 'not a Microsoft Graph address')
    for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined && v !== '') u.searchParams.set(ODATA.has(k) ? `$${k}` : k, String(v))
    return u.href
  }

  /** one request; the JSON answer (null for an empty one, such as a send's 202) */
  async call<T = Record<string, any>>(c: GraphCall): Promise<T | null> {
    const headers: [string, string][] = [['Authorization', `Bearer ${this.token}`], ['Accept', 'application/json'], ...(c.headers ?? [])]
    let body: Buffer | null = null
    if (c.json !== undefined) { headers.push(['Content-Type', 'application/json']); body = Buffer.from(JSON.stringify(c.json)) }
    else if (c.bytes) { headers.push(['Content-Type', c.bytes.type]); body = c.bytes.data }
    const res = await serviceRequest(this.url(c), { method: c.method ?? 'GET', headers, body, maxBytes: c.maxBytes ?? JSON_MAX, signal: this.signal }, this.net)
    if (res.status === 401) throw new GraphUnauthorized(res.body.subarray(0, 4096), res.headers['www-authenticate'] ?? '')
    if (res.status < 200 || res.status >= 300) throw graphErrorOf(res)
    if (res.truncated) throw new GraphError(413, 'tooLarge', 'the answer was too large; ask for fewer items')
    if (!res.body.length) return null
    try { return JSON.parse(res.body.toString('utf8')) as T } catch { throw new GraphError(502, 'notJson', 'Microsoft sent an answer that could not be read') }
  }

  /** a file's bytes from the pre-signed address Graph named (no token is sent there), at most `max` */
  async download(url: string, max: number): Promise<Buffer> {
    const res = await serviceRequest(url, { method: 'GET', headers: [], maxBytes: max + 1, signal: this.signal }, this.net)
    if (res.status < 200 || res.status >= 300) throw new GraphError(res.status, 'downloadFailed', 'the file could not be downloaded')
    if (res.truncated || res.body.length > max) throw new GraphError(413, 'tooLarge', 'the file is too large to read here')
    return res.body
  }
}

export const isNetError = (e: unknown): e is NetError => e instanceof NetError

/** The signed-in Microsoft account as people read it (the connection's `account`, Settings › Connectors): its mail
 * address, else its sign-in name (userPrincipalName), else its display name; null when Graph names none usable. One
 * Graph call (`User.Read`, asked for at sign-in). */
export async function microsoftAccountOf(g: Graph): Promise<string | null> {
  const me = await g.call<{ displayName?: unknown; mail?: unknown; userPrincipalName?: unknown }>({ path: '/me', query: { select: 'displayName,mail,userPrincipalName' } })
  const ok = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 320 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v) ? v.trim() : null)
  return ok(me?.mail) ?? ok(me?.userPrincipalName) ?? ok(me?.displayName)
}
