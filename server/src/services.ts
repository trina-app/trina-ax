// Cross-component service interfaces. Each component implements its service in its own folder and installs it in
// its route module's init() (ctx.services.x = ...). Until then the app runs with the fallbacks below, which refuse
// politely instead of pretending to work.
import type { Attachment, ClientKind, ConnectionStatus, JobKind, Locale, Role, ServerEventInput } from '@mycel/shared/api'

/** Who is calling (set by the session middleware for every request). */
export interface AuthInfo {
  user: { id: string; username: string; name: string; role: Role; locale: Locale; mustChangePassword: boolean }
  /** expiresAt (ISO): when the session ends; the realtime hub closes the session's sockets then (no expiry: never) */
  session: { id: string; client: ClientKind; expiresAt?: string }
  /** cookie: CSRF header required on state-changing requests; bearer: not */
  via: 'cookie' | 'bearer'
}

/** Facts about the request transport that handlers may need (never trust client headers for these). */
export interface RequestInfo {
  /** real client IP: TLS socket peer (office), relay OPEN-frame metadata (remote); null when unknown */
  ip: string | null
  via: 'direct' | 'relay' | 'local' | 'test'
}

/** Component A (server/src/auth/*). */
export interface SessionService {
  /** Read the session cookie / bearer token; null when absent, expired or revoked. Updates last_seen_at. */
  resolve(req: Request, info: RequestInfo): Promise<AuthInfo | null>
  /** owner-reauth endpoints: check the re-entered password (rate-limited like login) */
  verifyPassword(userId: string, password: string, info: RequestInfo): Promise<boolean>
}

/**
 * A WebSocket that did not come through Bun.serve's upgrade: a browser WebSocket proxied by the relay as a stream
 * (component F, server/src/relay-client). Tab 4 "중계로 들어온 요청": the relay client wraps it as a RealtimeConn
 * (relay-client/realtime-conn.ts) and the realtime hub attaches it with RealtimeHub.attach exactly like a direct
 * upgrade (same cookie / Origin / ticket checks on `req`, same seq / resume rules); only keep-alive differs (the
 * relay pings the browser). The handshake is already complete when the hub sees it (subprotocol in `protocol`).
 */
export interface VirtualWebSocket {
  readonly protocol: string
  /** bytes queued for the client and not yet delivered (slow-client check, close 4408 like a direct socket) */
  readonly bufferedAmount: number
  readonly readyState: 'open' | 'closing' | 'closed'
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onMessage: ((data: string | Uint8Array) => void) | null
  onClose: ((code: number, reason: string) => void) | null
}

/** Component B (server/src/realtime/*). */
export interface RealtimeHub {
  /** Send to every open window of one person (adds seq/at, keeps it in the replay buffer). */
  publish(userId: string, ev: ServerEventInput): void
  /** For events whose visibility depends on the person (files.changed): build per connected-or-buffered user, null = skip. */
  publishEach(build: (userId: string) => ServerEventInput | null): void
  /** Send session.ended to every socket of a person, then close them (4401). */
  disconnectUser(userId: string, reason: 'logout' | 'password_changed' | 'disabled' | 'expired' | 'revoked'): void
  /** session.ended + close for the sockets of one session only (logout on one device, "sign out this device", the other sessions after
   * a password change). Optional: without it the session's sockets stay open until they reconnect. Added by A. */
  disconnectSession?(sessionId: string, reason: 'logout' | 'password_changed' | 'disabled' | 'expired' | 'revoked'): void
  /**
   * Drop the person's replay buffer, keeping their seq: a later resume from before this point gets `resync` and the
   * window reloads over REST. Called whenever the person's access changes (rules, groups, role, disabled, deleted),
   * so events filtered under the old access are never replayed under the new one.
   */
  forgetReplay(userId: string): void
  /**
   * Attach a WebSocket-like connection that did not come through Bun's upgrade (the relay client's virtual
   * sockets, tab 4 "중계로 들어온 요청"). `req` carries the original path (/api/ws?windowId=..), headers (cookie,
   * Origin, Sec-WebSocket-Protocol); the hub authenticates it exactly like a direct upgrade. On failure the
   * connection is closed with a WsClose code.
   */
  attach(conn: RealtimeConn, req: Request, info: RequestInfo): Promise<void>
}

