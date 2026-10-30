// WebSocket protocol (GET /api/ws, tab 4 "WebSocket 이벤트"). Owner: B (server/src/routes/ws.ts, server/src/realtime/*).
//
// One socket per signed-in window. Server events carry a per-user `seq` (1, 2, 3, ... within an `epoch`; the epoch
// is a random id chosen at every server start). The server keeps recent events per user in a memory ring buffer
// (including the text deltas of running answers). Resume rules:
//   connect /api/ws?windowId=W                    -> hello { epoch, seq: current }           (fresh window)
//   connect /api/ws?windowId=W&epoch=E&after=N    -> hello { resumed: true } + every event with seq > N, in order
//        E differs from the server's epoch         -> reset  (server restarted: reload chats/messages from REST)
//        N older than the buffer                   -> resync (reload from REST, then continue after hello.seq)
// Reconnect: wait 0..1 s random, then 1, 2, 4 ... s, at most ~10 s (relay connections drop every 30-60 min).
// Streaming answers are saved to the DB every 0.3 s, so after a REST reload the client appends deltas whose
// `offset` >= the content length it has (drops overlap by offset).
// Keep-alive: the server sends a WebSocket protocol ping every 20 s (browsers answer automatically); app-level
// ping/pong is optional for clients that want to notice a dead link sooner.
import { z } from 'zod'
import { Uuid7 } from '../ids'
import { ApiErrorBody, ErrorCode, RelPath } from './common'
import { BrowserCall, BrowserResult } from './browser'
import { ArtifactSummary, ArtifactType, Chat, Job, JobKind, Memory, Message, MessageStatus, Step, UserRef } from './entities'
import { CredentialLogin } from './credentials'

export const WS_PATH = '/api/ws'
export const WS_PING_INTERVAL_MS = 20_000
/** Server ring buffer per user: events kept at least this long / this many (whichever is larger). */
export const WS_REPLAY_MIN_EVENTS = 2000
export const WS_REPLAY_MIN_MS = 5 * 60_000
/** The server closes a socket whose unsent backlog exceeds this (slow client); it reconnects and resumes. */
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export const WsClose = {
  /** not signed in / session ended (do not reconnect; go to the sign-in screen) */
  unauthorized: 4401,
  /** bad connect parameters (e.g. no windowId) */
  badRequest: 4400,
  /** Origin not allowed (cross-site WebSocket hijacking guard) */
  forbiddenOrigin: 4403,
  /** client too slow to read; reconnect and resume */
  tooSlow: 4408,
  /** same windowId connected again elsewhere; this socket is replaced */
  replaced: 4409,
  /** server restarting (reconnect) */
  serviceRestart: 1012,
} as const

export const WsConnectQuery = z.object({
  windowId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  epoch: z.string().max(64).optional(),
  after: z.coerce.number().int().nonnegative().optional(),
})
export type WsConnectQuery = z.infer<typeof WsConnectQuery>

// ---------------- server -> client: control frames (no seq, never replayed) ----------------
export const HelloFrame = z.object({
  type: z.literal('hello'),
  epoch: z.string(),
  /** last seq assigned for this user; events after it will follow */
  seq: z.number().int().nonnegative(),
  resumed: z.boolean(),
  windowId: z.string(),
  serverVersion: z.string(),
  pingIntervalMs: z.number().int().positive(),
})
export const ResyncFrame = z.object({ type: z.literal('resync'), epoch: z.string(), seq: z.number().int().nonnegative(), reason: z.enum(['buffer_overflow']) })
export const ResetFrame = z.object({ type: z.literal('reset'), epoch: z.string(), seq: z.number().int().nonnegative(), reason: z.enum(['server_restarted', 'epoch_mismatch']) })
export const PongFrame = z.object({ type: z.literal('pong'), t: z.number() })
export const ErrorFrame = z.object({ type: z.literal('error'), code: ErrorCode, message: z.string() })
export const ControlFrame = z.discriminatedUnion('type', [HelloFrame, ResyncFrame, ResetFrame, PongFrame, ErrorFrame])
export type ControlFrame = z.infer<typeof ControlFrame>

