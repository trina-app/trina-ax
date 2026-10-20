// Office-network guard for the in-app browser's session (design tab 7 "내부망 공격 … 앱 브라우저는 사람 확인").
// A page the AI opened must not reach devices inside the office (router admin pages, NAS) unless the person said so:
//  - team addresses (relay and office), this computer (localhost, 127.0.0.0/8, ::1, names resolving there) are
//    never reachable, whatever anyone answers (design tab 5 "앱 안 브라우저 분리"; redirects included, since
//    every redirect hop comes through onBeforeRequest again)
//  - main-frame navigations to a private address ask the person (once / always / deny), unless the address is
//    already allowed, the person typed it, or the tab is already on an allowed office page (intranet browsing)
//  - sub-requests (images, fetch, WebSocket, iframes) to private addresses are blocked unless the page itself is
//    an allowed office page
//  - a document response that came from a private IP although its name looked public (DNS rebinding) stops
//    the tab (stopIfRebound, fed from the tab's CDP network events)
import type { OnBeforeRequestListenerDetails, WebContents } from 'electron'
import { redactUrl } from '../../common/input'
import { isLoopbackIp } from '../../common/netaddr'
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
  const noteBlocked = (host: string, kind: 'blocked' | 'forbidden' = 'blocked') => {
    const now = Date.now()
    if ((lastBlocked.get(host) ?? 0) > now - 5000) return
    lastBlocked.set(host, now)
    if (lastBlocked.size > 200) lastBlocked.delete(lastBlocked.keys().next().value as string)
    pane.activity(kind, host)
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
      noteBlocked(k.key, 'forbidden')
      return { cancel: true }
    }
    if ((await pane.classifier.classify(k.hostname)) === 'public') return {}
    const ctx = pane.currentCall()
    if (approved(k.key, ctx?.turnId)) return {}
    const owner = d.webContentsId !== undefined ? pane.tabForWebContents(d.webContentsId) : undefined
    if (!owner) return { cancel: true } // service workers and unknown requesters get no office access
    const topOk = await topIsApprovedOffice(owner.topUrl, ctx?.turnId)
    if (d.resourceType === 'mainFrame') {
      if (topOk && !pane.isDriving) return {}
      const decision = await pane.ask({ scope: 'private', host: k.key, url: redactUrl(d.url), tool: ctx?.tool ?? 'navigate' }, ctx)
      if (decision === 'deny') {
        noteBlocked(k.key)
        return { cancel: true }
      }
      pane.grant(['site', 'private'], k.key, decision, ctx?.turnId)
      return {}
    }
    if (topOk) return {}
    noteBlocked(k.key)
    return { cancel: true }
  }

  ses.webRequest.onBeforeRequest(FILTER, (details, callback) => {
    decide(details).then(callback, () => callback({ cancel: true }))
  })
}

/**
 * A document response that came from an office address although its name was classified public (DNS answered
 * differently when Chromium connected: rebinding). Called from the tab's CDP Network.responseReceived.
 * Returns true when the tab was stopped.
 */
export function stopIfRebound(pane: BrowserPane, wc: WebContents, url: string, ip: string | undefined): boolean {
  if (!ip) return false
  const k = keyOf(url)
  if (!k) return false
  // answered from this computer: never allowed (unless it is a test name mapped there on purpose)
  if (isLoopbackIp(ip) && !pane.classifier.isTestMapped(k.hostname)) return stopTab(pane, wc, k.key, 'forbidden')
  if (!pane.classifier.wasResolvedPublic(k.hostname)) return false
  if (pane.classifier.classifyIpNow(ip) !== 'private') return false
  if (pane.perms.isAllowed('private', k.key, pane.currentCall()?.turnId) || pane.userHosts.has(k.key)) return false
  return stopTab(pane, wc, k.key)
}

function stopTab(pane: BrowserPane, wc: WebContents, key: string, kind: 'blocked' | 'forbidden' = 'blocked'): boolean {
  if (wc.isDestroyed()) return false
  wc.stop()
  void wc.loadURL('about:blank').catch(() => {})
  pane.activity(kind, key)
  return true
}
