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
/** The first-run setup token from the setup link (/setup#token=…), sent with GET /api/setup: through the relay the
 * answer says setup is still needed only to a visitor who has the token. A header, not a query, so no request line or
 * access log holds it. */
export const SETUP_TOKEN_HEADER = 'x-mycel-setup-token'
/** WebSocket subprotocols. Clients that can't send cookies (mobile shells) add `mycel.bearer.<token>`. */
export const WS_PROTOCOL = 'mycel.v1'
export const WS_BEARER_PREFIX = 'mycel.bearer.'
export const API_PREFIX = '/api'

/** Small uploads (POST /api/files/upload, /api/uploads, /api/transcribe): one file up to 50 MB. */
export const SMALL_UPLOAD_MAX = 50 * 1024 * 1024
/** The most a file the AI attaches to its answer in a chat shared with people may be (server/src/chat/chat-files.ts
 * createFromAi; docs/decisions/20261121-shared-chat-attach-work-file.md): 1 GB, as a room file
 * (docs/decisions/20261116-room-file-limit-1gb.md), within the team's storage and the turn's write limits. An upload
 * keeps SMALL_UPLOAD_MAX (CHAT_FILE_MAX). */
export const CHAT_FILE_AI_MAX = 1024 * 1024 * 1024
/** Chunked uploads: 8 MB chunks (Cloudflare's 100 MB body limit on the relay path is far away). */
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
/** Largest file accepted through an upload session. */
export const UPLOAD_SESSION_MAX = 20 * 1024 * 1024 * 1024
/** Largest file sent in a room (a DM, a group chat, a team room): 1 GB per file, fixed, like Slack (the owner,
 * docs/decisions/20261116-room-file-limit-1gb.md). Up to SMALL_UPLOAD_MAX in one request, anything larger through an
 * upload session (8 MB chunks, resumable), so it passes a proxy's request size limit. */
export const ROOM_FILE_MAX = 1024 * 1024 * 1024
/** The largest file a guest may upload (in a room, to their project's folder, to an AI chat): the team's choice (TeamSettings.guestFileMax, Admin > Members >
 * Guests), 100 MB unless the owner or an admin raises it to 1 GB; never more than a member's ROOM_FILE_MAX. A stored
 * '10gb' from before the room limit became 1 GB is read as '1gb' (server admin/settings.ts getTeamSettings). */
export const GUEST_FILE_MAX = { '100mb': 100 * 1024 * 1024, '1gb': ROOM_FILE_MAX } as const
export type GuestFileMax = keyof typeof GUEST_FILE_MAX
export const GUEST_FILE_DEFAULT: GuestFileMax = '100mb'
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

/** `guest`: an outside person who reaches only the group chats and projects they were invited to (docs/DECISIONS.md
 * "Guests: only what they were invited to"). Never a folder rule subject, never set by a role change. */
export const Role = z.enum(['owner', 'admin', 'member', 'guest'])
export type Role = z.infer<typeof Role>
/** A role the members screen can give (a guest comes only from a guest invite). */
export const TeamRole = Role.exclude(['owner', 'guest'])
export type TeamRole = z.infer<typeof TeamRole>
/** How a guest's AI runs: off (default), team connections assigned to them under a limit, or their own sign-in. */
export const GuestAi = z.enum(['none', 'team', 'own'])
export type GuestAi = z.infer<typeof GuestAi>
/** A guest's place: one group chat (`room`) or one project. A guest is in at most one of each kind at a time (owner,
 * 2026-11-15); an invite opens one place. */
export const GuestPlace = z.object({ kind: z.enum(['room', 'project']), id: z.string().min(1).max(64) })
export type GuestPlace = z.infer<typeof GuestPlace>
/** The most a guest's monthly token limit can be (10억 tokens): far above any preset, below anything that overflows. */
export const GUEST_TOKENS_MAX = 1_000_000_000
/** The AI choice a guest invite carries: `team` needs a team connection and a usage limit (a 'block' budget of the
 * guest's own, a month long); `own` = the guest's own Claude/Codex sign-in; `none` (default) = no AI. The limit is in
 * tokens (`limitTokens`, owner 2026-11-15: tokens count with every connection, US dollars only with API keys). A guest
 * given Team AI before then keeps their US dollar limit (`limitUsd`, read and enforced as it is) until an admin changes
 * it: there is no safe rule from dollars to tokens (docs/DECISIONS.md "Guest Team AI: a token limit"). Exactly one of
 * the two is there. What is sent to the server: GuestAiChoiceBody (tokens only). */
export const GuestAiChoice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('own') }),
  z.object({ mode: z.literal('team'), credentialId: z.string().min(1).max(64), limitTokens: z.number().int().positive().max(GUEST_TOKENS_MAX).optional(), limitUsd: z.number().positive().max(100_000).optional() }),
])
/** The AI choice as an invite or Admin › Change AI sends it: Team AI always with a monthly token limit. */
export const GuestAiChoiceBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('own') }),
  // strict: a body still in US dollars (limitUsd) is refused, not read as tokens with the dollars dropped
  z.object({ mode: z.literal('team'), credentialId: z.string().min(1).max(64), limitTokens: z.number().int().positive().max(GUEST_TOKENS_MAX) }).strict(),
])
export type GuestAiChoiceBody = z.infer<typeof GuestAiChoiceBody>
export type GuestAiChoice = z.infer<typeof GuestAiChoice>
/** A guest's place with its name, as screens show it (Me.guest, User.guest). */
export const GuestPlaceNamed = GuestPlace.extend({ name: z.string() })
/** Why a guest is not in a place of theirs now: 'left' = taken out of it or left it, 'trashed' = the project is in the
 * trash (restoring it brings them back), 'gone' = the group chat was closed or the project deleted for good. */
