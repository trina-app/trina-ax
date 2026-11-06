// Who cannot use AI now ("No AI" in Admin › Members and the owner's start checklist). Owner: A. Not a second copy of
// the rules: the engines that answer a person come from admin/engine-choice.ts (the engines they may pick, else the
// team default; an engine whose program is missing here answers nobody, as in the composer), and whether one of them
// has a connection for the person comes from credentials/resolve.ts (the same candidates and checks as the turn and the
// model proxy). A connection at a provider's short limit counts as usable: that person only waits; a longer limit is
// "No AI" with the time it ends (withoutAi `until`).
import type { EngineId } from '@mycel/shared/api'
import { allowedCredentialKinds, isManaged, type AllowedKinds } from '../app-config'
import type { AppContext } from '../context'
import { canChooseEngine, choosableEngines, engineOn, teamDefault, type Person } from '../admin/engine-choice'
import type { EngineConfs } from '../chat/engines'
import { credentialBackAt, hasCredentialSoonFor, resolveCredential, type CredEngine } from './resolve'
import { hostedChatState } from './hosted-chat'
import { memberOwnAllowed } from './policy'

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
 * AI connection. On a server that holds the hosting service's trial credit, a Claude Code or Codex turn that its own
 * engine cannot answer may go to the other engine or to the credit (connectionRoute, the same rule as chat/turn.ts), so
 * such an engine counts as usable then. */
export function canUseAi(ctx: Ctx, p: Person, o: AccessOptions = {}, allowed = allowedCredentialKinds(ctx.config)): boolean {
  const now = o.now ?? new Date()
  return enginesAnswering(ctx, p, o.problems).some((e) => e === 'api' || hasCredentialSoonFor(ctx.db, p.id, e, allowed, now)
    || (isManaged(ctx.config) && connectionRoute(ctx, p, e, { now, problems: o.problems, allowed }) !== 'own'))
}

const OTHER: Record<CredEngine, CredEngine> = { 'claude-code': 'codex', codex: 'claude-code' }
/**
 * Where a Claude Code or Codex turn of this person goes on a server that holds the hosting service's trial credit
 * (credentials/hosted-chat.ts, docs/DECISIONS.md "Z"). The team's own AI always comes first, the credit last:
 *   'own'      its engine has a connection that works now; or one only at a limit while the other engine has one (the
 *              usual wait, or the admin's "Claude 한도에 닿으면 Codex로 넘기기"); or nothing answers (the usual errors)
 *   the other  its engine has no connection that works, the other of the two has one and is on here: that one answers
 *              (a team that connected only ChatGPT gets its Claude Code chats answered by Codex, not by the credit)
 *   'trial'    no connection of the person works on either engine and the credit is active
 * A server without a trial credit always gets 'own' (unchanged). Managed servers only (the caller checks).
 */
export function connectionRoute(ctx: Ctx, p: { id: string }, engine: CredEngine, o: { now?: Date; problems?: EngineConfs['problems']; allowed?: AllowedKinds } = {}): 'own' | 'trial' | CredEngine {
  const now = o.now ?? new Date()
  const state = hostedChatState(ctx.db, now)
  if (!state) return 'own'
  const allowedKinds = o.allowed ?? allowedCredentialKinds(ctx.config)
  const own = resolveCredential(ctx.db, { userId: p.id, engine, allowedKinds, now })
  if (own.ok) return 'own'
  const other = OTHER[engine]
  if (engineOn(ctx, other) && !o.problems?.[other] && resolveCredential(ctx.db, { userId: p.id, engine: other, allowedKinds, now }).ok) {
    return own.skipped.some((s) => s.why === 'limited') ? 'own' : other
  }
  return state === 'active' ? 'trial' : 'own'
}

/**
 * What AI a person who joins through the team link would have (docs/DECISIONS.md "W5": the invite message says
 * "본인 AI 계정이 필요해요" for `connect_own`): `ready` when a team connection for everyone or for one of the link's
 * groups answers the engines a new member gets, the API engine or the hosting service's active trial credit answers
 * them, or the server does not answer with AI connections; else `connect_own` while the team allows personal
 * connections, `ask_owner` when it does not. The same candidates as a turn (credentials/resolve.ts), for someone with
 * no account yet.
 */
