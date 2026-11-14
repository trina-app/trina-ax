// D1 defaults do not grant permission to sell hosted consumer-subscription access.
// Deployment allowedKinds remains a separate, stricter boundary.
import type { Database } from 'bun:sqlite'
import { PRODUCT } from '@mycel/shared'
import { guestAiOf } from './guest-ai'

export const MEMBER_OWN_KEY = 'credentials.memberOwn'
export const SHARED_SUBSCRIPTIONS_KEY = 'credentials.sharedSubscriptions'

/** Only an absent setting gets the fresh-install default. Explicit false/corrupt rows stay closed. */
export function memberOwnAllowed(db: Database): boolean {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(MEMBER_OWN_KEY) as { value: string } | null
  if (!row) return true
  try { return JSON.parse(row.value) === true } catch { return false }
}

/** May this person add and use AI connections of their own (one's own Claude or ChatGPT sign-in, one's own key)? A
 * member, admin or owner: while the team's member-own switch is on. A guest (credentials/guest-ai.ts): only when their
 * AI choice is 'own', whatever that switch says (the team chose it for this guest: docs/DECISIONS.md "Guests: only what
 * they were invited to"); never with 'none' or 'team'. */
export function personalConnectionsAllowed(db: Database, userId: string): boolean {
  const guest = guestAiOf(db, userId)
  return guest ? guest.ai === 'own' : memberOwnAllowed(db)
}

/** Only an absent setting gets the edition's fresh-install default (PRODUCT.sharedSubscriptionsDefault). An explicit
 * false or a corrupt row stays closed: the owner's choice is never overridden, and imported rows never flip it. */
export function sharedSubscriptionsAllowed(db: Database): boolean {
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(SHARED_SUBSCRIPTIONS_KEY) as { value: string } | null
  if (!row) return PRODUCT.sharedSubscriptionsDefault
  try { return JSON.parse(row.value) === true } catch { return false }
}
