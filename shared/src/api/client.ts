// Typed HTTP client for the API registry. Used by web/, desktop/ and server tests.
//   const api = new ApiClient({ baseUrl: '' })
//   const chats = await api.call(API.listChats, { query: { limit: 20 } })
import { buildPath, isSchema, type BodyOf, type Endpoint, type ParamsOf, type QueryOf, type ResponseOf } from './endpoint'
import { ApiErrorResponse, CSRF_HEADER, WINDOW_HEADER, type ApiErrorBody } from './common'

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
  }
  get code() { return this.body.code }
}

export interface ApiClientOptions {
  /** '' for same origin (web served by the team server), or 'https://acme.treesoop.com' */
  baseUrl: string
  /** bearer token (mobile shells, scripts); without it the session cookie is used */
  token?: string
  /** sent as X-Mycel-Window (browser tools go to the window that sent the turn) */
  windowId?: string
  fetch?: typeof fetch
}

type HasKeys<T> = keyof T extends never ? false : true
export type CallArgs<E> =
  (HasKeys<ParamsOf<E>> extends true ? { params: ParamsOf<E> } : { params?: undefined }) &
  (QueryOf<E> extends undefined ? { query?: undefined } : { query?: QueryOf<E> }) &
  (BodyOf<E> extends undefined ? { body?: undefined } : { body: BodyOf<E> }) &
  { signal?: AbortSignal; headers?: Record<string, string> }

export class ApiClient {
  constructor(private o: ApiClientOptions) {}

  url<E extends Endpoint>(ep: E, args: { params?: Record<string, string>; query?: Record<string, unknown> } = {}): string {
    let u = this.o.baseUrl + buildPath(ep.path, args.params)
    if (args.query) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(args.query)) {
        if (v === undefined || v === null) continue
        qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
      }
      const s = qs.toString()
      if (s) u += '?' + s
    }
    return u
  }

  /** Raw fetch with auth + CSRF headers; errors become ApiError. Streams (downloads) come back as Response. */
  async call<E extends Endpoint>(ep: E, args: CallArgs<E> = {} as CallArgs<E>): Promise<ResponseOf<E>> {
    const a = args as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
    const headers: Record<string, string> = { ...(a.headers ?? {}) }
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`
    if (ep.method !== 'GET') headers[CSRF_HEADER] = '1'
    if (this.o.windowId) headers[WINDOW_HEADER] = this.o.windowId
    let body: BodyInit | undefined
    const spec = ep.body
    if (spec && isSchema(spec)) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(a.body ?? {})
    } else if (spec && spec.kind === 'multipart') {
      const b = a.body as { fields: Record<string, unknown>; file: Blob; filename?: string }
      const fd = new FormData()
      for (const [k, v] of Object.entries(b.fields ?? {})) if (v !== undefined && v !== null) fd.set(k, String(v))
      fd.set('file', b.file, b.filename ?? (b.file as File).name ?? 'file')
      body = fd
    } else if (spec && spec.kind === 'binary') {
      headers['content-type'] = 'application/octet-stream'
      body = a.body as BodyInit
    }
    const f = this.o.fetch ?? fetch
    const res = await f(this.url(ep, a), { method: ep.method, headers, body, signal: a.signal, credentials: 'include' })
    if (!res.ok && !(res.status === 206)) {
      let parsed: ApiErrorBody = { code: 'internal', message: `HTTP ${res.status}` }
      try {
        const j = ApiErrorResponse.safeParse(await res.json())
        if (j.success) parsed = j.data.error
      } catch { /* not JSON (e.g. relay HTML error page) */ }
      throw new ApiError(res.status, parsed)
    }
    const r = ep.response
    if (isSchema(r)) return r.parse(await res.json()) as ResponseOf<E>
    if (r.kind === 'stream') return res as ResponseOf<E>
    return undefined as ResponseOf<E>
  }
}
