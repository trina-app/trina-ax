// The extension's version and its guard (docs/RELEASE-CI.md "Chrome extension releases"). The store never gets one
// version with two different contents: chrome-extension/shipped.json keeps the version and the fingerprint of what the
// zip is built from (chrome-extension/inputs.ts).
//   bun run chrome:bump patch|minor|major   sets EXTENSION_VERSION in build.ts and records shipped.json
//   bun run chrome:check                    fails when shipped.json is stale, or the extension changed against the base
//                                           branch (CHROME_BASE, a git ref; else the pull request's base in CI) and the
//                                           version is not higher there
//   bun chrome-extension/release.ts version prints EXTENSION_VERSION (the release workflow)
//   bun chrome-extension/release.ts protocol  (re)writes tests/fixtures/chrome-protocol/<EXTENSION_VERSION>.json, what
//                                           this version and the server say to each other (chrome-extension/protocol.ts)
// A bump also writes the new version's protocol file and removes the previous version's when that one was never
// released (no tag chrome-v<version> on origin): only released versions bind later servers.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseRef } from '../scripts/changelog'
import { EXTENSION_VERSION } from './build'
import { extensionFingerprint } from './inputs'
import { protocolSnapshot } from './protocol'

const HERE = import.meta.dir
const ROOT = join(HERE, '..')
export const SHIPPED_FILE = 'chrome-extension/shipped.json'
export const PROTOCOL_DIR = 'tests/fixtures/chrome-protocol'
export const protocolFile = (version: string) => `${PROTOCOL_DIR}/${version}.json`
export const TAG_PREFIX = 'chrome-v'
/** plain MAJOR.MINOR.PATCH: the Web Store takes only numbers (no pre-release) */
export const VERSION_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/

export interface Shipped { version: string; fingerprint: string }

