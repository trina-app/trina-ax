// "My setup" for the team's owner (docs/decisions/20261120-my-setup-card.md): the personal card on Home that invited
// people get (member-welcome.ts) is made for the owner when the team setup ends: its end screen (welcome.ts
// updateWelcome, recordShared) or ✕ on the steps once it held (endHeldDismissal). Owners whose setup ended before this
// existed get it on their next Home read while the 14 days from that end last (member-welcome.ts welcomeAnswer).
// Its own module, so the welcome steps need no import of the card's code (that one reads the steps).
import type { AppContext } from '../context'

/**
 * The team setup ended for its owner at `at`: their own card, its 14 days from then (`setup = 1`, migration 428; no
 * inviter, via 'invite' since the CHECK has no other value). Like a member's row, it holds the owner's connection
 * template notices for the templates already there until they open Connected apps or its days are over
 * (notifications/service.ts offerTemplates). An owner card already there (a second end) is kept as it is. A member's row
 * of theirs (a lead who joined with a lead invite and was handed the team: hidden at the handover) becomes the owner's
 * card, fresh. Never throws: the setup is done whatever happens here.
 */
export function startMySetup(ctx: Pick<AppContext, 'db' | 'log'>, userId: string, at = new Date().toISOString()): void {
  try {
    const owner = ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND deleted_at IS NULL").get(userId)
    if (!owner) return
    ctx.db.query(`INSERT INTO member_welcome (user_id, invited_by, via, joined_at, setup) VALUES (?, NULL, 'invite', ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET setup = 1, invited_by = NULL, joined_at = excluded.joined_at, hidden_at = NULL, asked_at = NULL, done_at = NULL, tools_at = NULL, apps_seen_at = NULL
      WHERE member_welcome.setup = 0`).run(userId, at)
  } catch (e) { ctx.log.warn('the owner\'s setup card was not made', { err: e }) }
}
