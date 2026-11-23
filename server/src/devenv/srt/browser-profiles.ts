// The profile folders Puppeteer and Playwright make in the TMPDIR of a run. They remove them themselves, unless the run
// is killed. A private chat's TMPDIR outlives its runs (a shared chat's goes with each run), so what a killed browser
// left there (cookies, cache of the pages it opened) is removed when the run ends.
import fs from 'node:fs'
import path from 'node:path'

export const BROWSER_PROFILE_RE = /^(?:puppeteer_dev_chrome_profile-|playwright_chromiumdev_profile-)/

/** Is `dir` the same as or inside one of `roots`? */
const under = (dir: string, roots: readonly string[]) => roots.some((r) => dir === r || dir.startsWith(r.endsWith('/') ? r : `${r}/`))

/** Another live run that can write this TMPDIR may be using a profile there: then nothing is removed, and a later run's
 * end does it. */
export const tmpInUse = (tmp: string, runId: string, live: Iterable<[string, { roots: readonly string[] }]>) => {
  for (const [id, l] of live) if (id !== runId && under(tmp, l.roots)) return true
  return false
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
