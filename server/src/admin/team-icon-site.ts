// Admin › Team settings › Team logo › "From the website" (docs/decisions/20261128-team-icon-from-site.md): the saved
// company profile's website (never an address from the request: the route is no fetch proxy), its square app icon by
// onboarding/site-icon.ts with web_fetch's network rules, stored in place of the logo there (an explicit press).
// Refused while this server does not know its own public exit address (web_fetch would ask a person; nobody is asked
// here), on a shared platform's page (the icon there is the platform's), and while another run is going. Every failure
// to find one is the same "not found" to the client (no fetch error text: no probing oracle); the log keeps the reason.
//
// With the team's AI (docs/decisions/20261128-team-icon-ai-assist.md): when the person who pressed has a working Claude
// Code or Codex connection, the press answers at once ("pending") and the rules and then one AI task
// (onboarding/site-icon-ai.ts) run in the background; the result lands within about 90 s, only over the logo that was
// there at the press (an upload meanwhile wins: replaceTeamIconIf), audited and announced as before. The onboarding
// press (onboarding/welcome-result.ts) uses the same background run with the icon its draft staged. The pressing
// window reads its own last run (GET /api/admin/team-icon/from-site: siteRunOf).
import type { Locale, TeamIconSiteRun } from '@mycel/shared/api'
import { imageInfo, type TeamIconFile } from '@mycel/shared'
import { normalizeWebsite, profileName } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { ChatRuntime } from '../chat/runtime'
import type { Role } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { egressOf, egressSettled, exitAddressCheckOff } from '../tools/egress'
import { webScope } from '../onboarding/draft'
import { readCompanyProfile } from '../onboarding/profile'
import { markTeamIconAi, teamIconAiTried } from '../onboarding/welcome'
import { fetchSiteIcon, type IconSource, type PickOptions, type SiteIcon } from '../onboarding/site-icon'
import { runTeamIconAi, teamIconAiAvailable, type TeamIconAiOptions, type TeamIconAiOutcome } from '../onboarding/site-icon-ai'
import type { NetOptions } from '../onboarding/brand-assets'
import { getTeamSettings } from './settings'
import { audit } from './audit'
import { readTeamIcon, replaceTeamIconIf, saveTeamIconBytes, SITE_ICON_TEXT, TEAM_ICON_CHANGED, teamIconInfo } from './team-icon'


/** Tests only: the local web server's network options, and how the saved website maps onto it (a port). */
type TestNet = { net: NetOptions; site?: (website: string) => string; pick?: PickOptions; ai?: TeamIconAiOptions | false }
const testNets = new WeakMap<object, TestNet>()
/** (`ai: false`: no AI help, the rules alone; `ai: {…}`: the AI task's test options) */
export function setSiteIconNetForTests(ctx: object, o: TestNet | null): void {
  if (o) testNets.set(ctx, o)
  else testNets.delete(ctx)
}

/** one run at a time per server (the rules up to 30 s, with the AI up to 90 s) */
const running = new WeakSet<object>()

/** A run's state, per person who pressed, kept a while for their window to read (GET …/from-site). */
const RUN_KEEP_MS = 10 * 60_000
const runs = new WeakMap<object, Map<string, TeamIconSiteRun & { at: number }>>()
function setRun(ctx: object, userId: string, s: TeamIconSiteRun): void {
  let m = runs.get(ctx)
  if (!m) runs.set(ctx, (m = new Map()))
  for (const [k, v] of m) if (Date.now() - v.at > RUN_KEEP_MS) m.delete(k)
  m.set(userId, { ...s, at: Date.now() })
}
/** The last run of `userId` (idle when none, or long ago). */
export function siteRunOf(ctx: object, userId: string): TeamIconSiteRun {
  const r = runs.get(ctx)?.get(userId)
  if (!r || Date.now() - r.at > RUN_KEEP_MS) return { status: 'idle' }
  const { at: _at, ...s } = r
  void _at
  return s
}

/** The net of a run: the test server's in tests, and this server's own exit addresses refused. */
function netOf(ctx: AppContext): NetOptions {
  const test = testNets.get(ctx)
  return { ...test?.net, blockedIps: () => [...(test?.net.blockedIps?.() ?? []), ...egressOf(ctx).ips] }
}

/** The website of the saved company profile, its company name, and whether it is the company's own site (not a shared
 * platform's page). */
function siteOf(ctx: AppContext, userId: string): { website: string; company: string; own: boolean } | null {
  const profile = readCompanyProfile(ctx.files, ctx.files.principal(userId))
  const website = normalizeWebsite(profile?.website ?? '')
  if (!website || !profile) return null
  const scope = webScope(website)
  return { website, company: profileName(profile, getTeamSettings(ctx.db).teamName), own: !!scope && !scope.prefix }
}

/** May the team's AI help with this press now: a known exit address (or the check off), the person's AI (site-icon-ai
 * teamIconAiAvailable), no other run going. */
function aiHelps(ctx: AppContext, rt: ChatRuntime | null, who: { id: string; role: Role }, locale: Locale): rt is ChatRuntime {
  if (!rt || running.has(ctx) || testNets.get(ctx)?.ai === false) return false
  if (!egressOf(ctx).known && !exitAddressCheckOff()) return false
  return teamIconAiAvailable(ctx, rt, who, locale)
}

/**
 * The AI's result as the team logo, over exactly the logo that was there at the press (`before`; null: none), audited
 * (team_icon.set, source "site", ai: what the AI did) and announced. Null: nothing to set, or the logo changed meanwhile.
 */