/** A server->client message channel (Bun ServerWebSocket, or a relay stream). */
export interface RealtimeConn {
  send(data: string): void
  close(code: number, reason?: string): void
  /** bytes queued but not yet sent (slow-client guard); 0 when unknown */
  bufferedAmount(): number
  /** WebSocket protocol ping; absent where the transport keeps itself alive (relay) */
  ping?(): void
  onMessage(fn: (data: string) => void): void
  /** called once when the connection closes; registering after it already closed calls `fn` right away */
  onClose(fn: () => void): void
}

/** Component C: chat attachments uploaded via POST /api/uploads or an upload session (users/<id>/.attachments/<chatId>/).
 * B turns them into turn inputs. */
export interface AttachmentStore {
  /** The caller's own attachments of this chat, in the order of `ids`; unknown / other people's ids are left out. */
  get(userId: string, chatId: string, ids: string[]): Attachment[]
}

/** What a turn tool gets for one call (B builds it per turn). */
export interface TurnToolContext {
  turnId: string
  chatId: string
  userId: string
  /** the answer being written */
  messageId: string
  locale: Locale
  /** aborted when the turn is stopped / ends */
  signal: AbortSignal
  /** the turn's file-tool context (read hashes, write limits) for policy-checked file work */
  files: import('./files/service').ToolCtx
}
export type TurnToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface TurnToolResult {
  content: TurnToolContent[]
  isError?: boolean
  /** audit line for tool_events.summary (default: "<name> -> ok|error") */
  summary?: string
}
/**
 * A tool the engine can call besides the six file tools (as mcp__team__<name>). C registers make_file,
 * share_file, artifact, web_fetch; B registers remember, forget, ask_user and the browser tools.
 * Register in init(): (ctx.services.turnTools ??= []).push(tool)
 */
export interface TurnTool {
  name: string
  description: string
  /** JSON schema of the input (draft-7 object schema) */
  inputSchema: Record<string, unknown>
  /** offered to this turn? (default: always) */
  available?(t: { userId: string; chatId: string; browser: boolean }): boolean
  call(args: unknown, t: TurnToolContext): Promise<TurnToolResult>
}

export interface JobHandle {
  id: string
  signal: AbortSignal
  progress(p: number | null, message?: string | null): void
}
/** Component C (server/src/jobs/*). G uses it for backup / restore / update / export. */
export interface JobService {
  /** Create a job row (queued), run it in the background, publish job.progress / job.done. Returns the job id.
   * `discard` runs instead of `run` when the job never starts (canceled while queued, server shutting down): it
   * removes what was set aside for the job (a transcription's audio file). */
  start(o: { kind: JobKind; userId: string | null; run: (h: JobHandle) => Promise<unknown>; discard?: () => void }): string
  cancel(id: string): boolean
}

/** Component F (server/src/relay-client/*). G's /api/admin/connection reads it. */
export interface RelayStatusProvider {
  status(): ConnectionStatus
  /**
   * Move the team address to this server's key with the recovery code printed at registration (a restore on another
   * Mac, or a lost key file: state not_registered, detail 'recovery_needed'; `teamId` from the printed recovery sheet when this
   * server has no registration at all). Rejects with a message when the relay
   * refuses the code. Component G puts it behind an owner screen.
   */
  recover?(recoveryCode: string, teamId?: string): Promise<ConnectionStatus>
}

export interface Services {
  sessions: SessionService
  realtime: RealtimeHub
  jobs: JobService | null
  relay: RelayStatusProvider | null
  /** C (optional until C lands): attachment lookup for turn inputs */
  attachments?: AttachmentStore | null
  /** tools offered to engine turns besides the file tools (B, C) */
  turnTools?: TurnTool[]
}

/** Fallbacks before A and B land: nobody is signed in; events go nowhere. */
export const noSessions: SessionService = {
  async resolve() { return null },
  async verifyPassword() { return false },
}
export const nullRealtime: RealtimeHub = {
  publish() {}, publishEach() {}, disconnectUser() {}, disconnectSession() {}, forgetReplay() {},
  async attach(conn) { conn.close(1012, 'realtime not available') },
}
