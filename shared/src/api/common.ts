// Building blocks shared by every REST endpoint and WebSocket event (design tab 4).
import { z } from 'zod'
import { Uuid7 } from '../ids'

// ---------------- transport constants ----------------
/** Session cookie for web/desktop: __Host- prefix = Secure, Path=/, no Domain (another team's subdomain can't overwrite it). */
export const SESSION_COOKIE = '__Host-sid'
/** Plain-HTTP dev servers (http://*.localhost) can't set __Host- cookies; the dev server uses this name instead. */
export const DEV_SESSION_COOKIE = 'mycel-dev-sid'
/**
 * CSRF guard: every state-changing request authenticated by the cookie must carry this header (any non-empty
 * value; clients send "1"). A cross-site form or <img> can't set custom headers, and a cross-site fetch with a
 * custom header needs a CORS preflight the server never grants. Bearer-token requests don't need it.
 * The server additionally rejects cookie requests whose Origin / Sec-Fetch-Site says cross-site.
 */
export const CSRF_HEADER = 'x-mycel-csrf'
/** Each open window (tab / desktop window) picks a random id once and sends it on REST calls that start a turn and
 * on the WebSocket, so browser.call goes only to the window that sent the turn. */
export const WINDOW_HEADER = 'x-mycel-window'
/** The language the page shows before sign-in (the person picked it on the sign-in screen). The server uses it only
 * for requests without a session; signed-in requests use the person's language. */
export const LOCALE_HEADER = 'x-mycel-locale'
/** WebSocket subprotocols. Clients that can't send cookies (mobile shells) add `mycel.bearer.<token>`. */
export const WS_PROTOCOL = 'mycel.v1'
export const WS_BEARER_PREFIX = 'mycel.bearer.'
export const API_PREFIX = '/api'

/** Small uploads (POST /api/files/upload, /api/uploads, /api/transcribe): one file up to 50 MB. */
export const SMALL_UPLOAD_MAX = 50 * 1024 * 1024
/** Chunked uploads: 8 MB chunks (Cloudflare's 100 MB body limit on the relay path is far away). */
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
/** Largest file accepted through an upload session. */
export const UPLOAD_SESSION_MAX = 20 * 1024 * 1024 * 1024
/** Every ordinary API call must finish well inside Cloudflare's 100 s; long work becomes a job. */
export const API_DEADLINE_MS = 90_000

// ---------------- primitives ----------------
export const IsoTime = z.iso.datetime({ offset: true })
export type IsoTime = z.infer<typeof IsoTime>

/**
 * Path relative to the team folder root, as the user sees it: "finance/2026/q3.xlsx". '' is the root.
 * Shape check only (no leading "/", no "\\", no "." / ".." segments, no NUL, no empty segment). The server's
 * policy function does the real checks (actual names on disk, name rules, permissions).
 */
export const RelPath = z.string().max(1024).refine((p) => {
  if (p === '') return true
  if (p.startsWith('/') || p.endsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}, 'path must be relative to the team folder, without "..", "\\\\" or a leading "/"')
export type RelPath = z.infer<typeof RelPath>

export const Role = z.enum(['owner', 'admin', 'member'])
export type Role = z.infer<typeof Role>
export const UserStatus = z.enum(['active', 'disabled'])
export type UserStatus = z.infer<typeof UserStatus>
export const Locale = z.enum(['ko', 'en', 'id'])
export type Locale = z.infer<typeof Locale>
/** Language when nothing else decides: no personal choice and no team default stored (a fresh install). */
export const DEFAULT_LOCALE: Locale = 'en'
/** Each language named in its own language (language pickers), in the order pickers list them. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ko: '한국어', id: 'Bahasa Indonesia' }
export const LOCALE_ORDER: readonly Locale[] = ['en', 'ko', 'id']
/** "ko" / "ko-KR" / "in" -> one of ours, else null. */
export function asLocale(tag: string | null | undefined): Locale | null {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (base === 'ko' || base === 'en' || base === 'id') return base
  if (base === 'in') return 'id' // old Java/Android code for Indonesian
  return null
}
export const ClientKind = z.enum(['web', 'desktop', 'mobile'])
export type ClientKind = z.infer<typeof ClientKind>
export const Access = z.enum(['none', 'read', 'write'])
export type Access = z.infer<typeof Access>
/** Engine ids as stored in chats.engine / turns.engine. */
export const EngineId = z.enum(['claude-code', 'codex', 'api'])
export type EngineId = z.infer<typeof EngineId>
export const Theme = z.enum(['system', 'light', 'dark'])
export type Theme = z.infer<typeof Theme>

// ---------------- errors ----------------
/** Stable machine codes. `message` is in the user's language (see errors.ts). */
export const ErrorCode = z.enum([
  'bad_request', // malformed JSON, wrong content type
  'validation', // body/query/params failed the schema; details in `fields`
  'unauthorized', // no or expired session
  'password_change_required', // must_change_password: only /api/me and /api/auth/password allowed
  'forbidden', // logged in, but not allowed (role, not your chat, read-only folder)
  'csrf', // missing CSRF header or cross-site origin
  'not_found', // also used for "no access" to files, so hidden folders don't leak
  'conflict', // edit conflict, name taken, wrong state
  'gone', // expired invite / upload session
  'payload_too_large',
  'range_not_satisfiable',
  'rate_limited',
  'budget_exceeded', // model budget block (tab 1)
  'engine_unavailable', // engine not installed / not logged in
  'busy', // e.g. update refused while turns are running
  'unavailable', // server shutting down / restoring
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorStatus: Record<ErrorCode, number> = {
  bad_request: 400, validation: 400, unauthorized: 401, password_change_required: 403, forbidden: 403, csrf: 403,
  not_found: 404, conflict: 409, gone: 410, payload_too_large: 413, range_not_satisfiable: 416, rate_limited: 429,
  budget_exceeded: 429, engine_unavailable: 503, busy: 409, unavailable: 503, internal: 500,
}

export const ApiErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  /** validation: field path ("body.name", "query.limit") -> problem */
  fields: z.record(z.string(), z.string()).optional(),
  /** machine-readable details for a client that must react (e.g. conflict {reason:'audience_narrowed', lostViewers}) */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** rate_limited / busy: seconds to wait */
  retryAfter: z.number().int().nonnegative().optional(),
  /** request id from the X-Request-Id response header, to find the log line */
  requestId: z.string().optional(),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>
/** Every non-2xx JSON response: { error: { code, message } }. */
export const ApiErrorResponse = z.object({ error: ApiErrorBody })
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>

// ---------------- pagination ----------------
/** Long lists use opaque cursors: ?cursor=&limit= (tab 4). */
export const PageQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type PageQuery = z.infer<typeof PageQuery>
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() })
export type Page<T> = { items: T[]; nextCursor: string | null }

export const Ok = z.object({ ok: z.literal(true) })
export type Ok = z.infer<typeof Ok>
/** 202 for long-running work: progress over WebSocket job.progress / job.done, result at GET /api/jobs/:id. */
export const JobAccepted = z.object({ jobId: Uuid7 })
export type JobAccepted = z.infer<typeof JobAccepted>

/** Query-string boolean: "1" / "true" / "0" / "false". */
export const QueryBool = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true')