// ---------------- server -> client: events (seq, replayable) ----------------
const ev = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ type: z.literal(type), seq: z.number().int().positive(), at: z.number().int(), data })

export const SkillWritePreview = z.object({
  kind: z.literal('skill_write'),
  path: RelPath,
  isNew: z.boolean(),
  /** the skill's name from its header; null = a team rule (a .md without a header) or not Markdown */
  skillName: z.string().nullable(),
  /** "@@ … @@" unified diff of the text (a new file: every line added), or a one-line summary for other files */
  diff: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type SkillWritePreview = z.infer<typeof SkillWritePreview>

/** What a server check is about to let out, shown in full (docs/DECISIONS.md "Outbound web channels"): what a connected
 * service is sent, a scheduled task's instruction and the addresses it may open. `fields` (who receives it: to, channel,
 * repo, address …) come first; the whole `text` is shown, scrollable, with its size; `marks` are long random-looking
 * parts of it (they can carry data in an address) to highlight. */
export const ConfirmDetail = z.object({
  label: z.string(),
  text: z.string(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  marks: z.array(z.string()).optional(),
})
export type ConfirmDetail = z.infer<typeof ConfirmDetail>

export const AskUserRequest = z.object({
  kind: z.literal('ask_user'),
  requestId: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  multiple: z.boolean().optional(),
  allowText: z.boolean().optional(),
  /** when the card closes by itself (the AI then continues without an answer) */
  expiresAt: z.string().optional(),
  /** 'server': a safety check the server raised inside a tool call (an unseen web address, saving where more people
   * see it, remember after outside content), shown with its own header. The AI's ask_user never sets it, so a
   * question the AI writes cannot pass for one (design tab 7 "화면 보안"). */
  origin: z.literal('server').optional(),
  /** a server check that shows what is about to be saved (the AI saving under skills/: team skills and team rules
   * every teammate's AI follows): the file, new or changed, and the change as a unified diff (cut when long) */
  preview: SkillWritePreview.optional(),
  /** a server check: exactly what is about to go out, each block in full (ConfirmDetail) */
  details: z.array(ConfirmDetail).max(8).optional(),
})
/** browser wants to open an office-network (private) address: ask once / always / deny */
export const BrowserSiteRequest = z.object({ kind: z.literal('browser_site'), requestId: z.string(), url: z.string(), host: z.string(), reason: z.string().optional() })
export const TurnRequest = z.discriminatedUnion('kind', [AskUserRequest, BrowserSiteRequest])
export type TurnRequest = z.infer<typeof TurnRequest>

export const FileChange = z.object({
  path: RelPath,
  action: z.enum(['create', 'update', 'delete', 'move', 'restore', 'mkdir']),
  /** move: old path */
  from: RelPath.optional(),
  by: UserRef.nullable(),
  turnId: Uuid7.nullable(),
})
export type FileChange = z.infer<typeof FileChange>

export const ServerEvent = z.discriminatedUnion('type', [
  /** a message appeared that this window didn't create (another window/device of the same person) */
  ev('message.created', z.object({ chatId: Uuid7, message: Message })),
  /** answer text; offset = position in message.content where `text` starts. reset: the text from offset on is
   * discarded first (a refused attempt's partial answer before the retry), then `text` follows */
  ev('message.delta', z.object({ chatId: Uuid7, messageId: Uuid7, offset: z.number().int().nonnegative(), text: z.string(), reset: z.literal(true).optional() })),
  /** tool step started / updated / ended (same step.id) */
  ev('message.step', z.object({ chatId: Uuid7, messageId: Uuid7, step: Step })),
  /** finished: done / error / stopped; the full final message (content, steps, file summary, usage) */
  ev('message.done', z.object({ chatId: Uuid7, messageId: Uuid7, status: MessageStatus, message: Message })),
  ev('queue.position', z.object({ chatId: Uuid7, messageId: Uuid7, turnId: Uuid7, position: z.number().int().nonnegative(), epoch: z.string().optional(), revision: z.number().int().nonnegative().optional() })),
  /** artifact being written (status writing, content so far, throttled) or saved (status done, summary) */
  ev('artifact.updated', z.object({
    chatId: Uuid7, messageId: Uuid7.nullable(), key: z.string(), type: ArtifactType, title: z.string().nullable(),
    status: z.enum(['writing', 'done']), content: z.string().optional(), artifact: ArtifactSummary.nullable(),
  })),
  ev('chat.updated', z.object({ chatId: Uuid7, change: z.enum(['created', 'updated', 'deleted', 'restored', 'purged']), chat: Chat.nullable() })),
  /** only paths this person can read (file screen refresh) */
  ev('files.changed', z.object({ changes: z.array(FileChange) })),
  /** someone's save met a newer version: theirs became `copyPath` next to `path` (sent to the saver and to whoever
   * changed it first, each only while they can read both; tab 2 "동시 수정", tab 4 PUT content) */
  ev('files.conflict', z.object({ path: RelPath, copyPath: RelPath, by: UserRef.nullable() })),
  ev('turn.request', z.object({ turnId: Uuid7, chatId: Uuid7, messageId: Uuid7, request: TurnRequest })),
  /** answered (maybe in another window), timed out, or the turn ended: close the card */
  ev('turn.request.closed', z.object({ turnId: Uuid7, requestId: z.string(), reason: z.enum(['answered', 'timeout', 'turn_ended']) })),
  ev('job.progress', z.object({ jobId: Uuid7, kind: JobKind, progress: z.number().min(0).max(1).nullable(), message: z.string().nullable() })),
  ev('job.done', z.object({ job: Job })),
  /** only to the window that sent the turn (windowId); the window must dedupe by callId */
  ev('browser.call', z.object({ windowId: z.string(), call: BrowserCall })),
  /** the turn stopped; abandon this call */
  ev('browser.cancel', z.object({ windowId: z.string(), callId: z.string() })),
  ev('memory.changed', z.object({ change: z.enum(['created', 'deleted', 'cleared']), memory: Memory.nullable() })),
  /** budget warnings, scheduled update, engine trouble (shown as a banner/toast) */
  ev('notice', z.object({ level: z.enum(['info', 'warn', 'error']), code: z.string(), message: z.string(), error: ApiErrorBody.optional(),
    /** an app address to open from the banner (e.g. the version history of a changed team skill) */
    link: z.string().max(2000).regex(/^\/[^/]/).optional() })),
  /** a ChatGPT sign-in this person started (Admin / Settings > AI connections): the device address and code, then the
   * result. Sent to the person who started it only, never to the other admins. */
  ev('credential.login', CredentialLogin),
  /** the session ended (logout elsewhere, password changed, account disabled); the socket closes with 4401 */
  ev('session.ended', z.object({ reason: z.enum(['logout', 'password_changed', 'disabled', 'expired', 'revoked']) })),
])
export type ServerEvent = z.infer<typeof ServerEvent>
export type ServerEventType = ServerEvent['type']
export type ServerEventData<T extends ServerEventType> = Extract<ServerEvent, { type: T }>['data']
/** What server code publishes; the realtime hub adds seq and at. */
export type ServerEventInput = { [T in ServerEventType]: { type: T; data: ServerEventData<T> } }[ServerEventType]

/** Anything the server sends on the socket. */
export const ServerFrame = z.union([ControlFrame, ServerEvent])
export type ServerFrame = z.infer<typeof ServerFrame>

// ---------------- client -> server ----------------
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), t: z.number() }),
  /** the window received browser.call and started it (stops the server from re-sending after a reconnect) */
  z.object({ type: z.literal('browser.ack'), callId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('browser.result'), result: BrowserResult }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

