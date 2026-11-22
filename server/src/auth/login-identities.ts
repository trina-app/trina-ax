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

/** The people who connected a Google account (Admin › Members' "Google"; part A2): ids only. */
export function googleConnectedUsers(db: Database): string[] {
  return (db.query("SELECT user_id FROM login_identities WHERE provider = 'google' ORDER BY user_id").all() as { user_id: string }[]).map((r) => r.user_id)
}

/** The address of the Google account this person signs in with, for `login_hint` on the Google address of their own
 * Google Drive and Google apps in direct mode (part A2: Google skips its account picker), else null. Google only uses
 * it to pick the account: a hint, never a check, and never logged. A plain address only (the row keeps what Google said
 * at the last sign-in). */
export function googleLoginHint(db: Database, userId: string): string | null {
  const r = db.query("SELECT email FROM login_identities WHERE user_id = ? AND provider = 'google'").get(userId) as { email: string | null } | null
  const email = r?.email?.trim()
  return email && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}
