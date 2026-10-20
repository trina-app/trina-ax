// Endpoint definitions: one object per REST endpoint, used by the server (validation, auth level, routing) and
// by clients (typed calls). The path uses Hono/Express style params (":id").
import { z } from 'zod'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Who may call it.
 * - public: no session (health, login, invite info)
 * - user: any signed-in active user (must_change_password users only reach endpoints marked allowWhilePasswordChange)
 * - admin: role admin or owner
 * - owner: role owner
 * - owner-reauth: owner, and the body carries `password` (re-entered) — update / restore (tab 4)
 */
export type AuthLevel = 'public' | 'user' | 'admin' | 'owner' | 'owner-reauth'

/** Raw body (PUT chunk). The server reads at most maxBytes, streaming. */
export interface BinaryBody { kind: 'binary'; maxBytes: number }
/** multipart/form-data with exactly one file part named "file" plus text fields validated by `fields`. */
export interface MultipartBody<F extends z.ZodType = z.ZodType> { kind: 'multipart'; fields: F; maxBytes: number }
export type BodySpec = z.ZodType | BinaryBody | MultipartBody
/** Streamed bytes (downloads; Range supported when `range` is true). */
export interface StreamResponse { kind: 'stream'; range: boolean }
/** 204 No Content */
export interface EmptyResponse { kind: 'empty' }
export type ResponseSpec = z.ZodType | StreamResponse | EmptyResponse

/** Component that implements the endpoint (docs/WORKPLAN.md). */
export type Owner = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

export interface Endpoint<
  M extends Method = Method,
  P extends string = string,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends BodySpec | undefined = BodySpec | undefined,
  R extends ResponseSpec = ResponseSpec,
  A extends AuthLevel = AuthLevel,
> {
  method: M
  path: P
  auth: A
  owner: Owner
  /** success status (default 200; 201 create, 202 accepted job/turn, 204 empty) */
  status?: number
  query?: Q
  body?: B
  response: R
  /** reachable while users.must_change_password is set */
  allowWhilePasswordChange?: boolean
  summary: string
}

export function endpoint<
  M extends Method, P extends string, Q extends z.ZodType | undefined = undefined, B extends BodySpec | undefined = undefined, R extends ResponseSpec = ResponseSpec, A extends AuthLevel = AuthLevel,
>(e: Endpoint<M, P, Q, B, R, A>): Endpoint<M, P, Q, B, R, A> {
  return e
}

export const binary = (maxBytes: number): BinaryBody => ({ kind: 'binary', maxBytes })
export const multipart = <F extends z.ZodType>(fields: F, maxBytes: number): MultipartBody<F> => ({ kind: 'multipart', fields, maxBytes })
export const stream = (range = true): StreamResponse => ({ kind: 'stream', range })
export const empty: EmptyResponse = { kind: 'empty' }

export const isSchema = (x: unknown): x is z.ZodType => !!x && typeof x === 'object' && 'safeParse' in (x as object)

// ---------------- type helpers ----------------
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : P extends `${string}:${infer Name}` ? Name : never
/** { id: string } for "/api/chats/:id" */
export type PathParams<P extends string> = { [K in ParamNames<P>]: string }

export type QueryOf<E> = E extends Endpoint<any, any, infer Q, any, any> ? (Q extends z.ZodType ? z.input<Q> : undefined) : never
export type BodyOf<E> = E extends Endpoint<any, any, any, infer B, any>
  ? B extends z.ZodType ? z.input<B>
  : B extends MultipartBody<infer F> ? { fields: z.input<F>; file: Blob; filename?: string }
  : B extends BinaryBody ? Blob | ArrayBuffer | Uint8Array
  : undefined
  : never
/** parsed body as the server handler sees it */
export type ParsedBodyOf<E> = E extends Endpoint<any, any, any, infer B, any> ? (B extends z.ZodType ? z.output<B> : undefined) : never
export type ParsedQueryOf<E> = E extends Endpoint<any, any, infer Q, any, any> ? (Q extends z.ZodType ? z.output<Q> : undefined) : never
export type ResponseOf<E> = E extends Endpoint<any, any, any, any, infer R> ? (R extends z.ZodType ? z.output<R> : R extends StreamResponse ? Response : void) : never
export type ParamsOf<E> = E extends Endpoint<any, infer P, any, any, any> ? PathParams<P> : never

/** Fill ":name" params; values are URI-encoded. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k: string) => {
    const v = params[k]
    if (v === undefined) throw new Error(`missing path param ${k} for ${path}`)
    return encodeURIComponent(v)
  })
}
