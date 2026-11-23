// The profile folders Puppeteer and Playwright make in the TMPDIR of a run. They remove them themselves, unless the run
// is killed. A private chat's TMPDIR outlives its runs (a shared chat's goes with each run), so what a killed browser
// left there (cookies, cache of the pages it opened) and Chromium's crash dumps are removed when the run ends.
import fs from 'node:fs'
import path from 'node:path'

export const BROWSER_PROFILE_RE = /^(?:puppeteer_dev_chrome_profile-|playwright_chromiumdev_profile-)/

/** Is `dir` the same as or inside one of `roots`? */
const under = (dir: string, roots: readonly string[]) => roots.some((r) => dir === r || dir.startsWith(r.endsWith('/') ? r : `${r}/`))

/** A live run as the runner tracks it. `rowId`: tracked again after a server restart, when its roots are the row's folders
 * and do not name the person's home or TMPDIR. */
export interface LiveRun { userId: string; roots: readonly string[]; rowId?: string }

/** Another live run may be using a profile in this TMPDIR: one that can write it, or any run of the same person tracked
 * again after a restart (its roots cannot tell, so this fails closed). Then nothing is removed, and a later run's end
 * does it. */
export const tmpInUse = (tmp: string, runId: string, userId: string, live: Iterable<[string, LiveRun]>) => {
  for (const [id, l] of live) if (id !== runId && (under(tmp, l.roots) || (l.rowId !== undefined && l.userId === userId))) return true
  return false
}

/** A private chat's run ended: its browser profiles and crash dumps go, unless another live run may be using them. */
export const sweepAfterRun = (tmp: string, home: string, runId: string, userId: string, live: Iterable<[string, LiveRun]>) => {
  if (tmpInUse(tmp, runId, userId, live)) return 0
  return sweepBrowserProfiles(tmp) + sweepCrashDumps(home)
}

/** Where Chromium keeps its crash dumps under a home. A dump holds the process's memory strings, the proxy login of its run too. */
export const CRASH_DUMP_DIRS = ['.config/chromium/Crash Reports', '.config/google-chrome/Crash Reports', '.config/chrome-headless-shell/Crash Reports']

/** Removes the crash dump folders under `home`, and returns how many. A run can swap any folder in its home for a link:
 * a path with a link in it is left alone. Call it only when no run can write `home` (tmpInUse). */
export function sweepCrashDumps(home: string): number {
  let n = 0
  for (const rel of CRASH_DUMP_DIRS) {
    try {
      let p = home, real = true
      if (!fs.lstatSync(home).isDirectory()) return n
      for (const part of rel.split('/')) { p = path.join(p, part); if (!fs.lstatSync(p).isDirectory()) { real = false; break } }
      if (real) { fs.rmSync(p, { recursive: true, force: true }); n++ }
    } catch { /* not there */ }
  }
  return n
}

/** Removes the profile folders in `tmp`, and returns how many. A run can swap its TMPDIR for a link, so a `tmp` that is
 * a link is left alone; an entry that is a link is not a profile. Call it only when no run can write `tmp` (tmpInUse). */
export function sweepBrowserProfiles(tmp: string): number {
  let names: fs.Dirent[]
  try {
    if (!fs.lstatSync(tmp).isDirectory()) return 0
    if (fs.realpathSync(tmp) !== path.join(fs.realpathSync(path.dirname(tmp)), path.basename(tmp))) return 0
    names = fs.readdirSync(tmp, { withFileTypes: true })
  } catch { return 0 }
  let n = 0
  for (const e of names) {
    if (!e.isDirectory() || !BROWSER_PROFILE_RE.test(e.name)) continue
    try { fs.rmSync(path.join(tmp, e.name), { recursive: true, force: true }); n++ } catch { /* the next run's end */ }
  }
  return n
}
