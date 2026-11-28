// Route module "chrome" — owner: component B (docs/WORKPLAN.md). The AI's browser in the person's own Chrome
// (docs/decisions/20261128-trina-in-chrome.md). Implements: CHROME (shared/src/api/chrome.ts) and the extension's
// WebSocket CHROME_WS_PATH (off contract, like /api/ws). Logic: chrome/store.ts (codes, links), chrome/links.ts (live
// connections), realtime/browser-relay.ts (calls).
import type { ServerWebSocket } from 'bun'
import { API, BrowserUploadTicket, CHROME_WS_PATH, CHROME_WS_PROTOCOL, type ChromeLink } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import type { AppContextC } from '../http/env'
import { getChatRuntime } from '../chat/runtime'
import { audit } from '../admin/audit'
import { authOf } from '../auth/service'
import { tokenGuard } from '../auth/accounts'
import { getTeamSettings } from '../admin/settings'
import { isGuestUser } from '../credentials/guest-ai'
import { bunConn, type ConnHooks } from './ws'
import { chromeWindowOf } from '../chrome/links'
import { addLinkSite, browserTarget, linkByToken, linkOf, linkSites, linksOf, mintCode, redeemCode, removeLinkSite, setBrowserTarget, unlink, updateLink, type LinkRow } from '../chrome/store'
import { siteToKeep } from '@mycel/shared/web-site'
import { coversTeam, teamHosts } from '../chrome/team-hosts'

interface WsData {
  events: {
    onOpen?(evt: Event, ws: { raw: ServerWebSocket<WsData> }): void
    onMessage?(evt: MessageEvent, ws: { raw: ServerWebSocket<WsData> }): void
    onClose?(evt: CloseEvent, ws: { raw: ServerWebSocket<WsData> }): void
  }
  url: URL
  protocol: string
}

/** codes a person makes per 15 minutes (each Connect press on the team page) */
const pairKey = (userId: string) => ({ kind: 'app-code' as const, id: `chrome:${userId}` })

