// Cross-component service interfaces. Each component implements its service in its own folder and installs it in
// its route module's init() (ctx.services.x = ...). Until then the app runs with the fallbacks below, which refuse
// politely instead of pretending to work.
import type { ClientKind, ConnectionStatus, JobKind, Locale, Role, ServerEventInput } from '@mycel/shared/api'

/** Who is calling (set by the session middleware for every request). */
export interface AuthInfo {
  user: { id: string; username: string; name: string; role: Role; locale: Locale; mustChangePassword: boolean }
  session: { id: string; client: ClientKind }
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
 * (component F, server/src/relay-client). Tab 4 "중계로 들어온 요청": the realtime hub attaches it exactly like a direct
 * upgrade (same cookie / Origin / ticket checks on `req`, same seq / resume rules); only keep-alive differs (the relay
 * pings the browser). The handshake is already complete when the hub sees it (subprotocol in `protocol`).
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
  /** Close every socket of a person (session.ended already published). */
  disconnectUser(userId: string, reason: 'logout' | 'password_changed' | 'disabled' | 'expired' | 'revoked'): void
  /** A WebSocket that arrived over the relay (GET /api/ws as a relay stream). Absent: the relay client closes it
   * with 1013 ("realtime not available"). `req` carries the browser's path, query, cookies and Origin. */
  attachVirtual?(ws: VirtualWebSocket, req: Request, info: RequestInfo): void
}

export interface JobHandle {
  id: string
  signal: AbortSignal
  progress(p: number | null, message?: string | null): void
}
/** Component C (server/src/jobs/*). G uses it for backup / restore / update / export. */
export interface JobService {
  /** Create a job row (queued), run it in the background, publish job.progress / job.done. Returns the job id. */
  start(o: { kind: JobKind; userId: string | null; run: (h: JobHandle) => Promise<unknown> }): string
  cancel(id: string): boolean
}

/** Component F (server/src/relay-client/*). G's /api/admin/connection reads it. */
export interface RelayStatusProvider {
  status(): ConnectionStatus
}

export interface Services {
  sessions: SessionService
  realtime: RealtimeHub
  jobs: JobService | null
  relay: RelayStatusProvider | null
}

/** Fallbacks before A and B land: nobody is signed in; events go nowhere. */
export const noSessions: SessionService = {
  async resolve() { return null },
  async verifyPassword() { return false },
}
export const nullRealtime: RealtimeHub = { publish() {}, publishEach() {}, disconnectUser() {} }
