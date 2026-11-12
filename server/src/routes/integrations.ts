// External-service connections (contract shared/src/api/integrations.ts, docs/INTEGRATIONS.md), registered by the
// files route module (component C) after the Google Drive routes (their fixed paths win over /api/integrations/:id).
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import type { AppContextC } from '../http/env'
import { linkBase } from '../auth/accounts'
import { integrationsOf, type CallbackResult, type FlowFailure } from '../integrations/connections/service'
import { requestsOf } from '../integrations/connections/requests'
import { templatesOf } from '../integrations/connections/templates'
import { templatesSeen } from '../onboarding/member-welcome'
import type { AuthInfo } from '../services'
import { say, type TextKey } from '../integrations/connections/text'

export const INTEGRATION_CALLBACK = '/api/integrations/oauth/callback'
const CLOSE = 'window.close()'
const CLOSE_HASH = 'sha256-' + crypto.createHash('sha256').update(CLOSE).digest('base64')
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const viewer = (auth: AuthInfo) => ({ id: auth.user.id, role: auth.user.role })
/** a sign-in the service did not finish, in words (never a code, never the service's answer); one that never started
 * here (no session in this browser, a used link) says to sign in to the team account */
const FAILED_TEXT: Record<FlowFailure, TextKey> = {
  client: 'callbackClient', client_template: 'callbackClientTemplate', denied: 'callbackDenied', changed: 'callbackChanged', exchange: 'callbackExchange', invalid: 'callbackExchange', superseded: 'callbackChanged',
}

export function registerIntegrationRoutes(kit: RouteKit, ctx: AppContext) {
  const svc = () => integrationsOf(ctx)
  kit.handle(API.listIntegrations, ({ c, auth }) => svc().list(viewer(auth), c.get('locale')))
  kit.handle(API.createIntegration, ({ c, auth, body }) => svc().create(viewer(auth), body, 'personal', c.get('locale')))
  kit.handle(API.updateIntegration, ({ c, auth, params, body }) => svc().update(viewer(auth), params.id, body, c.get('locale')))
  kit.handle(API.deleteIntegration, async ({ auth, params }) => { await svc().remove(viewer(auth), params.id) })
  kit.handle(API.setIntegrationTool, ({ c, auth, params, body }) => svc().setTool(viewer(auth), params.id, body.name, body.enabled, c.get('locale')))
  kit.handle(API.refreshIntegration, ({ c, auth, params }) => svc().refresh(viewer(auth), params.id, c.get('locale')))
  kit.handle(API.authorizeIntegration, ({ c, auth, params }) => svc().authorize(viewer(auth), auth.session.id, params.id, linkBase(c, ctx), c.get('locale')))
  kit.handle(API.integrationFlow, ({ auth, params }) => svc().flow(auth.user.id, auth.session.id, params.id))
  kit.handle(API.listTeamIntegrations, ({ c, auth }) => ({ items: svc().listTeam(viewer(auth), c.get('locale')) }))
  kit.handle(API.createTeamIntegration, ({ c, auth, body }) => svc().create(viewer(auth), body, 'team', c.get('locale')))
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
  kit.raw('GET', INTEGRATION_CALLBACK, async (c) => {
    let r: CallbackResult = { ok: false, reason: null }
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    try {
      r = await svc().callback({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), iss: c.req.query('iss') },
        auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined)
    } catch {}
    const L = cc.get('locale')
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    // the only script is the one whose hash is allowed: it tries to close the window (the app watches the sign-in itself)
    c.header('Content-Security-Policy', `default-src 'none'; script-src '${CLOSE_HASH}'; frame-ancestors 'none'`)
    // static text and a same-origin link only: the code and state never go anywhere else
    return c.html(`<!doctype html><html lang="${L}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(say('callbackTitle', L))}</title>`
      + (r.ok ? `<p>${esc(say('callbackOk', L))}</p><script>${CLOSE}</script>`
        : r.reason ? `<p>${esc(say(FAILED_TEXT[r.reason], L))}</p>`
          : `<p>${esc(say('callbackFail', L))}</p><p><a href="/login" rel="noreferrer">${esc(say('callbackLogin', L))}</a></p>`), r.ok ? 200 : 400)
  })
}
