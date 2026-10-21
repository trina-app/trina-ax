// Office-network guard for the in-app browser's session (design tab 7 "내부망 공격 … 앱 브라우저는 사람 확인").
// A page the AI opened must not reach devices inside the office (router admin pages, NAS) unless the person said so:
//  - team addresses (relay and office), this computer (localhost, 127.0.0.0/8, ::1, names resolving there) are
//    never reachable, whatever anyone answers (design tab 5 "앱 안 브라우저 분리"; redirects included, since
//    every redirect hop comes through onBeforeRequest again)
//  - main-frame navigations to a private address ask the person (once / always / deny), unless the address is
//    already allowed, the person typed it, or the tab is already on an allowed office page (intranet browsing)
//  - sub-requests (images, fetch, WebSocket, iframes) to private addresses are blocked unless the page itself is
//    an allowed office page
//  - a document or script-readable response that came from a private IP although its name looked public (DNS
//    rebinding, or DNS gave no answer before the request) stops the tab (stopIfRebound, fed from the tab's CDP
//    network events)
// What it refused goes to the pane's activity log; only a stopped page load (main frame) to the office network or
// this computer is shown over the page (common/pane-activity.ts).
import type { OnBeforeRequestListenerDetails, WebContents } from 'electron'
import { redactUrl } from '../../common/input'
import { isLoopbackIp } from '../../common/netaddr'
import { publicRequestVerdict, REBIND_CHECKED_TYPES, responseSourceVerdict } from '../../common/net-policy'
import type { ActivityKind } from '../../common/pane-activity'
import type { BrowserPane } from './pane'

const FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }

/** host[:port] of any http(s)/ws(s) URL, "www." dropped (same keys as site permissions). */
function keyOf(url: string): { key: string; hostname: string } | null {
  try {
    const u = new URL(url)
    return { key: u.host.toLowerCase().replace(/^www\./, ''), hostname: u.hostname }
  } catch {
    return null
  }
}

