// External-service connections (contract shared/src/api/integrations.ts, docs/INTEGRATIONS.md), registered by the
// files route module (component C) after the Google Drive routes (their fixed paths win over /api/integrations/:id).
import crypto from 'node:crypto'
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import type { AppContextC } from '../http/env'
import { linkBase } from '../auth/accounts'
import { integrationsOf } from '../integrations/connections/service'
import type { AuthInfo } from '../services'
import { say } from '../integrations/connections/text'

export const INTEGRATION_CALLBACK = '/api/integrations/oauth/callback'
const CLOSE = 'window.close()'
const CLOSE_HASH = 'sha256-' + crypto.createHash('sha256').update(CLOSE).digest('base64')
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const viewer = (auth: AuthInfo) => ({ id: auth.user.id, role: auth.user.role })

export function registerIntegrationRoutes(kit: RouteKit, ctx: AppContext) {
  const svc = () => integrationsOf(ctx)
  kit.handle(API.listIntegrations, ({ c, auth }) => svc().list(viewer(auth), c.get('locale')))
  kit.handle(API.createIntegration, ({ c, auth, body }) => svc().create(viewer(auth), body, 'personal', c.get('locale')))
  kit.handle(API.updateIntegration, ({ c, auth, params, body }) => svc().update(viewer(auth), params.id, body, c.get('locale')))
  kit.handle(API.deleteIntegration, async ({ auth, params }) => { await svc().remove(viewer(auth), params.id) })
  kit.handle(API.refreshIntegration, ({ c, auth, params }) => svc().refresh(viewer(auth), params.id, c.get('locale')))
  kit.handle(API.authorizeIntegration, ({ c, auth, params }) => svc().authorize(viewer(auth), auth.session.id, params.id, linkBase(c, ctx), c.get('locale')))
  kit.handle(API.integrationFlow, ({ auth, params }) => svc().flow(auth.user.id, auth.session.id, params.id))
  kit.handle(API.listTeamIntegrations, ({ c, auth }) => ({ items: svc().listTeam(viewer(auth), c.get('locale')) }))
  kit.handle(API.createTeamIntegration, ({ c, auth, body }) => svc().create(viewer(auth), body, 'team', c.get('locale')))
  kit.raw('GET', INTEGRATION_CALLBACK, async (c) => {
    let ok = false
    const cc = c as unknown as AppContextC
    const auth = cc.get('auth')
    try {
      ok = await svc().callback({ state: c.req.query('state'), code: c.req.query('code'), error: c.req.query('error'), iss: c.req.query('iss') },
        auth ? { userId: auth.user.id, sessionId: auth.session.id } : undefined)
    } catch {}
    const L = cc.get('locale')
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    // the only script is the one whose hash is allowed: it tries to close the window (the app watches the sign-in itself)
    c.header('Content-Security-Policy', `default-src 'none'; script-src '${CLOSE_HASH}'; frame-ancestors 'none'`)
    // static text and a same-origin link only: the code and state never go anywhere else
    return c.html(`<!doctype html><html lang="${L}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(say('callbackTitle', L))}</title>`
      + (ok ? `<p>${esc(say('callbackOk', L))}</p><script>${CLOSE}</script>`
        : `<p>${esc(say('callbackFail', L))}</p><p><a href="/login" rel="noreferrer">${esc(say('callbackLogin', L))}</a></p>`), ok ? 200 : 400)
  })
}
