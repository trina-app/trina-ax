// External-service connections (contract shared/src/api/integrations.ts, docs/INTEGRATIONS.md), registered by the
// files route module (component C) after the Google Drive routes (their fixed paths win over /api/integrations/:id).
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import type { AppContextC } from '../http/env'
import { linkBase } from '../auth/accounts'
import { backToApp, CLOSE_SCRIPT, handedPage, heldPage, returnHeaders, returnPage } from '../integrations/connections/return-page'
import { integrationsOf, MAX_PERSONAL, type CallbackResult, type FlowFailure } from '../integrations/connections/service'
import { requestsOf } from '../integrations/connections/requests'
import { templatesOf } from '../integrations/connections/templates'
import { githubAppView } from '../integrations/github/app'
import { afterTeamConnection } from '../integrations/service-requests'
import { templatesSeen } from '../onboarding/member-welcome'
import type { AuthInfo } from '../services'
import { say, type TextKey } from '../integrations/connections/text'
import { CALLBACK_PATH, CLIENT_METADATA_PATH, clientMetadata, documentOriginAt, documentOrigins } from '../integrations/connections/oauth'

export const INTEGRATION_CALLBACK = CALLBACK_PATH
const viewer = (auth: AuthInfo) => ({ id: auth.user.id, role: auth.user.role })
/** the desktop window a request came from (its x-mycel-window, from a desktop session only): where an app on the
 * person's computer is checked (integrations/connections/local.ts); null from the web or the phone app */
const desktopWindow = (c: AppContextC, auth: AuthInfo): { windowId: string; turnId: null } | null => {
  const w = c.req.header('x-mycel-window') ?? ''
  return auth.session.client === 'desktop' && /^[A-Za-z0-9_-]{8,64}$/.test(w) ? { windowId: w, turnId: null } : null
}
/** a sign-in the service did not finish, in words (never a code, never the service's answer); one this browser may not
 * finish (a used or expired link, a web or phone sign-in in a browser without the person's session) says to go back to
 * the app and press Connect again */
const FAILED_TEXT: Record<FlowFailure, TextKey> = {
  client: 'callbackClient', client_template: 'callbackClientTemplate', limit: 'callbackLimit', denied: 'callbackDenied', changed: 'callbackChanged', exchange: 'callbackExchange', invalid: 'callbackExchange', superseded: 'callbackChanged', cancelled: 'callbackCancelled',
  expired: 'callbackExpired',
}

