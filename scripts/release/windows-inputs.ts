// What goes into the Windows app, as a fingerprint a release can compare with the last Windows release's
// (scripts/release/windows-cadence.ts; owner, 2026-11-26: "most releases change only the web, so the Windows app does
// not change"; docs/decisions/20261126-windows-when-changed.md).
//
// The Windows app is the desk shell only: Electron, the main process, three preloads, its own small screens (welcome,
// browser pane, host bar, find bar, consent) and the script it puts into pages of the in-app browser
// (desktop/build.ts, desktop/build-entries.ts). The team's pages are not in it: the app opens the team server's address
// and the server sends the web app, so a web or server change reaches Windows users without a new installer.
//
// The fingerprint, per part (so the notice can say what changed):
//   - every bundle desktop/build.ts makes (desktop/build-entries.ts), built here the same way as `dist:win` builds it
//     (minified, no source maps): the code from desktop/src, the parts of shared/ it uses and its npm packages (zod,
//     tldts, electron-updater …), after tree shaking. A shared/ change the app does not use leaves it the same.
//   - electron-builder.config.ts bundled with its own files (shared/src/product.ts names, the signing hook
//     desktop/scripts/win-sign.ts, the app id), packages left out
//   - the files packaging reads as they are: the screens' pages and style, the page script, the Windows icon, the
//     installer's NSIS include, Electron's download helper, the release notices script, LICENSE and NOTICE
//   - every other file in desktop/build-resources/ (electron-builder picks up icon.ico, installerSidebar.bmp, license.txt
//     … there by name alone), except the Mac's and Linux's
//   - the Bun version release.yml builds with (both trees are bundled here with this run's Bun)
//   - desktop/package.json without its `version` (bumped every release; the installer gets the release's version from
//     CI anyway): Electron's and electron-builder's versions are pinned there
//   - bun.lock's entries for everything Electron and electron-builder pull in (the packaging tools themselves)
// The Mac-only files (dictation helper, InfoPlist strings, dmg art, entitlements) and the Linux icons are not in it.
//
// The page and the app also agree on bridge versions (shared/src/desktop-bridge.ts, shared/src/api/local-apps.ts):
// a page that asks for a newer one than the app has refuses that feature on the app ("too old"). bridgeVersions()
// reads them so the rule can send a new Windows app at once when they change.
//
//   bun scripts/release/windows-inputs.ts [<repository folder>]   prints the parts and their sha256 (JSON)
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLE_ENTRIES, COPIED, UI_PAGES } from '../../desktop/build-entries'

export type Fingerprint = Record<string, string>

/** packaging reads these as they are (under the repository root) */
export const RAW_FILES = [
  ...UI_PAGES.map((f) => `desktop/src/ui/${f}`),
  ...COPIED.map(([from]) => `desktop/${from}`),
  'desktop/build-resources/icon.png',
  'desktop/build-resources/installer.nsh',
  'desktop/scripts/ensure-electron.ts',
  'scripts/release-notices.ts',
  'LICENSE',
  'NOTICE',
] as const

/** electron-builder also picks up files in build-resources/ by name alone (icon.ico, installerSidebar.bmp,
 * license.txt …): every file there counts, except these, which only the Mac and Linux builds read */
const NOT_WINDOWS_RESOURCES = /^(mac-infoplist|linux-icons)\/|^background(@2x)?\.png$|^entitlements\..*\.plist$/

/** the packaging tools: their bun.lock entries and everything they depend on */
export const LOCK_ROOTS = ['electron', 'electron-builder'] as const

/** the bridge versions a page checks against the app (export const <NAME> = <n>) */
export const BRIDGE_FILES = ['shared/src/desktop-bridge.ts', 'shared/src/api/local-apps.ts'] as const
/** what the Windows app offers no matter its version, or never on Windows (voice input on the Mac only) */
const NOT_A_WINDOWS_BRIDGE = new Set(['DICTATION_BRIDGE_VERSION'])
const BRIDGE_CONST = /^export const ([A-Z][A-Z0-9_]*_(?:BRIDGE_VERSION|WIDE_VERSION)) = (\d+)\b/gm

const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

/** bun.lock is JSON with trailing commas */
function readLock(file: string): { packages?: Record<string, unknown[]> } {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/,(\s*[}\]])/g, '$1'))
}

