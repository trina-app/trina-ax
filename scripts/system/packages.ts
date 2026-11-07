// The one list of system packages and downloaded programs (scripts/system/packages.json): its shape, read by bun. The
// shell scripts read it through scripts/system/packages.sh; tests/unit/system-packages.test.ts checks that both readers
// agree, that the list is well formed and that no install or image script keeps a list of its own.
//
//   bun scripts/system/packages.ts check     the list is well formed (exit 1 and the problems otherwise)
//   bun scripts/system/packages.ts linux     the Linux copy of the list (root/packages.json of a Linux bundle)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LIST_FILE = path.join(import.meta.dir, 'packages.json')

export type Install = 'always' | 'default' | 'on-request'
export const INSTALLS: readonly Install[] = ['always', 'default', 'on-request']
/** conditions a package may name in "when" (packages.sh pk_packages evaluates them) */
export const WHENS = ['userns-restricted'] as const
/** names packages.sh takes as a profile, so no group may have them */
export const PROFILES = ['minimal', 'default'] as const
export const PLATFORMS = ['linux-amd64', 'linux-arm64', 'darwin-arm64', 'darwin-amd64', 'any'] as const
/** the platforms an artifact must have a version, url and sha256 for: every Linux server and, for the browser, every
 * office Mac (office-install.sh) */
export const REQUIRED_PLATFORMS: Record<string, readonly string[]> = {
  'chrome-headless-shell': ['linux-amd64', 'linux-arm64', 'darwin-arm64', 'darwin-amd64'],
  node: ['linux-amd64', 'linux-arm64'],
  srt: ['any'],
}

export interface PackageSpec { min?: string; on?: string[]; when?: (typeof WHENS)[number] }
export interface Group { install: Install; for: string; packages?: Record<string, string | PackageSpec>; remove?: string[]; artifacts?: string[] }
/** revoked: versions that must not stay on a machine even when newer than the pin (a bad pin rolled back: packages.sh
 * switches back to version and removes them) */
export interface Artifact { version: string; for: string; revoked?: string[]; platforms: Record<string, { url: string; sha256: string; size: number; dir?: string }> }
export interface PackageList {
  format: 1
  _about?: string[]
  distros: Record<string, { id: string; version: string; suite: string }>
  arches: string[]
  groups: Record<string, Group>
  artifacts: Record<string, Artifact>
}

export const readList = (file = LIST_FILE): PackageList => JSON.parse(fs.readFileSync(file, 'utf8')) as PackageList

const NAME = /^[a-z0-9][a-z0-9.+-]*$/
const FLOOR = /^>=[0-9][0-9A-Za-z.+:~-]*$/
const GROUP = /^[a-z][a-z0-9-]*$/
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const extra = (o: object, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k))

