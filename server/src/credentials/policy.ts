// D1 defaults do not grant permission to sell hosted consumer-subscription access.
// Deployment allowedKinds remains a separate, stricter boundary.
import type { Database } from 'bun:sqlite'
import { getSetting } from '../admin/settings'

export const MEMBER_OWN_KEY = 'credentials.memberOwn'
export const SHARED_SUBSCRIPTIONS_KEY = 'credentials.sharedSubscriptions'

/** Only an absent setting gets the fresh-install default. Explicit false/corrupt rows stay closed. */
export function memberOwnAllowed(db: Database): boolean {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(MEMBER_OWN_KEY) as { value: string } | null
  if (!row) return true
  try { return JSON.parse(row.value) === true } catch { return false }
}

/** Existing/migrated team subscription rows never imply the customer's consent to sharing. */
export const sharedSubscriptionsAllowed = (db: Database): boolean => getSetting<unknown>(db, SHARED_SUBSCRIPTIONS_KEY) === true
