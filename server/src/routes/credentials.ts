// AI connections (contract: shared/src/api/credentials.ts), registered by the admin route module (owner A). The owner
// and admins change the team's connections alike (adding and replacing a secret, and starting a sign-in, ask the
// person for their own password again: auth 'admin-reauth', the RouteKit checks it; so does "Move it to the team",
// which is an add with moveFrom); an admin's change is told to the owner (credentials/store.ts noticeOwners). Members
// manage their own connections while the team allows them (/api/me/credentials). Request bodies are never
// written to the audit log here (credentials/service.ts writes field names, kinds, labels, hints only).
import { API, type Locale } from '@mycel/shared/api'
import { anthropicGateway, gatewayLabel, isManaged } from '../app-config'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import type { RouteKit } from '../http/route'
import { credentialLogins, serverLoginDeps } from '../credentials/login'
import { PRICES_AS_OF } from '../credentials/prices'
import { memberOwnAllowed } from '../credentials/resolve'
import { sharedSubscriptionsAllowed } from '../credentials/policy'
import {
  checkCredential, createCredential, deleteCredential, listCredentials, myCredentials, replaceSecret, setCredentialSettings, unsealOrFail, updateCredential,
} from '../credentials/service'
import { admins, credentialsOf } from '../credentials/store'
import { ct } from '../credentials/i18n'
import { trialCredit } from '../credentials/hosted-chat'
import { engineStatusCache } from '../admin/engines'
import { aiAccessFor } from '../credentials/access'
import { notificationsOf } from '../notifications/service'
import { getChatRuntime } from '../chat/runtime'

/** open composers ask GET /api/engines again (an engine may have gained or lost its last connection) */
const ENGINES_CHANGED = { type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } } as const

