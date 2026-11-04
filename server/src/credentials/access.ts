// Who cannot use AI now ("No AI" in Admin › Members and the owner's start checklist). Owner: A. Not a second copy of
// the rules: the engines that answer a person come from admin/engine-choice.ts (the engines they may pick, else the
// team default; an engine whose program is missing here answers nobody, as in the composer), and whether one of them
// has a connection for the person comes from credentials/resolve.ts (the same candidates and checks as the turn and the
// model proxy). A connection at a provider's short limit counts as usable: that person only waits.
import type { EngineId } from '@mycel/shared/api'
import { allowedCredentialKinds, isManaged } from '../app-config'
import type { AppContext } from '../context'
import { canChooseEngine, choosableEngines, engineOn, teamDefault, type Person } from '../admin/engine-choice'
import type { EngineConfs } from '../chat/engines'
import { hasCredentialSoonFor } from './resolve'

type Ctx = Pick<AppContext, 'db' | 'config'>
export interface AccessOptions {
  now?: Date
  /** engines that cannot run here (chat/engines.ts: no engine program) */
  problems?: EngineConfs['problems']
}

/** the engines this person's chats are answered by: the ones they may pick, else the team default */
export function enginesAnswering(ctx: Ctx, p: Person, problems: EngineConfs['problems'] = {}): EngineId[] {
  const d = teamDefault(ctx).engine
  const ids = canChooseEngine(ctx, p) ? choosableEngines(ctx, p) : engineOn(ctx, d) ? [d] : []
  return ids.filter((id) => !problems[id])
}

/** Can this person use AI now (or once a short limit is over)? The API engine answers with its own key, not with an
 * AI connection. */
export function canUseAi(ctx: Ctx, p: Person, o: AccessOptions = {}, allowed = allowedCredentialKinds(ctx.config)): boolean {
  const now = o.now ?? new Date()
  return enginesAnswering(ctx, p, o.problems).some((e) => e === 'api' || hasCredentialSoonFor(ctx.db, p.id, e, allowed, now))
}

/** The ids of the active people who cannot use AI now, in the members list's order; null when this server does not
 * answer with AI connections (engine.authMode other than managed: the engines' own sign-in, which is not per person). */
export function peopleWithoutAi(ctx: Ctx, o: AccessOptions = {}): string[] | null {
  if (!isManaged(ctx.config)) return null
  const people = ctx.db.query("SELECT id, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at, id").all() as Person[]
  const allowed = allowedCredentialKinds(ctx.config)
  return people.filter((p) => !canUseAi(ctx, p, o, allowed)).map((p) => p.id)
}

/** What a person without a usable AI connection can do about it (the button in the chat error and the banner above the
 * composer, web/src/lib/aiAccess.ts). The owner connects one for the team; a member (an admin too: only the owner adds
 * team connections, credentials routes) connects their own while the team allows it; anyone else asks the owner. */
export type AiAction = 'connect_team' | 'connect_own' | 'ask_owner'
export interface AiAccess {
  /** false: nothing answers this person now (always true when engines sign in on their own, authMode other than managed) */
  usable: boolean
  action: AiAction
}
export function aiAccessFor(ctx: Ctx, p: Person, memberOwn: boolean, o: AccessOptions = {}): AiAccess {
  const usable = !isManaged(ctx.config) || canUseAi(ctx, p, o)
  const action: AiAction = p.role === 'owner' ? 'connect_team' : memberOwn ? 'connect_own' : 'ask_owner'
  return { usable, action }
}