export const GuestPlaceOut = z.enum(['left', 'trashed', 'gone'])
/** A guest's details: their places and their AI (Me.guest for the guest, User.guest for admins). */
export const GuestDetail = z.object({
  /** the group chat and/or the project they are in (at most one of each kind; the group chat first). An active guest:
   * the places they are in now. A removed guest (account off): each place they were last in, with `out` saying why
   * they are not in it now. */
  places: z.array(GuestPlaceNamed.extend({ out: GuestPlaceOut.optional() })).max(2),
  ai: GuestAiChoice,
  /** a removed guest (account off) who is in none of their places now, the reason that decides whether switching them
   * on can work ('trashed' when their project is in the trash, else 'left' when a place is still there, else 'gone').
   * Absent for an active guest and for a removed one who could be switched back on */
  placeOut: GuestPlaceOut.optional(),
  /** placeOut 'left' because they left it on their own (Admin: "Left"); absent when someone took them out ("Removed") */
  leftThemselves: z.literal(true).optional(),
  /** Team AI was picked for them, but that team AI account was deleted since: `ai` reads No AI, and the guest is told
   * that AI can't answer them now (not that it is off) */
  teamAiGone: z.literal(true).optional(),
  /** Team AI with this month's limit used up (Admin's row says so; the guest's own screens say it on a send) */
  aiUsedUp: z.literal(true).optional(),
  /** Team AI: what this month's limit has used so far (the turns of the guest since the 1st in the team's time zone,
   * as the limit counts them) and when it starts over. Left = the limit minus used */
  aiUse: z.object({ usedTokens: z.number().nonnegative(), usedUsd: z.number().nonnegative(), resetsAt: z.string() }).optional(),
})
export const UserStatus = z.enum(['active', 'disabled'])
export type UserStatus = z.infer<typeof UserStatus>
export const Locale = z.enum(['ko', 'en', 'id', 'ja', 'es', 'zh'])
export type Locale = z.infer<typeof Locale>
/** Language when nothing else decides: no personal choice and no team default stored (a fresh install). */
export const DEFAULT_LOCALE: Locale = 'en'
/** Each language named in its own language (language pickers), in the order pickers list them. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ko: '한국어', id: 'Bahasa Indonesia', ja: "日本語", es: "Español", zh: "简体中文" }
export const LOCALE_ORDER: readonly Locale[] = ['en', 'ko', 'id', 'ja', 'es', 'zh']
/** "ko" / "ko-KR" / "in" -> one of ours, else null. Every Chinese tag ("zh", "zh-CN", "zh-Hans", "zh-SG", and also
 * "zh-TW" / "zh-HK" / "zh-Hant") is "zh": Simplified Chinese is the only Chinese we have, and it reads better for a
 * Traditional reader than English. */
export function asLocale(tag: string | null | undefined): Locale | null {
  const base = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (base === 'ko' || base === 'en' || base === 'id' || base === 'ja' || base === 'es' || base === 'zh') return base
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
/** How hard the AI thinks (docs/decisions/20261126-model-effort-choice.md): 빠르게 · 보통 · 꼼꼼하게. Claude Code takes
 * `--effort low` / no flag / `--effort high`; Codex `model_reasoning_effort` low / medium / high. null or absent = not
 * chosen (보통: Claude Code gets no flag, Codex medium). */
export const Effort = z.enum(['quick', 'normal', 'thorough'])
export type Effort = z.infer<typeof Effort>
export const Theme = z.enum(['system', 'light', 'dark'])
export type Theme = z.infer<typeof Theme>
/** The person's text size (Settings > Profile), smallest to largest: the web app's root font size (web/src/lib/textSize.ts). */
export const TextSize = z.enum(['small', 'default', 'large', 'larger', 'largest'])
export type TextSize = z.infer<typeof TextSize>

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
  'storage_full', // 507: the team's storage is (almost) full; writes are refused until space is freed
  'plan_limit', // 409: over the plan (plan.json): seats (params.reason seat_limit) or answers at the same time (concurrency_over_plan); params.manageUrl = where to change it; params.changePlan = the message says to change the plan (a store app words it itself)
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorStatus: Record<ErrorCode, number> = {
  bad_request: 400, validation: 400, unauthorized: 401, password_change_required: 403, forbidden: 403, csrf: 403,
  not_found: 404, conflict: 409, gone: 410, payload_too_large: 413, range_not_satisfiable: 416, rate_limited: 429,
  budget_exceeded: 429, engine_unavailable: 503, busy: 409, unavailable: 503, internal: 500, storage_full: 507,
  plan_limit: 409,
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

/** A re-check (docs/decisions/20261122-google-reauth.md; server/src/auth/reauth.ts), spread into every body that asks
 * for it: the caller's own password again, or, only for an account without a password (made with Google),
 * `reauthFlow`: the id of a Google check this session finished in the last 5 minutes (POST /api/me/google/reauth, then
 * GET /api/me/google/reauth/:id says `confirmed`). Exactly one: both or neither is a 400. A wrong one of either kind
 * counts on the person's re-check limit (5 per 15 minutes). */
export const ReauthFields = {
  password: z.string().min(1).max(256).optional(),
  reauthFlow: Uuid7.optional(),
}
/** 202 for long-running work: progress over WebSocket job.progress / job.done, result at GET /api/jobs/:id. */
export const JobAccepted = z.object({ jobId: Uuid7 })
export type JobAccepted = z.infer<typeof JobAccepted>

/** Query-string boolean: "1" / "true" / "0" / "false". */
export const QueryBool = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true')
