// Typed route registration: route modules implement contract endpoints (shared/src/api) with
//   kit.handle(API.listChats, async ({ query, auth }) => ({ items, nextCursor }))
// The kit validates params / query / body against the contract, enforces the endpoint's auth level and the
// must-change-password gate, re-checks the password (or a Google check) for owner-reauth endpoints, reads bodies with size limits,
// and (when config.validateResponses) checks the response against the contract.
import type { Context, Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isSchema, type BinaryBody, type Endpoint, type MultipartBody, type ParamsOf, type ParsedQueryOf, type StreamResponse, type EmptyResponse } from '@mycel/shared/api'
import type { AppEnv } from './env'
import { HttpError, fail } from './errors'
import { GUEST_ENDPOINTS } from '../auth/guest-endpoints'
import { requireReauth } from '../auth/reauth'
import { removedSignIn } from '../auth/account-removal'
import type { AuthInfo } from '../services'
import type { AppContext } from '../context'
import { demoGuard, freeRoamBody, freeRoamFence, freeRoamRawFenced } from '../demo/guard'
import { spoolMultipart, type SpooledFile } from './multipart'
import { endConnectionAfter } from './tunnel'

/** Default JSON body limit; endpoints that need more set it in BODY_LIMITS below (or via kit.handle options). */
export const DEFAULT_JSON_LIMIT = 1024 * 1024

type BodyIn<E extends Endpoint> = E extends Endpoint<any, any, any, infer B, any>
  ? B extends MultipartBody<infer F> ? { fields: z.output<F>; file: SpooledFile }
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
  // refused before the body is read: what is still on its way ends with the connection (http/tunnel.ts)
  if (len !== null && Number(len) > maxBytes) { endConnectionAfter(req); fail('payload_too_large') }
  if (!req.body) return
  let total = 0
  const reader = req.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > maxBytes) { endConnectionAfter(req); fail('payload_too_large') }
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
  // a guest: only the endpoints of the guest allow-list (auth/guest-endpoints.ts), whatever their auth level
  if (role === 'guest' && !GUEST_ENDPOINTS.has(ep)) fail('forbidden')
  if ((ep.auth === 'admin' || ep.auth === 'admin-reauth') && role !== 'admin' && role !== 'owner') fail('forbidden')
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
      // a sign-in that ended because its account was removed says so, to that sign-in's holder only (TC-1974)
      // a guest's also says whether they left or were taken out, with the team's name (guest walkthrough S5/S6)
      if (!auth && ep.auth !== 'public') { const why = removedSignIn(this.ctx, c.req.raw); if (why) fail('unauthorized', undefined, { params: { reason: 'account_removed', ...(why.guest ? { guest: why.guest, ...(why.team ? { team: why.team } : {}) } : {}) } }) }
      // a free-roam demo (demo/guard.ts): what it fences is refused whoever asks, before the body is read
      if (this.ctx.config.demo) freeRoamFence(this.ctx, ep, { locale: c.get('locale'), contentLength: c.req.header('content-length') ?? null })
      enforceAuth(ep, auth)

      const params = c.req.param() as ParamsOf<E>
      let query = undefined as ParsedQueryOf<E>
      if (ep.query) {
        const r = (ep.query as z.ZodType).safeParse(c.req.query())
        if (!r.success) fail('validation', undefined, { fields: zodFields('query', r.error) })
        query = r.data as ParsedQueryOf<E>
      }

      let body: unknown = undefined
      /** a multipart upload's temp file: removed when the request ends, unless the handler moved it into place */
      let spooled: SpooledFile | null = null
      const spec = ep.body
      try {
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
        // streamed to a temp file with the limit counted on the way, never read into memory whole (http/multipart.ts)
        const form = await spoolMultipart(c.req.raw, { maxBytes: spec.maxBytes, dir: path.join(this.ctx.config.dataDir, 'uploads', 'tmp') }).catch((e: unknown) => {
          // refused before the body was read to its end: what is still on its way must not be read for nothing, so the
          // connection ends with this answer (Bun ignores the header alone: http/tunnel.ts endConnectionAfter)
          c.header('Connection', 'close')
          endConnectionAfter(c.req.raw)
          throw e
        })
        spooled = form.file
        if (!form.file) fail('validation', undefined, { fields: { 'body.file': 'file part missing' } })
        const r = spec.fields.safeParse(form.fields)
        if (!r.success) fail('validation', undefined, { fields: zodFields('body', r.error) })
        body = { fields: r.data, file: form.file }
      } else if (spec && spec.kind === 'binary') {
        body = boundedBody(c.req.raw, spec.maxBytes)
      }

      // demo mode (MYCEL_DEMO): no owner password re-checks, the demo people's accounts stay as seeded
      if (this.ctx.config.demo) {
        demoGuard(this.ctx, ep, { params: params as Record<string, string>, body, auth, locale: c.get('locale') })
        freeRoamBody(this.ctx, ep, { body, locale: c.get('locale') })
      }

      // the password again, or for an account without one a Google check this session just finished (auth/reauth.ts)
      if (ep.auth === 'owner-reauth' || ep.auth === 'admin-reauth') await requireReauth(c, this.ctx, body)

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
      } finally {
        if (spooled) fs.rmSync(spooled.path, { force: true })
      }
    })
  }

  /** Off-contract routes (WebSocket upgrade, static files). Recorded so the coverage test knows about them. */
  raw(method: string, path: string, ...handlers: Parameters<Hono<AppEnv>['on']> extends [any, any, ...infer H] ? H : never): void {
    this.ctx.implemented.set(`${method} ${path}`, this.module)
    // a free-roam demo answers none of them but the web app's, its WebSocket and the app links (demo/guard.ts)
    if (freeRoamRawFenced(this.ctx, this.module)) {
      ;(this.app.on as (m: string, p: string, ...h: unknown[]) => void)(method, path, () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
      return
    }
    ;(this.app.on as (m: string, p: string, ...h: unknown[]) => void)(method, path, ...handlers)
  }
}
