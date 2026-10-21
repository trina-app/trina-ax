// Desktop app updates (docs/OFFICE.md "자동 업데이트"), the parts without Electron (unit-tested in
// tests/unit/e-desktop-update.test.ts).
//
// Windows: electron-updater with the generic provider pointed at the open team's own address + /downloads/ (the
// clinic's Mac puts the installer and its latest.yml there, server/src/office/update.ts), with the team session as a
// Bearer token because /downloads/ is for signed-in people only. Checked 20 s after start and every 4 hours, downloaded
// in the background, installed when the app quits or when the person clicks "다시 시작". The installer is unsigned
// NSIS: no publisherName, so electron-updater does not ask for a signature; the sha512 in latest.yml is checked.
// macOS: no automatic install (that needs an Apple-signed app); /downloads/index.json is read with the team page's
// own cookies and a newer Mac item is announced once per version, with a link to Settings > Apps.
export const FIRST_CHECK_MS = 20_000
export const CHECK_EVERY_MS = 4 * 3600_000

export type UpdateMode = 'auto-install' | 'notice' | 'off'

/** what this build does: electron-updater only in a packaged Windows app (MYCEL_DESKTOP_UPDATE_TEST forces a mode in
 * development and tests) */
export function updateMode(platform: string, packaged: boolean, forced?: string): UpdateMode {
  if (forced === 'auto-install' || forced === 'notice' || forced === 'off') return forced
  if (!packaged) return 'off'
  if (platform === 'win32') return 'auto-install'
  if (platform === 'darwin') return 'notice'
  return 'off'
}

/** <team origin>/downloads/ (only an https team address; a dev address on *.localhost may be http) */
export function feedUrlFor(origin: string): string | null {
  let u: URL
  try { u = new URL(origin) } catch { return null }
  const devHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1')
  if (u.protocol !== 'https:' && !devHttp) return null
  if (u.username || u.password) return null
  return `${u.origin}/downloads/`
}

/** electron-updater's generic provider options for a team */
export function genericFeed(origin: string, token: string | null): { provider: 'generic'; url: string; requestHeaders?: Record<string, string> } | null {
  const url = feedUrlFor(origin)
  if (!url) return null
  return { provider: 'generic', url, ...(token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? { requestHeaders: { Authorization: `Bearer ${token}` } } : {}) }
}

/** semver order (numbers as numbers; a release after its pre-releases) */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const core = v.split('+', 1)[0]!
    const dash = core.indexOf('-')
    return { nums: (dash < 0 ? core : core.slice(0, dash)).split('.').map((x) => parseInt(x, 10) || 0), pre: dash < 0 ? null : core.slice(dash + 1).split('.') }
  }
  const x = split(a), y = split(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === q) continue
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1; continue }
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** The newest Mac app in /downloads/index.json that is newer than this one, or null. */
export function macNotice(index: unknown, appVersion: string): { version: string; file: string } | null {
  const items = (index as { items?: unknown })?.items
  if (!Array.isArray(items)) return null
  let best: { version: string; file: string } | null = null
  for (const i of items) {
    if (!i || typeof i !== 'object') continue
    const { platform, version, file } = i as Record<string, unknown>
    if (platform !== 'mac' || typeof version !== 'string' || typeof file !== 'string') continue
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(version)) continue
    if (compareVersions(version, appVersion) <= 0) continue
    if (!best || compareVersions(version, best.version) > 0) best = { version, file }
  }
  return best
}
