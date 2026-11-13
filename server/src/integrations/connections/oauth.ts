// Signing in at an MCP server (MCP authorization): protected-resource metadata (RFC 9728, from WWW-Authenticate or the
// well-known address), authorization-server metadata (RFC 8414, OpenID Connect discovery as fallback), dynamic client
// registration (RFC 7591), authorization code with PKCE S256 and the resource indicator (RFC 8707), refresh and
// revocation (RFC 7009). Every request goes through net.ts (public https only, no redirects, size and time limits).
// A service that does not register apps (Google's MCP servers, an HTTP API such as NAVER WORKS) is signed in at with
// the person's or team's own app instead (ownClient), at the addresses found here or given with the app (manualServer).
// A service that refuses the app registered for itself (it lets only apps it approved sign in: Canva's callback list,
// Figma's catalog, Vercel's allowlist) may take a Client ID Metadata Document instead (MCP authorization 2025-11-25,
// draft-ietf-oauth-client-id-metadata-document): the client ID is the address of a document this server publishes
// (clientMetadata, metadataClient). preflight opens the sign-in address once to see a clear refusal before the browser does.
import { PRODUCT } from '@mycel/shared'
import { checkHostName } from '../../tools/web-fetch'
import { jsonRequest, NetError, serviceRequest, type NetOptions } from './net'

/** issuer: null when the addresses were given with an own app instead of found (an answer's "iss" is then checked
 * against the sign-in address's server, issuerMatches) */
export interface OAuthServer { issuer: string | null; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; revocationEndpoint: string | null }
export interface OAuthClient { clientId: string; clientSecret: string | null; authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'; redirectUri: string }
export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null }
/** what a connection keeps (encrypted) once signed in. resource: the MCP server's resource indicator (RFC 8707); null
 * for an HTTP API, which has none. */
export interface OAuthSecret { type: 'oauth'; server: OAuthServer; client: OAuthClient; resource: string | null; scope: string | null; tokens: OAuthTokens }
/** your own app at the service, as stored (docs/INTEGRATIONS.md "Your own app"). foundTokenUrl: the token address the
 * first sign-in that worked found from the server, where its secret may go (service.ts pinFound). clientSecret: null
 * also when the stored one was entered for another address of the connection (store.ts secretHere) */
export interface OwnClient {
  clientId: string; clientSecret: string | null; authorizationUrl: string | null; tokenUrl: string | null; scope: string | null; foundTokenUrl: string | null
  /** the stored values it was read from (pinFound writes only onto these), and the version of the row that holds them
   * (a template's: a sign-in through it finishes only on the template as it was when it started) */
  stored: { json: string; enc: string | null; version: number }
}

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

/** Where to sign in for the MCP server at `mcpUrl`. Throws NetError('oauth_unsupported') when it offers no usable sign-in.
 * `authMethods`: how the token endpoint takes a client secret (token_endpoint_auth_methods_supported), when it says. */
export async function discover(mcpUrl: string, net: NetOptions, header = ''): Promise<{ server: OAuthServer; resource: string; scope: string | null; authMethods: string[] | null; metadataClients: boolean }> {
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
  const authMethods = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.filter((m: unknown): m is string => typeof m === 'string') : null
  const methods = meta.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) throw new NetError('oauth_unsupported')
  if (Array.isArray(meta.response_types_supported) && !meta.response_types_supported.includes('code')) throw new NetError('oauth_unsupported')
  const authorizationEndpoint = httpsUrl(meta.authorization_endpoint), tokenEndpoint = httpsUrl(meta.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) throw new NetError('oauth_unsupported')
  const scopes = h.scope || (Array.isArray(prm?.scopes_supported) ? prm!.scopes_supported.filter((s: unknown) => typeof s === 'string').join(' ') : '')
  return {
    server: { issuer: trimSlash(issuer), authorizationEndpoint, tokenEndpoint, registrationEndpoint: httpsUrl(meta.registration_endpoint), revocationEndpoint: httpsUrl(meta.revocation_endpoint) },
    resource, scope: scopes && scopes.length <= 2000 ? scopes : null, authMethods,
    // the server takes a client ID that is the address of a client metadata document (metadataClient)
    metadataClients: meta.client_id_metadata_document_supported === true,
  }
}

