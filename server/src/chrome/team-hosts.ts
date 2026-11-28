// Every host name this team answers on (its public addresses, the hosts it accepts, the office public address, its
// Tailscale name), and the hosting service's own domain (every hosted team, the console, the relay: another team the
// person is signed in to must never be driven either; security review): a linked Chrome never opens or sends to them, so the AI can never press its own cards in the
// person's signed-in team page (docs/decisions/20261128-trina-in-chrome.md). The extension adds the address it linked
// through itself.
import type { AppContext } from '../context'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'

const hostOf = (s: string): string | null => {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^\[|\]$/g, '') || null } catch { return null }
}

export function teamHosts(ctx: AppContext, also: readonly string[] = []): string[] {
  const c = ctx.config
  const out = new Set<string>()
  for (const s of [SERVICE_HOSTS.teamDomain, ...(c.publicOrigins ?? []), ...(c.allowedHosts ?? []), ...(c.tunnel ? [c.tunnel.host] : []), ...(c.tailnet ? [c.tailnet.host] : []), ...also]) {
    const h = hostOf(s)
    if (h) out.add(h)
  }
  return [...out].slice(0, 50)
}

/** Would keeping `site` for a profile cover a team host (or is it one)? Such a site is never kept or allowed. */
export function coversTeam(ctx: AppContext, site: string, also: readonly string[] = []): boolean {
  const k = site.toLowerCase()
  return teamHosts(ctx, also).some((h) => h === k || h.endsWith('.' + k) || k.endsWith('.' + h))
}