export function registerIntegrationRoutes(kit: RouteKit, ctx: AppContext) {
  const svc = () => integrationsOf(ctx)
  kit.handle(API.listIntegrations, ({ c, auth }) => svc().list(viewer(auth), c.get('locale')))
  kit.handle(API.createIntegration, ({ c, auth, body }) => svc().create(viewer(auth), body, 'personal', c.get('locale')))
  // a team connection made or changed: members who asked for that listed service and may use it now are told (QA TC-133)
  kit.handle(API.updateIntegration, async ({ c, auth, params, body }) => { const i = await svc().update(viewer(auth), params.id, body, c.get('locale')); if (i.scope === 'team') afterTeamConnection(ctx, i.url); return i })
  kit.handle(API.deleteIntegration, async ({ auth, params }) => { await svc().remove(viewer(auth), params.id) })
  kit.handle(API.setIntegrationTool, ({ c, auth, params, body }) => svc().setTool(viewer(auth), params.id, body.name, body.enabled, c.get('locale')))
  kit.handle(API.stopAlwaysAllow, ({ c, auth, params }) => svc().stopAlwaysAllow(viewer(auth), params.id, c.get('locale')))
  kit.handle(API.refreshIntegration, ({ c, auth, params }) => svc().refresh(viewer(auth), params.id, c.get('locale'), desktopWindow(c, auth)))
  kit.handle(API.createLocalIntegration, ({ c, auth, body }) => svc().createLocal(viewer(auth), body, c.get('locale'), desktopWindow(c, auth)))
  kit.handle(API.updateLocalIntegration, ({ c, auth, params, body }) => svc().updateLocal(viewer(auth), params.id, body.spec, c.get('locale'), desktopWindow(c, auth)))
  // the desktop app's return port counts only from a desktop session (what the app said at sign-in, as for its browser
  // tools); from any other session it is dropped, whatever the body says
  kit.handle(API.authorizeIntegration, ({ c, auth, params, body }) => svc().authorize(viewer(auth), auth.session.id, params.id, linkBase(c, ctx), c.get('locale'),
    { client: auth.session.client, loopbackPort: auth.session.client === 'desktop' ? body.loopbackPort ?? null : null }))
  kit.handle(API.integrationFlow, ({ auth, params }) => svc().flow(auth.user.id, auth.session.id, params.id))
  kit.handle(API.cancelIntegrationFlow, ({ auth, params }) => { svc().cancelFlow(auth.user.id, auth.session.id, params.id) })
  kit.handle(API.listTeamIntegrations, ({ c, auth }) => ({ items: svc().listTeam(viewer(auth), c.get('locale')), github: githubAppView(ctx) }))
  kit.handle(API.createTeamIntegration, async ({ c, auth, body }) => { const i = await svc().create(viewer(auth), body, 'team', c.get('locale')); afterTeamConnection(ctx, i.url); return i })
  // an admin asks a member to connect a service as their own connection (integrations/connections/requests.ts)
  const reqs = () => requestsOf(ctx)
  kit.handle(API.listIntegrationRequests, ({ c, auth }) => ({ items: reqs().listMine(auth.user.id, linkBase(c, ctx)) }))
  kit.handle(API.getIntegrationRequest, ({ c, auth, params }) => reqs().getMine(auth.user.id, params.id, linkBase(c, ctx)))
  kit.handle(API.completeIntegrationRequest, ({ c, auth, params, body }) => reqs().complete(viewer(auth), params.id, body, c.get('locale')))
  kit.handle(API.declineIntegrationRequest, ({ c, auth, params }) => reqs().decline(viewer(auth), params.id, linkBase(c, ctx), c.get('locale')))
  kit.handle(API.listTeamIntegrationRequests, ({ c }) => ({ items: reqs().listTeam(linkBase(c, ctx)) }))
  kit.handle(API.createIntegrationRequest, ({ c, auth, body }) => reqs().create(viewer(auth), body, linkBase(c, ctx), c.get('locale')))
  kit.handle(API.withdrawIntegrationRequest, ({ c, auth, params }) => reqs().withdraw(viewer(auth), params.id, linkBase(c, ctx), c.get('locale')))
  // an admin's template: each member it is for connects it with their own key (integrations/connections/templates.ts)
  const tpl = () => templatesOf(ctx)
  kit.handle(API.listIntegrationTemplates, async ({ c, auth }) => {
    const items = await tpl().listMine(viewer(auth), c.get('locale'))
    // someone who joined lately sees the templates here: they count as offered, with no notice (onboarding/member-welcome.ts)
    templatesSeen(ctx, auth.user.id, items.filter((t) => !t.connection).map((t) => t.id))
    return { items }
  })
  kit.handle(API.connectIntegrationTemplate, ({ c, auth, params, body }) => tpl().connect(viewer(auth), params.id, body, c.get('locale')))
  kit.handle(API.listTeamIntegrationTemplates, async ({ auth }) => ({ items: await tpl().listTeam(viewer(auth)) }))
  kit.handle(API.createIntegrationTemplate, ({ c, auth, body }) => tpl().create(viewer(auth), body, c.get('locale')))
  kit.handle(API.updateIntegrationTemplate, ({ c, auth, params, body }) => tpl().update(viewer(auth), params.id, body, c.get('locale')))
  kit.handle(API.deleteIntegrationTemplate, async ({ auth, params }) => { await tpl().remove(viewer(auth), params.id) })
  kit.handle(API.listIntegrationTemplateMembers, async ({ auth, params }) => ({ items: await tpl().members(viewer(auth), params.id) }))
  // the client metadata document a service fetches when a sign-in uses its address as the client ID (oauth.ts
  // clientMetadata): public, no session. Its addresses are those of the configured public address (or the office
  // tunnel's) the service asked at, so https behind a tunnel; a host that is neither gets 404, never a document naming
  // whatever Host header came in
  kit.raw('GET', CLIENT_METADATA_PATH, (c) => {
    const origin = documentOriginAt(documentOrigins(ctx.config), c.req.header('host') ?? new URL(c.req.url).host)
    c.header('Cache-Control', 'private, max-age=300')
    if (!origin) return c.text('not found', 404)
    return c.json(clientMetadata(origin))
  })
  kit.raw('GET', INTEGRATION_CALLBACK, async (c) => {
    let r: CallbackResult = { ok: false, reason: null }
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    try {
      r = await svc().callback({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), iss: c.req.query('iss') },
        auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined)
    } catch {}
    const L = cc.get('locale')
    returnHeaders(c)
    const origin = new URL(c.req.url).origin
    const page = (o: Parameters<typeof returnPage>[1]) => returnPage(L, o)
    const back = backToApp(L, origin)
    // A desktop sign-in held for the app on this computer (service.ts hold): the shared held page (return-page.ts)
    // (docs/decisions/20261121-connect-browser-handoff.md)
    if (r.ok && r.held) return c.html(heldPage(L, origin, r.held), 200)
    if (r.ok) return c.html(page({ title: say('callbackOkTitle', L), text: say('callbackOk', L), tail: CLOSE_SCRIPT }), 200)
    // the one next step: back to the desktop app that started it, or Connectors on the web; the phone app gets words only
    // (static text and same-origin or app links only: the code and state never go anywhere else)
    const next = r.from === 'desktop' ? back : r.from === 'web' ? { href: '/settings/connectors', label: say('callbackOpenConnectors', L) } : undefined
    if (r.handed) return c.html(handedPage(L, origin), 400)
    if (r.otherAccount) return c.html(page({ title: say('callbackOtherTitle', L), text: say('callbackOtherAccount', L), cta: next }), 400)
    return c.html(page({ title: say('callbackNotTitle', L), text: r.reason ? say(FAILED_TEXT[r.reason], L, { n: MAX_PERSONAL }) : say('callbackFail', L), cta: next }), 400)
  })
}
