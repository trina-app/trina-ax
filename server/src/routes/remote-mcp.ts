import { REMOTE_MCP } from '@mycel/shared/api'
import type { Context } from 'hono'
import type { RouteModule } from './module'
import { remoteOAuthOf } from '../connectors/remote-mcp/oauth'
import { OAuthError } from '../connectors/remote-mcp/policy'
import { json, mcpRequest, noStore, oauthBody, oauthError, uniqueParams } from '../connectors/remote-mcp/transport'
import { fail } from '../http/errors'
import { linkUpload } from '../connectors/remote-mcp/upload-link'
import type { AppContextC } from '../http/env'

const EXPIRED_LINK_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link expired</title></head>'
  + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;line-height:1.5">'
  + '<p>This connection link has expired. Start the connection again from Claude or ChatGPT.</p></body></html>'

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
    kit.handle(REMOTE_MCP.decideRemoteConnectorConsent, ({ auth, params, body }) => browser(() => oauth().decide(params.id, auth, body.allow, { write: body.write, rooms: body.rooms, roomsWrite: body.roomsWrite })))
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
        const target = oauth().authorize(uniqueParams(new URL(c.req.url).searchParams), ip(c))
        return new Response(null, { status: 302, headers: { ...noStore, location: target } })
      } catch (e) {
        // a person's browser lands here: an unknown or removed app gets a page to read, not an OAuth error body
        if (e instanceof OAuthError && e.code === 'invalid_client') return new Response(EXPIRED_LINK_PAGE, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', ...noStore, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } })
        return oauthError(e)
      }
    })
    kit.raw('POST', '/oauth/token', async c => {
      try {
        // the body (16 KiB at most) first: a live code or refresh token is not counted with anonymous traffic
        const body = await oauthBody(c.req.raw)
        const live = oauth().liveCredential(body)
        oauth().ingress('token', ip(c), { shared: !live })
        try { return json(oauth().token(body, live)) } catch (e) { if (live) oauth().chargeShared(); throw e }
      } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/oauth/revoke', async c => {
      try { oauth().ingress('revoke', ip(c)); oauth().revoke(await oauthBody(c.req.raw)); return new Response(null, { status: 200, headers: noStore }) } catch (e) { return oauthError(e) }
    })
    kit.raw('POST', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
    kit.raw('GET', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
    kit.raw('DELETE', '/mcp', c => mcpRequest(ctx, c.req.raw, ip(c)))
    // One-time upload links from create_upload_link (outside /api: the token is the auth, no cookie or CSRF header).
    kit.raw('PUT', '/connector-uploads/:token', c => linkUpload(ctx, c.req.raw, c.req.param('token') ?? '', ip(c)))
  },
}