export function parseVersion(v: string): [number, number, number] {
  const m = VERSION_RE.exec(v)
  if (!m) throw new Error(`"${v}" is not a version MAJOR.MINOR.PATCH (numbers only: the Web Store takes no pre-release)`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

export function nextVersion(v: string, part: 'patch' | 'minor' | 'major'): string {
  const [M, m, p] = parseVersion(v)
  return part === 'major' ? `${M + 1}.0.0` : part === 'minor' ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`
}

export function parseShipped(text: string): Shipped {
  const j = JSON.parse(text) as Partial<Shipped>
  if (typeof j.version !== 'string' || typeof j.fingerprint !== 'string') throw new Error(`${SHIPPED_FILE}: needs "version" and "fingerprint"`)
  return { version: j.version, fingerprint: j.fingerprint }
}

/** What is wrong: `version` is EXTENSION_VERSION, `fingerprint` today's, `base` shipped.json on the base branch (null:
 * none to compare with). */
export function problems(o: { version: string; fingerprint: string; shipped: Shipped; base: Shipped | null }): string[] {
  const out: string[] = []
  const bump = 'run `bun run chrome:bump patch|minor|major` (docs/RELEASE-CI.md "Chrome extension releases")'
  if (!VERSION_RE.test(o.version)) out.push(`EXTENSION_VERSION "${o.version}" is not MAJOR.MINOR.PATCH`)
  if (o.shipped.version !== o.version) out.push(`${SHIPPED_FILE} names ${o.shipped.version} but EXTENSION_VERSION is ${o.version}: ${bump}`)
  if (o.shipped.fingerprint !== o.fingerprint) out.push(`the extension changed (what its zip is built from) since ${SHIPPED_FILE} was recorded: ${bump}`)
  if (o.base && o.base.fingerprint !== o.fingerprint && VERSION_RE.test(o.version) && VERSION_RE.test(o.base.version) && compareVersions(o.version, o.base.version) <= 0)
    out.push(`the extension changed against the base branch but its version ${o.version} is not above the base's ${o.base.version}: ${bump}`)
  return out
}

const readShipped = () => parseShipped(readFileSync(join(ROOT, SHIPPED_FILE), 'utf8'))
const writeShipped = (s: Shipped) => writeFileSync(join(ROOT, SHIPPED_FILE), `${JSON.stringify(s, null, 2)}\n`)

export function writeProtocol(version: string): string {
  const file = protocolFile(version)
  mkdirSync(join(ROOT, PROTOCOL_DIR), { recursive: true })
  writeFileSync(join(ROOT, file), `${JSON.stringify(protocolSnapshot(version), null, 2)}\n`)
  return file
}

/** versions in the store without a tag: uploaded by hand before the release workflow */
export const HAND_RELEASED = ['0.1.0']

/** true: in the store (the tag chrome-v<version> is on origin, or uploaded by hand); null: could not tell (offline) */
function released(version: string): boolean | null {
  if (HAND_RELEASED.includes(version)) return true
  const r = spawnSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${TAG_PREFIX}${version}`], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
  return r.status === 0 ? r.stdout.trim() !== '' : null
}

export function bump(part: 'patch' | 'minor' | 'major'): Shipped {
  const prev = EXTENSION_VERSION
  const next = nextVersion(prev, part)
  const file = join(HERE, 'build.ts')
  const src = readFileSync(file, 'utf8')
  const out = src.replace(/(export const EXTENSION_VERSION = )'[^']*'/, `$1'${next}'`)
  if (out === src) throw new Error('EXTENSION_VERSION not found in build.ts')
  writeFileSync(file, out)
  const s = { version: next, fingerprint: extensionFingerprint() }
  writeShipped(s)
  writeProtocol(next)
  if (existsSync(join(ROOT, protocolFile(prev)))) {
    const r = released(prev)
    if (r === false) rmSync(join(ROOT, protocolFile(prev)))
    else if (r === null) console.log(`could not ask origin whether ${prev} was released: ${protocolFile(prev)} kept (remove it if it never was)`)
  }
  return s
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'version') {
    console.log(EXTENSION_VERSION)
  } else if (cmd === 'protocol') {
    console.log(`wrote ${writeProtocol(EXTENSION_VERSION)}`)
  } else if (cmd === 'bump') {
    if (arg !== 'patch' && arg !== 'minor' && arg !== 'major') { console.error('usage: bun run chrome:bump patch|minor|major'); process.exit(2) }
    const s = bump(arg)
    console.log(`EXTENSION_VERSION ${EXTENSION_VERSION} -> ${s.version}; ${SHIPPED_FILE} recorded`)
  } else if (cmd === 'check') {
    const warn = (why: string) => console.log(`${process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '}chrome:check: ${why}; not compared with the base branch`)
    const ref = baseRef(ROOT, process.env, warn, process.env.CHROME_BASE ?? '')
    const atBase = (...args: string[]) => (ref === null ? null : spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }))
    const shown = atBase('show', `${ref}:${SHIPPED_FILE}`)
    let base: Shipped | null = null
    if (shown && shown.status !== 0) warn(`${SHIPPED_FILE} is not on ${ref}`)
    else if (shown) try { base = parseShipped(shown.stdout) } catch (e) { warn(`the base's ${SHIPPED_FILE} cannot be read (${(e as Error).message})`) }
    // a released version's protocol file binds every later server: it is never removed (a bump removes only an
    // unreleased one, and a version can be released between that bump and its merge)
    const gone: string[] = []
    const listed = atBase('ls-tree', '--name-only', `${ref}:${PROTOCOL_DIR}`)
    for (const f of listed && listed.status === 0 ? listed.stdout.split('\n').filter((l) => l.endsWith('.json')) : []) {
      const v = f.replace(/\.json$/, '')
      if (!existsSync(join(ROOT, PROTOCOL_DIR, f)) && released(v) !== false) gone.push(`${protocolFile(v)} was removed but ${v} is in the store (or origin could not tell): put it back, later servers must keep working with it`)
    }
    const bad = [...problems({ version: EXTENSION_VERSION, fingerprint: extensionFingerprint(), shipped: readShipped(), base }), ...gone]
    for (const b of bad) console.error(b)
    if (bad.length) process.exit(1)
    console.log(`Chrome extension ${EXTENSION_VERSION}: ${SHIPPED_FILE} is current${base ? `, version checked against the base (${base.version})` : ''}.`)
  } else {
    console.error('usage: bun chrome-extension/release.ts version | bump patch|minor|major | check | protocol')
    process.exit(2)
  }
}
