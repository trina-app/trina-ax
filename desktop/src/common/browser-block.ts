// Addresses the in-app browser may never open or send requests to, whatever the person or the AI answers
// (design tab 5 "앱 안 브라우저 분리", tab 7 threat table): every team address this app knows (relay address,
// office LAN names and IPs of the team server), this computer (localhost, *.localhost, 127.0.0.0/8, ::1 ...), and
// non-web schemes. An injected AI must not open the team address in the pane and call the team API with the
// person's rights; the pane's partition never holds a team cookie, and the server rejects requests that carry
// the in-app browser's User-Agent mark (IN_APP_BROWSER_UA_MARK) as a second line.
// Pure: unit-tested in tests/unit/e-browser-block.test.ts.
import { isLoopbackName } from './netaddr'

export type BlockReason = 'team' | 'loopback' | 'scheme'

const normHost = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

/** Hostnames of every remembered team: the team address and the office (direct) hosts it announced. */
export function teamHostnames(teams: readonly { origin: string; direct?: { hosts: readonly string[] } | null }[]): Set<string> {
  const out = new Set<string>()
  for (const t of teams) {
    try {
      out.add(normHost(new URL(t.origin).hostname))
    } catch {
      // unparseable stored origin: nothing to add
    }
    for (const h of t.direct?.hosts ?? []) out.add(normHost(h))
  }
  return out
}

/** Why `url` is off limits for the in-app browser before any DNS lookup, or null. */
export function blockedUrl(url: string, teamHosts: ReadonlySet<string>): BlockReason | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'scheme'
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return 'scheme'
  const host = normHost(u.hostname)
  if (teamHosts.has(host)) return 'team'
  if (isLoopbackName(host)) return 'loopback'
  return null
}

/** The sentence the AI gets when it tries one of these addresses. */
export function blockedMessage(reason: BlockReason, host: string): string {
  if (reason === 'team') {
    return `The in-app browser cannot open the team's own address (${host}). Use the team's own tools for team data instead of the browser.`
  }
  if (reason === 'loopback') return `The in-app browser cannot open addresses on this computer (${host}).`
  return 'Only http(s) pages can be opened in the browser pane.'
}
