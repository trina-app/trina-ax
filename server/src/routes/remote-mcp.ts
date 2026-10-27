import { REMOTE_MCP } from '@mycel/shared/api'
import type { Context } from 'hono'
import type { RouteModule } from './module'
import { remoteOAuthOf } from '../connectors/remote-mcp/oauth'
import { OAuthError } from '../connectors/remote-mcp/policy'
import { json, mcpRequest, noStore, oauthBody, oauthError, uniqueParams } from '../connectors/remote-mcp/transport'
import { fail } from '../http/errors'
import type { AppContextC } from '../http/env'

function browser<T>(fn: () => T): T {
  try { return fn() } catch (e) {
    if (e instanceof OAuthError) return fail(e.status === 404 ? 'not_found' : e.status === 403 ? 'forbidden' : e.status === 503 ? 'unavailable' : e.status === 429 ? 'rate_limited' : 'bad_request')
    throw e
  }
}
export const remoteMcpRoutes: RouteModule = {
  name: 'remote-mcp', owner: 'A',
  register(kit, ctx) {
    const oauth = () => remoteOAuthOf(ctx)
    const ip = (c: Context) => (c as unknown as AppContextC).get('info').ip
    kit.handle(REMOTE_MCP.getRemoteConnectorConsent, ({ auth, params }) => browser(() => oauth().consent(params.id, auth)))
    kit.handle(REMOTE_MCP.decideRemoteConnectorConsent, ({ auth, params, body }) => browser(() => oauth().decide(params.id, auth, body.allow)))
    kit.handle(REMOTE_MCP.listRemoteConnectors, ({ auth }) => browser(() => oauth().connections(auth)))
    kit.handle(REMOTE_MCP.revokeRemoteConnector, ({ auth, params }) => browser(() => oauth().disconnect(params.id, auth)))
    const resourceMetadata = (c: Context) => {
      try { oauth().ingress('metadata', ip(c)); return json(oauth().protectedMetadata()) } catch (e) { return oauthError(e) }
    }
    kit.raw('GET', '/.well-known/oauth-protected-resource', resourceMetadata)
    kit.raw('GET', '/.well-known/oauth-protected-resource/mcp', resourceMetadata)
    kit.raw('GET', '/.well-known/oauth-authorization-server', c => {
      try { oauth().ingress('metadata', ip(c)); return json(oauth().metadata()) } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/oauth/register', async c => {
      try { oauth().ingress('register', ip(c)); return json(oauth().register(await oauthBody(c.req.raw, true)), 201) } catch (e) { return oauthError(e) }
    })
    kit.raw('GET', '/oauth/authorize', c => {
      try {
        oauth().ingress('authorize', ip(c))
        if (c.req.url.length > 8192) throw new OAuthError('invalid_request')
        const target = oauth().authorize(uniqueParams(new URL(c.req.url).searchParams))
        return new Response(null, { status: 302, headers: { ...noStore, location: target } })
      } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/oauth/token', async c => {
      try { oauth().ingress('token', ip(c)); return json(oauth().token(await oauthBody(c.req.raw))) } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/oauth/revoke', async c => {
      try { oauth().ingress('revoke', ip(c)); oauth().revoke(await oauthBody(c.req.raw)); return new Response(null, { status: 200, headers: noStore }) } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
    kit.raw('GET', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
    kit.raw('DELETE', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
  },
}
