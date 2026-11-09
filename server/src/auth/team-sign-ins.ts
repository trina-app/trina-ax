// Who signed a team-wide connection in with their own account, and when (team_sign_ins, migration 270): a team AI
// subscription token (engine_credentials), a Drive shared with the team, a team connection's OAuth sign-in. Written by
// the sign-in itself and cleared when that sign-in ends, so a row always means a live sign-in of that person. 팀장
// 넘기기 (admin/handover.ts) reads only this to list what the person handing the team over leaves signed in; a sign-in
// with no row (made before the record existed, or by the server itself) is unknown and never listed or ended.
import type { Database } from 'bun:sqlite'

export type SignInKind = 'team_ai' | 'drive_share' | 'team_connection'

export function recordSignIn(db: Database, kind: SignInKind, id: string, userId: string, at: string): void {
  db.query('INSERT INTO team_sign_ins (kind, target_id, user_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, target_id) DO UPDATE SET user_id = excluded.user_id, at = excluded.at').run(kind, id, userId, at)
}

export function forgetSignIn(db: Database, kind: SignInKind, id: string): void {
  db.query('DELETE FROM team_sign_ins WHERE kind = ? AND target_id = ?').run(kind, id)
}

export function signInOf(db: Database, kind: SignInKind, id: string): { userId: string; at: string } | null {
  const r = db.query('SELECT user_id, at FROM team_sign_ins WHERE kind = ? AND target_id = ?').get(kind, id) as { user_id: string; at: string } | null
  return r ? { userId: r.user_id, at: r.at } : null
}