/** RFC 9207: does an authorization answer's `iss` name the server the sign-in started at? Found addresses: the issuer
 * found. Given addresses (no issuer known): the sign-in address's own server, by origin (an issuer may have a path,
 * such as a tenant's). */
export function issuerMatches(iss: string, server: Pick<OAuthServer, 'issuer' | 'authorizationEndpoint'>): boolean {
  if (server.issuer) return trimSlash(iss) === server.issuer
  try { return new URL(iss).origin === new URL(server.authorizationEndpoint).origin } catch { return false }
}

/** The sign-in and token addresses given with an own app (an HTTP API, or an MCP server whose addresses are not found). */
export function manualServer(c: Pick<OwnClient, 'authorizationUrl' | 'tokenUrl'>): OAuthServer {
  const authorizationEndpoint = httpsUrl(c.authorizationUrl), tokenEndpoint = httpsUrl(c.tokenUrl)
  if (!authorizationEndpoint || !tokenEndpoint) throw new NetError('oauth_unsupported')
  return { issuer: null, authorizationEndpoint, tokenEndpoint, registrationEndpoint: null, revocationEndpoint: null }
}

/** Your own app as the client of a sign-in. A secret goes in the token request's body (client_secret_post: what Google,
 * NAVER WORKS and most services take) unless the service says it takes only HTTP basic. */
export function ownClient(c: Pick<OwnClient, 'clientId' | 'clientSecret'>, redirectUri: string, authMethods: string[] | null = null): OAuthClient {
  if (!c.clientSecret) return { clientId: c.clientId, clientSecret: null, authMethod: 'none', redirectUri }
  const basicOnly = !!authMethods?.length && !authMethods.includes('client_secret_post') && authMethods.includes('client_secret_basic')
  return { clientId: c.clientId, clientSecret: c.clientSecret, authMethod: basicOnly ? 'client_secret_basic' : 'client_secret_post', redirectUri }
}

/** Sign-in parameters some services need besides the standard ones. Google hands out a refresh token only with
 * access_type=offline, and again for an account that consented before only with prompt=consent; without one the person
 * would sign in again every hour. */
function extraParams(authorizationEndpoint: string): Record<string, string> {
  return new URL(authorizationEndpoint).origin === 'https://accounts.google.com' ? { access_type: 'offline', prompt: 'consent' } : {}
}

/** Dynamic client registration for our callback address. A server without it needs an own app (ownClient) or takes a
 * metadata document (metadataClient). A refusal of this app (400 or 403: Figma's 403 for apps outside its catalog,
 * Vercel's and Square's 400 for a callback not on their list, Railway's 403 "registration is disabled"; or any 4xx
 * whose error is invalid_redirect_uri or invalid_client_metadata) is `oauth_approved_apps_only`; 429 (too many
 * registrations now) is `oauth_busy`; anything else stays `oauth_unsupported`. */
