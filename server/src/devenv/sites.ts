// Sites a person allows for the dev environment on srt (docs/DECISIONS.md "Dev environment: sites a person allows").
// The person decides, with no admin step (owner, 2026-11-06): when a command of her chat needs a site that is not
// allowed, the chat asks her (allow once, always allow, don't allow). "Always" goes into her own list here; "once" stays
// with the turn (a foreground command) or with the row (a job or dev server). She can also turn Full internet on for
// herself, after a warning. Both go only into the settings of HER runs (srt/runner.ts settingsFor), never into another
// person's runs.
//
// The team's No network (and the plan's offline) wins over all of it: then no site is asked for and nothing is added
// (srt/config.ts srtSettings). The team server's host names, IP addresses and local names are never allowed
// (userSiteProblem); the private, link-local and metadata ranges stay denied with every list and with Full internet.
import type { Database } from 'bun:sqlite'
import { DEV_ENV_DEFAULT_DOMAINS, DEV_ENV_FULL_WARNING_VERSION, DEV_ENV_MAX_USER_SITES, mergeSites, siteCovers, userSiteProblem } from '@mycel/shared'

export interface UserSite { host: string; createdAt: string }

/** the sites this person allowed "always", oldest first */
export function userSites(db: Database, userId: string): UserSite[] {
  return (db.query('SELECT host, created_at FROM dev_env_site_grants WHERE user_id = ? ORDER BY created_at, host').all(userId) as { host: string; created_at: string }[])
    .map((r) => ({ host: r.host, createdAt: r.created_at }))
}

/** Add a site to the person's own list. 'full': the list has DEV_ENV_MAX_USER_SITES sites already. The caller checked
 * the host (userSiteProblem). */
export function grantUserSite(db: Database, userId: string, host: string): 'ok' | 'full' {
  const n = (db.query('SELECT COUNT(*) AS n FROM dev_env_site_grants WHERE user_id = ?').get(userId) as { n: number }).n
  const has = !!db.query('SELECT 1 FROM dev_env_site_grants WHERE user_id = ? AND host = ?').get(userId, host)
  if (!has && n >= DEV_ENV_MAX_USER_SITES) return 'full'
  db.query('INSERT OR IGNORE INTO dev_env_site_grants (user_id, host) VALUES (?, ?)').run(userId, host)
  return 'ok'
}

/** Remove a site from the person's own list; false when it was not there. */
export function removeUserSite(db: Database, userId: string, host: string): boolean {
  return db.query('DELETE FROM dev_env_site_grants WHERE user_id = ? AND host = ?').run(userId, host).changes > 0
}

/** Is Full internet on for this person, with the current warning accepted? */
export function fullInternet(db: Database, userId: string): boolean {
  const r = db.query('SELECT full_internet, full_warning FROM dev_env_user_net WHERE user_id = ?').get(userId) as { full_internet: number; full_warning: number } | null
  return !!r && r.full_internet === 1 && r.full_warning === DEV_ENV_FULL_WARNING_VERSION
}

export function setFullInternet(db: Database, userId: string, on: boolean) {
  db.query(`INSERT INTO dev_env_user_net (user_id, full_internet, full_warning, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET full_internet = excluded.full_internet, full_warning = CASE WHEN excluded.full_internet = 1 THEN excluded.full_warning ELSE full_warning END, updated_at = excluded.updated_at`)
    .run(userId, on ? 1 : 0, on ? DEV_ENV_FULL_WARNING_VERSION : 0, new Date().toISOString())
}

/** The person's network part of a run: her own sites (checked again now: a site that became a team host name is left
 * out, not an error) and her Full switch. */
export interface PersonNet { sites: string[]; full: boolean }
export function personNet(db: Database, userId: string, teamHosts: readonly string[]): PersonNet {
  return { sites: userSites(db, userId).map((s) => s.host).filter((h) => !userSiteProblem(h, teamHosts)), full: fullInternet(db, userId) }
}

/** The once-allowed sites of a row (comma list), checked again. */
export const parseOnce = (v: string, teamHosts: readonly string[]) => v.split(',').map((h) => h.trim()).filter((h) => h && !userSiteProblem(h, teamHosts))
export const formatOnce = (hosts: Iterable<string>) => [...new Set(hosts)].join(',').slice(0, 4000)

/** Is this host allowed for a run now (any list, or Full internet)? */
export function siteAllowed(host: string, o: { teamSites: readonly string[]; person: PersonNet; once: Iterable<string> }): boolean {
  if (o.person.full) return true
  return mergeSites(DEV_ENV_DEFAULT_DOMAINS, o.teamSites, o.person.sites, [...o.once]).some((p) => siteCovers(p, host))
}

/** What a running job or dev server started with, for the tracker: the team's sites, the person's sites and Full. */
export interface NetSnapshot { full: boolean; sites: string[] }
export const netSnapshot = (teamSites: readonly string[], p: PersonNet): NetSnapshot => ({ full: p.full, sites: mergeSites(teamSites, p.sites) })
export function parseSnapshot(v: string): NetSnapshot | null {
  if (!v) return null
  try { const j = JSON.parse(v) as NetSnapshot; return typeof j.full === 'boolean' && Array.isArray(j.sites) ? j : null } catch { return null }
}

/** Did the network of a run get narrower since it started (a site removed, Full internet turned off)? A new site does
 * not count: the run does not need it, and stopping it would punish the person for saying yes. */
export function netNarrowed(started: NetSnapshot, now: NetSnapshot): boolean {
  if (started.full && !now.full) return true
  if (now.full) return false
  const have = new Set(now.sites)
  return started.sites.some((s) => !have.has(s))
}
