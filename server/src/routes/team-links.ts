// The team invite link (contract: shared/src/api/team-links.ts), registered by the admin route module (owner A). The
// admin endpoints make, show and revoke the one open link; the two public ones are what its join page calls, with the
// token in the request body (it travels in the address's #fragment, never in a path: server/src/auth/team-links.ts).
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { createTeamLink, getTeamLink, joinTeamLink, revokeTeamLink, teamLinkInfo, updateTeamLink } from '../auth/team-links'

export function registerTeamLinkRoutes(kit: RouteKit, ctx: AppContext): void {
  kit.handle(API.getTeamLink, ({ c }) => getTeamLink(c, ctx))
  kit.handle(API.createTeamLink, ({ c, body }) => createTeamLink(c, ctx, body))
  kit.handle(API.updateTeamLink, ({ c, body }) => updateTeamLink(c, ctx, body))
  kit.handle(API.revokeTeamLink, ({ c }) => revokeTeamLink(c, ctx))
  kit.handle(API.teamLinkInfo, ({ c, body }) => teamLinkInfo(c, ctx, body.token))
  kit.handle(API.joinTeamLink, ({ c, body }) => joinTeamLink(c, ctx, body))
}