function landAiResult(ctx: AppContext, userId: string, r: TeamIconAiOutcome, before: string | null): TeamIconFile | null {
  if (!r.icon) return null
  let set: TeamIconFile | null = null
  try { set = replaceTeamIconIf(ctx.config.dataDir, r.icon.bytes, r.icon.type, before) } catch (err) { ctx.log.warn('the website logo was not set', { err }) }
  if (!set) return null
  audit(ctx.db, { actor: userId, action: 'team_icon.set', target: null, detail: { ...teamIconInfo(set), before, source: 'site', url: r.icon.url.slice(0, 2000), ai: r.outcome === 'rules' ? `rules (${r.ai})` : r.outcome } })
  ctx.services.realtime.publishEach(() => TEAM_ICON_CHANGED)
  return set
}

/** The background run of one press: `rules` gives the rules' pick (the admin's fetch, or the icon onboarding staged),
 * then the AI task, then the result lands. Never throws; always frees the run. */
function runInBackground(ctx: AppContext, rt: ChatRuntime, who: { id: string; role: Role }, locale: Locale, site: { website: string; company: string }, before: string | null, rules: () => Promise<SiteIcon | null>): void {
  running.add(ctx)
  setRun(ctx, who.id, { status: 'running' })
  void (async () => {
    let outcome = 'failed'
    try {
      let rule: SiteIcon | null = null
      try { rule = await rules() } catch (err) { ctx.log.warn('the website icon could not be fetched', { err }) }
      const r = await runTeamIconAi(ctx, rt, who, { ...site, rule, net: netOf(ctx) }, locale, testNets.get(ctx)?.ai || undefined)
      outcome = r.outcome === 'rules' ? `rules (${r.ai})` : r.outcome
      const set = landAiResult(ctx, who.id, r, before)
      setRun(ctx, who.id, set ? { status: 'set', version: set.version, ai: r.outcome } : { status: 'none', message: SITE_ICON_TEXT.notFound[locale] })
      if (!set) ctx.log.warn('no team logo from the website', { reason: r.icon ? 'changed meanwhile' : outcome })
    } catch (err) {
      ctx.log.warn('the website logo run failed', { err })
      setRun(ctx, who.id, { status: 'none', message: SITE_ICON_TEXT.notFound[locale] })
    } finally {
      running.delete(ctx)
      ctx.log.info('team logo from the website: AI run done', { outcome })
    }
  })()
}

/** The website's icon as the team logo, or `pending` (the team's AI checks and finds in the background), or a refusal in
 * the caller's words (params.reason: no_website, not_ready, not_found, busy). */
export async function teamIconFromSite(ctx: AppContext, who: { id: string; role: Role }, locale: Locale, rt: ChatRuntime | null = null): Promise<{ icon: TeamIconFile; url: string } | { pending: true }> {
  const site = siteOf(ctx, who.id)
  if (!site) return fail('conflict', SITE_ICON_TEXT.noWebsite[locale], { params: { reason: 'no_website' } })
  if (running.has(ctx)) return fail('busy', SITE_ICON_TEXT.busy[locale], { params: { reason: 'busy' } })
  const test = testNets.get(ctx)
  const fetchRules = () => fetchSiteIcon(test?.site ? test.site(site.website) : site.website, netOf(ctx), test?.pick)
  // the team's AI: everything in the background, the press answers at once
  await egressSettled(ctx)
  if (running.has(ctx)) return fail('busy', SITE_ICON_TEXT.busy[locale], { params: { reason: 'busy' } })
  if (site.own && aiHelps(ctx, rt, who, locale)) {
    runInBackground(ctx, rt, who, locale, site, readTeamIcon(ctx.config.dataDir)?.version ?? null, fetchRules)
    return { pending: true }
  }
  running.add(ctx)
  try {
    // right after a start the server may still be learning its exit address (tools/egress.ts): a moment, then refuse,
    // unless the install turned the check off (MYCEL_EXIT_ADDRESS_CHECK=off: then a person's press is what web_fetch
    // asks for, and this press is one)
    if (!egressOf(ctx).known && !exitAddressCheckOff()) return fail('unavailable', SITE_ICON_TEXT.notReady[locale], { params: { reason: 'not_ready' } })
    let why = 'shared platform'
    let got: Awaited<ReturnType<typeof fetchSiteIcon>> = null
    if (site.own) {
      why = 'no usable icon'
      try { got = await fetchRules() } catch (err) { why = 'failed'; ctx.log.warn('the website icon could not be fetched', { err }) }
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

/**
 * The onboarding press (onboarding/welcome-result.ts placeBrand): the icon the draft staged (or none) checked and, when
 * none or not the logo, looked for by the team's AI, in the background. False: no AI help now (the caller sets the staged
 * icon as before). Only while the team has no logo, once per website (a logo undone stays undone on a later save; the
 * welcome row's teamIconAiSite); the result lands only if it still has none.
 */
export function startOnboardingIconAi(ctx: AppContext, rt: ChatRuntime | null, who: { id: string; role: Role }, locale: Locale, staged: { bytes: Uint8Array<ArrayBuffer>; url: string; source: string } | null): boolean {
  if (readTeamIcon(ctx.config.dataDir)) return false
  let site: ReturnType<typeof siteOf>
  try { site = siteOf(ctx, who.id) } catch { return false }
  if (!site?.own || teamIconAiTried(ctx, site.website) || !aiHelps(ctx, rt, who, locale)) return false
  markTeamIconAi(ctx, site.website)
  const info = staged ? imageInfo(staged.bytes) : null
  const rule: SiteIcon | null = staged && info ? { bytes: staged.bytes, type: info.type, width: info.width, height: info.height, url: staged.url, source: (staged.source || 'icon') as IconSource } : null
  runInBackground(ctx, rt, who, locale, site, null, async () => rule)
  return true
}