/** What is wrong with the list (empty: nothing). linux: the Linux copy (linuxList), which has no darwin platforms. */
export function listProblems(j: unknown, opts: { linux?: boolean } = {}): string[] {
  const p: string[] = []
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['the list is not a JSON object']
  const l = j as PackageList
  if (l.format !== 1) p.push(`format is ${String(l.format)}, not 1`)
  for (const k of extra(l, ['format', '_about', 'distros', 'arches', 'groups', 'artifacts'])) p.push(`unknown key ${k}`)
  // a TAB or a line break would break packages.sh's flat lines; a space would split a name
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string') { if (/[\t\n\r]/.test(v)) p.push(`${at}: a TAB or line break`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/[\s]/.test(k)) p.push(`${at}: the key "${k}" has a space`); walk(x, `${at}.${k}`) }
  }
  walk(l, 'list')
  const distros = l.distros && typeof l.distros === 'object' ? l.distros : {}
  if (!Object.keys(distros).length) p.push('no distros')
  for (const [k, d] of Object.entries(distros)) {
    if (!d || typeof d !== 'object') { p.push(`distro ${k}: not an object`); continue }
    if (!['debian', 'ubuntu'].includes(d.id)) p.push(`distro ${k}: id ${d.id} (debian or ubuntu)`)
    if (typeof d.version !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(d.version)) p.push(`distro ${k}: version must be a string like "13" or "24.04"`)
    if (k !== `${d.id}-${d.version}`) p.push(`distro ${k}: the key must be <id>-<version>`)
    if (typeof d.suite !== 'string' || !/^[a-z]+$/.test(d.suite)) p.push(`distro ${k}: no suite (the release's code name)`)
  }
  const arches = Array.isArray(l.arches) ? l.arches : []
  if (!arches.length || arches.some((a) => !['amd64', 'arm64'].includes(a)) || new Set(arches).size !== arches.length) p.push('arches must be amd64 and/or arm64, each once')
  const targets = new Set([...Object.keys(distros), ...Object.keys(distros).flatMap((d) => arches.map((a) => `${d}/${a}`))])
  const artifacts = l.artifacts && typeof l.artifacts === 'object' ? l.artifacts : {}
  const groups = l.groups && typeof l.groups === 'object' ? l.groups : {}
  if (!Object.values(groups).some((g) => g?.install === 'always')) p.push('no group with install "always"')
  for (const [g, v] of Object.entries(groups)) {
    const at = `group ${g}`
    if (!GROUP.test(g) || (PROFILES as readonly string[]).includes(g)) p.push(`${at}: bad name (a-z, 0-9, -; not ${PROFILES.join(' or ')})`)
    if (!v || typeof v !== 'object') { p.push(`${at}: not an object`); continue }
    for (const k of extra(v, ['install', 'for', 'packages', 'remove', 'artifacts'])) p.push(`${at}: unknown key ${k}`)
    if (!INSTALLS.includes(v.install)) p.push(`${at}: install must be ${INSTALLS.join(', ')}`)
    if (typeof v.for !== 'string' || !v.for) p.push(`${at}: say what it is for ("for")`)
    if (!v.packages && !v.artifacts) p.push(`${at}: no packages and no artifacts`)
    for (const [n, s] of Object.entries(v.packages ?? {})) {
      if (!NAME.test(n)) p.push(`${at}: bad package name ${n}`)
      const spec: PackageSpec = typeof s === 'string' ? { min: s } : s
      if (typeof s !== 'string' && (!s || typeof s !== 'object' || Array.isArray(s))) { p.push(`${at}: ${n}: "" , ">=V" or an object`); continue }
      if (typeof s === 'object') for (const k of extra(s, ['min', 'on', 'when'])) p.push(`${at}: ${n}: unknown key ${k}`)
      if (spec.min !== undefined && spec.min !== '' && !FLOOR.test(spec.min)) p.push(`${at}: ${n}: the floor must be ">=<version>" (dpkg), not ${spec.min}`)
      if (spec.on !== undefined && (!Array.isArray(spec.on) || !spec.on.length || spec.on.some((o) => !targets.has(o)))) p.push(`${at}: ${n}: "on" names a distro (or distro/arch) the list does not have`)
      if (spec.when !== undefined && !(WHENS as readonly string[]).includes(spec.when)) p.push(`${at}: ${n}: unknown "when" ${spec.when}`)
    }
    for (const n of v.remove ?? []) if (!NAME.test(n)) p.push(`${at}: bad package to remove ${n}`)
    for (const a of v.artifacts ?? []) if (!has(artifacts, a)) p.push(`${at}: no artifact ${a}`)
    // an always group installs on every system of the list
    if (v.install === 'always') {
      for (const t of Object.keys(distros).flatMap((d) => arches.map((a) => [d, a] as const))) {
        if (!packagesFor(l, t[0], t[1], [g]).length) p.push(`${at}: no package for ${t[0]} ${t[1]}`)
      }
    }
  }
  for (const [n, a] of Object.entries(artifacts)) {
    const at = `artifact ${n}`
    if (!GROUP.test(n)) p.push(`${at}: bad name`)
    if (!a || typeof a !== 'object') { p.push(`${at}: not an object`); continue }
    for (const k of extra(a, ['version', 'for', 'revoked', 'platforms'])) p.push(`${at}: unknown key ${k}`)
    if (typeof a.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]*$/.test(a.version)) p.push(`${at}: no version`)
    if (a.revoked !== undefined) {
      if (!Array.isArray(a.revoked) || a.revoked.some((v) => typeof v !== 'string' || !/^[0-9][0-9.]*$/.test(v))) p.push(`${at}: revoked must be a list of versions`)
      else if (a.revoked.includes(a.version)) p.push(`${at}: revoked names the pinned version ${a.version}`)
    }
    if (typeof a.for !== 'string' || !a.for) p.push(`${at}: say what it is for ("for")`)
    const plats = a.platforms && typeof a.platforms === 'object' ? a.platforms : {}
    for (const need of REQUIRED_PLATFORMS[n] ?? []) if (!has(plats, need) && !(opts.linux && need.startsWith('darwin-'))) p.push(`${at}: no ${need}`)
    if (!Object.keys(plats).length) p.push(`${at}: no platforms`)
    for (const [pl, f] of Object.entries(plats)) {
      const pa = `${at} ${pl}`
      if (!(PLATFORMS as readonly string[]).includes(pl)) p.push(`${pa}: unknown platform (${PLATFORMS.join(', ')})`)
      if (!f || typeof f !== 'object') { p.push(`${pa}: not an object`); continue }
      for (const k of extra(f, ['url', 'sha256', 'size', 'dir'])) p.push(`${pa}: unknown key ${k}`)
      if (typeof f.url !== 'string' || !/^https:\/\/[A-Za-z0-9./_+%@-]+$/.test(f.url)) p.push(`${pa}: the url must be https`)
      else if (typeof a.version === 'string' && !f.url.includes(a.version)) p.push(`${pa}: the url does not name version ${a.version} (a version moved without its files?)`)
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) p.push(`${pa}: no sha256 (64 hex characters)`)
      if (!Number.isInteger(f.size) || f.size <= 0) p.push(`${pa}: no size (bytes)`)
      if (f.dir !== undefined && (typeof f.dir !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f.dir) || f.dir.includes('..'))) p.push(`${pa}: bad dir (a folder name, no ..)`)
    }
  }
  for (const n of Object.keys(REQUIRED_PLATFORMS)) if (!has(artifacts, n)) p.push(`no artifact ${n}`)
  return p
}

