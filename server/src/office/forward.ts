// Office mode: never go back to a build that cannot read the database (QA TC-335, docs/OFFICE.md troubleshooting).
//
// A new version migrates the database (data/app.db) when it starts. When the migration raises the schema reader
// level (db.ts SCHEMA_READER_LEVEL, the min_compatible_reader of the migrations), an older build refuses to start on
// it and exits 75 (main.ts EXIT.schemaTooNew). Before this change, an update that migrated and then did not answer in
// time was rolled back to the old build, and the supervisor restarted that old build every 30 s with no end.
//
// The pieces that use this module:
//   - office.js install (the NEW installer runs it): when app.previous cannot read the database any more, it is moved
//     to app.unreadable. An old updater (0.4.0 and the like, which still runs the rollback) then finds no app.previous,
//     refuses the rollback and leaves the new app/ in place. Under an updater the install also writes a heal marker.
//   - office.js update run (every 15 min, from app/, so the new version after a refused rollback): heal() starts the
//     server again when the marker says that an old updater stopped it.
//   - the updater (update.ts): it does not roll back to a build that cannot read the database.
//   - the supervisor (cli.ts run): on exit 75 it goes forward to a newer kept release that can read the database, or
//     it stops with one clear message instead of a restart loop.
// Each check compares the database's reader level with the level of the build in a folder (bundleReaderLevel: the
// highest min_compatible_reader of the migrations it ships, the same figure publish-server.ts publishes).
import fs from 'node:fs'
import path from 'node:path'
import { requiredReaderLevelOfFile } from '../db'
import { bundleReaderLevel, compareVersions } from '../system/update'
import { PRODUCT } from '@mycel/shared'

/** the folders of an installation that can hold a whole release (app/ is the one that runs) */
export const KEPT = ['app.failed', 'app.previous'] as const
/** where an old release goes when it cannot read the database: never a rollback target (old updaters look only for
 * app.previous), removed by the next update that ends well */
export const UNREADABLE = 'app.unreadable'
/** the marker of a heal that may be needed: update/heal.json */
export const healFile = (home: string) => path.join(path.resolve(home), 'update', 'heal.json')

export const dbFile = (home: string) => path.join(path.resolve(home), 'data', 'app.db')

/** the reader level the database needs now (1: no database or not readable) */
export function dbReaderLevel(home: string): number {
  return fs.existsSync(dbFile(home)) ? requiredReaderLevelOfFile(dbFile(home)) : 1
}

export interface ReleaseDir { dir: string; name: string; version: string; level: number }

/** the release in <home>/<name>, or null when there is none (no VERSION file) */
export function releaseIn(home: string, name: string): ReleaseDir | null {
  const dir = path.join(path.resolve(home), name)
  let version = ''
  try { version = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() } catch { return null }
  if (!version) return null
  return { dir, name, version, level: bundleReaderLevel(dir) }
}

/** app.previous when it cannot read the database as it is now, else null */
export function unreadablePrevious(home: string, need = dbReaderLevel(home)): ReleaseDir | null {
  const prev = releaseIn(home, 'app.previous')
  return prev && prev.level < need ? prev : null
}

/** Move app.previous to app.unreadable when it cannot read the database. Returns a line for the log ('' = nothing done). */
export function setAsideUnreadablePrevious(home: string): string {
  const need = dbReaderLevel(home)
  const prev = unreadablePrevious(home, need)
  return prev ? setAsidePrevious(home, prev, `the database needs level ${need}`) : ''
}

/** Move app.previous (prev) to app.unreadable; `why` ends the log line. */
export function setAsidePrevious(home: string, prev: ReleaseDir, why: string): string {
  const to = path.join(path.resolve(home), UNREADABLE)
  fs.rmSync(to, { recursive: true, force: true })
  fs.renameSync(prev.dir, to)
  return `app.previous (${prev.version}) reads schema level ${prev.level} and ${why}: moved to ${UNREADABLE}, so no update can roll back to it`
}

/** What `office.js install` does about app.previous once its wait for the server is over. Pure.
 *  - The database already needs more than app.previous reads: set it aside (a rollback can never start it).
 *  - Under an updater, the server still says "migrating" and this build ships a higher reader level than app.previous:
 *    set it aside too. The migrations commit together at the end (db.ts), so the database still reads the old level
 *    now, but an updater that does not know "migrating" (0.4.0 waits 150 s) would roll back after the commit.
 *  - Never answered and never migrating: keep it. Nothing was migrated, so a rollback is the right way back.
 * Under an updater a set-aside also writes the heal marker, and an install whose server did not answer exits 0 (the
 * updater goes on waiting; a rollback would find no app.previous). */
export function previousDecision(o: {
  up: 'up' | 'migrating' | 'still-migrating' | false
  underUpdater: boolean
  /** the database's reader level now */
  need: number
  /** bundleReaderLevel of the new app/ */
  newLevel: number
  prevLevel: number | null
}): { setAside: boolean; why: string; marker: boolean; exitZero: boolean } {
  const none = { setAside: false, why: '', marker: false, exitZero: false }
  if (o.prevLevel === null) return none
  let why = ''
  if (o.need > o.prevLevel) why = `the database needs level ${o.need}`
  else if (o.underUpdater && (o.up === 'migrating' || o.up === 'still-migrating') && o.newLevel > o.prevLevel) why = `the database is being updated to level ${o.newLevel}`
  if (!why) return none
  return { setAside: true, why, marker: o.underUpdater, exitZero: o.underUpdater && !o.up }
}

/** The text that names the way back for the owner (one command). */
export function recoveryAdvice(home: string, kit: string | null): string {
  const zip = kit ? `${PRODUCT.officeBundle}-${kit} zip or a newer one` : 'newest zip'
  return `run office-install.sh from the ${zip} (bash <unzipped folder>/office-install.sh --prefix ${path.resolve(home)}); an older zip cannot start this database`
}

