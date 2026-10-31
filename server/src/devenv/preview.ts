// Preview of a dev server in a project box (hole 3 of the review: the preview runs arbitrary code). Rules:
//  - A separate origin, never the app's: the gateway is its own listener (MYCEL_DEV_PREVIEW_LISTEN) behind a wildcard
//    host on another registrable domain (MYCEL_DEV_PREVIEW_ORIGIN, e.g. "https://*.preview.example.net"). It serves
//    no app route, and the app's cookies are never sent to it (other site) nor forwarded by it.
//  - Every link is its own origin: a random label per link (<label>.preview.example.net), so two previews cannot read
//    each other's storage.
//  - A short-lived, single-use token in the link (5 minutes); redeeming it sets a session cookie for that one origin
//    (60 minutes). Every request checks again that the person may read the project folder and that the project's
//    dev environment is in force.
//  - The gateway reaches the dev server through boxd's per-port unix socket (no host port) and sends Host: localhost
//    (Vite refuses other hosts; P0 spike section 3.5).
// Not yet: WebSocket upgrades (Vite HMR falls back to a full reload), HTTP/2.
import crypto from 'node:crypto'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { canRead } from '../chat/projects'
import { boxd } from './boxd'
import { devEnvInForce, devEnvSetting } from './setting'

export const TOKEN_TTL_MS = 5 * 60_000
export const SESSION_TTL_MS = 60 * 60_000
const COOKIE = 'mycel_pv'
const REDEEM_PATH = '/__mycel_preview'

interface Link {
  label: string; projectId: string; folderPath: string; port: number; userId: string
  token: string | null; redeemBy: number; session: string | null; until: number
}
const links = new Map<string, Link>()

/** "https://*.preview.example.net" -> parts, or null when not set or not a wildcard origin */
export function previewBase(env: Record<string, string | undefined> = process.env): { scheme: 'http' | 'https'; suffix: string; port: string } | null {
  const m = /^(https?):\/\/\*\.([a-z0-9.-]+)(?::(\d+))?\/?$/i.exec(env.MYCEL_DEV_PREVIEW_ORIGIN ?? '')
  return m ? { scheme: m[1]!.toLowerCase() as 'http' | 'https', suffix: m[2]!.toLowerCase(), port: m[3] ?? '' } : null
}

/** the last two labels (no public suffix list: the setup note asks for a domain of its own, this catches mistakes) */
const site = (host: string) => host.toLowerCase().replace(/:\d+$/, '').split('.').slice(-2).join('.')
export function sameSite(a: string, b: string) { return site(a) === site(b) }

const rand = (n: number) => crypto.randomBytes(n).toString('hex')
const eq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function issuePreview(ctx: AppContext, o: { projectId: string; folderPath: string; port: number; userId: string; appHost?: string | null }, now = Date.now()): { url: string; expiresAt: string } | { error: 'not_configured' | 'same_site' } {
  const base = previewBase()
  if (!base) return { error: 'not_configured' }
  if (o.appHost && sameSite(o.appHost, base.suffix)) return { error: 'same_site' }
  for (const [k, l] of links) if (l.until < now && l.redeemBy < now) links.delete(k)
  const label = rand(10), token = rand(24)
  links.set(label, { label, projectId: o.projectId, folderPath: o.folderPath, port: o.port, userId: o.userId, token, redeemBy: now + TOKEN_TTL_MS, session: null, until: 0 })
  audit(ctx.db, { actor: o.userId, action: 'dev_env.preview', target: o.projectId, detail: { port: o.port, label } })
  const host = `${label}.${base.suffix}${base.port ? ':' + base.port : ''}`
  return { url: `${base.scheme}://${host}${REDEEM_PATH}?t=${token}`, expiresAt: new Date(now + TOKEN_TTL_MS).toISOString() }
}

function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return v.join('=')
  }
  return null
}
const withoutOurCookie = (h: string | null) => (h ?? '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith(COOKIE + '=')).join('; ')

const deny = (status: number, msg: string) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })

