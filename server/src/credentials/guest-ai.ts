// How a guest's AI runs (docs/DECISIONS.md "Guests: only what they were invited to"; migration 122_a_guests.sql). Read
// straight from the guests row, never from engine_credential_assignments: one assignment row would turn a team-wide
// connection into an assigned-only one and every member would lose it (credentials/resolve.ts candidates).
//   none (default): no connection at all.
//   own:  only the guest's own personal connection (whatever the team's member-own switch says: the team chose it).
//   team: only guests.team_credential_id, while it is still a team connection (no owner) and while the guest has a
//         'user' budget with action 'block' (the usage limit the invite set). Never group or team-wide connections.
// A guest never uses the hosting service's trial credit, the API engine (the team's key), or, on a server that is not
// managed (engines on the host's own sign-in), any AI at all.
import type { Database } from 'bun:sqlite'

export interface GuestAiRow { ai: 'none' | 'team' | 'own'; teamCredentialId: string | null }

/** The guest's AI settings, or null when `userId` is not a guest. A guest flag without a guests row reads 'none'. */
export function guestAiOf(db: Database, userId: string): GuestAiRow | null {
  let flag: { guest: number } | null = null
  try { flag = db.query('SELECT guest FROM users WHERE id = ?').get(userId) as { guest: number } | null } catch { return null }
  if (!flag || flag.guest !== 1) return null
  const r = db.query('SELECT ai, team_credential_id FROM guests WHERE user_id = ?').get(userId) as { ai: GuestAiRow['ai']; team_credential_id: string | null } | null
  return r ? { ai: r.ai, teamCredentialId: r.team_credential_id } : { ai: 'none', teamCredentialId: null }
}

export const isGuestUser = (db: Database, userId: string): boolean => guestAiOf(db, userId) !== null

/** The guest's own usage limit is set: a 'user' budget with action 'block'. */
export function guestHasBlockBudget(db: Database, userId: string): boolean {
  return !!db.query("SELECT 1 FROM budgets WHERE subject_type = 'user' AND subject_id = ? AND action = 'block'").get(userId)
}
