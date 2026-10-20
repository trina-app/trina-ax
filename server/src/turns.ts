// Turn tokens. A token is valid only while its turn runs, only for its user, and only from a process in that
// turn's engine process group (checked with the peer credentials the gate stamps on each connection).
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { TurnFiles } from './files/service'

export interface Peer { pid: number; uid: number; gid: number; pgid: number; sid: number }
export interface Turn {
  id: string; userId: string; chatId: string; tokenHash: string
  files: TurnFiles
  /** engine process group (= session id; the launcher starts the engine with setsid) */
  pgid: number | null
  revoked: boolean
  waiters: (() => void)[]
}

const h = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

export class TurnRegistry {
  private byId = new Map<string, Turn>()
  private byHash = new Map<string, Turn>()
  constructor(private db: Database, private agentUid: number) {}

  create(userId: string, chatId: string, engine = 'claude-code', model: string | null = null): { turn: Turn; token: string } {
    const id = 't_' + crypto.randomBytes(9).toString('base64url')
    const token = crypto.randomBytes(32).toString('base64url')
    const turn: Turn = { id, userId, chatId, tokenHash: h(token), files: new TurnFiles(), pgid: null, revoked: false, waiters: [] }
    this.byId.set(id, turn); this.byHash.set(turn.tokenHash, turn)
    this.db.query('INSERT INTO turns (id, chat_id, user_id, engine, model) VALUES (?,?,?,?,?)').run(id, chatId, userId, engine, model)
    return { turn, token }
  }
  get(id: string) { return this.byId.get(id) }
  bind(turnId: string, pgid: number) {
    const t = this.byId.get(turnId); if (!t || t.revoked) return false
    t.pgid = pgid; t.waiters.splice(0).forEach((f) => f()); return true
  }
  /** end of turn: token is useless from now on */
  revoke(turnId: string, status: 'done' | 'error' | 'stopped' | 'interrupted' = 'done', err?: string) {
    const t = this.byId.get(turnId); if (!t) return
    t.revoked = true; this.byHash.delete(t.tokenHash); this.byId.delete(turnId)
    t.waiters.splice(0).forEach((f) => f())
    this.db.query('UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, new Date().toISOString(), err ?? null, turnId)
  }
  /** Validate a bridge connection. Returns the turn or a reason. */
  async authenticate(token: unknown, peer: Peer, waitMs = 3000): Promise<Turn | string> {
    if (typeof token !== 'string' || token.length < 20) return 'missing token'
    const t = this.byHash.get(h(token))
    if (!t || t.revoked) return 'unknown or expired token'
    if (peer.uid !== this.agentUid) return `peer uid ${peer.uid} is not the engine account`
    if (t.pgid === null) await new Promise<void>((res) => { t.waiters.push(res); setTimeout(res, waitMs) })
    if (t.revoked) return 'turn ended'
    if (t.pgid === null) return 'turn engine not started'
    if (peer.pgid !== t.pgid || peer.sid !== t.pgid) return `peer process ${peer.pid} is not part of this turn's engine (pgid ${peer.pgid}/sid ${peer.sid} != ${t.pgid})`
    return t
  }
}
