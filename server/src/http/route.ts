// Typed route registration: route modules implement contract endpoints (shared/src/api) with
//   kit.handle(API.listChats, async ({ query, auth }) => ({ items, nextCursor }))
// The kit validates params / query / body against the contract, enforces the endpoint's auth level and the
// must-change-password gate, re-checks the password for owner-reauth endpoints, reads bodies with size limits,
// and (when config.validateResponses) checks the response against the contract.
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { isSchema, type BinaryBody, type Endpoint, type MultipartBody, type ParamsOf, type ParsedQueryOf, type StreamResponse, type EmptyResponse } from '@mycel/shared/api'
import type { AppEnv } from './env'
import { HttpError, fail } from './errors'
import type { AuthInfo } from '../services'
import type { AppContext } from '../context'

/** Default JSON body limit; endpoints that need more set it in BODY_LIMITS below (or via kit.handle options). */
export const DEFAULT_JSON_LIMIT = 1024 * 1024

type BodyIn<E extends Endpoint> = E extends Endpoint<any, any, any, infer B, any>
  ? B extends MultipartBody<infer F> ? { fields: z.output<F>; file: File }
  : B extends BinaryBody ? AsyncIterable<Uint8Array>
  : B extends z.ZodType ? z.output<B>
  : undefined
  : never
type AuthIn<E extends Endpoint> = E extends Endpoint<any, any, any, any, any, infer A> ? (A extends 'public' ? AuthInfo | null : AuthInfo) : never
export type HandlerOut<E extends Endpoint> =
  E['response'] extends z.ZodType ? z.input<E['response']>
  : E['response'] extends StreamResponse ? Response
  : E['response'] extends EmptyResponse ? void
  : never

export interface HandlerInput<E extends Endpoint> {
  c: Context<AppEnv>
  params: ParamsOf<E>
  query: ParsedQueryOf<E>
  body: BodyIn<E>
  auth: AuthIn<E>
}
export type Handler<E extends Endpoint> = (input: HandlerInput<E>) => Promise<HandlerOut<E>> | HandlerOut<E>

export interface HandleOptions {
  /** JSON body limit in bytes (default 1 MB) */
  jsonLimit?: number
}

const zodFields = (prefix: string, err: z.ZodError): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const i of err.issues) out[[prefix, ...i.path.map(String)].join('.')] ??= i.message
  return out
}

/** Read a request body as a bounded stream of chunks (never more than maxBytes in total). */
export async function* boundedBody(req: Request, maxBytes: number): AsyncIterable<Uint8Array> {
  const len = req.headers.get('content-length')
  if (len !== null && Number(len) > maxBytes) fail('payload_too_large')
  if (!req.body) return
  let total = 0
  const reader = req.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > maxBytes) fail('payload_too_large')
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export async function readBoundedText(req: Request, maxBytes: number): Promise<string> {
  const parts: Uint8Array[] = []
  for await (const ch of boundedBody(req, maxBytes)) parts.push(ch)
  return new TextDecoder().decode(Buffer.concat(parts))
}

export function enforceAuth(ep: Endpoint, auth: AuthInfo | null) {
  if (ep.auth === 'public') return
  if (!auth) fail('unauthorized')
  if (auth!.user.mustChangePassword && !ep.allowWhilePasswordChange) fail('password_change_required')
  const role = auth!.user.role
  if (ep.auth === 'admin' && role !== 'admin' && role !== 'owner') fail('forbidden')
  if ((ep.auth === 'owner' || ep.auth === 'owner-reauth') && role !== 'owner') fail('forbidden')
}

export class RouteKit {
  constructor(public readonly app: Hono<AppEnv>, private ctx: AppContext, public readonly module: string) {}