/** the bun.lock entries of `roots` and of everything they depend on (dependencies and optional ones) */
export function lockClosure(lock: { packages?: Record<string, unknown[]> }, roots: readonly string[]): Record<string, unknown[]> {
  const pk = lock.packages ?? {}
  const seen: Record<string, unknown[]> = {}
  const todo = [...roots]
  while (todo.length) {
    const name = todo.pop()!
    if (seen[name] || !pk[name]) continue
    const entry = pk[name]!
    seen[name] = entry
    const meta = entry.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, Record<string, string>> | undefined
    for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(meta?.[k] ?? {})) {
        // a nested copy (bun.lock "parent/dep") wins over the top one for this parent
        todo.push(pk[`${name}/${dep}`] ? `${name}/${dep}` : dep)
      }
    }
  }
  return Object.fromEntries(Object.keys(seen).sort().map((k) => [k, seen[k]!]))
}

async function bundle(repo: string, entry: string, o: Partial<Parameters<typeof Bun.build>[0]>): Promise<string> {
  const file = path.join(repo, 'desktop', entry)
  if (!fs.existsSync(file)) return 'missing'
  const r = await Bun.build({ entrypoints: [file], minify: true, sourcemap: 'none', ...o } as Parameters<typeof Bun.build>[0])
  if (!r.success) throw new Error(`${entry}: ${r.logs.map(String).join('\n').slice(0, 500)}`)
  const h = crypto.createHash('sha256')
  // the folder the checkout sits in is not part of the app
  for (const out of r.outputs) h.update((await out.text()).split(repo).join('<root>'))
  return h.digest('hex')
}

/** The Windows app's fingerprint of the repository at `root` (its node_modules installed). Throws when it cannot be
 * built: the caller then cannot tell, and treats it as changed. */
export async function windowsFingerprint(root: string): Promise<Fingerprint> {
  const parts: Fingerprint = {}
  const desktop = path.join(root, 'desktop')
  for (const [entry, out, target] of BUNDLE_ENTRIES) {
    parts[`desktop/dist/${out}`] = await bundle(root, entry, target === 'node'
      ? { target: 'node', format: 'cjs', external: ['electron'] }
      : { target: 'browser', format: 'esm' })
  }
  parts['desktop/electron-builder.config.ts'] = await bundle(root, 'electron-builder.config.ts', { target: 'bun', format: 'esm', packages: 'external' })
  for (const f of RAW_FILES) {
    const p = path.join(root, f)
    parts[f] = fs.existsSync(p) ? sha(fs.readFileSync(p)) : 'missing'
  }
  // the other files electron-builder finds in build-resources/ by their names (a new one counts)
  const res = path.join(desktop, 'build-resources')
  if (fs.existsSync(res)) {
    for (const f of (fs.readdirSync(res, { recursive: true }) as string[]).map((x) => String(x).split(path.sep).join('/')).sort()) {
      const k = `desktop/build-resources/${f}`
      if (NOT_WINDOWS_RESOURCES.test(f) || k in parts || !fs.statSync(path.join(res, f)).isFile()) continue
      parts[k] = sha(fs.readFileSync(path.join(res, f)))
    }
  }
  // the Bun that bundles the real build (release.yml BUN_VERSION): both trees are bundled here with this run's Bun
  const wf = path.join(root, '.github/workflows/release.yml')
  parts['Bun version (release.yml)'] = (fs.existsSync(wf) && /^\s*BUN_VERSION:\s*(\S+)/m.exec(fs.readFileSync(wf, 'utf8'))?.[1]) || 'missing'
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as Record<string, unknown>
  delete pkg.version
  parts['desktop/package.json (without version)'] = sha(JSON.stringify(pkg))
  parts['bun.lock (Electron, electron-builder)'] = sha(JSON.stringify(lockClosure(readLock(path.join(root, 'bun.lock')), LOCK_ROOTS)))
  return parts
}

/** the parts that differ (a part only one side has counts) */
export function changedParts(a: Fingerprint, b: Fingerprint): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()
}

/** The bridge versions the Windows app and the team's pages agree on, from the repository at `root`. */
export function bridgeVersions(root: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of BRIDGE_FILES) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) continue
    for (const m of fs.readFileSync(p, 'utf8').matchAll(BRIDGE_CONST)) if (!NOT_A_WINDOWS_BRIDGE.has(m[1]!)) out[m[1]!] = Number(m[2])
  }
  return out
}

/** the bridge versions that differ between the last Windows app and this release (a new one counts) */
export function changedBridges(last: Record<string, number>, now: Record<string, number>): string[] {
  return Object.keys(now).filter((k) => last[k] !== now[k]).sort().map((k) => `${k} ${last[k] ?? 'none'} → ${now[k]}`)
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? '.')
  console.log(JSON.stringify({ parts: await windowsFingerprint(root), bridges: bridgeVersions(root) }, null, 2))
}
