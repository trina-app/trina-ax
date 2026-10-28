// Signing in at an MCP server (MCP authorization): protected-resource metadata (RFC 9728, from WWW-Authenticate or the
// well-known address), authorization-server metadata (RFC 8414, OpenID Connect discovery as fallback), dynamic client
// registration (RFC 7591), authorization code with PKCE S256 and the resource indicator (RFC 8707), refresh and
// revocation (RFC 7009). Every request goes through net.ts (public https only, no redirects, size and time limits).
import { PRODUCT } from '@mycel/shared'
import { jsonRequest, NetError, type NetOptions } from './net'

export interface OAuthServer { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; revocationEndpoint: string | null }
export interface OAuthClient { clientId: string; clientSecret: string | null; authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'; redirectUri: string }
export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null }
/** what a connection keeps (encrypted) once signed in */
export interface OAuthSecret { type: 'oauth'; server: OAuthServer; client: OAuthClient; resource: string; scope: string | null; tokens: OAuthTokens }

export class GrantError extends Error { name = 'GrantError' }

const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2000) return null
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash ? u.href : null } catch { return null }
}
const trimSlash = (s: string) => s.replace(/\/+$/, '')

/** The resource indicator of an MCP address: scheme, host and path, no query, no lone "/". */
export function canonicalResource(url: string): string {
  const u = new URL(url)
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`
}

/** `Bearer resource_metadata="…", scope="…"` -> its parameters */
export function wwwAuthenticate(h: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of h.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
  return out
}

const get = async (url: string, net: NetOptions) => {
  try {
    const r = await jsonRequest(url, { method: 'GET', headers: [['Accept', 'application/json']] }, net)
    return r.status === 200 ? r.json : null
  } catch (e) { if (e instanceof NetError && (e.reason === 'timeout' || e.reason === 'tls')) throw e; return null }
}

/** Where to sign in for the MCP server at `mcpUrl`. Throws NetError('oauth_unsupported') when it offers no usable sign-in. */
export async function discover(mcpUrl: string, net: NetOptions, header = ''): Promise<{ server: OAuthServer; resource: string; scope: string | null }> {
  const u = new URL(mcpUrl)
  const h = wwwAuthenticate(header)
  const candidates = [httpsUrl(h.resource_metadata), `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`]
  let prm: Record<string, any> | null = null
  for (const c of [...new Set(candidates.filter((x): x is string => !!x))]) if ((prm = await get(c, net))) break
  let resource = canonicalResource(mcpUrl)
  let issuer = u.origin
  if (prm) {
    const r = httpsUrl(prm.resource)
    if (r) {
      // the metadata must describe this server (its address or one above it on the same host)
      const ru = new URL(r)
      if (ru.origin !== u.origin || !(u.pathname === ru.pathname || u.pathname.startsWith(trimSlash(ru.pathname) + '/') || ru.pathname === '/')) throw new NetError('oauth_unsupported')
      resource = canonicalResource(r)
    }
    const as = Array.isArray(prm.authorization_servers) ? httpsUrl(prm.authorization_servers[0]) : null
    if (as) issuer = trimSlash(as)
  }
  const iu = new URL(issuer)
  const p = iu.pathname === '/' ? '' : trimSlash(iu.pathname)
  const metaUrls = p
    ? [`${iu.origin}/.well-known/oauth-authorization-server${p}`, `${iu.origin}/.well-known/openid-configuration${p}`, `${iu.origin}${p}/.well-known/openid-configuration`]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`]
  let meta: Record<string, any> | null = null
  for (const m of metaUrls) if ((meta = await get(m, net))) break
  if (!meta) throw new NetError('oauth_unsupported')
  if (typeof meta.issuer === 'string' && trimSlash(meta.issuer) !== trimSlash(issuer)) throw new NetError('oauth_unsupported')
  const methods = meta.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) throw new NetError('oauth_unsupported')
  if (Array.isArray(meta.response_types_supported) && !meta.response_types_supported.includes('code')) throw new NetError('oauth_unsupported')
  const authorizationEndpoint = httpsUrl(meta.authorization_endpoint), tokenEndpoint = httpsUrl(meta.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) throw new NetError('oauth_unsupported')
  const scopes = h.scope || (Array.isArray(prm?.scopes_supported) ? prm!.scopes_supported.filter((s: unknown) => typeof s === 'string').join(' ') : '')
  return {
    server: { issuer: trimSlash(issuer), authorizationEndpoint, tokenEndpoint, registrationEndpoint: httpsUrl(meta.registration_endpoint), revocationEndpoint: httpsUrl(meta.revocation_endpoint) },
    resource, scope: scopes && scopes.length <= 2000 ? scopes : null,
  }
}

