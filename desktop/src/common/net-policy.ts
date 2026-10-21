// What the in-app browser does with a request to a PUBLIC address (design tab 7 "프롬프트 주입": an address can carry
// data out). The AI can send what the person can read to any server by opening an address, by a redirect from an
// allowed site, or by running script in a page. So:
//  - a page load (main frame, every redirect hop included) while the AI is driving the pane, or while any tab holds a
//    document the AI ran script in (a script can navigate other windows it has a reference to), to a site the person
//    has not allowed: ask the person ("site" scope, like the AI's own navigate)
//  - sub-requests (fetch, images, beacons, iframes, WebSocket) of a document the AI ran script in (or of another tab
//    on the same site, which that script can reach), to another site than the page's own that the person has not
//    allowed: blocked until the tab loads a new page (the script's timers die with its document)
//  - everything else (the person browsing, pages the AI did not script loading their own resources): as any browser
// javascript_tool never runs on a blank tab (no site to allow: pane.ts permit()).
// Pure: unit-tested in tests/unit/e-desktop-common.test.ts; used by main/pane/net-guard.ts.

export type PublicVerdict = 'allow' | 'ask' | 'block'

export interface PublicRequest {
  /** a page load of the tab (Electron resourceType 'mainFrame', each redirect hop) */
  mainFrame: boolean
  /** the request belongs to a pane tab or popup (not a service worker or another requester without a tab) */
  hasOwner: boolean
  /** the pane is running an AI browser call right now */
  driving: boolean
  /** some tab holds a document the AI ran javascript_tool in */
  anyScripted: boolean
  /** the AI ran javascript_tool in this tab's current document, or in a tab on the same site (same-origin access) */
  scripted: boolean
  /** the target is the same site (host[:port], "www." dropped) as the tab's current page */
  sameSiteAsTop: boolean
  /** the person allowed the target site (this turn or always) or typed it themselves */
  siteAllowed: boolean
}

export function publicRequestVerdict(r: PublicRequest): PublicVerdict {
  if (r.siteAllowed) return 'allow'
  // service workers and other requesters that are no tab: held back while an AI script lives (it can register one)
  if (!r.hasOwner) return r.anyScripted ? 'block' : 'allow'
  if (r.mainFrame) return r.driving || r.anyScripted || r.scripted ? 'ask' : 'allow'
  return r.scripted && !r.sameSiteAsTop ? 'block' : 'allow'
}

/** Browser tools that run the AI's own code in the page: never on a blank tab (no site the person could allow). */
export const RUNS_AI_SCRIPT: ReadonlySet<string> = new Set(['javascript_tool'])

/** A tab URL with no web page in it (fresh tab, about:blank). */
export function isBlankPage(url: string): boolean {
  return url === '' || url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?')
}
