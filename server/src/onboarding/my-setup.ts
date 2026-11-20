// "My setup" for the team's owner (docs/decisions/20261120-my-setup-card.md): the personal card on Home that invited
// people get (member-welcome.ts) is made for the owner when the team setup reaches its end screen (welcome.ts
// updateWelcome). Its own module, so the welcome steps need no import of the card's code (that one reads the steps).
import type { AppContext } from '../context'

/**
 * The team setup just ended for its owner: their own card, its 14 days from now (`setup = 1`, migration 428; no
 * inviter, via 'invite' since the CHECK has no other value and only 'admin' is read elsewhere). A row already there
 * (an owner who joined with a lead invite and was handed the team, a second end) is kept as it is. Never throws: the
 * setup is done whatever happens here.
 */
export function startMySetup(ctx: Pick<AppContext, 'db' | 'log'>, userId: string, now = new Date().toISOString()): void {
  try {
    const owner = ctx.db.query("SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND deleted_at IS NULL").get(userId)
    if (!owner) return
    ctx.db.query("INSERT OR IGNORE INTO member_welcome (user_id, invited_by, via, joined_at, setup) VALUES (?, NULL, 'invite', ?, 1)").run(userId, now)
  } catch (e) { ctx.log.warn('the owner\'s setup card was not made', { err: e }) }
}