/** The groups a profile or group names stand for, in list order (packages.sh pk_groups). */
export function groupsFor(l: PackageList, names: string[]): string[] {
  return Object.entries(l.groups).filter(([g, v]) => names.includes(g)
    || (names.includes('minimal') && v.install === 'always')
    || (names.includes('default') && (v.install === 'always' || v.install === 'default'))).map(([g]) => g)
}

/** The apt packages for a system (packages.sh pk_packages), each once, in list order. */
export function packagesFor(l: PackageList, distro: string, arch: string, names: string[], when: { usernsRestricted?: boolean } = {}): string[] {
  const out: string[] = []
  for (const g of groupsFor(l, names)) {
    for (const [n, s] of Object.entries(l.groups[g]!.packages ?? {})) {
      const spec: PackageSpec = typeof s === 'string' ? { min: s } : s
      if (spec.on && !spec.on.some((o) => o === distro || o === `${distro}/${arch}`)) continue
      if (spec.when === 'userns-restricted' && !when.usernsRestricted) continue
      if (!out.includes(n)) out.push(n)
    }
  }
  return out
}

/** The flat lines packages.sh reads (its pk_flat, with bun or jq): the same text, for the test that compares them. */
export function flatLines(l: PackageList): string {
  const o: string[] = []
  const f = (x: unknown) => x === undefined || x === null || x === '' ? '-' : String(x)
  const t = (...a: unknown[]) => o.push(a.map(f).join('\t'))
  for (const [k, d] of Object.entries(l.distros)) t('D', k, d.id, d.version, d.suite)
  for (const a of l.arches) t('A', a)
  for (const [g, v] of Object.entries(l.groups)) {
    t('G', g, v.install)
    for (const [n, s] of Object.entries(v.packages ?? {})) {
      const p: PackageSpec = typeof s === 'string' ? { min: s } : s
      t('P', g, n, (p.min ?? '').replace(/^>=/, ''), (p.on ?? []).join(','), p.when)
    }
    for (const n of v.remove ?? []) t('R', g, n)
    for (const a of v.artifacts ?? []) t('GA', g, a)
  }
  for (const [n, a] of Object.entries(l.artifacts)) for (const [p, x] of Object.entries(a.platforms)) t('F', n, p, a.version, x.url, x.sha256, x.size, x.dir)
  for (const [n, a] of Object.entries(l.artifacts)) for (const v of a.revoked ?? []) t('X', n, v)
  return o.join('\n')
}

/** root/packages.flat of a Linux bundle: a first line with the sha256 of the list's bytes, then its flat lines. packages.sh
 * reads it with awk alone when the sha256 is the list's (pk__flat_file), so root needs neither bun nor jq. */
export function flatFile(listText: string): string {
  return `#sha256 ${createHash('sha256').update(listText).digest('hex')}\n${flatLines(JSON.parse(listText) as PackageList)}\n`
}

/** The platforms a Linux server reads (packages.sh pk_platform on Linux, and "any"). */
const LINUX_PLATFORM = (p: string) => p.startsWith('linux-') || p === 'any'
const LINUX_ABOUT = ['The Linux copy of scripts/system/packages.json, made by scripts/build-bundle.ts (packages.ts linuxList): only',
  'the platforms of a Linux server, so a change of an office Mac\'s download changes no byte here and is no root update.']

/** root/packages.json of a Linux bundle: the list without the darwin platforms of its artifacts and with a fixed _about,
 * so a Mac-only change of scripts/system/packages.json leaves the file byte for byte the same (no root release, which
 * restarts the launcher and loads the firewall again on every server: PR #164 review, question 7). Groups, packages,
 * distros, arches and revoked versions are the list's. The image builds compare a kit's root/packages.json with this
 * of their checkout (scripts/image/build.sh, build-ami.sh). */
export function linuxList(listText: string): string {
  const l = JSON.parse(listText) as PackageList
  const artifacts = Object.fromEntries(Object.entries(l.artifacts).map(([n, a]) =>
    [n, { ...a, platforms: Object.fromEntries(Object.entries(a.platforms).filter(([p]) => LINUX_PLATFORM(p))) }]))
  return `${JSON.stringify({ ...l, _about: LINUX_ABOUT, artifacts }, null, 2)}\n`
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'linux') { process.stdout.write(linuxList(fs.readFileSync(process.argv[3] ?? LIST_FILE, 'utf8'))); process.exit(0) }
  if (cmd !== 'check') { console.error('usage: bun scripts/system/packages.ts check | linux [<list>]'); process.exit(2) }
  const problems = listProblems(readList())
  for (const x of problems) console.error(`packages.json: ${x}`)
  if (problems.length) process.exit(1)
  console.log('packages.json: ok')
}