  /** Implement a contract endpoint. */
  handle<E extends Endpoint>(ep: E, handler: Handler<E>, o: HandleOptions = {}): void {
    const key = `${ep.method} ${ep.path}`
    const prev = this.ctx.implemented.get(key)
    if (prev) throw new Error(`${key} is implemented twice (${prev} and ${this.module})`)
    this.ctx.implemented.set(key, this.module)
    this.app.on(ep.method, ep.path, async (c) => {
      const auth = c.get('auth')
      enforceAuth(ep, auth)

      const params = c.req.param() as ParamsOf<E>
      let query = undefined as ParsedQueryOf<E>
      if (ep.query) {
        const r = (ep.query as z.ZodType).safeParse(c.req.query())
        if (!r.success) fail('validation', undefined, { fields: zodFields('query', r.error) })
        query = r.data as ParsedQueryOf<E>
      }

      let body: unknown = undefined
      const spec = ep.body
      if (spec && isSchema(spec)) {
        const ct = c.req.header('content-type') ?? ''
        const text = await readBoundedText(c.req.raw, o.jsonLimit ?? DEFAULT_JSON_LIMIT)
        let json: unknown = {}
        if (text.trim() !== '') {
          if (!/^application\/json\b/i.test(ct)) fail('bad_request')
          try { json = JSON.parse(text) } catch { fail('bad_request') }
        }
        const r = spec.safeParse(json)
        if (!r.success) fail('validation', undefined, { fields: zodFields('body', r.error) })
        body = r.data
      } else if (spec && spec.kind === 'multipart') {
        const len = c.req.header('content-length')
        if (len !== undefined && Number(len) > spec.maxBytes + 64 * 1024) fail('payload_too_large')
        if (!/^multipart\/form-data\b/i.test(c.req.header('content-type') ?? '')) fail('bad_request')
        let form: FormData
        try { form = await c.req.raw.formData() } catch { fail('bad_request') }
        const file = form!.get('file')
        if (!(file instanceof File)) fail('validation', undefined, { fields: { 'body.file': 'file part missing' } })
        if ((file as File).size > spec.maxBytes) fail('payload_too_large')
        const fields: Record<string, string> = {}
        for (const [k, v] of form!.entries()) if (k !== 'file' && typeof v === 'string') fields[k] = v
        const r = spec.fields.safeParse(fields)
        if (!r.success) fail('validation', undefined, { fields: zodFields('body', r.error) })
        body = { fields: r.data, file }
      } else if (spec && spec.kind === 'binary') {
        body = boundedBody(c.req.raw, spec.maxBytes)
      }

      if (ep.auth === 'owner-reauth') {
        const pw = (body as { password?: unknown } | undefined)?.password
        if (typeof pw !== 'string' || !(await this.ctx.services.sessions.verifyPassword(auth!.user.id, pw, c.get('info')))) {
          fail('forbidden', undefined, { fields: { 'body.password': 'wrong password' } })
        }
      }

      const out = await handler({ c, params, query, body: body as BodyIn<E>, auth: auth as AuthIn<E> })
      const res = ep.response
      if (isSchema(res)) {
        let payload: unknown = out
        if (this.ctx.config.validateResponses) {
          const r = res.safeParse(out)
          if (!r.success) {
            c.get('log').error('response does not match the contract', { endpoint: key, issues: r.error.issues.slice(0, 5) })
            throw new HttpError('internal')
          }
          payload = r.data
        }
        return c.json(payload as object, (ep.status ?? 200) as 200)
      }
      if (res.kind === 'stream') {
        if (!(out instanceof Response)) throw new Error(`${key}: stream endpoint must return a Response`)
        return out
      }
      return c.body(null, (ep.status ?? 204) as 204)
    })
  }

  /** Off-contract routes (WebSocket upgrade, static files). Recorded so the coverage test knows about them. */
  raw(method: string, path: string, ...handlers: Parameters<Hono<AppEnv>['on']> extends [any, any, ...infer H] ? H : never): void {
    this.ctx.implemented.set(`${method} ${path}`, this.module)
    ;(this.app.on as (m: string, p: string, ...h: unknown[]) => void)(method, path, ...handlers)
  }
}