export const chromeRoutes: RouteModule = {
  name: 'chrome',
  owner: 'B',
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)

    const view = (l: LinkRow): ChromeLink => ({
      id: l.id, label: l.label, createdAt: l.created_at, lastSeenAt: l.last_seen_at, online: rt.chrome.online(l.id), version: l.version,
      sites: linkSites(ctx.db, l.id), onlyListed: l.only_listed === 1,
    })
    kit.handle(API.chromeLinks, ({ auth }) => ({ links: linksOf(ctx.db, auth.user.id).map(view), target: browserTarget(ctx.db, auth.user.id) }))

    // a profile's name and site rules: only the person's own profile; every change is audited
    kit.handle(API.chromeUpdateLink, ({ c, auth, params, body }) => {
      if (!linkOf(ctx.db, auth.user.id, params.id)) fail('not_found')
      // a site as the site card keeps one (a registrable domain), never a public suffix or the team's own address
      let site: string | null = null
      if (body.addSite) {
        site = siteToKeep(body.addSite)
        if (!site || coversTeam(ctx, site, [new URL(c.req.url).hostname])) fail('validation', undefined, { fields: { addSite: 'not a site that can be allowed' } })
      }
      updateLink(ctx.db, auth.user.id, params.id, { label: body.label, onlyListed: body.onlyListed })
      if (site) addLinkSite(ctx.db, params.id, site)
      if (body.removeSite) removeLinkSite(ctx.db, params.id, body.removeSite)
      audit(ctx.db, { actor: auth.user.id, action: 'chrome.link_update', target: params.id, detail: { ...(body.label !== undefined ? { label: true } : {}), ...(body.onlyListed !== undefined ? { onlyListed: body.onlyListed } : {}), ...(body.addSite ? { addSite: body.addSite } : {}), ...(body.removeSite ? { removeSite: body.removeSite } : {}) } })
      return view(linkOf(ctx.db, auth.user.id, params.id)!)
    })

    kit.handle(API.chromeUnlink, ({ auth, params }) => {
      if (!unlink(ctx.db, auth.user.id, params.id)) fail('not_found')
      rt.chrome.drop(params.id)
      audit(ctx.db, { actor: auth.user.id, action: 'chrome.unlink', target: params.id })
    })

    kit.handle(API.chromeTarget, ({ auth, body }) => {
      setBrowserTarget(ctx.db, auth.user.id, body.target)
    })

    // the signed-in team page in that Chrome (web /connect-chrome): the person's own browser session only, never an app's
    // or a script's bearer token, and never a guest
    kit.handle(API.chromePair, ({ c, auth, body }) => {
      if (auth.via !== 'cookie') fail('forbidden')
      if (isGuestUser(ctx.db, auth.user.id)) fail('forbidden')
      const hold = authOf(ctx).limiter.hold([pairKey(auth.user.id)])
      if (hold.wait > 0) fail('rate_limited', undefined, { retryAfter: hold.wait })
      const made = mintCode(ctx.db, auth.user.id, body.challenge)
      audit(ctx.db, { actor: auth.user.id, action: 'chrome.pair_code', target: auth.user.id, detail: { ip: c.get('info').ip, expiresAt: made.expiresAt } })
      return made
    })

    // the extension spends the code with its verifier; a wrong one counts against the address (as invite links do)
    kit.handle(API.chromeRedeem, ({ c, body }) => {
      const info = c.get('info')
      const guard = tokenGuard(ctx, info.ip)
      const got = redeemCode(ctx.db, body)
      if (got === 'full') return fail('conflict', undefined, { params: { reason: 'links_full' } })
      if (!got) { guard.fail(); return fail('gone') }
      if (got.replaced) rt.chrome.drop(got.replaced)
      const u = ctx.db.query('SELECT name, username FROM users WHERE id = ?').get(got.link.user_id) as { name: string; username: string }
      audit(ctx.db, { actor: got.link.user_id, action: 'chrome.link', target: got.link.id, detail: { ip: info.ip, label: got.link.label, version: got.link.version, ...(got.replaced ? { replaced: got.replaced } : {}) } })
      return { token: got.token, linkId: got.link.id, user: { name: u.name, username: u.username }, team: { name: getTeamSettings(ctx.db).teamName }, teamHosts: teamHosts(ctx, [new URL(c.req.url).hostname]) }
    })

    // file_upload's files for the person's linked Chrome: its link token, the person's own ticket, once; every failure is
    // the same 404 (no hint whether a ticket exists or whose it is)
    kit.handle(API.chromeUpload, ({ c }) => {
      const m = /^Bearer\s+([A-Za-z0-9_-]{43})\s*$/.exec(c.req.header('authorization') ?? '')
      const link = m ? linkByToken(ctx.db, m[1]!) : null
      const ticket = c.req.param('ticket') ?? ''
      const got = link && BrowserUploadTicket.safeParse(ticket).success ? rt.relay.uploads.take(ticket, link.user_id, chromeWindowOf(link.id)) : null
      if (!got) return fail('not_found')
      return new Response(got.bytes as unknown as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(got.bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' },
      })
    })

    // the extension's live connection: the token comes in the first frame (chrome/links.ts), never in a header or address
    kit.raw('GET', CHROME_WS_PATH, async (c) => {
      if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') fail('bad_request')
      const server = (c.env as { server?: { upgrade(req: Request, o: { data: WsData; headers?: HeadersInit }): boolean } } | undefined)?.server
      if (!server) fail('unavailable')
      // only a browser extension opens it (a page of a website cannot pretend to be one: the browser sets Origin)
      const origin = c.req.header('origin') ?? ''
      if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]{1,64}$/.test(origin)) fail('forbidden')
      const offered = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim())
      if (!offered.includes(CHROME_WS_PROTOCOL)) fail('bad_request')
      const ip = (c as unknown as AppContextC).get('info').ip ?? 'unknown'
      // sockets waiting for their first frame per address (one script cannot hold the server's sockets open)
      if (!rt.chrome.mayOpen(ip)) fail('rate_limited', undefined, { retryAfter: 10 })
      const hooks: ConnHooks = { message: [], close: [], closed: false }
      const data: WsData = {
        url: new URL(c.req.url),
        protocol: CHROME_WS_PROTOCOL,
        events: {
          onOpen(_e, ws) { rt.chrome.attach(bunConn(ws.raw as never, hooks), Date.now, ip) },
          onMessage(e) {
            const d = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)
            for (const f of hooks.message) f(d)
          },
          onClose() { hooks.closed = true; for (const f of hooks.close.splice(0)) f() },
        },
      }
      const original = (c.env as { upgradeReq?: Request } | undefined)?.upgradeReq ?? c.req.raw
      const ok = server!.upgrade(original, { data, headers: { 'Sec-WebSocket-Protocol': CHROME_WS_PROTOCOL } })
      if (!ok) fail('bad_request')
      return new Response(null)
    })
  },
}
