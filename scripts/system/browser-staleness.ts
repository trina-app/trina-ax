// Is the pinned chrome-headless-shell (scripts/system/packages.json) behind Chrome for Testing's Stable channel? The
// browser prints untrusted HTML with --no-sandbox and gets no security updates of its own: only a bump of the pin in the
// list brings one. CI runs this (ci.yml, "Pinned browser against Chrome for Testing Stable"); the policy is in
// docs/DECISIONS.md "One list of system packages", "Browser pin: staleness and roll-back".
//
//   bun scripts/system/browser-staleness.ts            fetch Stable, print the verdict, exit 1 only on "fail"
//
// Policy (staleness):
//   ok    the pin is Stable's version
//   warn  the pin is behind Stable in the same major (a security build came out: bump it within 7 days), one major
//         behind, or newer than Stable (a Beta pinned by hand); also when Stable cannot be fetched (CI never goes red
//         for a network error)
//   fail  the pin is two or more majors behind Stable: about four weeks or more without the fixes Stable got
import { readList } from './packages'

export type Level = 'ok' | 'warn' | 'fail'
export const LAST_KNOWN_GOOD = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json'
export const BROWSER = 'chrome-headless-shell'

const parts = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10))
const VERSION = /^[0-9]+(\.[0-9]+){3}$/

/** -1, 0, 1 as a is older than, the same as, newer than b (four-part Chrome versions) */
export function compareChrome(a: string, b: string): number {
  const x = parts(a), y = parts(b)
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  return 0
}

/** The verdict for the pin against Stable's version (no network). */
export function staleness(pin: string, stable: string): { level: Level; message: string } {
  if (!VERSION.test(pin)) return { level: 'fail', message: `the list pins "${pin}", not a Chrome version` }
  if (!VERSION.test(stable)) return { level: 'warn', message: `Chrome for Testing gave "${stable}" as Stable; not checked` }
  const c = compareChrome(pin, stable)
  if (c === 0) return { level: 'ok', message: `${BROWSER} ${pin} is Chrome for Testing Stable` }
  if (c > 0) return { level: 'warn', message: `${BROWSER} ${pin} is newer than Stable ${stable} (a Beta?): pin a Stable build` }
  const behind = parts(stable)[0]! - parts(pin)[0]!
  const bump = 'bump the pin in scripts/system/packages.json (version, url, sha256 and size per platform; docs/DECISIONS.md "Browser pin")'
  if (behind >= 2) return { level: 'fail', message: `${BROWSER} ${pin} is ${behind} majors behind Stable ${stable}: no security fixes for weeks; ${bump}` }
  if (behind === 1) return { level: 'warn', message: `${BROWSER} ${pin} is one major behind Stable ${stable}; ${bump}` }
  return { level: 'warn', message: `${BROWSER} ${pin} is behind Stable ${stable} (a newer build of the same major, often security fixes); ${bump} within 7 days` }
}

/** Stable's version from the last-known-good JSON, or null (a network error, a bad answer). */
export async function fetchStable(url = LAST_KNOWN_GOOD, timeoutMs = 20_000): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const j = await r.json() as { channels?: { Stable?: { version?: unknown } } }
    const v = j.channels?.Stable?.version
    return typeof v === 'string' ? v : null
  } catch { return null }
}

if (import.meta.main) {
  const pin = readList().artifacts[BROWSER]?.version ?? ''
  const stable = await fetchStable()
  // GitHub annotations: a warning or an error on the run's summary
  if (stable === null) {
    console.log(`::warning::could not read Chrome for Testing Stable (${LAST_KNOWN_GOOD}); the pin ${pin} is not checked`)
    process.exit(0)
  }
  const v = staleness(pin, stable)
  console.log(v.level === 'ok' ? v.message : `::${v.level === 'fail' ? 'error' : 'warning'}::${v.message}`)
  process.exit(v.level === 'fail' ? 1 : 0)
}