export function registerCredentialRoutes(kit: RouteKit, ctx: AppContext) {
  const cc = () => credentialsOf(ctx)
  const loc = (c: { get(k: 'locale'): Locale }) => c.get('locale')
  // the CLI each sign-in runs: the server's own Codex / Claude Code (the launcher allows only those files)
  const logins = () => credentialLogins(cc(), serverLoginDeps(ctx, (kind) => {
    try { const e = getChatRuntime(ctx).engines.get(); return (kind === 'chatgpt' ? e.codex?.bin : e.claude?.bin) ?? null } catch { return null }
  }))
  const changed = () => {
    const cache = engineStatusCache(ctx)
    cache.forget('claude-code'); cache.forget('codex')
    ctx.services.realtime.publishEach(() => ENGINES_CHANGED)
  }

  // the add dialog takes the gateway's key format and names the gateway (engine.anthropicGateway; never its address)
  const gateway = () => { const g = anthropicGateway(ctx.config); return g ? { label: gatewayLabel(g) } : null }
  kit.handle(API.listCredentials, ({ c }) => ({ items: listCredentials(cc(), loc(c)), memberOwn: memberOwnAllowed(ctx.db), sharedSubscriptions: sharedSubscriptionsAllowed(ctx.db), allowedKinds: [...cc().allowedKinds], pricesAsOf: PRICES_AS_OF, anthropicGateway: gateway() }))
  kit.handle(API.createCredential, async ({ c, body, auth }) => {
    const secret = await unsealOrFail(cc(), body.sealed, 'credential.create', loc(c))
    const r = await createCredential(cc(), { kind: body.kind, label: body.label, secret, assignments: body.assignments, priority: body.priority, ownerUserId: null, actor: auth.user.id, acknowledgedPlanNotice: body.acknowledgedPlanNotice, moveFrom: body.moveFrom }, loc(c))
    changed()
    return r
  })
  kit.handle(API.updateCredential, ({ c, params, body, auth }) => {
    const r = updateCredential(cc(), params.id, body, auth.user.id, loc(c))
    changed()
    return r
  })
  kit.handle(API.replaceCredentialSecret, async ({ c, params, body, auth }) => {
    const secret = await unsealOrFail(cc(), body.sealed, 'credential.replace', loc(c))
    const r = await replaceSecret(cc(), params.id, secret, auth.user.id, loc(c))
    changed()
    return r
  })
  kit.handle(API.deleteCredential, ({ params, auth }) => { deleteCredential(cc(), params.id, auth.user.id); changed() })
  kit.handle(API.checkCredential, async ({ c, params, auth }) => {
    const r = await checkCredential(cc(), params.id, auth.user.id, loc(c))
    changed()
    return r
  })
  kit.handle(API.updateCredentialSettings, ({ c, body, auth }) => {
    const result = setCredentialSettings(cc(), body, auth.user.id, loc(c))
    changed()
    return result
  })
  kit.handle(API.sealingKey, () => cc().sealer.publicKey())
  // the hosting service's trial AI credit (credentials/hosted-chat.ts): Admin › AI connections and the start goal card.
  // Only turns that answer with AI connections (managed mode) ever use it.
  kit.handle(API.trialCredit, () => ({ credit: isManaged(ctx.config) ? trialCredit(ctx.db, new Date()) : null }))

  // ChatGPT and Claude sign-ins (the team's: owner or admin + their password; one's own: while the team allows personal connections).
  // The Claude code: only from the person who started that sign-in (404 for anyone else, before it is opened), sealed
  // like a token (its own purpose)
  const submitCode = async (id: string, userId: string, sealed: Parameters<typeof unsealOrFail>[1], locale: Locale) => {
    logins().get(id, userId)
    const code = await unsealOrFail(cc(), sealed, 'credential.login-code', locale)
    return logins().submitCode(id, userId, code, locale)
  }
  kit.handle(API.startCredentialLogin, ({ c, body, auth }) => logins().start({ userId: auth.user.id, locale: loc(c), personal: false, kind: body.kind, label: body.label, assignments: body.assignments, priority: body.priority, reconnectId: body.reconnectId }))
  kit.handle(API.getCredentialLogin, ({ params, auth }) => logins().get(params.id, auth.user.id))
  kit.handle(API.cancelCredentialLogin, ({ c, params, auth }) => logins().cancel(params.id, auth.user.id, loc(c)))
  kit.handle(API.submitCredentialLoginCode, ({ c, params, body, auth }) => submitCode(params.id, auth.user.id, body.sealed, loc(c)))

  // ---------------- one's own connections ----------------
  const ownAllowed = (locale: Locale) => { if (!memberOwnAllowed(ctx.db)) fail('forbidden', ct('memberOwnOff', locale)) }
  kit.handle(API.myCredentials, ({ c, auth }) => ({ allowed: memberOwnAllowed(ctx.db), allowedKinds: [...cc().allowedKinds], items: myCredentials(cc(), auth.user.id, loc(c)), anthropicGateway: gateway() }))
  // onboarding: the person's way out of "no AI" (credentials/access.ts aiAccessFor) and the one request to the owner(s) and admins
  const accessOf = (auth: { user: { id: string; role: string } }) => {
    const person = { id: auth.user.id, role: auth.user.role }
    return { person, ...aiAccessFor(ctx, person, memberOwnAllowed(ctx.db)) }
  }
  kit.handle(API.getAiAccess, ({ auth }) => {
    const { usable, action, trial } = accessOf(auth)
    return { usable, action, requested: notificationsOf(ctx).aiRequested(auth.user.id), ...(trial ? { trial } : {}) }
  })
  kit.handle(API.requestAiAccess, ({ c, auth }) => {
    const { person, usable } = accessOf(auth)
    if (person.role === 'owner' || person.role === 'admin' || usable) fail('forbidden', ct('aiRequestNotNeeded', loc(c)))
    const n = notificationsOf(ctx)
    if (n.aiRequested(person.id)) return { requested: true as const, already: true }
    // the owner(s) and the admins: all of them can connect the team's AI
    for (const id of admins(ctx.db)) n.onboardingAiRequest(id, person.id)
    return { requested: true as const, already: false }
  })
  kit.handle(API.createMyCredential, async ({ c, body, auth }) => {
    ownAllowed(loc(c))
    const secret = await unsealOrFail(cc(), body.sealed, 'credential.create', loc(c))
    const r = await createCredential(cc(), { kind: body.kind, label: body.label, secret, assignments: [], priority: 100, ownerUserId: auth.user.id, actor: auth.user.id, acknowledgedPlanNotice: body.acknowledgedPlanNotice }, loc(c))
    changed()
    return r
  })
  kit.handle(API.deleteMyCredential, ({ params, auth }) => { deleteCredential(cc(), params.id, auth.user.id, auth.user.id); changed() })
  kit.handle(API.startMyCredentialLogin, ({ c, body, auth }) => {
    ownAllowed(loc(c))
    return logins().start({ userId: auth.user.id, locale: loc(c), personal: true, kind: body.kind, label: body.label, assignments: [], priority: 100, reconnectId: body.reconnectId })
  })
  kit.handle(API.getMyCredentialLogin, ({ params, auth }) => logins().get(params.id, auth.user.id))
  kit.handle(API.cancelMyCredentialLogin, ({ c, params, auth }) => logins().cancel(params.id, auth.user.id, loc(c)))
  kit.handle(API.submitMyCredentialLoginCode, ({ c, params, body, auth }) => submitCode(params.id, auth.user.id, body.sealed, loc(c)))
}
