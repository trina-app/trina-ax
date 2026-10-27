import type { Database } from 'bun:sqlite'

/** Synchronous transactions only: commit admission/claim before starting an engine or emitting events. */
export class QueueStore {
  constructor(private db: Database) {}
  private next(): number {
    const n = (this.db.query('UPDATE chat_queue_state SET next_seq = next_seq + 1 WHERE id = 1 RETURNING next_seq').get() as { next_seq: number }).next_seq
    if (!Number.isSafeInteger(n)) throw new Error('queue sequence exhausted')
    return n
  }
  /** Caller inserts messages/turn and schedule progress in the SAME transaction. */
  admit(userId: string): number {
    const seq = this.next()
    if (!this.db.query('SELECT 1 FROM chat_queue_users WHERE user_id = ?').get(userId))
      this.db.query('INSERT INTO chat_queue_users(user_id, rr_ticket) VALUES (?,?)').run(userId, this.next())
    return seq
  }
  tickets(): Map<string, number> {
    return new Map((this.db.query('SELECT user_id, rr_ticket FROM chat_queue_users').all() as { user_id: string; rr_ticket: number }[]).map(r => [r.user_id, r.rr_ticket]))
  }
  settle(userId: string) {
    this.db.query("DELETE FROM chat_queue_users WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM turns WHERE user_id = ? AND status = 'queued')").run(userId, userId)
  }
  claim(turnId: string, userId: string, wallMs: number, now = new Date().toISOString()): { dispatchedAt: string; wallDeadlineAt: string } | null {
    return this.db.transaction(() => {
      const deadline = new Date(Date.parse(now) + wallMs).toISOString()
      const result = this.db.query("UPDATE turns SET status = 'running', started_at = ?, dispatched_at = ?, wall_deadline_at = ? WHERE id = ? AND user_id = ? AND status = 'queued'")
        .run(now, now, deadline, turnId, userId)
      if (!result.changes) return null
      this.settle(userId)
      if (this.db.query('SELECT 1 FROM chat_queue_users WHERE user_id = ?').get(userId))
        this.db.query('UPDATE chat_queue_users SET rr_ticket = ? WHERE user_id = ?').run(this.next(), userId)
      return { dispatchedAt: now, wallDeadlineAt: deadline }
    })()
  }
  /** Preserve surviving tickets; repair only missing state, after invalid queued rows have been stopped. */
  repair() {
    this.db.transaction(() => {
      this.db.query('UPDATE chat_queue_state SET next_seq = MAX(next_seq, COALESCE((SELECT MAX(queue_seq) FROM turns),0), COALESCE((SELECT MAX(rr_ticket) FROM chat_queue_users),0)) WHERE id=1').run()
      const old = this.db.query("SELECT id FROM turns WHERE status='queued' AND queue_seq IS NULL ORDER BY COALESCE(queued_at,started_at),id").all() as { id: string }[]
      for (const row of old) this.db.query('UPDATE turns SET queue_seq=? WHERE id=?').run(this.next(), row.id)
      this.db.query("DELETE FROM chat_queue_users WHERE NOT EXISTS (SELECT 1 FROM turns WHERE turns.user_id=chat_queue_users.user_id AND status='queued')").run()
      const missing = this.db.query("SELECT user_id, MIN(queue_seq) AS seq FROM turns WHERE status='queued' AND user_id NOT IN (SELECT user_id FROM chat_queue_users) GROUP BY user_id ORDER BY seq,user_id").all() as { user_id: string }[]
      for (const row of missing) this.db.query('INSERT INTO chat_queue_users(user_id,rr_ticket) VALUES (?,?)').run(row.user_id, this.next())
    })()
  }
}
