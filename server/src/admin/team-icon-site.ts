// Admin › Team settings › Team logo › "From the website" (docs/decisions/20261128-team-icon-from-site.md): the saved
// company profile's website (never an address from the request: the route is no fetch proxy), its square app icon by
// onboarding/site-icon.ts with web_fetch's network rules, stored in place of the logo there (an explicit press).
// Refused while this server does not know its own public exit address (web_fetch would ask a person; nobody is asked
// here), on a shared platform's page (the icon there is the platform's), and while another run is going. Every failure
// to find one is the same "not found" to the client (no fetch error text: no probing oracle); the log keeps the reason.
import type { Locale } from '@mycel/shared/api'
import { normalizeWebsite } from '@mycel/shared/api'
import type { TeamIconFile } from '@mycel/shared'
import type { AppContext } from '../context'
import { fail } from '../http/errors'
import { egressOf, egressSettled, exitAddressCheckOff } from '../tools/egress'
import { webScope } from '../onboarding/draft'
import { readCompanyProfile } from '../onboarding/profile'
import { fetchSiteIcon, type PickOptions } from '../onboarding/site-icon'
import type { NetOptions } from '../onboarding/brand-assets'
import { saveTeamIconBytes, SITE_ICON_TEXT } from './team-icon'


/** Tests only: the local web server's network options, and how the saved website maps onto it (a port). */
const testNets = new WeakMap<object, { net: NetOptions; site?: (website: string) => string; pick?: PickOptions }>()
export function setSiteIconNetForTests(ctx: object, o: { net: NetOptions; site?: (website: string) => string; pick?: PickOptions } | null): void {
  if (o) testNets.set(ctx, o)
  else testNets.delete(ctx)
}

/** one run at a time per server (it may take up to 30 s) */
const running = new WeakSet<object>()

/** The website's icon as the team logo, or a refusal in the caller's words (params.reason: no_website, not_ready,
 * not_found, busy). */
export async function teamIconFromSite(ctx: AppContext, userId: string, locale: Locale): Promise<{ icon: TeamIconFile; url: string }> {
  const profile = readCompanyProfile(ctx.files, ctx.files.principal(userId))
  const website = normalizeWebsite(profile?.website ?? '')
  if (!website) return fail('conflict', SITE_ICON_TEXT.noWebsite[locale], { params: { reason: 'no_website' } })
  if (running.has(ctx)) return fail('busy', SITE_ICON_TEXT.busy[locale], { params: { reason: 'busy' } })
  running.add(ctx)
  try {
    // right after a start the server may still be learning its exit address (tools/egress.ts): a moment, then refuse,
    // unless the install turned the check off (MYCEL_EXIT_ADDRESS_CHECK=off: then a person's press is what web_fetch
    // asks for, and this press is one)
    await egressSettled(ctx)
    if (!egressOf(ctx).known && !exitAddressCheckOff()) return fail('unavailable', SITE_ICON_TEXT.notReady[locale], { params: { reason: 'not_ready' } })
    const test = testNets.get(ctx)
    const scope = webScope(website)
    let why = 'shared platform'
    let got: Awaited<ReturnType<typeof fetchSiteIcon>> = null
    if (scope && !scope.prefix) {
      why = 'no usable icon'
      try {
        got = await fetchSiteIcon(test?.site ? test.site(website) : website, { ...test?.net, blockedIps: () => [...(test?.net.blockedIps?.() ?? []), ...egressOf(ctx).ips] }, test?.pick)
      } catch (err) { why = 'failed'; ctx.log.warn('the website icon could not be fetched', { err }) }
    }
    const icon = got ? await saveTeamIconBytes(ctx.config.dataDir, got.bytes, got.type) : null
    if (!got || !icon) {
      ctx.log.warn('no team logo from the website', { reason: why })
      return fail('not_found', SITE_ICON_TEXT.notFound[locale], { params: { reason: 'not_found' } })
    }
    return { icon, url: got.url }
  } finally {
    running.delete(ctx)
  }
}