/** How many more seconds `office.js install` may wait under an updater after its 90 s, when no rollback can help.
 * The updater kills the installer after 10 minutes (an old updater too), and the installer must end before that, or
 * nothing of this runs: at most 9 minutes from the installer's start (TEAMAX_INSTALLER_STARTED, epoch seconds, set by
 * office-install.sh), at most `max`. 0 when the start is unknown or the time is used up. */
export function extraWaitSeconds(startedEpochSec: string | undefined, nowMs: number, budgetSec = 540, max = 240): number {
  const started = Number(startedEpochSec)
  if (!startedEpochSec || !Number.isFinite(started) || started <= 0) return 0
  const left = Math.floor(started + budgetSec - nowMs / 1000)
  return Math.max(0, Math.min(max, left))
}

/** What the supervisor does when the server exits 75 (database too new for this build). */
export type Exit75Decision =
  | { kind: 'restart'; reason: string }
  | { kind: 'forward'; to: ReleaseDir; from: ReleaseDir | null; need: number }
  | { kind: 'stop'; message: string; need: number }

export function exit75Decision(home: string): Exit75Decision {
  const need = dbReaderLevel(home)
  const app = releaseIn(home, 'app')
  if (app && app.level >= need) return { kind: 'restart', reason: `${app.version} reads schema level ${app.level} and the database needs ${need}` }
  // the newest kept release that can read the database and is newer than app/
  const kept = KEPT.map((n) => releaseIn(home, n)).filter((r): r is ReleaseDir => !!r && r.level >= need && (!app || compareVersions(r.version, app.version) > 0))
  kept.sort((a, b) => compareVersions(b.version, a.version))
  if (kept[0]) return { kind: 'forward', to: kept[0], from: app, need }
  const newest = KEPT.map((n) => releaseIn(home, n)).filter((r): r is ReleaseDir => !!r).sort((a, b) => compareVersions(b.version, a.version))[0]
  const kit = newest && (!app || compareVersions(newest.version, app.version) > 0) ? newest.version : null
  return {
    kind: 'stop', need,
    message: `${app?.version ?? 'this build'} reads schema level ${app?.level ?? '?'}, but the database needs level ${need} (a newer version updated it), so the server is not started again. ${recoveryAdvice(home, kit)}`,
  }
}

/** Put a kept release in place of app/: app/ (which cannot read the database) goes to app.unreadable. Only while the
 * server is stopped. */
export function goForward(home: string, to: ReleaseDir): string {
  const h = path.resolve(home)
  const app = path.join(h, 'app'), aside = path.join(h, UNREADABLE)
  const from = releaseIn(h, 'app')
  if (fs.existsSync(app)) { fs.rmSync(aside, { recursive: true, force: true }); fs.renameSync(app, aside) }
  fs.renameSync(to.dir, app)
  return `app = ${to.version} (from ${to.name})${from ? `, ${from.version} moved to ${UNREADABLE}` : ''}`
}

/** a lock file (update/lock) whose process still runs: an update run is busy */
export function updateRunning(home: string): boolean {
  let pid = 0
  try { pid = Number(fs.readFileSync(path.join(path.resolve(home), 'update', 'lock'), 'utf8')) } catch { return false }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface HealMarker { at: string; version: string; previous: string; reason: string }

export function writeHealMarker(home: string, m: HealMarker) {
  const f = healFile(home)
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
  fs.writeFileSync(f, JSON.stringify(m, null, 1) + '\n', { mode: 0o600 })
}

export function readHealMarker(home: string): HealMarker | null {
  try {
    const j = JSON.parse(fs.readFileSync(healFile(home), 'utf8')) as Partial<HealMarker>
    return typeof j.version === 'string' && typeof j.at === 'string' ? { at: j.at, version: j.version, previous: String(j.previous ?? ''), reason: String(j.reason ?? '') } : null
  } catch { return null }
}

/** What `update run` does with a heal marker. Pure: the caller passes what it saw. */
export type HealDecision = { kind: 'none'; drop: boolean; why: string } | { kind: 'start'; why: string }

export function healDecision(o: {
  marker: HealMarker | null
  installed: string | null
  /** the main LaunchAgent's plist file exists (`teamax uninstall-agent` removes it) */
  plist: boolean
  loaded: boolean
  /** what /api/health answers (null: nothing) */
  answer: string | null
  updateRunning: boolean
  /** the last update's result as state.json has it */
  lastUpdate: { to: string; result: string } | null
}): HealDecision {
  const m = o.marker
  if (!m) return { kind: 'none', drop: false, why: 'no marker' }
  if (o.updateRunning) return { kind: 'none', drop: false, why: 'an update run is busy' }
  if (o.installed !== m.version) return { kind: 'none', drop: true, why: `app/ is ${o.installed ?? 'missing'}, not ${m.version}` }
  if (o.answer === m.version) return { kind: 'none', drop: o.lastUpdate?.result === 'updated', why: `${m.version} answers` }
  if (!o.plist) return { kind: 'none', drop: true, why: 'the agent was removed (uninstall)' }
  if (o.loaded) return { kind: 'none', drop: false, why: 'the agent is loaded (the server is starting or restarting)' }
  // only after an update that failed: `teamax stop` after a good update is the owner's choice
  if (!o.lastUpdate || o.lastUpdate.to !== m.version || o.lastUpdate.result === 'updated') return { kind: 'none', drop: true, why: 'the last update did not fail' }
  return { kind: 'start', why: `the update to ${m.version} was not rolled back (${m.previous || 'the old version'} cannot read the database), and the old updater stopped the server` }
}
