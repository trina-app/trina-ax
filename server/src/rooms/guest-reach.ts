// Rooms and guests (docs/DECISIONS.md "Guests: only what they were invited to"): who a guest may reach in rooms, and
// switching a guest off when they leave their one place (a group chat). The rules live in auth/guests.ts.
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { isGuest, placePeople } from '../auth/guests'

/** The DM's two people still share a place when either is a guest (a DM never counts as one). */
export function dmPairOk(db: Database, roomKind: string, dmKey: string | null): boolean {
  if (roomKind !== 'dm' || !dmKey) return true
  const [a, b] = dmKey.split('|') as [string, string]
  const ga = isGuest(db, a), gb = isGuest(db, b)
  if (!ga && !gb) return true
  if (ga && !placePeople(db, a).has(b)) return false
  if (gb && !placePeople(db, b).has(a)) return false
  return true
}

/** After people went out of a group chat: each guest among them who is now in no place is switched off
 * (admin/guests.ts disableGuestIfPlaceless; required lazily: admin/users imports this module's service). Never throws. */
export function afterGuestsLeft(ctx: AppContext, ids: Iterable<string>, actorId: string | null): void {
  const guests = [...new Set(ids)].filter((id) => isGuest(ctx.db, id))
  if (!guests.length) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { disableGuestIfPlaceless } = require('../admin/guests') as typeof import('../admin/guests')
    for (const id of guests) disableGuestIfPlaceless(ctx, id, actorId)
  } catch (e) { ctx.log.warn('guest switch-off after leaving failed', { err: e }) }
}