/** Dynamic client registration for our callback address. */
export async function register(server: OAuthServer, redirectUri: string, net: NetOptions): Promise<OAuthClient> {
  if (!server.registrationEndpoint) throw new NetError('oauth_unsupported')
  const body = { client_name: PRODUCT.displayName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  const r = await jsonRequest(server.registrationEndpoint, { method: 'POST', headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']], body: Buffer.from(JSON.stringify(body)) }, net)
  const j = r.json
  if ((r.status !== 200 && r.status !== 201) || !j || typeof j.client_id !== 'string' || !j.client_id || j.client_id.length > 1000) throw new NetError('oauth_unsupported')
  const secret = typeof j.client_secret === 'string' && j.client_secret && j.client_secret.length <= 4000 ? j.client_secret : null
  const method = secret ? (j.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic') : 'none'
  return { clientId: j.client_id, clientSecret: secret, authMethod: method, redirectUri }
}

export function authorizationUrl(s: { server: OAuthServer; client: OAuthClient; resource: string; scope: string | null }, state: string, challenge: string): string {
  const u = new URL(s.server.authorizationEndpoint)
  const p: Record<string, string> = { response_type: 'code', client_id: s.client.clientId, redirect_uri: s.client.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', resource: s.resource }
  if (s.scope) p.scope = s.scope
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
  return u.href
}

function withClient(client: OAuthClient, fields: Record<string, string>): { headers: [string, string][]; body: Buffer } {
  const headers: [string, string][] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']]
  const f = { ...fields }
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')])
  } else {
    f.client_id = client.clientId
    if (client.authMethod === 'client_secret_post' && client.clientSecret) f.client_secret = client.clientSecret
  }
  return { headers, body: Buffer.from(new URLSearchParams(f).toString()) }
}

/** The token endpoint: tokens, or GrantError for invalid_grant (sign in again). */
export async function tokenRequest(s: { server: OAuthServer; client: OAuthClient }, fields: Record<string, string>, net: NetOptions, now: number, previous?: OAuthTokens): Promise<OAuthTokens> {
  const r = await jsonRequest(s.server.tokenEndpoint, { method: 'POST', ...withClient(s.client, fields) }, net)
  const j = r.json
  if (r.status !== 200 || !j) {
    if (j?.error === 'invalid_grant' || j?.error === 'invalid_client' || j?.error === 'unauthorized_client') throw new GrantError(String(j.error))
    throw new NetError('oauth_failed')
  }
  const access = j.access_token, refresh = typeof j.refresh_token === 'string' ? j.refresh_token : previous?.refreshToken ?? null
  if (typeof access !== 'string' || !access || access.length > 16_384 || (refresh && refresh.length > 16_384)) throw new NetError('oauth_failed')
  if (typeof j.token_type === 'string' && j.token_type.toLowerCase() !== 'bearer') throw new NetError('oauth_failed')
  const exp = typeof j.expires_in === 'number' && Number.isFinite(j.expires_in) && j.expires_in > 0 ? Math.min(j.expires_in, 31_536_000) : null
  return { accessToken: access, refreshToken: refresh, expiresAt: exp ? now + exp * 1000 : null }
}

/** RFC 7009, best effort: true when the server said 200. */
export async function revoke(s: { server: OAuthServer; client: OAuthClient }, token: string, hint: 'refresh_token' | 'access_token', net: NetOptions): Promise<boolean> {
  if (!s.server.revocationEndpoint) return false
  try {
    const r = await jsonRequest(s.server.revocationEndpoint, { method: 'POST', ...withClient(s.client, { token, token_type_hint: hint }) }, net)
    return r.status === 200
  } catch { return false }
}