/** the person may still see this preview: active, can read the folder, dev environment in force */
function stillAllowed(ctx: AppContext, l: Link): boolean {
  if (!devEnvInForce(devEnvSetting(ctx.db, l.projectId))) return false
  const p = ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(l.projectId) as { folder_path: string } | null
  if (!p || p.folder_path !== l.folderPath) return false
  try { return canRead(ctx.files, ctx.files.principal(l.userId), l.folderPath) } catch { return false }
}

export type PreviewUpstream = (socket: string, req: Request) => Promise<Response>
/** the request as the dev server gets it: Host localhost, without our cookie and forwarding headers */
function upstreamRequest(req: Request, url: URL): Request {
  const headers = new Headers(req.headers)
  headers.set('host', 'localhost')
  const c = withoutOurCookie(req.headers.get('cookie'))
  if (c) headers.set('cookie', c); else headers.delete('cookie')
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded']) headers.delete(h)
  return new Request(`http://localhost${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body, redirect: 'manual' })
}
const fetchUpstream: PreviewUpstream = (socket, req) =>
  fetch(req, { unix: socket, redirect: 'manual', signal: AbortSignal.timeout(120_000) } as RequestInit)

/** The gateway's request handler (the separate listener). */
export async function previewFetch(ctx: AppContext, req: Request, upstream: PreviewUpstream = fetchUpstream, now = Date.now()): Promise<Response> {
  const base = previewBase()
  if (!base) return deny(404, 'not found')
  const url = new URL(req.url)
  const host = (req.headers.get('host') ?? url.host).toLowerCase().replace(/:\d+$/, '')
  if (!host.endsWith('.' + base.suffix)) return deny(404, 'not found')
  const label = host.slice(0, -(base.suffix.length + 1))
  const l = /^[0-9a-f]{20}$/.test(label) ? links.get(label) : undefined
  if (!l) return deny(404, 'This preview link is not valid. Open a new one from the project.')
  const secure = base.scheme === 'https'
  if (url.pathname === REDEEM_PATH) {
    const t = url.searchParams.get('t') ?? ''
    if (!l.token || l.redeemBy < now || !eq(t, l.token)) return deny(403, 'This preview link has expired. Open a new one from the project.')
    if (!stillAllowed(ctx, l)) return deny(403, 'You cannot open this preview.')
    l.token = null // single use
    l.session = rand(24); l.until = now + SESSION_TTL_MS
    const cookie = `${COOKIE}=${l.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
  }
  const c = cookieOf(req)
  if (!l.session || !c || !eq(c, l.session) || l.until < now) return deny(403, 'This preview session has ended. Open a new preview link from the project.')
  if (!stillAllowed(ctx, l)) return deny(403, 'You cannot open this preview.')
  if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return deny(501, 'WebSocket is not supported by the preview yet.')
  const client = boxd()
  if (!client) return deny(503, 'The dev environment is not set up on this server.')
  const s = await client.preview(l.projectId, l.port)
  if (!s.ok) return deny(502, 'The box does not run. Start the dev server from the chat first.')
  let r: Response
  try { r = await upstream(s.value.socket, upstreamRequest(req, url)) } catch { return deny(502, `Nothing answers on port ${l.port} in the box.`) }
  const headers = new Headers(r.headers)
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-robots-tag', 'noindex')
  // the dev app may set its own cookies on this origin, never ours
  const set = r.headers.getSetCookie?.() ?? []
  headers.delete('set-cookie')
  for (const v of set) if (!v.trim().startsWith(COOKIE + '=')) headers.append('set-cookie', v)
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers })
}

/** Start the gateway listener (dev environment flag on and MYCEL_DEV_PREVIEW_LISTEN = host:port). */
export function startPreviewGateway(ctx: AppContext, env: Record<string, string | undefined> = process.env): { stop(): void } | null {
  const m = /^([0-9a-zA-Z.:[\]-]+):(\d+)$/.exec(env.MYCEL_DEV_PREVIEW_LISTEN ?? '')
  if (!m || !previewBase(env)) return null
  const server = Bun.serve({ hostname: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]), fetch: (req) => previewFetch(ctx, req) })
  ctx.log.info('dev env preview gateway listening', { listen: env.MYCEL_DEV_PREVIEW_LISTEN })
  return { stop: () => server.stop(true) }
}

/** tests */
export function _previewLinks() { return links }
