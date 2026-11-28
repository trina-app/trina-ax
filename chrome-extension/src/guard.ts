// The guards on tabs the AI drives (as the desktop browser's net guard, desktop/src/main/pane/net-guard.ts):
//  - every request to one of the team's own addresses fails (CDP Fetch), navigations included: the AI must never
//    press its own cards in the person's signed-in team page
//  - after the AI's javascript_tool, the document's requests to sites the last call did not allow fail (a script can
//    carry what it read anywhere); the page's own site and the allowed ones go on. Reset when the page navigates.
//  - a page whose server answered from this computer or the office network while its name is a public one (DNS
//    rebinding) is stopped, and the AI hears it with its next result
import { classifyIp, isLoopbackIp } from '../../desktop/src/common/netaddr'
import { redactUrl } from '../../desktop/src/common/input'
import { sameSite } from '../../desktop/src/common/site-permissions'
import { cdp, type Target } from './cdp'
import { allowed, checkUrl, hostKey, isTeamHost, isThisComputer, keyMatches, office, splitHost } from './sites'
import { live } from './state'
import { addNotice, autoAttachParams, pushConsole, type TabState } from './tabs'

const teamHosts = () => live.link?.teamHosts ?? []

/** Fetch patterns for the team's addresses (and their subdomains, any port). */
export function teamPatterns(hosts: readonly string[]): { urlPattern: string }[] {
  const out: { urlPattern: string }[] = []
  for (const raw of hosts) {
    const h = splitHost(raw.toLowerCase()).name
    if (!h || /[*?\\]/.test(h)) continue
    for (const p of [`*://${h}/*`, `*://${h}:*`, `*://*.${h}/*`, `*://*.${h}:*`]) out.push({ urlPattern: p })
  }
  return out
}

/** Turn the Fetch guard on for a tab (or one of its child targets) as its state says. */
export async function applyFetch(st: TabState, target: Target = st.target): Promise<void> {
  if (!st.attached) return
  // while a call runs, page loads are checked too: a redirect or a click must not open a site nobody allowed
  const patterns = st.scripted ? [{ urlPattern: '*' }] : [...teamPatterns(teamHosts()), ...(st.busy > 0 ? [{ urlPattern: '*', resourceType: 'Document' }] : [])]
  if (patterns.length) await cdp(target, 'Fetch.enable', { patterns })
  else await cdp(target, 'Fetch.disable').catch(() => {})
  // a script's WebSocket does not pass through Fetch: none opens from a document the AI scripted
  await cdp(target, 'Network.setBlockedURLs', { urls: st.scripted ? ['ws://*', 'wss://*'] : [] }).catch(() => {})
}

/** Removed from a scripted document's main world before the AI's script runs: peer connections reach any address
 * without a request Fetch could see (best effort: README "Limits"). */
const UNGUARDED_APIS = `(() => {
  const gone = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport'];
  const strip = (w) => { try { for (const n of gone) { try { Object.defineProperty(w, n, { value: undefined, writable: false, configurable: false }); } catch (e) {} } } catch (e) {} };
  strip(window);
  try { for (let i = 0; i < window.frames.length; i++) { try { strip(window.frames[i]); } catch (e) {} } } catch (e) {}
  return true;
})()`

/** The AI is about to run its script in this document. */
export async function markScripted(st: TabState): Promise<void> {
  if (!st.scripted) {
    st.scripted = true
    await applyFetch(st)
    for (const sid of st.children.keys()) await applyFetch(st, { tabId: st.tabId, sessionId: sid }).catch(() => {})
    // windows it opens and its service and shared workers are attached (and guarded, or closed) from now on
    await cdp(st.target, 'Target.setAutoAttach', autoAttachParams(true)).catch(() => {})
  }
  await cdp(st.target, 'Runtime.evaluate', { expression: UNGUARDED_APIS, returnByValue: true }).catch(() => {})
}

/** Let a paused request go on, or fail it (as if an ad blocker had stopped it). */
export async function onRequestPaused(st: TabState, target: Target, params: { requestId: string; request: { url: string }; resourceType?: string; frameId?: string }): Promise<void> {
  let verdict = requestVerdict(params.request.url, st)
  // the main page of a tab the AI drives now: only sites the call allows (the person is asked about another)
  if (verdict === 'go' && st.busy > 0 && !target.sessionId && params.resourceType === 'Document' && params.frameId === st.mainFrameId) {
    const v = checkUrl(params.request.url, st.rules, teamHosts())
    if (v.kind === 'need') {
      st.blockedNav = v.office ? { host: v.host, office: true } : { host: v.host }
      verdict = 'fail'
    } else if (v.kind === 'blocked') verdict = 'fail'
  }
  if (verdict === 'fail') {
    pushConsole(st, { level: 'error', text: `[blocked] ${redactUrl(params.request.url).slice(0, 300)}: not allowed for the AI's browser.`, host: st.host })
    await cdp(target, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
  } else await cdp(target, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {})
}

/** fail: a team address or this computer (always), or a site nobody allowed while the document is scripted. */
export function requestVerdict(raw: string, st: Pick<TabState, 'scripted' | 'rules' | 'host'>, hosts: readonly string[] = teamHosts()): 'go' | 'fail' {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'go'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return 'go'
  if (isTeamHost(u.hostname, hosts) || isThisComputer(u.hostname)) return 'fail'
  const host = hostKey(u)
  if (!st.scripted) return 'go'
  if (sameSite(host, st.host.replace(/^www\./, ''))) return 'go'
  return allowed(host, st.rules) ? 'go' : 'fail'
}

/**
 * The main document's server answered: was it this computer or the office network under a public name (DNS
 * rebinding)? A connection through a proxy shows the proxy's address, on its own port, not the page's: skipped.
 */
export async function checkDocumentSource(st: TabState, response: { url?: string; remoteIPAddress?: string; remotePort?: number; fromDiskCache?: boolean; fromServiceWorker?: boolean }): Promise<void> {
  const ip = response.remoteIPAddress
  if (!ip || !response.url || response.fromDiskCache || response.fromServiceWorker) return
  let u: URL
  try {
    u = new URL(response.url)
  } catch {
    return
  }
  const urlPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  if (response.remotePort !== undefined && response.remotePort !== urlPort) return
  const host = hostKey(u)
  const bad = documentSourceVerdict(host, ip, st.rules)
  if (!bad) return
  const text = `[blocked] ${redactUrl(response.url).slice(0, 300)} answered from ${bad === 'loopback' ? 'this computer' : 'an office-network address'} (${ip}); the page was stopped. Do not open it again; tell the user.`
  pushConsole(st, { level: 'error', text, host: st.host })
  addNotice(st, text)
  await cdp(st.target, 'Page.stopLoading').catch(() => {})
  await cdp(st.target, 'Page.navigate', { url: 'about:blank' }).catch(() => {})
}

/** null: fine. loopback: a page served from this computer. office: from the office network, not allowed as such. */
export function documentSourceVerdict(host: string, ip: string, rules: { office?: readonly string[] }): 'loopback' | 'office' | null {
  if (isLoopbackIp(ip)) return 'loopback'
  if (classifyIp(ip) !== 'private') return null
  // an office address the person allowed, or the page was asked for by its office name or IP (allowed by its own card)
  if ((rules.office ?? []).some((k) => keyMatches(k, host))) return null
  if (office(host)) return null
  return 'office'
}