export function newMemberAi(ctx: Ctx, groups: readonly string[], o: AccessOptions = {}): 'ready' | 'connect_own' | 'ask_owner' {
  if (!isManaged(ctx.config)) return 'ready'
  const now = o.now ?? new Date()
  const allowed = allowedCredentialKinds(ctx.config)
  const p: Person = { id: '\u0000new-person', role: 'member' }
  const engines = enginesAnswering(ctx, p, o.problems)
  const ready = engines.some((e) => e === 'api' || hasCredentialSoonFor(ctx.db, p.id, e, allowed, now, groups))
    || (engines.some((e) => e !== 'api') && hostedChatState(ctx.db, now) === 'active')
  if (ready) return 'ready'
  return memberOwnAllowed(ctx.db) ? 'connect_own' : 'ask_owner'
}

/** The ids of the active people who cannot use AI now, in the members list's order; null when this server does not
 * answer with AI connections (engine.authMode other than managed: the engines' own sign-in, which is not per person). */
export function peopleWithoutAi(ctx: Ctx, o: AccessOptions = {}): string[] | null {
  return withoutAi(ctx, o)?.ids ?? null
}

/**
 * peopleWithoutAi, and for those of them whom waiting alone brings AI back, when (ISO): the earliest time a connection
 * of theirs works again on any engine that answers them (credentials/resolve.ts credentialBackAt: a provider's limit
 * that is not "out of credit", or the monthly block limit). Someone with nothing a wait fixes (no connection, switched
 * off, refused, expired, out of credit) is in `ids` only. Admin › Members "AI limit until …".
 */
export function withoutAi(ctx: Ctx, o: AccessOptions = {}): { ids: string[]; until: Record<string, string> } | null {
  if (!isManaged(ctx.config)) return null
  const people = ctx.db.query("SELECT id, role FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY created_at, id").all() as Person[]
  const allowed = allowedCredentialKinds(ctx.config)
  const now = o.now ?? new Date()
  const ids: string[] = []
  const until: Record<string, string> = {}
  for (const p of people) {
    if (canUseAi(ctx, p, { ...o, now }, allowed)) continue
    ids.push(p.id)
    // the API engine answers with its own key (canUseAi would have said yes), so only Claude Code and Codex are left
    const back = enginesAnswering(ctx, p, o.problems).filter((e): e is CredEngine => e !== 'api')
      .map((e) => credentialBackAt(ctx.db, p.id, e, allowed, now)).filter((t): t is string => t !== null).sort()[0]
    if (back) until[p.id] = back
  }
  return { ids, until }
}

/** What a person without a usable AI connection can do about it (the button in the chat error and the banner above the
 * composer, web/src/lib/aiAccess.ts). The owner connects one for the team; a member (an admin too: only the owner adds
 * team connections, credentials routes) connects their own while the team allows it; anyone else asks the owner. */
export type AiAction = 'connect_team' | 'connect_own' | 'ask_owner'
export interface AiAccess {
  /** false: nothing answers this person now (always true when engines sign in on their own, authMode other than managed) */
  usable: boolean
  action: AiAction
  /** not usable, Claude Code or Codex answers this person, and the hosting service's trial AI credit
   * (credentials/hosted-chat.ts), which answered while it was active, is used up or over: what the person is told first */
  trial?: 'used' | 'ended'
}
export function aiAccessFor(ctx: Ctx, p: Person, memberOwn: boolean, o: AccessOptions = {}): AiAccess {
  const usable = !isManaged(ctx.config) || canUseAi(ctx, p, o)
  const action: AiAction = p.role === 'owner' ? 'connect_team' : memberOwn ? 'connect_own' : 'ask_owner'
  if (usable || !enginesAnswering(ctx, p, o.problems).some((e) => e !== 'api')) return { usable, action }
  const trial = hostedChatState(ctx.db, o.now ?? new Date())
  return trial === 'used' || trial === 'ended' ? { usable, action, trial } : { usable, action }
}
