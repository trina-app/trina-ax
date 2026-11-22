// The Google accounts people connected to sign in with (migration 131_a_login_identities.sql, auth/google-login.ts).
// Apart from the sign-in code so the password resets (accounts.ts completeReset, admin/users.ts resetPassword) can drop
// them without loading it.
import type { Database } from 'bun:sqlite'

/** Forget every Google account that signs this person in; the number removed. An admin's temporary password and a
 * completed reset link call it: a reset after a suspected break-in locks the old ways in out, Google included
 * (docs/decisions/20261122-google-login-identity.md). */
export function forgetLoginIdentities(db: Database, userId: string): number {
  return db.query('DELETE FROM login_identities WHERE user_id = ?').run(userId).changes
}