export async function register(server: OAuthServer, redirectUri: string, net: NetOptions): Promise<OAuthClient> {
  if (!server.registrationEndpoint) throw new NetError('oauth_no_registration')
  const body = { client_name: PRODUCT.displayName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  const r = await jsonRequest(server.registrationEndpoint, { method: 'POST', headers: [['Content-Type', 'application/json'], ['Accept', 'application/json']], body: Buffer.from(JSON.stringify(body)) }, net)
  const j = r.json
  if (r.status === 429) throw new NetError('oauth_busy', r.status)
  if (r.status === 400 || r.status === 403 || (r.status >= 400 && r.status < 500 && REFUSED_APP.has(String(j?.error)))) throw new NetError('oauth_approved_apps_only', r.status)
  if ((r.status !== 200 && r.status !== 201) || !j || typeof j.client_id !== 'string' || !j.client_id || j.client_id.length > 1000) throw new NetError('oauth_unsupported')
  const secret = typeof j.client_secret === 'string' && j.client_secret && j.client_secret.length <= 4000 ? j.client_secret : null
  const method = secret ? (j.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic') : 'none'
  return { clientId: j.client_id, clientSecret: secret, authMethod: method, redirectUri }
}

/** registration errors that refuse this app itself (RFC 7591 section 3.2.2) */
const REFUSED_APP = new Set(['invalid_redirect_uri', 'invalid_client_metadata'])

/** Where this server publishes its client metadata document (served by routes/integrations.ts). */
export const CLIENT_METADATA_PATH = '/api/integrations/oauth/client-metadata.json'
export const CALLBACK_PATH = '/api/integrations/oauth/callback'

/** Whether a service can fetch a document from this origin: https on a public name (not localhost, an IP address, a
 * single label or a local network name). Office mode and local development sign in without one. */
export function publicOrigin(origin: string): boolean {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return !/^[\d.]+$/.test(host) && !host.includes(':') && !checkHostName(host)
  } catch { return false }
}

/** The client metadata document for `origin` (draft-ietf-oauth-client-id-metadata-document section 3): its client ID is
 * its own address; a public client (no secret) that signs in with the authorization code and refreshes. */
export function clientMetadata(origin: string) {
  return {
    client_id: new URL(CLIENT_METADATA_PATH, origin).href,
    client_name: PRODUCT.displayName,
    redirect_uris: [new URL(CALLBACK_PATH, origin).href],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/** The client a sign-in uses with a metadata document: the document's address as the client ID, no secret. Stored with
 * the connection like a registered client, so the token exchange and refreshes send the same client ID. */
export function metadataClient(origin: string): OAuthClient {
  const m = clientMetadata(origin)
  return { clientId: m.client_id, clientSecret: null, authMethod: 'none', redirectUri: m.redirect_uris[0]! }
}

/** how long the sign-in address may take to answer the preflight (it lets the sign-in through after that) */
export const PREFLIGHT_MS = 5000
/** how much of the sign-in page's answer is read for its words (cut before any pattern runs on it) */
const PAGE_WORDS_MAX = 4096
/** a 4xx page about the request's redirect address or client ("Invalid redirect URI.", "invalid_client", "Unknown
 * client", "client_id is not allowed") */
const CLIENT_WORDS = /redirect[\s_-]?ur[il]|(invalid|unknown|unauthori[sz]ed|unregistered)[\s_-]client|client[\s_-]?id/i
/** a page's words without its scripts, styles and tags (a script's "clientId" says nothing about the request). The text
 * is cut first and every pattern is bounded, so a hostile page (64 KB of "<" with no ">") costs no more than a few ms. */
export const pageWords = (body: string) => body.slice(0, PAGE_WORDS_MAX)
  .replace(/<(script|style)\b[^]{0,4096}?<\/\1\s{0,8}>/gi, ' ').replace(/<[^>]{0,1000}>/g, ' ')

/** What the sign-in page said to the preflight: `pass` (go on), `refused` (a clear refusal of the app: a 4xx about the
 * redirect address or the client, Canva's 400 "Invalid redirect URI."), or `unclear` (a plain 400 that names neither:
 * a refusal only where another client can be offered, never a reason to stop on its own). */
export type Preflight = 'pass' | 'refused' | 'unclear'

/** Opens the sign-in address once, as the person's browser would, without following a redirect. A sign-in page (2xx), a
 * redirect to one (3xx), a bot challenge (Cloudflare's 403), another 4xx that names neither the redirect address nor
 * the client, a 5xx, a slow answer or a network error all `pass`: the browser may well get through where this request
 * did not. */
export async function preflight(authorizationUrl: string, net: NetOptions): Promise<Preflight> {
  let r
  try {
    r = await serviceRequest(authorizationUrl, { method: 'GET', headers: [['Accept', 'text/html,application/json;q=0.9,*/*;q=0.8']], maxBytes: 64 * 1024 }, { ...net, timeoutMs: Math.min(net.timeoutMs ?? PREFLIGHT_MS, PREFLIGHT_MS) })
  } catch { return 'pass' }
  if (r.status < 400 || r.status >= 500) return 'pass'
  const text = r.body.subarray(0, PAGE_WORDS_MAX).toString('utf8')
  if (r.headers['cf-mitigated'] === 'challenge' || /challenge-platform|cf-chl-|Just a moment\.\.\./.test(text)) return 'pass'
  if (CLIENT_WORDS.test(pageWords(text))) return 'refused'
  return r.status === 400 ? 'unclear' : 'pass'
}

/** registration answers after which a metadata document is offered instead (the service refused this app, or has no
 * registration at all) */
const FALLBACK = new Set(['oauth_approved_apps_only', 'oauth_no_registration'])

/** The client a sign-in without an own app uses: `again` (the app registered for the same server before), else one
 * registered now (RFC 7591), so services that take it sign in as they always did. Its sign-in address (`urlFor`) is
 * opened once first (preflight); a stored app the page refuses is followed by one fresh registration. When the service
 * refuses the registered app (the registration with a 400 or 403, the sign-in page clearly, or no registration at all)
 * and it takes a client metadata document, that document's address is the client instead, when `origin` is one a
 * service can fetch from (publicOrigin). Without a document, only a clear refusal stops the sign-in: a plain 400 lets
 * it go on. Throws NetError: `oauth_approved_apps_only` when the service refused every client it was offered, or the
 * registration's own reason (`oauth_no_registration`, `oauth_busy`, `oauth_unsupported`). */
export async function chooseClient(setup: { server: OAuthServer; metadataClients?: boolean }, origin: string, redirectUri: string, net: NetOptions, urlFor: (c: OAuthClient) => string, again: OAuthClient | null = null): Promise<OAuthClient> {
  const metadata = !!setup.metadataClients && publicOrigin(origin) && new URL(CALLBACK_PATH, origin).href === redirectUri
  let refusedBy: OAuthClient | null = null
  for (const stored of again ? [true, false] : [false]) {
    let c: OAuthClient
    if (stored) c = again!
    else {
      try { c = await register(setup.server, redirectUri, net) } catch (e) {
        if (!metadata || !(e instanceof NetError) || !FALLBACK.has(e.reason)) throw e
        break
      }
    }
    const p = await preflight(urlFor(c), net)
    if (p === 'pass' || (p === 'unclear' && !metadata)) return c
    refusedBy = c
  }
  if (!metadata) throw new NetError('oauth_approved_apps_only')
  const doc = metadataClient(origin)
  if (refusedBy?.clientId === doc.clientId || (await preflight(urlFor(doc), net)) !== 'pass') throw new NetError('oauth_approved_apps_only')
  return doc
}

export function authorizationUrl(s: { server: OAuthServer; client: OAuthClient; resource: string | null; scope: string | null }, state: string, challenge: string): string {
  const u = new URL(s.server.authorizationEndpoint)
  const p: Record<string, string> = { ...extraParams(s.server.authorizationEndpoint), response_type: 'code', client_id: s.client.clientId, redirect_uri: s.client.redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }
  if (s.resource) p.resource = s.resource
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
  // a number, or a number written as text (NAVER WORKS sends "86400")
  const life = typeof j.expires_in === 'string' && /^\d{1,9}$/.test(j.expires_in) ? Number(j.expires_in) : j.expires_in
  const exp = typeof life === 'number' && Number.isFinite(life) && life > 0 ? Math.min(life, 31_536_000) : null
  return { accessToken: access, refreshToken: refresh, expiresAt: exp ? now + exp * 1000 : null }
}

/** RFC 7009, best effort: true when the server said 200. A client secret goes only to the token address's own server:
 * a revocation address elsewhere (metadata can name any) is not told, so the secret never goes where sign-in did not. */
export async function revoke(s: { server: OAuthServer; client: OAuthClient }, token: string, hint: 'refresh_token' | 'access_token', net: NetOptions): Promise<boolean> {
  if (!s.server.revocationEndpoint) return false
  if (s.client.clientSecret && new URL(s.server.revocationEndpoint).origin !== new URL(s.server.tokenEndpoint).origin) return false
  try {
    const r = await jsonRequest(s.server.revocationEndpoint, { method: 'POST', ...withClient(s.client, { token, token_type_hint: hint }) }, net)
    return r.status === 200
  } catch { return false }
}
