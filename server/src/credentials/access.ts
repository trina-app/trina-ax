// Who cannot use AI now ("No AI" in Admin › Members and the owner's start checklist). Owner: A. Not a second copy of
// the rules: the engines that answer a person come from admin/engine-choice.ts (the engines they may pick, else the
// team default), and whether one of them has a connection for the person comes from credentials/resolve.ts (the same
// candidates and checks as the turn and the model proxy). A connection at a provider's short limit counts as usable:
// that person only waits.
import type { EngineId } from '@mycel/shared/api'
import { allowedCredentialKinds, isManaged } from '../app-config'
import type { AppContext } from '../context'
import { canChooseEngine, choosableEngines, engineOn, teamDefault, type Person } from '../admin/engine-choice'
import { hasCredentialSoonFor } from './resolve'

type Ctx = Pick<AppContext, 'db' | 'config'>

/** the engines this person's chats are answered by: the ones they may pick, else the team default */
export function enginesAnswering(ctx: Ctx, p: Person): EngineId[] {
  if (canChooseEngine(ctx, p)) return choosableEngines(ctx, p)
  const d = teamDefault(ctx).engine
  return engineOn(ctx, d) ? [d] : []
}

/** Can this person use AI now (or once a short limit is over)? The API engine answers with its own key, not with an
 * AI connection. */
export function canUseAi(ctx: Ctx, p: Person, now = new Date(), allowed = allowedCredentialKinds(ctx.config)): boolean {
  return enginesAnswering(ctx, p).some((e) => e === 'api' || hasCredentialSoonFor(ctx.db, p.id, e, allowed, now))
}

/** The ids of the active people who cannot use AI now, in the members list's order; null when this server does not
 * answer with AI connections (engine.authMode other than managed: the engines' own sign-in, which is not per person). */
export function peopleWithoutAi(ctx: Ctx, now = new Date()): string[] | null {
  if (!isManaged(ctx.config)) return null
  const people = ctx.db.query("SELECT id, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at, id").all() as Person[]
  const allowed = allowedCredentialKinds(ctx.config)
  return people.filter((p) => !canUseAi(ctx, p, now, allowed)).map((p) => p.id)
}
