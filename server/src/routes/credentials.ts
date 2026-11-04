// AI connections (contract: shared/src/api/credentials.ts), registered by the admin route module (owner A). Admins
// see the team's connections; only the owner changes them (adding and replacing a secret ask for the password again,
// the RouteKit checks it; so does "Move it to the team", which is an add with moveFrom); members manage their own
// connections while the team allows them. Request bodies are never
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
import { credentialsOf } from '../credentials/store'
import { ct } from '../credentials/i18n'
import { trialCredit } from '../credentials/hosted-chat'
import { engineStatusCache } from '../admin/engines'
import { getChatRuntime } from '../chat/runtime'

/** open composers ask GET /api/engines again (an engine may have gained or lost its last connection) */
const ENGINES_CHANGED = { type: 'notice', data: { level: 'info', code: 'engine_choice_changed', message: '' } } as const

export function registerCredentialRoutes(kit: RouteKit, ctx: AppContext) {
  const cc = () => credentialsOf(ctx)
  const loc = (c: { get(k: 'locale'): Locale }) => c.get('locale')
  const logins = () => credentialLogins(cc(), serverLoginDeps(ctx, () => {
    try { return getChatRuntime(ctx).engines.get().codex?.bin ?? null } catch { return null }
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
  kit.handle(API.trialCredit, () => ({ credit: isManaged(ctx.config) ? trialCredit(ctx.db, new Date(), cc().allowedKinds) : null }))

  // ChatGPT sign-ins (the team's: owner + password; one's own: while the team allows personal connections)
  kit.handle(API.startCredentialLogin, ({ c, body, auth }) => logins().start({ userId: auth.user.id, locale: loc(c), personal: false, label: body.label, assignments: body.assignments, priority: body.priority, reconnectId: body.reconnectId }))
  kit.handle(API.getCredentialLogin, ({ params, auth }) => logins().get(params.id, auth.user.id))
  kit.handle(API.cancelCredentialLogin, ({ params, auth }) => logins().cancel(params.id, auth.user.id))

  // ---------------- one's own connections ----------------
  const ownAllowed = (locale: Locale) => { if (!memberOwnAllowed(ctx.db)) fail('forbidden', ct('memberOwnOff', locale)) }
  kit.handle(API.myCredentials, ({ c, auth }) => ({ allowed: memberOwnAllowed(ctx.db), allowedKinds: [...cc().allowedKinds], items: myCredentials(cc(), auth.user.id, loc(c)), anthropicGateway: gateway() }))
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
    return logins().start({ userId: auth.user.id, locale: loc(c), personal: true, label: body.label, assignments: [], priority: 100, reconnectId: body.reconnectId })
  })
  kit.handle(API.getMyCredentialLogin, ({ params, auth }) => logins().get(params.id, auth.user.id))
  kit.handle(API.cancelMyCredentialLogin, ({ params, auth }) => logins().cancel(params.id, auth.user.id))
}