export function installNetGuard(pane: BrowserPane) {
  const ses = pane.session
  const lastBlocked = new Map<string, number>()
  /** log a refusal (a page asks for the same host many times: once per 5 s per host and kind) */
  const noteBlocked = (host: string, kind: ActivityKind, d: OnBeforeRequestListenerDetails) => {
    const topLevel = d.resourceType === 'mainFrame'
    const k = `${kind} ${topLevel ? 'top' : 'sub'} ${host}`
    const now = Date.now()
    if ((lastBlocked.get(k) ?? 0) > now - 5000) return
    lastBlocked.set(k, now)
    if (lastBlocked.size > 200) lastBlocked.delete(lastBlocked.keys().next().value as string)
    pane.activity(kind, host, topLevel)
  }

  const approved = (key: string, turnId?: string) => pane.perms.isAllowed('private', key, turnId) || pane.userHosts.has(key)

  async function topIsApprovedOffice(topUrl: string, turnId?: string): Promise<boolean> {
    const top = keyOf(topUrl)
    if (!top || !/^https?:/.test(topUrl)) return false
    return approved(top.key, turnId) && (await pane.classifier.classify(top.hostname)) === 'private'
  }

  async function decide(d: OnBeforeRequestListenerDetails): Promise<{ cancel?: boolean }> {
    const k = keyOf(d.url)
    if (!k) return { cancel: true }
    if (await pane.forbidden(d.url)) {
      noteBlocked(k.key, 'forbidden', d)
      return { cancel: true }
    }
    const ctx = pane.currentCall()
    const owner = d.webContentsId !== undefined ? pane.tabForWebContents(d.webContentsId) : undefined
    if ((await pane.classifier.classify(k.hostname)) === 'public') return decidePublic(d, k.key, owner, ctx)
    if (approved(k.key, ctx?.turnId)) return {}
    if (!owner) return { cancel: true } // service workers and unknown requesters get no office access
    const topOk = await topIsApprovedOffice(owner.topUrl, ctx?.turnId)
    if (d.resourceType === 'mainFrame') {
      if (topOk && !pane.isDriving && !pane.anyScripted) return {}
      const decision = await pane.ask({ scope: 'private', host: k.key, url: redactUrl(d.url), tool: ctx?.tool ?? 'navigate' }, ctx)
      if (decision === 'deny') {
        noteBlocked(k.key, 'denied', d)
        return { cancel: true }
      }
      pane.grant(['site', 'private'], k.key, decision, ctx?.turnId)
      return {}
    }
    if (topOk) return {}
    noteBlocked(k.key, 'blocked', d)
    return { cancel: true }
  }

  // a public address (common/net-policy.ts): page loads the AI caused go to sites the person allowed, and a document
  // the AI ran script in reaches no other site the person did not allow (security r3: redirect hops, script
  // navigation and beacons carried data to any server with no prompt)
  async function decidePublic(
    d: OnBeforeRequestListenerDetails,
    key: string,
    owner: ReturnType<BrowserPane['tabForWebContents']>,
    ctx: ReturnType<BrowserPane['currentCall']>,
  ): Promise<{ cancel?: boolean }> {
    const mainFrame = d.resourceType === 'mainFrame'
    const verdict = publicRequestVerdict({
      mainFrame,
      hasOwner: Boolean(owner),
      driving: pane.isDriving,
      anyScripted: pane.anyScripted,
      scripted: owner ? pane.scriptedFor(owner.tab, owner.topUrl) : false,
      sameSiteAsTop: owner ? keyOf(owner.topUrl)?.key === key : false,
      siteAllowed: pane.perms.isAllowed('site', key, ctx?.turnId) || pane.userHosts.has(key),
    })
    if (verdict === 'allow') return {}
    // a public site, not the office network: this is the hold on pages the AI ran script in (net-policy.ts). It used
    // to be logged as an office-network block ("사내망 요청을 막았어요: static.licdn.com" over LinkedIn)
    if (verdict === 'block') {
      noteBlocked(key, 'offsite', d)
      return { cancel: true }
    }
    const decision = await pane.ask({ scope: 'site', host: key, url: redactUrl(d.url), tool: ctx?.tool ?? 'navigate' }, ctx)
    if (decision === 'deny') {
      noteBlocked(key, 'denied', d)
      return { cancel: true }
    }
    pane.grant(['site'], key, decision, ctx?.turnId)
    return {}
  }

  ses.webRequest.onBeforeRequest(FILTER, (details, callback) => {
    decide(details).then(callback, () => callback({ cancel: true }))
  })
}

/**
 * A response that came from an office address although its name was let through as public (DNS answered differently
 * when Chromium connected: rebinding; or gave no answer before the request), or from this computer. Called from the
 * tab's CDP Network.responseReceived with the address Chromium connected to. Resolves true when the tab was stopped.
 */
export async function stopIfRebound(pane: BrowserPane, wc: WebContents, url: string, ip: string | undefined, type: string): Promise<boolean> {
  if (!ip || !REBIND_CHECKED_TYPES.has(type)) return false
  const k = keyOf(url)
  if (!k) return false
  const loopback = isLoopbackIp(ip)
  const privateIp = pane.classifier.classifyIpNow(ip) === 'private'
  if (!loopback && !privateIp) return false
  // through a proxy the address is the proxy's (often 127.0.0.1 or an office address): nothing to learn from it
  const proxied = !/^DIRECT\b/.test((await pane.session.resolveProxy(url).catch(() => 'DIRECT')).trim() || 'DIRECT')
  const verdict = responseSourceVerdict({
    ip,
    proxied,
    loopback,
    privateIp,
    testMapped: pane.classifier.isTestMapped(k.hostname),
    resolvedPublic: pane.classifier.wasResolvedPublic(k.hostname),
    privateAllowed: pane.perms.isAllowed('private', k.key, pane.currentCall()?.turnId) || pane.userHosts.has(k.key),
  })
  return verdict === 'ok' ? false : stopTab(pane, wc, k.key, verdict)
}

function stopTab(pane: BrowserPane, wc: WebContents, key: string, kind: 'blocked' | 'forbidden'): boolean {
  if (wc.isDestroyed()) return false
  wc.stop()
  void wc.loadURL('about:blank').catch(() => {})
  // the whole page stopped: shown over the page, not only in the log
  pane.activity(kind, key, true)
  return true
}
