// Turn tokens. A token is valid only while its turn runs, only for its user, and only from a process in that
// turn's engine process group (checked with the peer credentials the gate stamps on each connection).
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { uuidv7 } from '@mycel/shared'
import { TurnFiles } from './files/service'

export interface Peer { pid: number; uid: number; gid: number; pgid: number; sid: number }

/** MCP content blocks our tools return. */
export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
/** Tools of one turn besides the six file tools (set by the chat runtime before the engine starts). */
export interface TurnToolSet {
  list(): { name: string; description: string; inputSchema: Record<string, unknown> }[]
  has(name: string): boolean
  call(name: string, args: unknown): Promise<{ content: McpContent[]; isError?: boolean; summary: string }>
  /** after a file tool call (the runtime publishes files.changed) */
  afterFileTool?(name: string, isError: boolean, args: unknown): void
  /** before a file tool call: a refusal text stops it (the person declined a confirmation card); with a summary, that
   * is the audit line (default: the wider-audience refusal) */
  beforeFileTool?(name: string, args: unknown): Promise<string | { refusal: string; summary: string } | null>
}
export interface Turn {
  id: string; userId: string; chatId: string; tokenHash: string
  files: TurnFiles
  /** engine session id (= engine pid = its process group; the launcher starts the engine with setsid).
   * Tool connections must come from this session. Engines may put helpers in their own process group
   * (Codex does this for MCP servers) but cannot leave the session without setsid, which yields a new id. */
  pgid: number | null
  revoked: boolean
  abort: AbortController
  waiters: (() => void)[]
  /** extra tools of this turn (chat runtime); absent = file tools only (stage 1) */
  tools?: TurnToolSet
}

const h = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

export class TurnRegistry {
  private byId = new Map<string, Turn>()
  private byHash = new Map<string, Turn>()
  constructor(private db: Database, private agentUid: number) {}

  /** New turn + token. With `existingId` (a queued turn row the chat runtime made), the row is marked running
   * instead of inserted. */
  create(userId: string, chatId: string, engine = 'claude-code', model: string | null = null, existingId?: string): { turn: Turn; token: string } {
    const id = existingId ?? uuidv7()
    if (this.byId.has(id)) throw new Error('turn already registered')
    const token = crypto.randomBytes(32).toString('base64url')
    const turn: Turn = { id, userId, chatId, tokenHash: h(token), files: new TurnFiles(), pgid: null, revoked: false, abort: new AbortController(), waiters: [] }
    if (existingId) {
      const updated = this.db.query("UPDATE turns SET status = 'running', started_at = COALESCE(dispatched_at, started_at), engine = ?, model = ? WHERE id = ? AND user_id = ? AND chat_id = ? AND status IN ('queued','running')").run(engine, model, id, userId, chatId)
      if (updated.changes !== 1) throw new Error('turn is not available for registration')
    }
    else this.db.query('INSERT INTO turns (id, chat_id, user_id, engine, model) VALUES (?,?,?,?,?)').run(id, chatId, userId, engine, model)
    // Publish no usable token until the durable row accepted this execution.
    this.byId.set(id, turn); this.byHash.set(turn.tokenHash, turn)
    return { turn, token }
  }
  get(id: string) { return this.byId.get(id) }
  /** Revoke access now; the runtime records the final status after actual termination. */
  invalidate(turnId: string) {
    const t = this.byId.get(turnId)
    if (!t) return
    t.revoked = true
    t.abort.abort()
    this.byHash.delete(t.tokenHash)
    t.waiters.splice(0).forEach(f => f())
  }
  bind(turnId: string, pgid: number) {
    const t = this.byId.get(turnId); if (!t || t.revoked) return false
    t.pgid = pgid; t.files.enginePid = pgid; t.waiters.splice(0).forEach((f) => f()); return true
  }
  /** end of turn: token is useless from now on */
  revoke(turnId: string, status: 'done' | 'error' | 'stopped' | 'interrupted' = 'done', err?: string) {
    const t = this.byId.get(turnId); if (!t) return
    t.revoked = true; this.byHash.delete(t.tokenHash); this.byId.delete(turnId)
    t.abort.abort()
    t.waiters.splice(0).forEach((f) => f())
    this.db.query('UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, new Date().toISOString(), err ?? null, turnId)
  }
  /** Validate a bridge connection. Returns the turn or a reason. */
  async authenticate(token: unknown, peer: Peer, waitMs = 3000, seen?: (t: Turn) => void): Promise<Turn | string> {
    if (typeof token !== 'string' || token.length < 20) return 'missing token'
    const t = this.byHash.get(h(token))
    if (!t || t.revoked) return 'unknown or expired token'
    seen?.(t)
    if (peer.uid !== this.agentUid) return `peer uid ${peer.uid} is not the engine account`
    if (t.pgid === null) await new Promise<void>((res) => { t.waiters.push(res); setTimeout(res, waitMs) })
    if (t.revoked) return 'turn ended'
    if (t.pgid === null) return 'turn engine not started'
    if (peer.sid !== t.pgid) return `peer process ${peer.pid} is not part of this turn's engine (session ${peer.sid} != ${t.pgid})`
    return t
  }
}
